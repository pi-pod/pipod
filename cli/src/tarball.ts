/**
 * Streaming POSIX ustar+gzip writer used to seed a pod workspace.
 *
 * Hand-rolled so we can stream (never buffer a whole file), enforce compressed /
 * uncompressed / entry caps as bytes come out, rewrite `.git/config` remote URLs,
 * and skip escaping/absolute/special entries without adding a tar dependency.
 *
 * Uncompressed accounting is every 512-byte header (including PAX) plus file
 * content padded to 512-byte blocks, plus the two trailing EOF blocks.
 */
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { finished } from "node:stream/promises";
import * as zlib from "node:zlib";
import { CancelledError, PiPodError } from "./errors.js";
import { walkTree, type WalkEntry } from "./send.js";

const BLOCK = 512;
const USTAR_NAME = 100;
const USTAR_PREFIX = 155;
const USTAR_LINK = 100;
/** 11 octal digits overflow at 8 GiB; store those sizes in a PAX `size` record. */
const USTAR_MAX_SIZE = 0o100000000000;
const PROGRESS_BYTES = 8 * 1024 * 1024;
const MiB = 1024 * 1024;

export interface TarballLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
}

/** 256 MiB gzip output, 2 GiB uncompressed headers+padding, 200_000 tar members. */
export const DEFAULT_TARBALL_LIMITS: TarballLimits = {
  maxCompressedBytes: 256 * MiB,
  maxUncompressedBytes: 2 * 1024 * MiB,
  maxEntries: 200_000,
};

export type TarballSkipReason =
  | "special-file"
  | "absolute-symlink"
  | "escaping-symlink"
  | "symlink"
  | "output-file"
  | "unreadable";

export interface TarballSkip {
  relPath: string;
  reason: TarballSkipReason;
}

export interface CreateTarballOptions {
  /** Directory whose CONTENTS become the archive root (entries are "src/app.ts", never "./x"). */
  root: string;
  /** Destination .tar.gz path. Created with mode 0o600. Parent dir must exist. */
  outputPath: string;
  /** Called per child with its name and root-relative POSIX path; true drops it and its subtree. */
  exclude?: (name: string, relPath: string) => boolean;
  /**
   * Include the top-level `.git` when it is a REAL directory (a `.git` FILE — linked
   * worktree / submodule — is always skipped). When included, `.git/config` contents
   * are rewritten through sanitizeGitConfig(). Default false.
   */
  includeGit?: boolean;
  /** Skip every symlink (pod-token callers; servers reject symlinks from them). Default false. */
  skipSymlinks?: boolean;
  limits?: Partial<TarballLimits>;
  /** Called periodically (at least every 256 entries or 8 MiB of file bytes) with running totals. */
  onProgress?: (progress: { entries: number; bytes: number }) => void;
  signal?: AbortSignal;
}

export interface TarballSummary {
  entries: number;
  bytes: number;
  compressedBytes: number;
  skipped: TarballSkip[];
  includedGit: boolean;
}

function formatMiB(bytes: number): string {
  return `${bytes / MiB} MiB`;
}

export class TarballLimitError extends PiPodError {
  readonly limit: "compressed" | "uncompressed" | "entries";

  constructor(limit: "compressed" | "uncompressed" | "entries", max: number) {
    super(
      limit === "entries"
        ? `archive exceeds the ${max} entry limit`
        : `archive exceeds the ${formatMiB(max)} ${limit} limit`,
      { hint: "narrow the tree or raise the seed archive cap" },
    );
    this.name = "TarballLimitError";
    this.limit = limit;
  }
}

/**
 * Strip userinfo (user:token@ or token@) from every `url` / `pushurl` / `proxy` value, and
 * drop `extraheader` lines that carry an Authorization header (the shape `actions/checkout`
 * and CI runners persist a token in). scp-style `git@host:path` has no scheme:// and is
 * left untouched. Everything else is copied byte-identical.
 */
export function sanitizeGitConfig(text: string): string {
  return text
    .replace(
      /(^|\n)([ \t]*(?:url|pushurl|proxy)[ \t]*=[ \t]*)([^\n]*)/gi,
      (_all, lead: string, prefix: string, value: string) => `${lead}${prefix}${stripUrlUserinfo(value)}`,
    )
    .replace(/^[ \t]*extraheader[ \t]*=[ \t]*(?:"[ \t]*)?authorization[ \t]*:[^\n]*(?:\n|$)/gim, "");
}

function stripUrlUserinfo(value: string): string {
  return value.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]+@/, "$1");
}

