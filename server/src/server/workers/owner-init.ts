/**
 * One-time owner initialization sweep for legacy unowned sandboxes (§7.2 rev3).
 *
 * Why this exists: unowned rows sit flat (`pps/<id>`) beside tenant parents
 * (`pps/tenant-<key>/<id>`), so twenty legacy flat pods would take twenty
 * tenant-sized shares once fairness is on. Controlled stop/start alone never
 * creates an owner — the control plane maps the authoritative pod owner and
 * initializes it via the native null→userKey CAS
 * (`PUT /v1/sandboxes/:id/owner`, master token only).
 *
 * Rules (all from the native contract, none invented):
 * - source of truth is `pods.user_id` → canonical opaque key. Labels are
 *   never consulted; activity tokens cannot do this (control-plane only).
 * - only stopped/archived/error sandboxes are initializable; live ones
 *   (hot/warm/transitioning) are grandfathered until they stop — a live
 *   cgroup is never moved. They re-queue automatically.
 * - same key replays idempotently (`changed: false` still means done).
 * - a different key is `409 owner_conflict`: ownership is immutable, so the
 *   row parks in `conflict` + audit for an operator (rehome via archive +
 *   import with the new owner). NEVER overwritten.
 * - only platform hosts (fleet-registered URLs, plus the deployment default
 *   in single mode): BYOK/external sandboxes are never touched.
 * - bounded (25 initializations per tick, 60s interval) and restart-safe
 *   (durable `pod_owner_init` rows; transport failures back off by attempts).
 *
 * Rollout sequence (operator): (1) deploy native rev3; (2) this sweep drives
 * `unownedInitializable → 0` (watch host `tenancy` reports); (3) enable
 * `PI_POD_SANDBOX_REQUIRE_OWNER=1` natively to refuse new unowned launches
 * with `400 owner_required`; (4) `unownedLive` drains as legacy pods stop
 * and relaunch owned. Grant-managed fairness stays off until debt is zero
 * (the allocator already excludes debted hosts).
 */
import { SandboxApiError } from "../../core/providers/sandbox/client.js";
import { resolveSandboxServiceUrl } from "../../core/providers/sandbox/index.js";
import { SandboxClient } from "../../core/providers/sandbox/client.js";
import { platformToken } from "../pods/operations.js";
import type { SandboxInfoWire } from "../../core/providers/sandbox/wire.js";
import { query } from "../db/index.js";
import { audit } from "../audit.js";
import { sanitizeFailureMessage } from "../safe-errors.js";
import { buildCreateOwner } from "../pods/owner-identity.js";
import { clientForHost, hostById, requireHostAwake } from "../pods/hostidentity.js";
import type { KekProvider } from "../secrets/crypto.js";
import { listDiallableSandboxHosts, sandboxPlacementMode } from "../pods/sandboxfleet.js";
import type { WaitStore } from "../pods/capacity-wait.js";

const store: WaitStore = {
  query: (text: string, params?: unknown[]) => query(text, params ?? []),
};

/** Initializable provider states (native CAS accepts stopped/archived/error tiers). */
const INITIALIZABLE_STATES = ["stopped", "archived", "error"] as const;

/** Bound per sweep tick (host calls are cheap but unbounded fans are not). */
export const OWNER_INIT_BATCH = 25;

/** Live-skipped rows re-queue after this long (the sandbox may have stopped). */
export const LIVE_REQUEUE_MS = 60 * 60_000;

export type OwnerInitStatus = "pending" | "done" | "conflict" | "live_skipped" | "error";

export interface OwnerInitCandidate {
  pod_id: string;
  org_id: string;
  user_id: string;
  host_id: string;
  host_url: string;
  sandbox_id: string;
}

