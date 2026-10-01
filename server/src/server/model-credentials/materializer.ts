/**
 * Compatibility adapter: a sanitized credential lease becomes the pod's `auth.json`.
 *
 * Brokered providers overwrite matching local keys unconditionally. Keys that are not in
 * the lease survive so a pod-local `/login` for an unsupported provider is not erased.
 * Account OAuth refresh tokens never land on disk; Claude credential files are not written.
 * Entry values are never logged.
 */
import { POD_PI_AGENT_DIR } from "../../core/hostconfig.js";
import type { Sandbox } from "../../core/providers/types.js";
import { query } from "../db/index.js";
import { sanitizeCredentialEntry } from "./store.js";
import type { CredentialLease } from "./types.js";

const POD_PI_AUTH_PATH = `${POD_PI_AGENT_DIR}/auth.json`;
const TMP_AUTH_PATH = "/tmp/pi-pod-auth.json";

function normalizeCredentialProviders(providers: readonly string[] | null | undefined): string[] {
  return [...new Set((providers ?? []).filter((id) => typeof id === "string" && id.length > 0))].sort();
}

function parseLocalAuth(output: string | undefined): Record<string, unknown> {
  if (!output) return {};
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Merge `lease.providers` over the sandbox `auth.json` and replace the file atomically
 * (upload tmp mode 0600, mkdir, mv, chmod 600). Missing or unreadable local files start as `{}`.
 */
export async function materializeCredentialLease(
  sandbox: Sandbox,
  lease: CredentialLease,
  env?: Record<string, string>,
): Promise<void> {
  const execOpts = { env, timeoutMs: 30_000 };
  const read = await sandbox.exec(["cat", POD_PI_AUTH_PATH], execOpts);
  const local =
    read.exitCode === 0 ? parseLocalAuth(read.output) : {};

  const merged: Record<string, unknown> = { ...local };
  for (const [providerId, item] of Object.entries(lease.providers)) {
    merged[providerId] = sanitizeCredentialEntry(item.entry);
  }

  const contents = `${JSON.stringify(merged, null, 2)}\n`;
  await sandbox.uploadFile(TMP_AUTH_PATH, new TextEncoder().encode(contents), 0o600);
  const res = await sandbox.exec(
    ["bash", "-c", `mkdir -p ${POD_PI_AGENT_DIR} && mv ${TMP_AUTH_PATH} ${POD_PI_AUTH_PATH} && chmod 600 ${POD_PI_AUTH_PATH}`],
    execOpts,
  );
  if (res.exitCode !== 0) throw new Error("failed to materialize the credential lease into the pod");
}

/** Persist the server-maintained authorized provider set. Pod tokens never write this column. */
export async function persistPodCredentialContract(podId: string, providers: string[]): Promise<void> {
  await query(`UPDATE pods SET credential_providers = $2, updated_at = now() WHERE id = $1`, [
    podId,
    normalizeCredentialProviders(providers),
  ]);
}

/** Normalize a loaded pod row's contract (null/empty → `[]`, unique, sorted). */
export async function readPodCredentialContract(pod: {
  credential_providers?: string[] | null;
  id: string;
}): Promise<string[]> {
  return normalizeCredentialProviders(pod.credential_providers);
}