/**
 * Shared launch-time seed filter: drop `node_modules` at any depth, `.pi-pod/env`
 * at the archive root, git-ignored root-relative paths, and `.git` unless includeGit.
 *
 * `ignored` comes from `git ls-files --others --ignored --directory`, which names each
 * ignored file and the top-most ignored directory. An exact match is enough: the walker
 * never descends into an excluded directory, so nothing below it is ever asked about.
 */
export function seedExclusionRule(opts: {
  ignored: ReadonlySet<string>;
  includeGit: boolean;
}): (name: string, relPath: string) => boolean {
  const ignored = opts.ignored;
  return (name, relPath) => {
    if (name === "node_modules") return true;
    if (relPath === ".pi-pod/env") return true;
    if (!opts.includeGit && name === ".git") return true;
    return ignored.has(relPath);
  };
}

export async function createTarball(opts: CreateTarballOptions): Promise<TarballSummary> {
  if (opts.signal?.aborted) throw cancelled();

  const limits: TarballLimits = { ...DEFAULT_TARBALL_LIMITS, ...opts.limits };
  const includeGit = opts.includeGit === true;
  const rootReal = fs.realpathSync(opts.root);
  const outputPath = path.resolve(opts.outputPath);
  const outputReal = realpathForOutput(outputPath);
  const outputInsideRoot = isInsideDir(rootReal, outputReal);

  const exclude = (name: string, relPath: string): boolean => {
    if (opts.exclude?.(name, relPath)) return true;
    // Don't descend into `.git` when it will never be emitted.
    if (!includeGit && name === ".git") return true;
    return false;
  };

  let out: fs.WriteStream | undefined;
  let gzip: zlib.Gzip | undefined;
  let limiter: CompressedByteLimit | undefined;
  let success = false;
  const skipped: TarballSkip[] = [];

  try {
    out = fs.createWriteStream(outputPath, { flags: "w", mode: 0o600 });
    await once(out, "open");
    try {
      fs.chmodSync(outputPath, 0o600);
    } catch {
      /* mode is best-effort; umask already applied at create */
    }
    const outStat = fs.statSync(outputPath);

    gzip = zlib.createGzip();
    limiter = new CompressedByteLimit(limits.maxCompressedBytes);
    gzip.pipe(limiter).pipe(out);

    const sink = new TarGzipSink({ gzip, limiter, out, limits, signal: opts.signal });

    if (opts.signal) {
      const abort = (): void => sink.destroy(cancelled());
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }

    let entries = 0;
    let bytes = 0;
    let includedGit = false;

    const reportProgress = (): void => {
      if (opts.onProgress) {
        try {
          opts.onProgress({ entries, bytes });
        } catch {
          /* progress is advisory — a throwing callback must not abort the archive */
        }
      }
      sink.throwIfAborted();
    };

    const countEntry = (): void => {
      if (entries + 1 > limits.maxEntries) throw new TarballLimitError("entries", limits.maxEntries);
      entries += 1;
    };

    for (const entry of walkTree(rootReal, { relBase: "", exclude })) {
      sink.throwIfAborted();

      if (outputInsideRoot && sameOutputFile(entry, outStat, outputReal)) {
        skipped.push({ relPath: entry.relPath, reason: "output-file" });
        continue;
      }

      if (skipGitEntry(entry, includeGit)) continue;
      if (entry.relPath === ".git" && entry.kind === "dir") includedGit = true;

      if (entry.kind === "other") {
        skipped.push({ relPath: entry.relPath, reason: "special-file" });
        continue;
      }

      if (entry.kind === "symlink") {
        if (opts.skipSymlinks) {
          skipped.push({ relPath: entry.relPath, reason: "symlink" });
          continue;
        }
        let target: string;
        try {
          target = fs.readlinkSync(entry.absPath);
        } catch {
          skipped.push({ relPath: entry.relPath, reason: "unreadable" });
          continue;
        }
        const reason = symlinkSkipReason(entry.relPath, target);
        if (reason) {
          skipped.push({ relPath: entry.relPath, reason });
          continue;
        }
        countEntry();
        await sink.writeSymlink(entry, target);
        reportProgress();
        continue;
      }

      if (entry.kind === "dir") {
        countEntry();
        await sink.writeDirectory(entry);
        reportProgress();
        continue;
      }

      const sanitized = shouldSanitizeGitConfig(entry.relPath);
      if (sanitized) {
        let body: Buffer;
        try {
          body = Buffer.from(sanitizeGitConfig(fs.readFileSync(entry.absPath, "utf8")), "utf8");
        } catch {
          skipped.push({ relPath: entry.relPath, reason: "unreadable" });
          continue;
        }
        countEntry();
        await sink.writeBufferFile(entry, body);
        bytes += body.length;
        reportProgress();
        continue;
      }

      let stream: fs.ReadStream | undefined;
      const size = entry.stat.size;
      try {
        if (size > 0) {
          stream = fs.createReadStream(entry.absPath, { start: 0, end: size - 1 });
          await once(stream, "open");
        } else {
          fs.accessSync(entry.absPath, fs.constants.R_OK);
        }
      } catch {
        stream?.destroy();
        skipped.push({ relPath: entry.relPath, reason: "unreadable" });
        continue;
      }

      countEntry();
      await sink.writeFileHeader(entry, size);
      if (stream) {
        let copied = 0;
        await sink.copyFileStream(stream, size, (n) => {
          copied += n;
          if (Math.floor((copied - n) / PROGRESS_BYTES) !== Math.floor(copied / PROGRESS_BYTES)) {
            reportProgress();
          }
        });
      }
      bytes += size;
      reportProgress();
    }

    await sink.finish();
    success = true;
    const compressedBytes = fs.statSync(outputPath).size;
    return { entries, bytes, compressedBytes, skipped, includedGit };
  } catch (error) {
    if (opts.signal?.aborted) throw cancelled();
    throw error;
  } finally {
    if (!success) {
      gzip?.destroy();
      limiter?.destroy();
      out?.destroy();
      await Promise.allSettled([
        gzip ? finished(gzip).catch(() => undefined) : Promise.resolve(),
        limiter ? finished(limiter).catch(() => undefined) : Promise.resolve(),
        out ? finished(out).catch(() => undefined) : Promise.resolve(),
      ]);
      try {
        fs.unlinkSync(outputPath);
      } catch {
        /* gone, or never created */
      }
    }
  }
}

