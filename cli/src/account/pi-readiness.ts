/** Enforce exact launcher/pod Pi lockstep before classic's unversioned RPC surface is used. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { verifyHello, verifyHelloEnvelope } from "../client/compat.js";
import { bundledPiVersion, comparePiVersions, installedPiPackage } from "../client/piversion.js";
import type { ShimHello } from "../client/protocol.js";
import { PiPodError } from "../errors.js";
import { info } from "../log.js";
import { SEND_MAX_BYTES, type SendEntry } from "../send.js";
import { shellQuote } from "./workspace-seed.js";
import type { AccountClient, ApiPod } from "./api.js";

const execFileAsync = promisify(execFile);

/** Base64 JSON overhead stays below the server's existing 24 MB decoded send bound. */
export const PI_DELIVERY_CHUNK_BYTES = Math.floor(SEND_MAX_BYTES * 2 / 3);
const INSTALL_ROOT = "/opt/pi-pod/pi";

export interface PiDeliveryArchive {
  version: string;
  /** Package-declared executable, relative to the archived package root. */
  bin: string;
  digest: string;
  chunks: Buffer[];
  cleanup(): void;
}

/** Tar only the package this process imported, including its package-local node_modules. */
export async function createPiDeliveryArchive(): Promise<PiDeliveryArchive> {
  const installed = installedPiPackage();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-pi-"));
  const archive = path.join(tempDir, "pi.tar.gz");
  try {
    await execFileAsync("tar", ["-czf", archive, "-C", installed.root, "."]);
    const bytes = fs.readFileSync(archive);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += PI_DELIVERY_CHUNK_BYTES) {
      chunks.push(bytes.subarray(offset, Math.min(offset + PI_DELIVERY_CHUNK_BYTES, bytes.length)));
    }
    if (chunks.length === 0) chunks.push(Buffer.alloc(0));
    return {
      version: installed.version,
      bin: installed.bin,
      digest: createHash("sha256").update(bytes).digest("hex"),
      chunks,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function buildPiInstallCommand(input: {
  version: string;
  bin: string;
  digest: string;
  chunkPaths: string[];
  workdir: string;
}): string {
  const normalizedBin = path.posix.normalize(input.bin);
  if (path.posix.isAbsolute(normalizedBin) || normalizedBin === ".." || normalizedBin.startsWith("../")) {
    throw new Error("the bundled pi executable must stay inside its package root");
  }
  const version = shellQuote(input.version);
  const targetPath = `${INSTALL_ROOT}/${input.version}`;
  const target = shellQuote(targetPath);
  const targetBin = shellQuote(path.posix.join(targetPath, normalizedBin));
  const archive = shellQuote(path.posix.join(input.workdir, `.pi-pod-pi-${input.version}.tar.gz`));
  const chunks = input.chunkPaths.map(shellQuote);
  const chunkList = chunks.join(" ");
  return [
    "set -euo pipefail",
    `# pi-pod-install-version: ${input.version}`,
    "umask 022",
    `archive=${archive}`,
    `target=${target}`,
    'stage=""',
    'linktmp="/usr/local/bin/.pi-pod-pi.$$"',
    `cleanup() { rm -f "$archive" "$linktmp" ${chunkList}; if [ -n "$stage" ]; then rm -rf "$stage"; fi; }`,
    "trap cleanup EXIT",
    `cat ${chunkList} > "$archive"`,
    `printf '%s  %s\\n' ${shellQuote(input.digest)} "$archive" | sha256sum -c - >/dev/null`,
    `mkdir -p ${shellQuote(INSTALL_ROOT)}`,
    'if [ ! -d "$target" ]; then',
    `  stage="$(mktemp -d ${shellQuote(`${INSTALL_ROOT}/.${input.version}.XXXXXX`)})"`,
    '  tar -xzf "$archive" -C "$stage"',
    `  test "$(node "$stage"/${shellQuote(normalizedBin)} --version)" = ${version}`,
    `  chmod 0755 "$stage"/${shellQuote(normalizedBin)}`,
    '  mv -T "$stage" "$target"',
    '  stage=""',
    "fi",
    `test "$(node ${targetBin} --version)" = ${version}`,
    `ln -s ${targetBin} "$linktmp"`,
    'mv -Tf "$linktmp" /usr/local/bin/pi',
    `test "$(/usr/local/bin/pi --version)" = ${version}`,
  ].join("\n");
}

interface ReadinessState {
  isStreaming: boolean;
  isCompacting: boolean;
}

interface ReadinessRpc {
  readonly helloInfo: ShimHello | null;
  readonly podId: string;
  /** Gateway's own pi pin. Null when the server omitted it (older gateways). */
  readonly serverPiVersion: string | null;
  readinessGetState(): Promise<ReadinessState>;
  readinessBash(command: string): Promise<unknown>;
  restartAfterStop(stop: () => Promise<void>): Promise<ShimHello>;
  close(): void;
}

export interface EnsureExactPiOptions {
  client: Pick<AccountClient, "request" | "podCommand">;
  pod: { id: string; connection?: ApiPod["connection"]; resolvedConfig: { workdir?: string } };
  rpc: ReadinessRpc;
  interactive: boolean;
  approve?: (question: string) => Promise<boolean>;
  createArchive?: () => Promise<PiDeliveryArchive>;
}

function refusalHint(): string {
  return "wait for the current session to become idle and attach again, or start a fresh pod on the current image without `--reuse`";
}

function failClosed(rpc: ReadinessRpc, message: string, cause?: unknown): never {
  rpc.close();
  throw new PiPodError(message, {
    hint: updateFailureHint(cause),
    ...(cause !== undefined ? { cause } : {}),
  });
}

function updateFailureHint(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  if (/version skew/i.test(message)) {
    return "this launcher is newer than the server; attach again after the server is upgraded — retrying will not help";
  }
  if (cause instanceof PiPodError && cause.hint) return cause.hint;
  return "the skewed session was detached; retry attach, or start a fresh pod on the current image without `--reuse`";
}

/** True when installing this launcher's pi would make the pod newer than the gateway's pin. */
function cannotUpgradePodToLauncherPin(bundled: string, serverPi: string | null): boolean {
  if (serverPi === null) return true;
  const order = comparePiVersions(bundled, serverPi);
  return order === null || order > 0;
}

function throwUnsafeUpgrade(
  rpc: ReadinessRpc,
  bundled: string,
  serverPi: string | null,
  podPi: string,
): never {
  rpc.close();
  const message = serverPi
    ? `this pi pod bundles pi ${bundled}; the server runs pi ${serverPi}`
    : `this pi pod bundles pi ${bundled}; the pod runs pi ${podPi}`;
  throw new PiPodError(message, {
    hint: "this launcher is newer than the server; attach again after the server is upgraded — the pod was not changed",
  });
}

function isRetryablePiUpdateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !/version skew|server runs pi|did not report its pi pin/i.test(message);
}

function updateWouldDisturb(_connection: ApiPod["connection"], state: ReadinessState): boolean {
  // ApiPod.connection describes the server↔pod gateway lease, not attached user clients;
  // a fresh launch may already report connected. Only observable live work needs approval.
  return state.isStreaming || state.isCompacting;
}

async function deliverArchive(
  opts: EnsureExactPiOptions,
  archive: PiDeliveryArchive,
): Promise<void> {
  const workdir = opts.pod.resolvedConfig.workdir ?? "/workspace";
  const nonce = randomUUID();
  const names = archive.chunks.map((_, index) => `.pi-pod-pi-${nonce}.part-${String(index).padStart(3, "0")}`);
  const remotePaths = names.map((name) => path.posix.join(workdir, name));
  try {
    for (let index = 0; index < archive.chunks.length; index += 1) {
      const entry: SendEntry = {
        relPath: names[index]!,
        kind: "file",
        contents: archive.chunks[index]!.toString("base64"),
        mode: 0o600,
      };
      await opts.client.request(`/pods/${opts.pod.id}/files`, { method: "POST", body: { entries: [entry] } });
    }
    await opts.rpc.readinessBash(
      buildPiInstallCommand({
        version: archive.version,
        bin: archive.bin,
        digest: archive.digest,
        chunkPaths: remotePaths,
        workdir,
      }),
    );
  } catch (error) {
    const cleanup = `rm -f ${remotePaths.map(shellQuote).join(" ")}`;
    try {
      await opts.rpc.readinessBash(cleanup);
    } catch {
      // The session may already be gone; the next successful install uses unique names.
    }
    throw error;
  }
}

/** Return only after this same RPC client has adopted an exact replacement hello. */
export async function ensureExactPi(opts: EnsureExactPiOptions): Promise<void> {
  const hello = opts.rpc.helloInfo;
  if (!hello) failClosed(opts.rpc, "the server session carried no pod handshake");
  verifyHelloEnvelope(hello, { close: () => opts.rpc.close() });

  const bundled = bundledPiVersion();
  if (hello.piVersion === bundled) {
    verifyHello(hello, { close: () => opts.rpc.close() });
    return;
  }

  const comparison = comparePiVersions(hello.piVersion, bundled);
  if (comparison === null) {
    failClosed(opts.rpc, `the pod reported an unknown or malformed pi version (${hello.piVersion})`);
  }
  if (comparison > 0) {
    opts.rpc.close();
    throw new PiPodError("pi version skew: the pod runs a newer pi than this launcher", {
      hint: "run `pipod update`, then attach again — the pod will not be downgraded",
    });
  }

  // The gateway refuses pods newer than *its* pin. Installing this launcher's pi is only
  // safe when that pin is known and at least as new as we are about to install.
  if (cannotUpgradePodToLauncherPin(bundled, opts.rpc.serverPiVersion)) {
    throwUnsafeUpgrade(opts.rpc, bundled, opts.rpc.serverPiVersion, hello.piVersion);
  }

  const state = await opts.rpc.readinessGetState();
  if (updateWouldDisturb(opts.pod.connection, state)) {
    if (!opts.interactive) {
      opts.rpc.close();
      throw new PiPodError("updating pi would interrupt a live pod session", { hint: refusalHint() });
    }
    const approved = await opts.approve?.(
      `pod pi ${hello.piVersion} must update to ${bundled}; another client or active turn may be interrupted. Continue?`,
    );
    if (!approved) {
      opts.rpc.close();
      throw new PiPodError("pi update declined; the skewed session was detached", { hint: refusalHint() });
    }
  }

  info(`updating pi in pod ${hello.piVersion} → ${bundled}`);
  const createArchive = opts.createArchive ?? createPiDeliveryArchive;
  let archive: PiDeliveryArchive;
  try {
    archive = await createArchive();
  } catch (error) {
    failClosed(opts.rpc, `could not prepare bundled pi for the pod: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  if (archive.version !== bundled) {
    archive.cleanup();
    failClosed(opts.rpc, "the prepared pi bundle does not match this launcher's installed pi");
  }

  try {
    const attempts = opts.interactive ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await deliverArchive(opts, archive);
        const replacement = await opts.rpc.restartAfterStop(async () => {
          await opts.client.podCommand(opts.pod.id, "stop");
        });
        verifyHello(replacement, { close: () => opts.rpc.close() });
        return;
      } catch (error) {
        if (attempt === attempts || !isRetryablePiUpdateError(error)) throw error;
        const retry = await opts.approve?.(
          `pi update failed (${error instanceof Error ? error.message : String(error)}). Retry once?`,
        );
        if (!retry) throw error;
      }
    }
  } catch (error) {
    failClosed(opts.rpc, `could not update pi in the pod: ${error instanceof Error ? error.message : String(error)}`, error);
  } finally {
    archive.cleanup();
  }
}
