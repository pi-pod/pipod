import { createHash } from "node:crypto";
import { SandboxClient } from "../../core/providers/sandbox/client.js";
import { parseHostSandboxId } from "../../core/providers/host.js";
import { SandboxServiceProvider, resolveSandboxServiceUrl } from "../../core/providers/sandbox/index.js";
import type { SandboxProvider } from "../../core/providers/types.js";
import { query } from "../db/index.js";
import { badRequest, conflict, serviceUnavailable } from "../httperrors.js";
import { decryptSecret, encryptSecret, type KekProvider } from "../secrets/crypto.js";
import type { PodRow } from "./types.js";

export type BoatState = "provisioning" | "starting" | "running" | "stopping" | "stopped" | "error" | "unknown" | "deleting" | "deleted" | "superseded";
/** Live owner slot: not a vendor-delete tombstone and not a retained superseded source. */
export function occupiesLiveOwnerSlot(state: string | null | undefined): boolean {
  return state != null && state !== "deleted" && state !== "superseded";
}
export interface HostIdentity {
  id: string;
  owner_user_id: string | null;
  isolated_pod_id?: string | null;
  boat_id: string | null;
  boat_state: BoatState | null;
  url: string | null;
  hosted_url: string | null;
  generation: string | number;
  runtime_boot_id?: string | null;
  auth_ciphertext: Buffer | null;
  auth_key_id: string | null;
  auth_encryption_version: number | null;
}
export interface HostAuth { runtimeToken: string; hostedToken?: string }
export function hostCanDial(host: Pick<HostIdentity, "boat_state">): boolean {
  return host.boat_state == null || host.boat_state === "running";
}
/** Personal Boat sleep clients may be told about as 4420 host_stopped. Static, unknown, error, and deleted stay out. */
export function personalBoatHostIsAsleep(
  host: Pick<HostIdentity, "owner_user_id" | "boat_id"> & { boat_state: string | null },
): boolean {
  return host.owner_user_id != null && host.boat_id != null && (host.boat_state === "stopped" || host.boat_state === "stopping");
}
/** A verified archive delivery may close sessions only after the current host row is actually asleep. Duplicates and delayed archive-after-resume (running) must not. */
export function shouldNotifyGatewayOfBoatArchive(args: {
  recordResult: "accepted" | "duplicate" | "digest_mismatch";
  eventType: string;
  host: (Pick<HostIdentity, "owner_user_id" | "boat_id"> & { boat_state: string | null }) | null;
}): boolean {
  return args.recordResult === "accepted" && args.eventType === "sandbox.archived" && args.host != null && personalBoatHostIsAsleep(args.host);
}
export function requireHostAwake(host: Pick<HostIdentity, "boat_state">): void {
  if (!hostCanDial(host)) {
    throw serviceUnavailable("the pod's host is asleep or starting", {
      kind: "admission", resource: "transitions", unit: "count",
      reason: host.boat_state === "stopped" ? "host_stopped" : host.boat_state === "deleted" ? "host_deleted" : host.boat_state === "superseded" ? "host_superseded" : "host_starting",
      retryable: host.boat_state !== "deleted" && host.boat_state !== "superseded",
    });
  }
}
function authContext(host: Pick<HostIdentity, "id" | "owner_user_id">) {
  return { kind: "sandbox_host" as const, hostId: host.id, ownerUserId: host.owner_user_id ?? "" };
}
function validateAuth(value: unknown): HostAuth {
  const auth = value as HostAuth | null;
  if (!auth || typeof auth.runtimeToken !== "string" || auth.runtimeToken.length < 16 ||
      (auth.hostedToken !== undefined && (typeof auth.hostedToken !== "string" || !auth.hostedToken.length))) {
    throw new Error("invalid sandbox host authentication record");
  }
  return { runtimeToken: auth.runtimeToken, ...(auth.hostedToken === undefined ? {} : { hostedToken: auth.hostedToken }) };
}
export function sealHostAuth(kek: KekProvider, host: Pick<HostIdentity, "id" | "owner_user_id">, auth: HostAuth) {
  return encryptSecret(kek, JSON.stringify(validateAuth(auth)), authContext(host));
}
export function openHostAuth(kek: KekProvider, host: HostIdentity): HostAuth | null {
  if (host.auth_ciphertext === null) {
    if (host.owner_user_id !== null) throw conflict("owned host has no authentication record");
    return null;
  }
  const plaintext = decryptSecret(kek, host.auth_ciphertext, host.auth_key_id!, authContext(host), host.auth_encryption_version!);
  let value: unknown;
  try { value = JSON.parse(plaintext); } catch { throw new Error("invalid sandbox host authentication record"); }
  return validateAuth(value);
}
export function currentHostUrl(host: HostIdentity): string {
  const url = host.hosted_url ?? host.url;
  if (!url) throw serviceUnavailable("host endpoint is not ready");
  return resolveSandboxServiceUrl(url, undefined);
}
export async function hostById(id: string): Promise<HostIdentity | null> {
  return (await query<HostIdentity>("SELECT * FROM sandbox_hosts WHERE id = $1", [id])).rows[0] ?? null;
}
/** The one LIVE legacy workstation a user may own. Pod-isolated hosts must
 * never be selected by owner-only billing or placement; tombstones are excluded. */