function cancelled(): CancelledError {
  return new CancelledError("cancelled");
}

function realpathForOutput(outputPath: string): string {
  try {
    return fs.realpathSync(outputPath);
  } catch {
    return path.join(fs.realpathSync(path.dirname(outputPath)), path.basename(outputPath));
  }
}

function isInsideDir(rootReal: string, fileReal: string): boolean {
  const rel = path.relative(rootReal, fileReal);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function sameOutputFile(entry: WalkEntry, outStat: fs.Stats, outputReal: string): boolean {
  if (entry.kind === "file" && entry.stat.dev === outStat.dev && entry.stat.ino === outStat.ino) return true;
  try {
    return entry.kind === "file" && fs.realpathSync(entry.absPath) === outputReal;
  } catch {
    return path.resolve(entry.absPath) === outputReal;
  }
}

/** Only the ROOT `.git` file is always skipped; nested `.git` dirs follow includeGit. */
function skipGitEntry(entry: WalkEntry, includeGit: boolean): boolean {
  const parts = entry.relPath.split("/");
  const idx = parts.indexOf(".git");
  if (idx === -1) return false;
  const isGitNode = idx === parts.length - 1;
  if (isGitNode && entry.kind !== "dir") return true;
  if (!includeGit) return true;
  return false;
}

function shouldSanitizeGitConfig(relPath: string): boolean {
  return relPath === ".git/config" || relPath.endsWith("/.git/config");
}

function symlinkSkipReason(relPath: string, target: string): TarballSkipReason | undefined {
  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) return "absolute-symlink";
  const dir = path.posix.dirname(relPath);
  const resolved = path.posix.normalize(path.posix.join(dir, target));
  if (resolved === ".." || resolved.startsWith("../")) return "escaping-symlink";
  return undefined;
}

class CompressedByteLimit extends Transform {
  bytes = 0;
  constructor(private readonly maxBytes: number) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new TarballLimitError("compressed", this.maxBytes));
      return;
    }
    callback(null, chunk);
  }
}

class TarGzipSink {
  private uncompressed = 0;
  private paxSeq = 0;
  private failed: Error | undefined;

  constructor(
    private readonly io: {
      gzip: zlib.Gzip;
      limiter: CompressedByteLimit;
      out: fs.WriteStream;
      limits: TarballLimits;
      signal?: AbortSignal;
    },
  ) {
    const fail = (err: Error): void => {
      this.failed = this.failed ?? err;
      if (!io.gzip.destroyed) io.gzip.destroy(err);
      if (!io.limiter.destroyed) io.limiter.destroy();
      if (!io.out.destroyed) io.out.destroy();
    };
    io.gzip.on("error", fail);
    io.limiter.on("error", fail);
    io.out.on("error", fail);
  }