/**
 * Discover platform pods needing initialization: stopped/archived/error with
 * a sandbox id, frozen onto a platform host, without a finished init row.
 * Live-skipped rows re-enter after LIVE_REQUEUE_MS; error rows back off by
 * attempts (10s × 2^attempts, capped at 10 min).
 *
 * Logical state covers BOTH `active` and `archived` rows: archiving is a
 * logical hide only (migration 008; plan §3 "preserve logical/history
 * state") — the physical sandbox still exists on the host and still blocks
 * the CPU allocator while unowned. Only truly terminal rows are excluded,
 * and those need no predicate: `provider_state = 'gone'` NULLs
 * `provider_sandbox_id` (lifecycle), so the `IS NOT NULL` check below
 * already drops them. Deleted pods are physically deleted (no `deleted`
 * logical state exists). A `state = 'active'`-only predicate strands hidden
 * pods: their sandboxes never initialize and the allocator stalls forever
 * (production 2026-09-07: 12 unowned sandboxes on archived pods).
 */
export async function discoverOwnerInitCandidates(
  client: WaitStore,
  platformUrls: ReadonlyMap<string, string>,
  limit: number,
): Promise<OwnerInitCandidate[]> {
  const urls = [...platformUrls.keys()];
  if (urls.length === 0) return [];
  const result = await client.query(
    `SELECT p.id AS pod_id, p.org_id, p.user_id, p.provider_sandbox_id AS sandbox_id, p.sandbox_host_id,
            p.resolved_config #>> '{config,providers,sandbox,url}' AS url
       FROM pods p
       LEFT JOIN pod_owner_init q ON q.pod_id = p.id
      WHERE p.provider = 'sandbox' AND p.state IN ('active', 'archived')
        AND p.provider_state IN (${INITIALIZABLE_STATES.map((state) => `'${state}'`).join(",")})
        AND p.provider_sandbox_id IS NOT NULL
        AND (p.sandbox_host_id = ANY($4::text[]) OR (p.sandbox_host_id IS NULL AND p.resolved_config #>> '{config,providers,sandbox,url}' = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM sandbox_hosts sh WHERE sh.owner_user_id IS NOT NULL AND (sh.url = p.resolved_config #>> '{config,providers,sandbox,url}' OR sh.hosted_url = p.resolved_config #>> '{config,providers,sandbox,url}'))))
        AND (
          q.pod_id IS NULL
          OR (q.status = 'live_skipped' AND q.updated_at < now() - make_interval(secs => $2))
          OR (q.status = 'error' AND q.updated_at < now() - make_interval(secs => LEAST(600, 10 * (2 ^ LEAST(q.attempts, 5)))))
        )
      ORDER BY p.created_at ASC
      LIMIT $3`,
    [urls, LIVE_REQUEUE_MS / 1000, limit, [...platformUrls.values()]],
  );
  const out: OwnerInitCandidate[] = [];
  for (const row of result.rows) {
    const url = String(row.url ?? "");
    const hostId = typeof row.sandbox_host_id === "string" ? row.sandbox_host_id : platformUrls.get(url);
    if (!hostId) continue;
    out.push({
      pod_id: String(row.pod_id),
      org_id: String(row.org_id),
      user_id: String(row.user_id),
      host_id: hostId,
      host_url: url,
      sandbox_id: String(row.sandbox_id),
    });
  }
  return out;
}

/**
 * Marker for durable-bookkeeping failures. Provider errors never escape
 * `initializePodOwner` (they become `error`/`conflict`/`live_skipped` rows),
 * so a marked throw reaching the sweep is always the bookkeeping UPSERT —
 * the sweep logs it under a distinct prefix naming that step. The marker is
 * a local property only; `sanitizeFailureMessage` never emits it (or any
 * SQL text) — it renders the static prefix plus a generic suffix.
 */
const OWNER_INIT_BOOKKEEPING_MARK = "__pipodOwnerInitBookkeeping";

export function isOwnerInitBookkeepingFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>)[OWNER_INIT_BOOKKEEPING_MARK] === true
  );
}