export async function hostByOwner(userId: string): Promise<HostIdentity | null> {
  return (await query<HostIdentity>(
    "SELECT * FROM sandbox_hosts WHERE owner_user_id = $1 AND isolated_pod_id IS NULL AND boat_state IS DISTINCT FROM 'deleted' AND boat_state IS DISTINCT FROM 'superseded'",
    [userId])).rows[0] ?? null;
}
/** Explicit/legacy URL lookup can identify a static host, never personal custody. */
export async function staticHostForUrl(value: unknown): Promise<HostIdentity | null> {
  if (typeof value !== "string" || !value) return null;
  const url=resolveSandboxServiceUrl(value,undefined);
  const host=(await query<HostIdentity>("SELECT * FROM sandbox_hosts WHERE url=$1 OR hosted_url=$1",[url])).rows[0] ?? null;
  if (host?.owner_user_id != null) throw conflict("owned host requires a stable pod host assignment");
  return host;
}

/**
 * A sandbox credential goes only to an endpoint the operator chose: a registered host or
 * the deployment's PI_POD_SANDBOX_URL. `providers.sandbox.url` can come from user settings,
 * templates and pod-authored config, so any other value is refused before a token follows it.
 */
export async function assertOperatorSandboxUrl(configured: unknown): Promise<void> {
  if (configured === undefined) return;
  const url = resolveSandboxServiceUrl(configured, undefined);
  const deployment = process.env["PI_POD_SANDBOX_URL"];
  if (deployment && url === resolveSandboxServiceUrl(deployment, undefined)) return;
  if (await staticHostForUrl(url)) return;
  throw badRequest(
    `providers.sandbox.url ${url} is not a registered sandbox host`,
    "remove it to use the deployment's sandbox, or have the operator register the host (`fleet add`)",
  );
}

export type PodHostIdentity = Pick<PodRow, "provider" | "user_id" | "resolved_config" | "sandbox_host_id"> &
  Partial<Pick<PodRow,"id" | "host_pod_id" | "provider_sandbox_id">> &
  { custody_pod_id?: string }; // captured identity without a fresh routing read
/** FK wins. URL fallback exists only for unmapped historical STATIC rows.
 * A supplied pod ID refreshes its pointer; id-less projections intentionally pin
 * captured reconciliation membership rather than following a representative move.
 */