  throwIfAborted(): void {
    if (this.io.signal?.aborted) throw cancelled();
    if (this.failed) throw this.failed;
  }

  destroy(err: Error): void {
    this.failed = this.failed ?? err;
    this.io.gzip.destroy(err);
    this.io.limiter.destroy();
    this.io.out.destroy();
  }

  async writeDirectory(entry: WalkEntry): Promise<void> {
    const name = tarDirName(entry.relPath);
    await this.writeMember({
      name,
      typeflag: "5",
      size: 0,
      mode: entry.stat.mode,
      mtime: mtimeSec(entry.stat),
      linkname: "",
    });
  }

  async writeSymlink(entry: WalkEntry, target: string): Promise<void> {
    await this.writeMember({
      name: entry.relPath,
      typeflag: "2",
      size: 0,
      mode: entry.stat.mode,
      mtime: mtimeSec(entry.stat),
      linkname: target,
    });
  }

  async writeFileHeader(entry: WalkEntry, size: number): Promise<void> {
    await this.writeMember({
      name: entry.relPath,
      typeflag: "0",
      size,
      mode: entry.stat.mode,
      mtime: mtimeSec(entry.stat),
      linkname: "",
    });
  }

  async writeBufferFile(entry: WalkEntry, body: Buffer): Promise<void> {
    await this.writeMember({
      name: entry.relPath,
      typeflag: "0",
      size: body.length,
      mode: entry.stat.mode,
      mtime: mtimeSec(entry.stat),
      linkname: "",
    });
    if (body.length > 0) await this.write(body);
    await this.padToBlock(body.length);
  }

  async copyFileStream(stream: fs.ReadStream, size: number, onBytes: (n: number) => void): Promise<void> {
    let remaining = size;
    try {
      for await (const chunk of stream) {
        this.throwIfAborted();
        if (remaining <= 0) break;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
        await this.write(slice);
        remaining -= slice.length;
        onBytes(slice.length);
      }
    } catch (error) {
      this.rethrowFatal(error);
      if (remaining > 0) {
        await this.write(Buffer.alloc(remaining));
        remaining = 0;
      }
    } finally {
      stream.destroy();
    }
    if (remaining > 0) await this.write(Buffer.alloc(remaining));
    await this.padToBlock(size);
  }