async function upsertOwnerInitRow(
  client: WaitStore,
  candidate: OwnerInitCandidate,
  userKey: string,
  patch: { status: OwnerInitStatus; lastError?: string | null; bumpAttempts?: boolean },
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO pod_owner_init
       (pod_id, org_id, user_id, host_id, sandbox_id, user_key, status, last_error, attempts, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (pod_id) DO UPDATE SET
       status = EXCLUDED.status,
       last_error = EXCLUDED.last_error,
       attempts = pod_owner_init.attempts + EXCLUDED.attempts,
       updated_at = now()`,
    [
      candidate.pod_id,
      candidate.org_id,
      candidate.user_id,
      candidate.host_id,
      candidate.sandbox_id,
      userKey,
      patch.status,
      patch.lastError ?? null,
      patch.bumpAttempts === true ? 1 : 0,
    ],
    );
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      (error as Record<string, unknown>)[OWNER_INIT_BOOKKEEPING_MARK] = true;
    }
    throw error;
  }
}

/**
 * Initialize one sandbox's owner (null → userKey CAS). Returns the terminal
 * status. Transport failures stay `error` for backoff retry; live sandboxes
 * stay `live_skipped` for re-queue; key conflicts park in `conflict` + audit
 * and are never retried or overwritten.
 */
export async function initializePodOwner(
  client: SandboxClient,
  candidate: OwnerInitCandidate,
  storeClient: WaitStore = store,
): Promise<OwnerInitStatus> {
  const { userKey } = buildCreateOwner({ userId: candidate.user_id });
  let info: SandboxInfoWire;
  try {
    info = await client.json<SandboxInfoWire>("GET", `/v1/sandboxes/${encodeURIComponent(candidate.sandbox_id)}`);
  } catch {
    await upsertOwnerInitRow(storeClient, candidate, userKey, { status: "error", lastError: "info lookup failed", bumpAttempts: true });
    return "error";
  }
  if (info.owner != null) {
    if (info.owner.userKey === userKey) {
      // Already initialized (possibly by an earlier crashed tick): done.
      await upsertOwnerInitRow(storeClient, candidate, userKey, { status: "done" });
      return "done";
    }
    // Set (not merely non-null): a different key is immutable — park it.
    // Note: v5 hosts omit `owner` (undefined) exactly like legacy null:
    // both mean unowned and both take the CAS path below.
    await upsertOwnerInitRow(storeClient, candidate, userKey, {
      status: "conflict",
      lastError: "sandbox already owned by a different key",
    });
    await audit({
      orgId: candidate.org_id,
      actorId: candidate.user_id,
      action: "pod.owner_conflict",
      targetType: "pod",
      targetId: candidate.pod_id,
      detail: { hostId: candidate.host_id, sandboxId: candidate.sandbox_id },
    }).catch(() => {});
    return "conflict";
  }
  try {
    await client.initializeOwner(candidate.sandbox_id, userKey);
  } catch (error) {
    if (error instanceof SandboxApiError && (error.status === 409 || error.code === "owner_conflict")) {
      // Live (grandfathered) or raced-into-ownership: re-read to tell which.
      const reread = await client
        .json<SandboxInfoWire>("GET", `/v1/sandboxes/${encodeURIComponent(candidate.sandbox_id)}`)
        .catch(() => null);
      if (reread?.owner?.userKey === userKey) {
        await upsertOwnerInitRow(storeClient, candidate, userKey, { status: "done" });
        return "done";
      }
      // Live sandboxes grandfather (never moved live); anything else that
      // still refuses the CAS — held rows, foreign owners — parks in
      // conflict for an operator (ownership is immutable, never overwritten).
      // v5 omits `owner` exactly like legacy null: both mean unowned.
      if (reread && (reread.state === "started" || reread.state === "starting") && reread.owner == null) {
        await upsertOwnerInitRow(storeClient, candidate, userKey, { status: "live_skipped" });
        return "live_skipped";
      }
      await upsertOwnerInitRow(storeClient, candidate, userKey, {
        status: "conflict",
        lastError: "owner_conflict",
      });
      await audit({
        orgId: candidate.org_id,
        actorId: candidate.user_id,
        action: "pod.owner_conflict",
        targetType: "pod",
        targetId: candidate.pod_id,
        detail: { hostId: candidate.host_id, sandboxId: candidate.sandbox_id },
      }).catch(() => {});
      return "conflict";
    }
    await upsertOwnerInitRow(storeClient, candidate, userKey, { status: "error", lastError: "owner PUT failed", bumpAttempts: true });
    return "error";
  }
  await upsertOwnerInitRow(storeClient, candidate, userKey, { status: "done" });
  return "done";
}

/**
 * Boot-snapshot slice this sweep may read (never ambient mid-tick: a BYO
 * overlay must not reroute which hosts get owner PUTs).
 */
export interface OwnerInitEnv {
  PI_POD_SANDBOX_TOKEN?: unknown;
  SANDBOX_PLACEMENT_MODE?: unknown;
  PI_POD_SANDBOX_URL?: unknown;
}

/** Platform URLs the sweep may touch: fleet hosts (+ default in single mode). */
export async function platformOwnerInitUrls(env?: OwnerInitEnv): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  // M6/M10: diallable-only listing IN SQL. Sleeping Box rows never enter the
  // map, so the sweep cannot queue owner PUTs against them (each candidate
  // still re-checks `requireHostAwake` before its PUT as defense in depth).
  const hosts = await listDiallableSandboxHosts();
  for (const host of hosts) {
    const url = host.hosted_url ?? host.url;
    if (url) urls.set(url, host.id);
  }
  const placement =
    env?.SANDBOX_PLACEMENT_MODE === undefined
      ? sandboxPlacementMode()
      : sandboxPlacementMode({ SANDBOX_PLACEMENT_MODE: env.SANDBOX_PLACEMENT_MODE });
  if (placement === "single") {
    const configuredUrl = typeof env?.PI_POD_SANDBOX_URL === "string" ? env.PI_POD_SANDBOX_URL : undefined;
    try {
      const fallback = resolveSandboxServiceUrl(
        undefined,
        configuredUrl ?? process.env["PI_POD_SANDBOX_URL"],
      );
      if (!urls.has(fallback) && !hosts.some((host) => host.url === fallback || host.hosted_url === fallback)) urls.set(fallback, "PI_POD_SANDBOX_URL");
    } catch {
      // Unconfigured default: fleet rows (if any) still sweep.
    }
  }
  return urls;
}

export async function runOwnerInitSweep(deps: {
  kek?: KekProvider;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /**
   * Boot-parsed env. The platform token is resolved from this snapshot so
   * a BYO credential overlay mid-sweep cannot reroute owner PUTs onto
   * another org's custody. Omitted (tests/CLI): legacy ambient read.
   */
  env?: OwnerInitEnv;
}): Promise<void> {
  try {
    const token = platformToken(deps.env);
    if (!token && !deps.kek) {
      deps.log.warn("owner-init sweep skipped: no platform sandbox token in this environment");
      return;
    }
    const urls = await platformOwnerInitUrls(deps.env);
    if (urls.size === 0) return;
    const candidates = await discoverOwnerInitCandidates(store, urls, OWNER_INIT_BATCH);
    if (candidates.length === 0) return;
    const clients = new Map<string, SandboxClient>();
    const clientFor = (url: string): SandboxClient => {
      let client = clients.get(url);
      if (!client) {
        if (!token) throw new Error("platform token unavailable");
        client = new SandboxClient(url, token);
        clients.set(url, client);
      }
      return client;
    };
    let done = 0;
    for (const candidate of candidates) {
      try {
        if (candidate.host_id !== "PI_POD_SANDBOX_URL") {
          const host = await hostById(candidate.host_id);
          if (!host) continue;
          requireHostAwake(host);
          if (host.owner_user_id && !deps.kek) continue;
        }
        const client = candidate.host_id !== "PI_POD_SANDBOX_URL" && deps.kek
          ? await clientForHost(candidate.host_id, deps.kek, token)
          : clientFor(candidate.host_url);
        const status = await initializePodOwner(client, candidate);
        if (status === "done") done += 1;
      } catch (e) {
        deps.log.error(
          sanitizeFailureMessage(e, {
            prefix: isOwnerInitBookkeepingFailure(e)
              ? `owner init bookkeeping failed for pod ${candidate.pod_id} (upsert)`
              : `owner init for pod ${candidate.pod_id} failed`,
          }),
        );
      }
    }
    if (done > 0 || candidates.length > 0) {
      deps.log.info(`owner-init sweep: ${done}/${candidates.length} initialized`);
    }
  } catch (e) {
    deps.log.error(sanitizeFailureMessage(e, { prefix: "owner-init sweep failed" }));
  }
}
