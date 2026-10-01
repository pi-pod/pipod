/**
 * Create-operation identity and ambiguous-create recovery (§6.5).
 *
 * The control plane generates a stable operation key tied to its pod record and
 * sends it with the create request (body `operationKey` + `Idempotency-Key`
 * header). The host persists key + request fingerprint before any allocation:
 *
 * - same key + same fingerprint while running → join the in-flight create,
 * - same key + same fingerprint after completion → replay the stored outcome,
 * - same key + different fingerprint → 409 idempotency_conflict (a bug: two
 *   different requests sharing one key),
 * - host restart with a pending create → rolled back, `failed/interrupted`;
 *   the same key may be retried with the same fingerprint (fresh attempt).
 *
 * Server rule: on transport ambiguity, query the ORIGINAL host by key first.
 * Only a confirmed pre-allocation refusal (507/400 with details) or a confirmed
 * terminal `failed`/`cancelled` status with `crossHostRetrySafe=true`
 * authorises trying another host. An unreachable original host retains the
 * assignment: the create is unresolved (it may still be running there), and a
 * blind cross-host retry would duplicate the sandbox.
 */
import { randomBytes } from "node:crypto";
import { OPERATION_KEY, type OperationStatusWire } from "../../core/providers/sandbox/wire.js";
import { SandboxApiError, SandboxClient } from "../../core/providers/sandbox/client.js";
import { PiPodError } from "../../core/errors.js";
import { PROVIDER_META } from "../../core/providers/meta.js";
import { serviceUnavailable, conflict } from "../httperrors.js";

/**
 * Platform token with strict startup-snapshot semantics (ROLE=all hardening).
 *
 * - `env` PROVIDED (every server runtime path passes its boot-parsed
 *   `ServerEnv`, fixed at `loadEnv()` before serving): returns the snapshot
 *   value, or NULL when the snapshot has none. It NEVER falls back to
 *   ambient — in an absent-platform-key deployment, ambient may transiently
 *   hold another org's BYO key installed by `withCredential`, and returning
 *   it would answer with another org's custody (the exact cross-org overlay
 *   bug). Explicit absent/empty startup credentials mean "no platform
 *   token", full stop.
 * - `env` OMITTED: legacy ambient read, allowed ONLY for CLI fresh processes
 *   (no overlay in flight by construction). Server hot paths must always pass
 *   env.
 *
 * Never pass a per-request or per-org value here: fleet hosts accept exactly
 * the platform token.
 */
export function platformToken(env?: { PI_POD_SANDBOX_TOKEN?: unknown }): string | null {
  if (env !== undefined) {
    const configured = env.PI_POD_SANDBOX_TOKEN;
    return typeof configured === "string" && configured.length > 0 ? configured : null;
  }
  const ambient = process.env[PROVIDER_META.sandbox.credentialEnv];
  return typeof ambient === "string" && ambient.length > 0 ? ambient : null;
}

/**
 * Platform-token client for operation lookup/cancel on one host
 * (control-plane only). `token` is REQUIRED explicit input — pass
 * `platformToken(bootEnv)` (null when unconfigured → no client, skip).
 * There is deliberately no ambient default: an omitted token must read as
 * "no credential", never as ambient process.env mid-overlay.
 */
export function platformSandboxClient(url: string, token: string | null): SandboxClient | null {
  if (!token) return null;
  return new SandboxClient(url, token);
}

export function isValidOperationKey(value: unknown): value is string {
  return typeof value === "string" && OPERATION_KEY.test(value);
}

/**
 * Build the stable operation key for a pod's initial create. Tied to the pod
 * record (one pod → one key), with randomness so a recreated pod row never
 * collides with a previous incarnation's tombstone on the host.
 */
export function buildCreateOperationKey(podId: string): string {
  const random = randomBytes(9).toString("base64url");
  const key = `pod-${podId}-${random}`;
  if (!isValidOperationKey(key)) {
    // UUIDs are [A-Za-z0-9-]; base64url is [A-Za-z0-9_-]. Truncate, never mangle.
    const fallback = `podcreate-${random.replace(/[^A-Za-z0-9._:-]/g, "")}`.slice(0, 64);
    if (!isValidOperationKey(fallback)) throw new Error("cannot build a valid operation key");
    return fallback;
  }
  return key;
}