export async function hostForPod(pod: PodHostIdentity): Promise<HostIdentity | null> {
  if (pod.provider !== "sandbox" && pod.provider !== "host") return null;
  if (pod.id) {
    const fresh = (await query<PodRow>("SELECT * FROM pods WHERE id = $1", [pod.id])).rows[0];
    if (!fresh) throw conflict("pod host assignment is missing");
    if (fresh.user_id !== pod.user_id || fresh.provider !== pod.provider) throw conflict("pod host custody mismatch");
    pod = fresh;
  }
  if (pod.provider === "host") {
    const parentId=pod.host_pod_id ?? parseHostSandboxId(pod.provider_sandbox_id ?? "")?.hostId;
    if (!parentId) throw conflict("co-located pod host assignment is missing");
    const parent=(await query<PodRow>("SELECT * FROM pods WHERE id=$1",[parentId])).rows[0];
    if (!parent || parent.provider === "host") throw conflict("co-located pod machine is not registered");
    // hostForPod(parent) already binds an isolated host to exactly that parent; a
    // co-located child runs inside the parent's sandbox on the same machine.
    const physical=await hostForPod(parent);
    if (physical?.owner_user_id != null && physical.owner_user_id !== pod.user_id) {
      throw conflict("pod host custody mismatch");
    }
    return physical;
  }
  let host: HostIdentity | null;
  if (pod.sandbox_host_id) {
    host = await hostById(pod.sandbox_host_id);
    if (!host) throw conflict("pod host registration is missing");
  } else {
    const url = pod.resolved_config.config.providers?.sandbox?.url;
    if (typeof url !== "string") return null;
    host = await staticHostForUrl(url);
  }
  if (host?.owner_user_id != null && host.owner_user_id !== pod.user_id) throw conflict("pod host custody mismatch");
  if (host?.isolated_pod_id != null && host.isolated_pod_id !== (pod.id ?? pod.custody_pod_id)) {
    throw conflict("pod host custody mismatch");
  }
  return host;
}
export async function clientForHost(id: string, kek: KekProvider, fallbackToken: string | null): Promise<SandboxClient> {
  const host = await hostById(id);
  if (!host) throw conflict("host registration is missing");
  requireHostAwake(host);
  const auth = openHostAuth(kek, host);
  const token = auth?.runtimeToken ?? fallbackToken;
  if (!token) throw conflict("host authentication is not configured");
  return new SandboxClient(currentHostUrl(host), token, { hostedToken: auth?.hostedToken });
}
/** Construct directly; per-host credentials NEVER enter process.env or provider config. */
export function providerForHost(host: HostIdentity, kek: KekProvider, config: Record<string, unknown>, fallbackToken: string | null): { provider: SandboxProvider; credentialScope: string } {
  requireHostAwake(host);
  const auth = openHostAuth(kek, host) ?? { runtimeToken: fallbackToken ?? "" };
  if (!auth.runtimeToken) throw conflict("host authentication is not configured");
  const url = currentHostUrl(host);
  return {
    provider: new SandboxServiceProvider({ ...config, url }, auth),
    credentialScope: "sha256:" + createHash("sha256").update(JSON.stringify([host.id, host.generation, url, auth])).digest("hex"),
  };
}
/** Endpoint/token replacement is fenced against a concurrent controller lease generation. */
export async function updateHostTransport(args: { hostId: string; expectedGeneration: string | number; url: string; auth: HostAuth; kek: KekProvider }): Promise<boolean> {
  const host = await hostById(args.hostId);
  if (!host) throw conflict("host registration is missing");
  const url = resolveSandboxServiceUrl(args.url, undefined);
  if (new URL(url).search) throw conflict("hosted endpoint must be query-free");
  const sealed = sealHostAuth(args.kek, host, args.auth);
  const result = await query(`UPDATE sandbox_hosts SET url = $3, hosted_url = $3,
    auth_ciphertext = $4, auth_key_id = $5, auth_encryption_version = $6,
    generation = generation + 1, updated_at = now() WHERE id = $1 AND generation = $2 RETURNING id`,
  [host.id, args.expectedGeneration, url, sealed.ciphertext, sealed.keyId, sealed.encryptionVersion]);
  return result.rows.length === 1;
}
