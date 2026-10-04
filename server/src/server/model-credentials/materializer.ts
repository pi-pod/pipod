/**
 * Compatibility adapter: a sanitized credential lease becomes the pod's `auth.json`.
 *
 * Brokered providers overwrite matching local keys unconditionally. A key the previous lease
 * wrote and this one omits is removed: the account credential was removed, revoked or
 * dropped from the pod's contract. Every other key survives, so a pod-local `/login` for an
 * unsupported provider is not erased. {@link POD_LEASED_PROVIDERS_PATH} records which keys
 * the last lease wrote; the pod's lease poll (`core/shim/pi-pod-ext.ts`) applies the same rule.
 * Account OAuth refresh tokens never land on disk; Claude credential files are not written.
 * Entry values are never logged.
 */
import { POD_LEASED_PROVIDERS_PATH, POD_PI_AGENT_DIR } from "../../core/hostconfig.js";
import type { Sandbox } from "../../core/providers/types.js";
import { shellQuote } from "../../core/providers/util.js";
import { query } from "../db/index.js";
import { capabilityOf, pinnedPiProviders } from "./dependencies.js";
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
 * Providers whose `auth.json` keys the previous lease owns. A pod written before
 * `pipod-leased.json` existed has no record; then every contracted provider the broker can
 * supply was lease-written, because only unsupported providers log in pod-locally.
 */
async function previouslyLeased(record: string | undefined, scope: readonly string[] = []): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(record ?? "");
    const providers = (parsed as { providers?: unknown } | null)?.providers;
    if (Array.isArray(providers)) return providers.filter((id): id is string => typeof id === "string");
  } catch {
    // no record yet
  }
  if (scope.length === 0) return [];
  const pinned = await pinnedPiProviders();
  return scope.filter((id) => capabilityOf(pinned.get(id)).supported);
}

/**
 * Apply `lease` to the sandbox `auth.json` — set its providers, remove the ones the previous
 * lease wrote that it omits — and replace the file atomically (upload tmp mode 0600, mkdir,
 * mv, chmod 600), then record the providers written. Missing or unreadable local files start
 * as `{}`.
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
  const recorded = await sandbox.exec(["cat", POD_LEASED_PROVIDERS_PATH], execOpts);

  const merged: Record<string, unknown> = { ...local };
  for (const providerId of await previouslyLeased(recorded.exitCode === 0 ? recorded.output : undefined, lease.scope)) {
    if (!Object.hasOwn(lease.providers, providerId)) delete merged[providerId];
  }
  for (const [providerId, item] of Object.entries(lease.providers)) {
    merged[providerId] = sanitizeCredentialEntry(item.entry);
  }

  const contents = `${JSON.stringify(merged, null, 2)}\n`;
  await sandbox.uploadFile(TMP_AUTH_PATH, new TextEncoder().encode(contents), 0o600);
  // The record holds provider ids, never values, so it travels in the command. It is written
  // after auth.json: a pass interrupted between the two leaves the old record, and the next
  // pass removes the same keys again.
  const record = JSON.stringify({ providers: Object.keys(lease.providers).sort() });
  const res = await sandbox.exec(
    ["bash", "-c", `mkdir -p ${POD_PI_AGENT_DIR} && mv ${TMP_AUTH_PATH} ${POD_PI_AUTH_PATH} && chmod 600 ${POD_PI_AUTH_PATH} && printf '%s\\n' ${shellQuote(record)} > ${POD_LEASED_PROVIDERS_PATH}.tmp && mv ${POD_LEASED_PROVIDERS_PATH}.tmp ${POD_LEASED_PROVIDERS_PATH}`],
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