/** Where a create request stands after the transport failed ambiguously. */
export type AmbiguousCreateResolution =
  | { outcome: "join"; status: OperationStatusWire }
  | { outcome: "replay-succeeded"; status: OperationStatusWire }
  | { outcome: "replay-failed"; status: OperationStatusWire }
  | { outcome: "retry-original"; status: OperationStatusWire }
  | { outcome: "retry-elsewhere-safe"; status: OperationStatusWire | null }
  | { outcome: "unresolved"; reason: string }
  | { outcome: "key-conflict"; status: number; code: string };

/**
 * Resolve an ambiguous create against the original host's operation status.
 * Pure decision table over an already-fetched status (or fetch failure):
 *
 * - pending → join/wait on the original (never a second host),
 * - succeeded → adopt the returned sandbox id (no second create),
 * - failed/cancelled with crossHostRetrySafe → another host may be tried,
 * - failed/cancelled quarantined → retain; surface unresolved (orphan queue),
 * - original host unreachable/unknown key → retain; unresolved, never blind retry.
 */
export function classifyOperationStatus(
  status: OperationStatusWire | null,
  fetchError: { status?: number; code?: string } | null,
): AmbiguousCreateResolution {
  if (status) {
    switch (status.status) {
      case "pending":
        return { outcome: "join", status };
      case "succeeded":
        return { outcome: "replay-succeeded", status };
      case "failed":
      case "cancelled":
        return status.crossHostRetrySafe
          ? { outcome: "retry-elsewhere-safe", status }
          : { outcome: "replay-failed", status };
    }
  }
  if (fetchError?.status === 404) {
    // Unknown key on the original host: it never persisted the create (pre-
    // allocation refusal path) or its tombstone expired (older than 72h, far
    // beyond any retry window). Safe to attempt elsewhere with the same key.
    return { outcome: "retry-elsewhere-safe", status: null };
  }
  return {
    outcome: "unresolved",
    reason:
      "the original host did not answer the operation lookup; the create may still be " +
      "running there, so no second host may be tried",
  };
}

/**
 * Query the original host for a create whose response was lost. Transport
 * errors from the lookup itself are returned as data (they mean "unresolved",
 * not "safe to retry elsewhere").
 */
export async function lookupOriginalOperation(
  client: SandboxClient,
  operationKey: string,
): Promise<{ status: OperationStatusWire | null; fetchError: { status?: number; code?: string } | null }> {
  try {
    const status = await client.getOperation(operationKey);
    return { status, fetchError: null };
  } catch (error) {
    if (error instanceof SandboxApiError) {
      return { status: null, fetchError: { status: error.status, code: error.code } };
    }
    return { status: null, fetchError: { code: "transport" } };
  }
}

/**
 * Best-effort cancellation of a create by key. Used when the pod is deleted or
 * the wait expires while the original host may still hold the operation:
 * cleanup happens by recovered sandbox id on the host, and failures enter the
 * durable orphan queue rather than disappearing into logs.
 */
export async function cancelHostOperation(
  client: SandboxClient,
  operationKey: string,
): Promise<OperationStatusWire | null> {
  try {
    return await client.cancelOperation(operationKey);
  } catch {
    return null;
  }
}

/**
 * True when a create threw without an HTTP status: the request may or may not
 * have reached the host (timeout, reset, unreachable). HTTP refusals (507/400/
 * 409, mapped with a status) are NOT ambiguous — the host answered.
 */
export function isTransportAmbiguity(error: unknown): boolean {
  return error instanceof PiPodError && error.status === undefined;
}

