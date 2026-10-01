import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { PtySessionWire } from "../wire.js";

/** Output kept for a detached session. Beyond this the oldest bytes go; a client that was
 *  away for a full build wants the tail, not a truncated head. */
const DETACHED_BUFFER_BYTES = 1 << 20;

export interface PtySpawn {
  file: string;
  args: string[];
  cols: number;
  rows: number;
}

export class PtySession {
  readonly id = randomUUID();
  readonly createdAt = new Date().toISOString();
  alive = true;
  exitCode: number | null = null;
  cols: number;
  rows: number;

  private readonly proc: pty.IPty;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private onData: ((data: Buffer) => void) | null = null;
  private onExit: ((code: number | null) => void) | null = null;
  private readonly exitHooks: Array<() => void> = [];

  constructor(
    readonly sandboxId: string,
    spawn: PtySpawn,
    private readonly onClosed: (session: PtySession) => void,
  ) {
    this.cols = spawn.cols;
    this.rows = spawn.rows;
    this.proc = pty.spawn(spawn.file, spawn.args, {
      name: "xterm-256color",
      cols: spawn.cols,
      rows: spawn.rows,
      cwd: "/",
      // crun resolves its state directory from XDG_RUNTIME_DIR when set (even as root), so
      // the exec must see the same value the `crun run` that created the sandbox saw, or it
      // looks for the container in the wrong place.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      },
      // pi's framed protocol rides this channel, so the bytes must arrive as sent — a utf8
      // round trip would rewrite every invalid sequence into U+FFFD.
      encoding: null,
    });
    this.proc.onData((data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string, "utf8");
      if (this.onData) this.onData(buf);
      else this.buffer(buf);
    });
    this.proc.onExit(({ exitCode }) => {
      this.alive = false;
      this.exitCode = exitCode;
      this.onExit?.(exitCode);
      for (const hook of this.exitHooks) hook();
      this.onClosed(this);
    });
  }

  private buffer(buf: Buffer): void {
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    while (this.pendingBytes > DETACHED_BUFFER_BYTES && this.pending.length > 1) {
      this.pendingBytes -= this.pending.shift()!.length;
    }
  }

  /** One client at a time: a second attach displaces the first rather than interleaving. */
  attach(onData: (data: Buffer) => void, onExit: (code: number | null) => void): void {
    this.onData = onData;
    this.onExit = onExit;
    if (this.pending.length > 0) {
      const flush = Buffer.concat(this.pending);
      this.pending = [];
      this.pendingBytes = 0;
      onData(flush);
    }
    if (!this.alive) onExit(this.exitCode);
  }

  /** Fires when the session ends, regardless of whether a client is attached. */
  onceExited(cb: () => void): void {
    if (!this.alive) {
      cb();
      return;
    }
    this.exitHooks.push(cb);
  }

  waitForExit(timeoutMs:number):Promise<boolean>{
    if(!this.alive)return Promise.resolve(true);
    return new Promise(resolve=>{
      const timer=setTimeout(()=>resolve(!this.alive),timeoutMs);
      this.onceExited(()=>{clearTimeout(timer);resolve(true)});
    });
  }

  detach(): void {
    this.onData = null;
    this.onExit = null;
  }

  write(data: Buffer): void {
    if (this.alive) this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.alive) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.proc.resize(cols, rows);
    } catch {
      /* the process exited between the check and the ioctl */
    }
  }

  kill(): void {
    if (!this.alive) return;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }

  toWire(): PtySessionWire {
    return {
      id: this.id,
      sandboxId: this.sandboxId,
      cols: this.cols,
      rows: this.rows,
      alive: this.alive,
      createdAt: this.createdAt,
    };
  }
}

export class PtyRegistry {
  private readonly sessions = new Map<string, PtySession>();

  open(sandboxId: string, spawn: PtySpawn): PtySession {
    const session = new PtySession(sandboxId, spawn, (s) => {
      // Dead sessions are dropped only after the client has been told, so a reattach that
      // races the exit still learns the exit code.
      setTimeout(() => this.sessions.delete(s.id), 60_000).unref();
    });
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): PtySession | null {
    return this.sessions.get(id) ?? null;
  }

  listFor(sandboxId: string): PtySession[] {
    return [...this.sessions.values()].filter((s) => s.sandboxId === sandboxId);
  }

  aliveCount(): number {
    let n = 0;
    for (const session of this.sessions.values()) if (session.alive) n += 1;
    return n;
  }

  killAll(sandboxId: string): void {
    for (const session of this.listFor(sandboxId)) {
      session.kill();
      this.sessions.delete(session.id);
    }
  }

  signalKillAllForVerification(sandboxId:string):PtySession[]{
    const sessions=this.listFor(sandboxId);for(const session of sessions)session.kill();return sessions;
  }
  async verifyExited(sessions:PtySession[],timeoutMs:number):Promise<void>{
    const exited=await Promise.all(sessions.map(session=>session.waitForExit(timeoutMs)));
    if(exited.some(value=>!value))throw new Error("PTY host process did not exit");
    for(const session of sessions)this.sessions.delete(session.id);
  }
}
