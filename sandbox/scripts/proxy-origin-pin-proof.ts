/**
 * MANUAL LOCAL two-origin synthetic-token network demonstration.
 *
 * Uses the ACTUAL production module (`createPinnedProxyStore` +
 * `writeProxyBindingAtomic`, same code `createObjectStore` uses) against two
 * locally spawned stub origins. No mocks, no real secrets, no external network.
 *
 * Run: `node --import tsx scripts/proxy-origin-pin-proof.ts --out-dir <new-empty-dir>`
 *   --out-dir must NOT exist (refusing to overwrite prior receipts); it is
 *   created 0700. Without --out-dir, a mkdtemp dir under os.tmpdir() is used.
 *   --fail-after-first-spawn is a test-only hook: it throws right after the
 *   first child is recorded, proving cleanup leaves zero owned children.
 * Every file inside the run dir is created 0700/0600 with no-clobber flags.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPinnedProxyStore, writeProxyBindingAtomic } from "../src/archive/proxy-origin-pin.js";

const HOST = "box-proofhost";
const TOKEN = "synthetic-proof-token-0123456789abcdef";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_FILE = path.join(here, "proxy-origin-pin-proof-server.mjs");

interface OwnedChild {
  child: ChildProcess;
  pid: number;
  start: string | null;
  label: string;
}

function procStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 is starttime (after comm which may contain spaces/parens).
    const end = stat.lastIndexOf(")");
    const after = stat.slice(end + 2).split(" ");
    // after[0] is state, ..., starttime is index 19 (0-based) after comm.
    return after[19] ?? null;
  } catch {
    return null;
  }
}

function procPpid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const after = stat.slice(end + 2).split(" ");
    return Number(after[1]);
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): { outDir: string | null; failAfterFirstSpawn: boolean } {
  let outDir: string | null = null;
  let failAfterFirstSpawn = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--out-dir needs a value");
      outDir = value;
      i++;
    } else if (argv[i] === "--fail-after-first-spawn") {
      failAfterFirstSpawn = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]} (usage: --out-dir <new-dir> [--fail-after-first-spawn])`);
    }
  }
  return { outDir, failAfterFirstSpawn };
}

function waitForReady(child: ChildProcess, label: string, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`${label} READY timeout`)), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((l) => l.startsWith("READY "));
      if (line) {
        clearTimeout(timer);
        const payload = JSON.parse(line.slice("READY ".length)) as { port: number };
        resolve(payload.port);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${label} stderr] ${chunk.toString()}`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited before READY (code ${code})`));
    });
  });
}

async function fetchCounts(origin: string): Promise<number> {
  const res = await fetch(`${origin}/__counts`);
  const body = (await res.json()) as { hits: number };
  return body.hits;
}

async function main(): Promise<void> {
  const { outDir, failAfterFirstSpawn } = parseArgs(process.argv.slice(2));
  // Exclusive run dir: must-not-exist (no receipt clobbering) or fresh mkdtemp.
  let proofDir: string;
  if (outDir !== null) {
    proofDir = path.resolve(outDir);
    try {
      await mkdir(proofDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`refusing to overwrite existing --out-dir: ${proofDir}`);
      }
      throw error;
    }
    await chmod(proofDir, 0o700);
  } else {
    proofDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "proxy-pin-proof-"));
    await chmod(proofDir, 0o700);
  }
  const stateDir = path.join(proofDir, "state");
  await mkdir(stateDir, { mode: 0o700 });
  await chmod(stateDir, 0o700);

  const env = { ...process.env, PROOF_HOST: HOST, PROOF_TOKEN: TOKEN };
  const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
  // Every spawned child is recorded IMMEDIATELY in `owned`, and the whole body
  // below (including receipt writes) runs inside try/finally over `owned` —
  // so even a throw between spawn #1 and spawn #2, or a receipt-write failure,
  // still terminates every owned child. No orphans, no broad pkill.
  const owned: OwnedChild[] = [];
  const spawnOrigin = (label: string): ChildProcess => {
    const child = spawn("node", [SERVER_FILE], { env, stdio });
    if (child.pid === undefined) throw new Error(`failed to spawn ${label}`);
    const entry: OwnedChild = { child, pid: child.pid, start: null, label };
    owned.push(entry);
    entry.start = procStartTime(entry.pid);
    console.log(`${label} child pid=${entry.pid} starttime=${entry.start} ppid=${procPpid(entry.pid)} (parent ${process.pid})`);
    return child;
  };
  const finish = async (entry: OwnedChild, signal: "SIGTERM" | "SIGKILL"): Promise<void> => {
    // Revalidate ownership before EVERY termination/escalation: same kernel
    // starttime (when receipted) plus direct-child ppid. A null starttime
    // (receipt read failed) still kills on ppid match — never orphans.
    const current = procStartTime(entry.pid);
    const ppid = procPpid(entry.pid);
    if (entry.start !== null && current !== entry.start) {
      throw new Error(`${entry.label}: pid ${entry.pid} starttime changed; refusing to signal (pid reuse?)`);
    }
    if (ppid !== process.pid) {
      throw new Error(`${entry.label}: pid ${entry.pid} ppid ${ppid} is not this process; refusing to signal`);
    }
    entry.child.kill(signal);
  };
  const drain = (entry: OwnedChild): Promise<void> =>
    new Promise((resolve) => {
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => resolve(), 5000);
      entry.child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  const stopAll = async (signal: "SIGTERM" | "SIGKILL"): Promise<void> => {
    for (const entry of owned) {
      try {
        await finish(entry, signal);
      } catch (error) {
        console.error(`stop ${entry.label}: ${String(error)}`);
      }
    }
    await Promise.all(owned.map(drain));
  };

  try {
    const childA = spawnOrigin("originA");
    if (failAfterFirstSpawn) throw new Error("test hook: failing after first spawn");
    const childB = spawnOrigin("originB");
    const pidA = childA.pid!;
    const pidB = childB.pid!;
    const startA = owned[0]!.start;
    const startB = owned[1]!.start;
    if (!startA || !startB) throw new Error("could not read kernel starttime receipts");
    await writeFile(
      path.join(proofDir, "pids.json"),
      JSON.stringify({ pidA, startA, pidB, startB, parent: process.pid }, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );

    const portA = await waitForReady(childA, "originA");
    const portB = await waitForReady(childB, "originB");
    const originA = `http://127.0.0.1:${portA}`;
    const originB = `http://127.0.0.1:${portB}`;
    console.log(`originA=${originA} originB=${originB}`);
    if (originA === originB) throw new Error("origins must differ");

    // Pin to origin A via the production atomic writer (factory contract bytes).
    await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: originA });
    await chmod(path.join(stateDir, "archive-proxy-binding.json"), 0o600);

    // Known-good roundtrip through the PRODUCTION pinned module.
    const good = createPinnedProxyStore({ stateDir, hostId: HOST, url: originA, token: TOKEN, timeoutMs: 30_000 });
    const contents = randomBytes(32 * 1024);
    const sha = createHash("sha256").update(contents).digest("hex");
    const key = `pod-1/upper-${sha}.tar.zst`;
    const source = path.join(stateDir, "source.tar.zst");
    await writeFile(source, contents, { mode: 0o600, flag: "wx" });
    await good.put(key, source, { sha256: sha });
    const head = await good.head(key);
    if (head?.size !== contents.length) throw new Error("HEAD size mismatch on origin A");
    const dest = path.join(stateDir, "restored.tar.zst");
    await good.get(key, dest);
    if (!(await readFile(dest)).equals(contents)) throw new Error("GET bytes mismatch on origin A");
    const listed = await good.list("pod-1/");
    if (!listed.some((e) => e.key === key)) throw new Error("LIST missing key on origin A");

    const originalOriginCount = await fetchCounts(originA);
    const driftedOriginCountBefore = await fetchCounts(originB);
    console.log(`after roundtrip: originalOriginCount=${originalOriginCount} driftedOriginCount=${driftedOriginCountBefore}`);
    if (originalOriginCount <= 0) throw new Error("expected production traffic on origin A");
    if (driftedOriginCountBefore !== 0) throw new Error("unexpected egress to drifted origin before drift");

    // Drift: env points at B while the binding still pins A. Construction must
    // fail closed with zero egress to either origin.
    let driftConstructionBlocked = false;
    try {
      createPinnedProxyStore({ stateDir, hostId: HOST, url: originB, token: TOKEN, timeoutMs: 30_000 });
    } catch (error) {
      if (String(error).includes("archive_proxy_origin_mismatch")) driftConstructionBlocked = true;
      else throw error;
    }
    if (!driftConstructionBlocked) throw new Error("drifted construction was not blocked");

    // Per-method blocking with zero egress: build a store pinned to B, then
    // swap the binding back to A so its env (B) mismatches at call time.
    await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: originB });
    const drifted = createPinnedProxyStore({ stateDir, hostId: HOST, url: originB, token: TOKEN, timeoutMs: 30_000 });
    await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: originA });
    const methods: Array<[string, () => Promise<unknown>]> = [
      ["put", () => drifted.put(key, source)],
      ["get", () => drifted.get(key, path.join(stateDir, "blocked-out.bin"))],
      ["head", () => drifted.head(key)],
      ["list", () => drifted.list("pod-1/")],
      ["delete", () => drifted.delete(key)],
    ];
    for (const [name, fn] of methods) {
      let blocked = false;
      try {
        await fn();
      } catch (error) {
        if (String(error).includes("archive_proxy_origin_mismatch")) blocked = true;
        else throw new Error(`drifted ${name} threw unexpected error: ${String(error)}`);
      }
      if (!blocked) throw new Error(`drifted ${name} was not blocked`);
      const message: string = await fn().then(
        () => "",
        (e: unknown) => String(e),
      );
      if (message.includes(TOKEN) || message.includes(originB) || message.includes(originA)) {
        throw new Error(`drifted ${name} error leaks URL/token`);
      }
    }
    const midA = await fetchCounts(originA);
    const midB = await fetchCounts(originB);
    console.log(`after drifted attempts: originA=${midA} originB=${midB}`);
    if (midB !== 0) throw new Error(`unexpected egress to drifted origin: ${midB}`);
    if (midA !== originalOriginCount) throw new Error(`unexpected egress on mismatch: A ${originalOriginCount} -> ${midA}`);

    // Deletion check: drifted delete blocked (object survives), pinned delete works.
    const stillThere = await good.head(key);
    if (stillThere?.size !== contents.length) throw new Error("object should survive blocked deletes");
    await good.delete(key);
    if ((await good.head(key)) !== null) throw new Error("pinned delete should remove the object");
    const finalA = await fetchCounts(originA);
    const finalB = await fetchCounts(originB);
    console.log(`after deletion check: originalOriginCount=${finalA} driftedOriginCount=${finalB}`);

    const result = {
      dateUtc: new Date().toISOString(),
      host: HOST,
      tokenKind: "synthetic-test-only",
      originA,
      originB,
      originalOriginCount: finalA,
      driftedOriginCount: finalB,
      driftConstructionBlocked,
      driftedMethodsBlocked: ["put", "get", "head", "list", "delete"],
      deletionCheck: "drifted delete blocked; pinned delete removed the object; HEAD null afterwards",
      egressVerdict: finalB === 0 ? "zero unexpected egress to drifted origin" : "UNEXPECTED EGRESS",
      pids: { pidA, startA, pidB, startB },
    };
    if (finalB !== 0) throw new Error("manual proof failed: drifted origin saw production traffic");
    await writeFile(path.join(proofDir, "proof.json"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log("MANUAL PROOF PASS", JSON.stringify({ originalOriginCount: finalA, driftedOriginCount: finalB }));
  } finally {
    // Stop: revalidate ownership per child, SIGTERM, escalate only after
    // revalidation, drain. Covers every recorded child however we got here.
    await stopAll("SIGTERM");
    const lingering = owned.filter((e) => e.child.exitCode === null && e.child.signalCode === null);
    if (lingering.length > 0) await stopAll("SIGKILL");
    for (const entry of owned) {
      console.log(
        `${entry.label} pid=${entry.pid} exit=${entry.child.exitCode} signal=${entry.child.signalCode}`,
      );
    }
  }
}

await main();