export type AmbiguousCreateAction =
  | { action: "adopt"; sandboxId: string }
  | { action: "next-host" }
  | { action: "fail"; error: unknown; kind: "unresolved" | "quarantined" | "timeout" | "conflict" | "empty" };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Recover a create whose response was lost in transport (§6.5). Queries the
 * ORIGINAL host by operation key and decides — purely from its answer:
 *
 * - pending → poll (bounded) then adopt the sandbox it produces;
 * - succeeded → adopt the returned sandbox id (verify it still exists);
 * - failed/cancelled with crossHostRetrySafe → another host may be tried;
 * - failed/cancelled quarantined → fail closed (no second host; the sandbox
 *   or its resources may still exist on the original);
 * - original unreachable / lookup transport failure → fail as UNRESOLVED,
 *   retaining the assignment. Never a blind cross-host retry.
 *
 * Non-ambiguous errors (HTTP refusals) are returned as `fail` verbatim for
 * the caller to fail over on (507/unsupported_shape) or surface (the rest).
 */
export async function recoverAmbiguousCreate(args: {
  /** Factory re-resolves the ORIGINAL host's current transport for every poll. */
  originalClient?: SandboxClient | (() => Promise<SandboxClient>);
  /** Optional identity-bound lookup encapsulates transport refresh and response fencing. */
  lookupOperation?: () => Promise<Awaited<ReturnType<typeof lookupOriginalOperation>>>;
  operationKey: string;
  /** False means verified absence. Throwing means unknown and forbids failover. */
  sandboxExists: (sandboxId: string) => Promise<boolean>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<AmbiguousCreateAction> {
  const pollIntervalMs = args.pollIntervalMs ?? 2_000;
  const pollTimeoutMs = args.pollTimeoutMs ?? 90_000;
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    let lookup: Awaited<ReturnType<typeof lookupOriginalOperation>>;
    try {
      if (args.lookupOperation) lookup = await args.lookupOperation();
      else {
        const client = typeof args.originalClient === "function" ? await args.originalClient() : args.originalClient;
        if (!client) throw new Error("original host lookup is not configured");
        lookup = await lookupOriginalOperation(client,args.operationKey);
      }
    } catch { lookup = { status:null, fetchError:{code:"transport"} }; }
    const resolution = classifyOperationStatus(lookup.status, lookup.fetchError);
    switch (resolution.outcome) {
      case "join":
        if (Date.now() >= deadline) {
          return {
            action: "fail",
            error: serviceUnavailable(
              "the sandbox host did not finish creating the pod in time",
              "the create is still pending on its original host; retry the launch",
            ),
            kind: "timeout",
          };
        }
        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
        continue;
      case "replay-succeeded": {
        const sandboxId = resolution.status.sandboxId;
        if (!sandboxId) {
          return {
            action: "fail",
            error: serviceUnavailable(
              "the sandbox host reported success without a sandbox",
              "retry the launch; no second sandbox was created",
            ),
            kind: "empty",
          };
        }
        let exists: boolean;
        try { exists = await args.sandboxExists(sandboxId); }
        catch {
          return { action:"fail", kind:"unresolved", error:serviceUnavailable(
            "created sandbox verification is unavailable; its original assignment is retained") };
        }
        if (!exists) {
          // The host finished but the sandbox is already gone: nothing exists
          // to duplicate, so another host may be tried with the same key.
          return { action: "next-host" };
        }
        return { action: "adopt", sandboxId };
      }
      case "retry-elsewhere-safe":
        return { action: "next-host" };
      case "retry-original":
        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
        continue;
      case "replay-failed":
        return {
          action: "fail",
          error: serviceUnavailable(
            "the pod's create failed on its sandbox host without releasing its resources",
            "the assignment is retained for operator cleanup; launching again would risk a duplicate",
          ),
          kind: "quarantined",
        };
      case "key-conflict":
        return {
          action: "fail",
          error: conflict(
            "operation key conflict: the same key carried a different request",
            "this is a control-plane bug; the host kept its original operation untouched",
          ),
          kind: "conflict",
        };
      case "unresolved":
        return {
          action: "fail",
          error: serviceUnavailable(
            "the pod's create may still be running on its original host, which is unreachable",
            "the assignment is retained; do not launch again until the host answers or an operator clears it",
          ),
          kind: "unresolved",
        };
    }
  }
}