  async finish(): Promise<void> {
    try {
      await this.write(Buffer.alloc(BLOCK * 2));
      await new Promise<void>((resolve, reject) => {
        this.io.gzip.end((err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await finished(this.io.out);
    } catch (error) {
      this.rethrowFatal(error);
      throw error;
    }
    this.throwIfAborted();
  }

  private async writeMember(member: {
    name: string;
    typeflag: "0" | "2" | "5";
    size: number;
    mode: number;
    mtime: number;
    linkname: string;
  }): Promise<void> {
    const pax: Record<string, string> = {};
    if (needsPaxPath(member.name)) pax["path"] = member.name;
    if (member.linkname && needsPaxLink(member.linkname)) pax["linkpath"] = member.linkname;
    if (member.size >= USTAR_MAX_SIZE) pax["size"] = String(member.size);

    if (Object.keys(pax).length > 0) {
      const body = buildPaxBody(pax);
      this.paxSeq += 1;
      const paxName = `PaxHeader/${this.paxSeq}`;
      await this.write(
        encodeUstarHeader({
          name: paxName,
          prefix: "",
          typeflag: "x",
          size: body.length,
          mode: 0o644,
          mtime: member.mtime,
          linkname: "",
        }),
      );
      await this.write(body);
      await this.padToBlock(body.length);
    }

    const split = ustarNameFields(member.name);
    const link = member.linkname.length <= USTAR_LINK ? member.linkname : member.linkname.slice(0, USTAR_LINK);
    const ustarSize = member.size >= USTAR_MAX_SIZE ? 0 : member.size;
    await this.write(
      encodeUstarHeader({
        name: split.name,
        prefix: split.prefix,
        typeflag: member.typeflag,
        size: ustarSize,
        mode: member.mode,
        mtime: member.mtime,
        linkname: link,
      }),
    );
  }

  private async padToBlock(size: number): Promise<void> {
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad > 0) await this.write(Buffer.alloc(pad));
  }

  private rethrowFatal(error: unknown): void {
    if (this.io.signal?.aborted) throw cancelled();
    if (this.failed) throw this.failed;
    if (error instanceof TarballLimitError || error instanceof CancelledError) throw error;
  }

  private async write(data: Buffer): Promise<void> {
    this.throwIfAborted();
    if (data.length === 0) return;
    this.uncompressed += data.length;
    if (this.uncompressed > this.io.limits.maxUncompressedBytes) {
      throw new TarballLimitError("uncompressed", this.io.limits.maxUncompressedBytes);
    }
    await new Promise<void>((resolve, reject) => {
      const gzip = this.io.gzip;
      if (gzip.destroyed || gzip.writableEnded) {
        reject(this.failed ?? new Error("tar sink closed"));
        return;
      }
      const onError = (err: Error): void => reject(this.failed ?? err);
      gzip.once("error", onError);
      try {
        gzip.write(data, (err) => {
          gzip.off("error", onError);
          if (err) reject(this.failed ?? err);
          else if (this.failed) reject(this.failed);
          else resolve();
        });
      } catch (err) {
        gzip.off("error", onError);
        reject(this.failed ?? err);
      }
    });
    this.throwIfAborted();
  }
}

function tarDirName(relPath: string): string {
  return relPath.endsWith("/") ? relPath : `${relPath}/`;
}

function mtimeSec(stat: fs.Stats): number {
  return Math.max(0, Math.floor(stat.mtimeMs / 1000));
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if ((value.charCodeAt(i) ?? 0) > 127) return false;
  }
  return true;
}

function needsPaxPath(name: string): boolean {
  if (!isAscii(name)) return true;
  return splitUstarPath(name) === undefined;
}

function needsPaxLink(linkname: string): boolean {
  return !isAscii(linkname) || Buffer.byteLength(linkname, "utf8") > USTAR_LINK;
}

function splitUstarPath(name: string): { name: string; prefix: string } | undefined {
  if (name.length <= USTAR_NAME) return { name, prefix: "" };
  let slash = name.lastIndexOf("/");
  while (slash >= 0) {
    const prefix = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    if (prefix.length <= USTAR_PREFIX && rest.length <= USTAR_NAME && rest.length > 0) {
      return { name: rest, prefix };
    }
    slash = name.lastIndexOf("/", slash - 1);
  }
  return undefined;
}

function ustarNameFields(full: string): { name: string; prefix: string } {
  const split = splitUstarPath(full);
  if (split) return split;
  const ascii = full.replace(/[^\x20-\x7E]/g, "_");
  const truncated = ascii.length <= USTAR_NAME ? ascii : ascii.slice(ascii.length - USTAR_NAME);
  return { name: truncated || "entry", prefix: "" };
}

function paxRecord(keyword: string, value: string): Buffer {
  const payload = Buffer.from(`${keyword}=${value}\n`, "utf8");
  let digits = 1;
  for (;;) {
    const total = digits + 1 + payload.length;
    const lenStr = String(total);
    if (lenStr.length === digits) return Buffer.concat([Buffer.from(`${lenStr} `, "ascii"), payload]);
    digits = lenStr.length;
  }
}

function buildPaxBody(attrs: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [keyword, value] of Object.entries(attrs)) {
    parts.push(paxRecord(keyword, value));
  }
  return Buffer.concat(parts);
}

function writeOctal(buf: Buffer, offset: number, width: number, value: number): void {
  const n = Math.max(0, Math.floor(value));
  const digits = n.toString(8).padStart(width - 1, "0");
  if (digits.length > width - 1) {
    buf.fill(0x30, offset, offset + width - 1);
    buf[offset + width - 1] = 0;
    return;
  }
  buf.write(digits, offset, width - 1, "ascii");
  buf[offset + width - 1] = 0;
}

function setChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i] ?? 0;
  const oct = sum.toString(8).padStart(6, "0");
  header.write(oct, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

function encodeUstarHeader(opts: {
  name: string;
  prefix: string;
  typeflag: string;
  size: number;
  mode: number;
  mtime: number;
  linkname: string;
}): Buffer {
  const buf = Buffer.alloc(BLOCK);
  writeStringField(buf, 0, USTAR_NAME, opts.name);
  writeOctal(buf, 100, 8, opts.mode & 0o7777);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, opts.size);
  writeOctal(buf, 136, 12, opts.mtime);
  buf.write(opts.typeflag, 156, 1, "ascii");
  writeStringField(buf, 157, USTAR_LINK, opts.linkname);
  buf.write("ustar\0", 257, 6, "latin1");
  buf.write("00", 263, 2, "ascii");
  writeStringField(buf, 345, USTAR_PREFIX, opts.prefix);
  setChecksum(buf);
  return buf;
}

function writeStringField(buf: Buffer, offset: number, width: number, value: string): void {
  if (value.length === 0) return;
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(buf, offset, 0, Math.min(width, bytes.length));
}
