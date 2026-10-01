/**
 * Operator retirement moves (retirement-brief.md): narrow audited CAS reconciliation of
 * provider_state plus a QUIESCENCE-GATED rehome. This module is deliberately separate
 * from sandboxfleet.ts (owned by the capacity workstream) — it only *reads* via that
 * module's exported helpers and never edits it.
 *
 * HONEST SCOPE — quiescence-gated, NOT unconditionally race-proof: the native hold is
 * the only true fence against a wake already holding the old URL, and this module
 * takes it (archived-only, revision CAS) before anything else moves. Same-object
 * proof is exact (manifest key + target key + full served-field equality against the
 * import body), and every uncertain branch keeps the fence: abort paths never release,
 * server manual release is DISABLED entirely (retry the move or retire-source; native
 * break-glass stays host-side), and only the atomic retire-while-held ends the fenced
 * state.
 * Attested quiescence (--quiescence-confirmed) remains mandatory: it covers the
 * pre-fence window and the unprovable shared-store identity. Abort here never deletes
 * shared objects and never enables two writers: the source row keeps pointing at the
 * source until a fully verified move commits.
 *
 * Invariants:
 * - Reconciliation is narrow: error→archived ONLY, and ONLY after the native host
 *   itself reports the sandbox archived. Logical `state` is never touched (hidden stays
 *   hidden). No generic unconditional state patch exists here by design.
 * - Rehome deletes a source sandbox row only via the atomic retire-while-held (same
 *   holder, exact adopted-object proof, post-repoint); shared-store objects are never
 *   deleted by any path here, and no cleanup happens before proof of adoption.
 * - Every move is audited with source/target host ids plus the host-issued revision
 *   and stoppedAt that proved quiescence.
 */
import { SandboxClient } from "../../core/providers/sandbox/client.js";
import { SandboxApiError } from "../../core/providers/sandbox/client.js";
import type {
  ArchiveReferenceWire,
  AuthzResponse,
  EgressPolicy,
  HoldRequest,
  ImportSandboxRequest,
  ReleaseHoldRequest,
  RetireRequest,
  RetireResponse,
  SandboxConfigManifest,
  SandboxInfoWire,
} from "../../core/providers/sandbox/wire.js";
import { query } from "../db/index.js";
import { audit } from "../audit.js";
import type { PodRow } from "./types.js";
import { notFound } from "../httperrors.js";

import {
  getSandboxHost,
  sandboxFleetClient,
  type FleetClientDeps,
  placeSandboxHost,
  podsOnHost,
  type PodOnHost,
  type SandboxHostRow,
} from "./sandboxfleet.js";

export interface RetirementDeps extends FleetClientDeps {
  /** Startup snapshot of the platform sandbox token (same discipline as the reconciler). */
  platformToken: string | null;
}

export type RehomeStage = "holding" | "manifest_ok" | "imported" | "repointed" | "retired";

/**
 * Cross-process per-pod serialization for moves and retire retries sharing one pod. Session-scoped advisory lock on a dedicated connection: held across
 * host I/O because these are rare operator commands, never hot paths. Callers must not
 * nest it (separate connections would self-deadlock); internal helpers assume the lock
 * is held and never take it themselves.
 */
export async function withPodMoveLock<T>(podId: string, fn: () => Promise<T>): Promise<T> {
  const { getPool } = await import("../db/index.js");
  const conn = await getPool().connect();
  // NOTE: pg Pool.release() does NOT unlock session advisory locks — a bare release
  // would leak the lock on an idle pooled connection and wedge every later holder.
  // Always unlock explicitly; if the unlock itself fails, destroy the connection so a
  // possibly-still-locked session can never re-enter the pool.
  try {
    await conn.query("SELECT pg_advisory_lock(hashtext($1))", [`pod-move:${podId}`]);
  } catch (e) {
    conn.release(e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
  try {
    return await fn();
  } finally {
    try {
      await conn.query("SELECT pg_advisory_unlock(hashtext($1))", [`pod-move:${podId}`]);
      conn.release();
    } catch (e) {
      conn.release(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export interface RehomeStageRow {
  holder: string;
  stage: RehomeStage;
  target_url: string | null;
  source_url: string;
  archive_key: string | null;
}

export async function readRehomeStage(podId: string): Promise<RehomeStageRow | null> {
  try {
    const rows = await query<RehomeStageRow>(
      `SELECT holder, stage, target_url, source_url, archive_key FROM pod_rehome_state WHERE pod_id = $1`,
      [podId],
    );
    return (rows.rows[0] as RehomeStageRow | undefined) ?? null;
  } catch {
    // Pre-migration database: no stage evidence exists; callers treat this as unknown
    // (the most conservative stage) rather than failing the move.
    return null;
  }
}

/**
 * Best-effort stage write: DIAGNOSTIC observability only (operator queries), never
 * safety evidence — writes/reads are swallowed by design, so nothing here may gate a
 * safety decision. The fence is the native hold; serialization is the advisory lock.
 */
export async function recordRehomeStage(args: {
  podId: string;
  holder: string;
  stage: RehomeStage;
  targetUrl?: string | null;
  sourceUrl: string | null;
  archiveKey?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO pod_rehome_state (pod_id, holder, stage, target_url, source_url, archive_key, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (pod_id) DO UPDATE SET holder = EXCLUDED.holder, stage = EXCLUDED.stage,
       target_url = COALESCE(EXCLUDED.target_url, pod_rehome_state.target_url),
       archive_key = COALESCE(EXCLUDED.archive_key, pod_rehome_state.archive_key),
       updated_at = now()`,
    [args.podId, args.holder, args.stage, args.targetUrl ?? null, args.sourceUrl, args.archiveKey ?? null],
  ).catch(() => {});
}

async function hostClient(host: SandboxHostRow, deps: RetirementDeps): Promise<SandboxClient> {
  return sandboxFleetClient(host, deps);
}

function belongsToHost(pod: PodOnHost, host: SandboxHostRow): boolean {
  if (host.owner_user_id != null && host.owner_user_id !== pod.user_id) return false;
  return pod.sandbox_host_id != null ? pod.sandbox_host_id === host.id
    : host.owner_user_id == null && frozenSandboxUrl(pod) === host.url;
}

function frozenSandboxUrl(pod: PodOnHost): string | null {
  const url = (pod.resolved_config as unknown as {
    config?: { providers?: { sandbox?: { url?: unknown } } };
  })?.config?.providers?.sandbox?.url;
  return typeof url === "string" ? url : null;
}

/** Native host's own view of one sandbox (404 → null = unknown to this host). */
async function fetchHostSandbox(
  client: SandboxClient,
  sandboxId: string,
): Promise<SandboxInfoWire | null> {
  try {
    return await client.json<SandboxInfoWire>("GET", `/v1/sandboxes/${encodeURIComponent(sandboxId)}`);
  } catch (e) {
    if (e instanceof Error && /(not_found|not found|404|gone)/i.test(e.message)) return null;
    throw e;
  }
}

export interface ReconcileResult {
  podId: string;
  /** What the host reported (null = host does not know it). */
  hostState: string | null;
  converged: boolean;
  detail: string;
}

/**
 * Narrow provider-state reconciliation: converge ONE pod from `error` to `archived`
 * after — and only after — the native host confirms the sandbox is archived.
 * Logical state is preserved. Any other from-state, a missing sandbox id, an
 * unreachable host, or a host that reports anything but archived → no write.
 */
/**
 * Caller-observed row identity for reconciliation. Every field participates in the final
 * CAS: a concurrent wake/reconcile/manual patch moves at least one of them, so a stale
 * GET can never rewrite a newly changed pod. `updatedAt` is the row-revision proxy
 * (pods carries no revision column); compared at millisecond precision alongside the
 * state/sandbox/URL guards.
 */
export interface ReconcileExpected {
  sandboxHostId?: string | null;
  providerSandboxId: string;
  sourceUrl: string;
  updatedAt: string;
}

/** Read the current reconcile identity for a pod (CLI/tests build `expected` from this). */
export async function readReconcileExpected(podId: string): Promise<ReconcileExpected | null> {
  // updated_at travels as FULL-PRECISION DB text: comparing via JS Date would truncate
  // PostgreSQL microseconds to milliseconds, letting a concurrent mutation inside the
  // same millisecond pass as unchanged. Exact text compare + SQL predicate below.
  const rows = await query<{
    provider_sandbox_id: string | null;
    sandbox_host_id: string | null;
    url: string | null;
    updated_at: string;
  }>(
    `SELECT provider_sandbox_id, sandbox_host_id,
            resolved_config -> 'config' -> 'providers' -> 'sandbox' ->> 'url' AS url,
            updated_at::text AS updated_at
       FROM pods WHERE id = $1 AND provider = 'sandbox'`,
    [podId],
  );
  const row = rows.rows[0];
  if (!row?.provider_sandbox_id || !row.url || !row.updated_at) return null;
  return {
    sandboxHostId: row.sandbox_host_id,
    providerSandboxId: row.provider_sandbox_id,
    sourceUrl: row.url,
    updatedAt: row.updated_at,
  };
}

export async function reconcileProviderArchived(
  deps: RetirementDeps,
  args: { host: SandboxHostRow; pod: PodOnHost; actorId: string | null; expected: ReconcileExpected },
): Promise<ReconcileResult> {
  const { host, pod, expected } = args;
  // The fence holder is ALWAYS `rehome:<podId>` — even though this step is called
  // reconcile — because reconcile is retirement preparation: the guarded rehome that
  // must follow re-PUTs the same holder (idempotent on the host) and proceeds under
  // one continuous fence. A reconcile-specific holder would deadlock the rehome it is
  // preparing for (409 held-by-another) with no server path allowed to clear it.
  const holder = `rehome:${pod.id}`;
  const noWrite = (hostState: string | null, detail: string): ReconcileResult => ({
    podId: pod.id,
    hostState,
    converged: false,
    detail,
  });
  if (pod.provider_state !== "error" && pod.provider_state !== "archived") {
    return noWrite(null, `refusing: provider_state is ${pod.provider_state}; only error converges here`);
  }
  if (!pod.provider_sandbox_id) {
    return noWrite(null, "refusing: pod has no provider sandbox id");
  }
  // The caller's own snapshot must already match what it claims to have read.
  if (
    pod.provider_sandbox_id !== expected.providerSandboxId ||
    frozenSandboxUrl(pod) !== expected.sourceUrl
  ) {
    return noWrite(null, "refusing: caller snapshot disagrees with expected identity; re-read first");
  }
  // Bind the dialed host BEFORE any native I/O: the pod row is loaded by id
  // independently of the caller-selected host, so without this a host that already
  // imported the same sandbox id would be fenced while the source-routed PG row gets
  // rewritten on its testimony — without ever fencing the actual source.
  if (!belongsToHost(pod, host) || (pod.sandbox_host_id ?? null) !== (expected.sandboxHostId ?? null)) {
    return noWrite(null, `refusing: selected host ${host.id} does not serve the expected source URL; re-select the source host`);
  }
  // Fresh DB read: fail fast on any concurrent transition before touching the host.
  // Compared as EXACT timestamp text (microseconds intact) — never via JS Dates.
  const fresh = await readReconcileExpected(pod.id);
  if (
    !fresh ||
    fresh.providerSandboxId !== expected.providerSandboxId ||
    fresh.sourceUrl !== expected.sourceUrl ||
    (fresh.sandboxHostId ?? null) !== (expected.sandboxHostId ?? null) ||
    fresh.updatedAt !== expected.updatedAt
  ) {
    return noWrite(null, "refusing: row changed since the caller read it (stale pointer/SID/state)");
  }
  const client = await hostClient(host, deps);
  // Already-archived rows are NOT converged here and their fence is NEVER released by
  // this path: a previous attempt may have fenced and converged, and releasing could
  // free a fence a guarded move still depends on. Continue with guarded rehome using
  // the same holder instead.
  if (pod.provider_state === "archived") {
    return noWrite(null, "row already archived; fence retained — continue with guarded rehome using the same holder");
  }
  // Live proof, twice: two agreeing host reads back-to-back. A late native start
  // between them is caught by the revision/stoppedAt stability check.
  let first: SandboxInfoWire | null;
  try {
    first = await fetchHostSandbox(client, expected.providerSandboxId);
  } catch (e) {
    return noWrite(null, `host unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!first) return noWrite(null, "host does not know this sandbox; leaving error for the orphan path");
  if (first.state !== "archived") {
    return noWrite(first.state, `host reports ${first.state}, not archived; no convergence`);
  }
  let second: SandboxInfoWire | null;
  try {
    second = await fetchHostSandbox(client, expected.providerSandboxId);
  } catch (e) {
    return noWrite(first.state, `host re-read failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!second || second.state !== "archived") {
    return noWrite(second?.state ?? null, "host changed its answer between reads; no convergence");
  }
  if (
    (first.revision !== undefined || second.revision !== undefined) &&
    first.revision !== second.revision
  ) {
    return noWrite("archived", "host revision moved between reads; retry when quiescent");
  }
  if (
    (first.stoppedAt !== undefined || second.stoppedAt !== undefined) &&
    first.stoppedAt !== second.stoppedAt
  ) {
    return noWrite("archived", "host stop instant moved between reads; retry when quiescent");
  }
  // THE FENCE: this PG row says error but the NATIVE tier is archived, and archived
  // rows CAN be held. Fence exactly the proven revision so a late native start between
  // proof and commit fails closed instead of converging under us. Hosts without the
  // hold API fail closed (refuse) — an unfenced convergence is no longer offered.
  const hold = await putSourceHold(client, expected.providerSandboxId, holder, second.revision);
  if (!hold.held) {
    return noWrite("archived", `fence refused: ${hold.reason}`);
  }
  // Re-verify under the fence via the full manifest: still held by us, same revision,
  // verified object — and served under THIS registry id, so an aliased host row can
  // never converge another backend's truth under our name.
  const fenced = await readSourceManifest(client, expected.providerSandboxId, holder);
  if (!fenced.manifest) {
    return noWrite("archived", `fence verification failed: ${fenced.reason}; source stays fenced, retry to reconcile`);
  }
  if (fenced.manifest.hostId !== host.id) {
    return noWrite("archived", `fenced manifest served under host ${fenced.manifest.hostId}, expected ${host.id}; refusing`);
  }
  // Commit + REQUIRED audit in one transaction, row-locked with the full tuple as an
  // exact predicate (timestamps compared in SQL at full precision — never via JS).
  const { tx } = await import("../db/index.js");
  try {
    await tx(async (db) => {
      const current = await db.query<{ updated_at: string }>(
        `SELECT updated_at::text AS updated_at FROM pods WHERE id = $1 AND provider = 'sandbox' FOR UPDATE`,
        [pod.id],
      );
      const row = current.rows[0];
      if (!row || row.updated_at !== expected.updatedAt) {
        throw new Error("row changed under reconcile; refusing stale write");
      }
      // The stop cause follows the provider-archived convention the background reconciler
      // would otherwise fill on its next tick: an existing cause is preserved verbatim, a
      // NULL one becomes 'provider_archived' here, inside the same audited transaction, so
      // the convergence delta is explicit and complete rather than split across two writers.
      const updated = await db.query(
        `UPDATE pods SET provider_state = 'archived', provider_state_changed_at = now(),
           last_stop_cause = COALESCE(last_stop_cause, 'provider_archived'),
           state_reason = NULL, updated_at = now()
         WHERE id = $1 AND provider = 'sandbox' AND provider_state = 'error' AND provider_sandbox_id = $2
           AND resolved_config -> 'config' -> 'providers' -> 'sandbox' ->> 'url' = $3
           AND updated_at::text = $4 AND sandbox_host_id IS NOT DISTINCT FROM $5::text`,
        [pod.id, expected.providerSandboxId, expected.sourceUrl, expected.updatedAt, expected.sandboxHostId ?? null],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error("lost CAS race at commit; refusing stale write");
      }
      await audit(
        {
          orgId: pod.org_id,
          actorId: args.actorId,
          action: "pod.provider_reconciled",
          targetType: "pod",
          targetId: pod.id,
          detail: {
            from: "error",
            to: "archived",
            host: host.id,
            logicalStatePreserved: pod.state,
            lastStopCause: "preserved-or-provider_archived",
            expectedSandboxId: expected.providerSandboxId,
            expectedSourceUrl: expected.sourceUrl,
            holder,
          },
        },
        db,
      );
    });
  } catch (e) {
    return {
      podId: pod.id,
      hostState: "archived",
      converged: false,
      detail: `${e instanceof Error ? e.message : String(e)} — source stays fenced; retry reconciles`,
    };
  }
  // NO post-commit release: the fence is retained on success exactly as on
  // uncertainty, and the detail routes the operator to the next step. Releasing here
  // would re-expose the row to wakes the retirement run has not fenced anywhere else,
  // and no server path may unfence — not even this one.
  return {
    podId: pod.id,
    hostState: "archived",
    converged: true,
    detail:
      "fenced error→archived convergence with audited exact-tuple CAS; fence retained — " +
      "continue with guarded rehome using the same holder",
  };
}

export interface GuardedRehomeResult {
  moved: Array<{ pod: string; to: string; retired: boolean; retireDetail: string }>;
  skipped: Array<{ pod: string; reason: string }>;
}

/**
 * Atomic held-source retire with honest ambiguity handling (rev7 §11.5): delete the
 * source row + local state without ever releasing the hold, only on proof the target
 * adopted this exact object. Refusals retain the hold natively. A missing source row
 * is converged by confirming it is actually gone (never assumed). The shared object
 * is never deleted by any path here.
 *
 * Recovery entry point: the adopted proof is re-derived live (target GET), never
 * trusted from input, so retrying after any ambiguity is safe and idempotent.
 */
/**
 * Recovery retire for a moved-but-unretired pod: the PG pointer MUST already name the
 * target. If the pointer still names the source, this refuses unconditionally — an
 * adopted-but-abandoned move must retry guarded rehome (which replays the exact
 * import idempotently, re-verifies, and commits the pointer first). Retiring the
 * source while it is still the routed row would delete the only copy the product
 * serves and leave the pod pointing at a 404. Stage evidence can never authorize
 * retirement; it is diagnostic only.
 */
export async function retireSourceRow(
  deps: RetirementDeps,
  args: { source: SandboxHostRow; podId: string; holder: string },
): Promise<{ retired: boolean; detail: string }> {
  return withPodMoveLock(args.podId, async () => {
  const podRows = await query<PodRow>(
    `SELECT * FROM pods WHERE id = $1`,
    [args.podId],
  );
  const pod = podRows.rows[0] as PodRow | undefined;
  if (!pod?.provider_sandbox_id) return { retired: false, detail: "pod has no provider sandbox" };
  const frozenUrl = frozenSandboxUrl(pod as unknown as PodOnHost);
  if (!frozenUrl) return { retired: false, detail: "pod names no target host" };
  if (belongsToHost(pod, args.source)) {
    return {
      retired: false,
      detail:
        "pointer still names the source: retry guarded rehome to commit the pointer first; " +
        "retire-source never retires the currently routed row (stage evidence cannot authorize it)",
    };
  }
  // Identity binding, recovery path too: the target URL must resolve to a REGISTERED
  // host distinct from the source, and the adopted proof must be served under that
  // registry id — an aliased URL must never retire the only source row.
  const targetRows = await query<SandboxHostRow>(`SELECT * FROM sandbox_hosts
    WHERE ($2::text IS NOT NULL AND id = $2) OR
      ($2::text IS NULL AND owner_user_id IS NULL AND url = $1)`, [frozenUrl, pod.sandbox_host_id ?? null]);
  const target = targetRows.rows[0];
  if (!target) return { retired: false, detail: "target URL names no registered host; refusing" };
  if (args.source.owner_user_id != null || target.owner_user_id != null) return { retired: false, detail: "owned Box retirement requires proven owner/shared storage" };
  if (target.id === args.source.id) {
    return { retired: false, detail: "target registry identity equals the source; refusing" };
  }
  const targetClient = await hostClient(target, deps);
  const sourceClient = await hostClient(args.source, deps);
  // Gone-convergence FIRST: if the source row is already absent (e.g. an earlier
  // retire whose response was lost), there is nothing to fence or delete — converge
  // by proving the committed adoption is intact, using only our own audit trail plus
  // the live target manifest. An unreadable source is UNKNOWN, never confirmed.
  try {
    await sourceClient.json<SandboxInfoWire>(
      "GET",
      `/v1/sandboxes/${encodeURIComponent(pod.provider_sandbox_id)}`,
    );
  } catch (e) {
    if (e instanceof SandboxApiError && e.status === 404) {
      return await convergeAlreadyRetired(deps, {
        podId: args.podId,
        sandboxId: pod.provider_sandbox_id,
        source: args.source,
        target,
        targetClient,
      });
    }
    return { retired: false, detail: "source presence unknown (GET failed); refusing" };
  }
  // Full bound proof, same as the move flow: verified target manifest with complete
  // config equality against a freshly read source manifest — not key-only, and never
  // trusted from input or stage rows.
  const sourceRef = await readSourceManifest(sourceClient, pod.provider_sandbox_id, args.holder);
  if (!sourceRef.manifest) {
    return { retired: false, detail: `source manifest unverified: ${sourceRef.reason}` };
  }
  if (sourceRef.manifest.hostId !== args.source.id) {
    return { retired: false, detail: `source manifest served under host ${sourceRef.manifest.hostId}, expected ${args.source.id}; refusing` };
  }
  let targetManifest: ArchiveReferenceWire | null = null;
  try {
    targetManifest = await targetClient.json<ArchiveReferenceWire>(
      "GET",
      `/v1/sandboxes/${encodeURIComponent(pod.provider_sandbox_id)}/archive?verify=1`,
    );
  } catch (e) {
    if (isAbsentRoute(e)) return { retired: false, detail: "target lacks the archive manifest API; adoption unproven" };
    return { retired: false, detail: "target manifest unreadable; adoption unproven" };
  }
  const proof = verifyTargetManifest({
    sandboxId: pod.provider_sandbox_id,
    source: sourceRef.manifest,
    target: targetManifest,
    expectedTargetId: target.id,
  });
  if (!proof.ok) {
    return { retired: false, detail: proof.reason };
  }
  const outcome = await retireSourceRowExact(deps, {
    source: args.source,
    sandboxId: pod.provider_sandbox_id,
    holder: args.holder,
    adoptedArchive: { key: sourceRef.manifest.key, sha256: sourceRef.manifest.sha256 },
    expectedRevision: sourceRef.manifest.revision,
  });
  if (outcome.retired) {
    await markRehomeStage(args.podId, "retired");
  }
  return outcome;
  });
}

/**
 * Converge an already-absent source row (lost retire response, prior operator run):
 * the committed `pod.rehomed` audit names the exact adopted object; the live target
 * manifest must still serve that object archived, verified, under the target registry
 * id. No POST, no DELETE — pure proof. Anything less refuses.
 *
 * Source identity is verified FIRST via the source host's own healthz: a 404 from an
 * unverified endpoint proves nothing (wrong host, stale DNS, proxy), so a wrong or
 * unreadable source identity refuses before the audit trail is even consulted.
 */
export async function convergeAlreadyRetired(
  deps: RetirementDeps,
  args: {
    podId: string;
    sandboxId: string;
    source: SandboxHostRow;
    target: SandboxHostRow;
    targetClient: SandboxClient;
  },
): Promise<{ retired: boolean; detail: string }> {
  const sourceClient = await hostClient(args.source, deps);
  let sourceIdentity: string | null = null;
  try {
    const health = await sourceClient.json<{ hostId?: unknown }>("GET", "/v1/healthz");
    if (typeof health.hostId === "string" && health.hostId.length > 0) sourceIdentity = health.hostId;
  } catch {
    sourceIdentity = null;
  }
  if (sourceIdentity === null) {
    return { retired: false, detail: "source identity unreadable; absence unconfirmed" };
  }
  if (sourceIdentity !== args.source.id) {
    return {
      retired: false,
      detail: `source endpoint answers as host ${sourceIdentity}, expected registered host ${args.source.id}; refusing`,
    };
  }
  const audits = await query<{ detail: Record<string, unknown> }>(
    `SELECT detail FROM audit_log WHERE target_id = $1 AND action = 'pod.rehomed' ORDER BY created_at DESC LIMIT 1`,
    [args.podId],
  );
  const detail = audits.rows[0]?.detail;
  const key = detail?.["archiveKey"];
  const sha = detail?.["archiveSha256"];
  if (typeof key !== "string" || typeof sha !== "string") {
    return { retired: false, detail: "no committed adoption on record for this pod; refusing" };
  }
  let manifest: ArchiveReferenceWire | null = null;
  try {
    manifest = await args.targetClient.json<ArchiveReferenceWire>(
      "GET",
      `/v1/sandboxes/${encodeURIComponent(args.sandboxId)}/archive?verify=1`,
    );
  } catch (e) {
    if (isAbsentRoute(e)) return { retired: false, detail: "target lacks the archive manifest API; adoption unproven" };
    return { retired: false, detail: "target manifest unreadable; adoption unproven" };
  }
  if (
    !manifest ||
    manifest.id !== args.sandboxId ||
    manifest.state !== "archived" ||
    manifest.hostId !== args.target.id ||
    !manifest.archive ||
    manifest.archive.key !== key ||
    manifest.archive.sha256 !== sha ||
    manifest.object?.matches !== true
  ) {
    return { retired: false, detail: "target does not serve the recorded adopted object verified; refusing" };
  }
  await markRehomeStage(args.podId, "retired");
  return { retired: true, detail: `source already gone (confirmed); adopted object ${key} intact at target` };
}

/** Exact-proof retire once the adopted object is known (recovery core above wraps this). */
export async function retireSourceRowExact(
  deps: RetirementDeps,
  args: { source: SandboxHostRow; sandboxId: string; holder: string; adoptedArchive: { key: string; sha256: string }; expectedRevision?: number },
): Promise<{ retired: boolean; detail: string }> {
  if (args.source.owner_user_id != null) return { retired: false, detail: "owned Box retirement requires proven owner/shared storage" };
  const client = await hostClient(args.source, deps);
  const finish = (retired: boolean, detail: string) => ({ retired, detail });
  let res: RetireResponse;
  try {
    res = await client.json<RetireResponse>("POST", `/v1/sandboxes/${encodeURIComponent(args.sandboxId)}/retire`, {
      holder: args.holder,
      ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
      adoptedArchive: args.adoptedArchive,
    } satisfies RetireRequest);
  } catch (e) {
    // Absence confirmation discipline: only an explicit authenticated 404 for THIS id
    // on the VERIFIED source host converges already-gone. A failed GET is UNKNOWN
    // (never confirmed), and a 404/405 POST against a live source row remains failure.
    // isAbsentRoute must not swallow the gone-check: it matches route absence, while a
    // missing ROW surfaces as typed not_found — disambiguated by the explicit GET below.
    if (e instanceof SandboxApiError && (e.status === 404 || e.status === 405)) {
      let gone = false;
      try {
        await client.json<SandboxInfoWire>("GET", `/v1/sandboxes/${encodeURIComponent(args.sandboxId)}`);
      } catch (getError) {
        gone = getError instanceof SandboxApiError && getError.status === 404;
        if (!gone && !(getError instanceof SandboxApiError)) {
          return finish(false, "retire ambiguous and source presence unknown (GET failed); retry to reconcile");
        }
      }
      if (gone) return finish(true, "source row already gone (explicit 404 confirmed)");
      // Row present but POST 404/405: the route is absent on a live source row.
      return finish(false, "source lacks the retire API; upgrade the host");
    }
    if (apiCode(e) === "not_found" || (e instanceof Error && /not_found|not found/.test(e.message))) {
      // Non-HTTP-typed 404 shape: same confirmation discipline as above.
      try {
        await client.json<SandboxInfoWire>("GET", `/v1/sandboxes/${encodeURIComponent(args.sandboxId)}`);
      } catch (getError) {
        if (getError instanceof SandboxApiError && getError.status === 404) {
          return finish(true, "source row already gone (explicit 404 confirmed)");
        }
        return finish(false, "retire ambiguous and source presence unknown (GET failed); retry to reconcile");
      }
      return finish(false, "retire ambiguous and source row still present; retry to reconcile");
    }
    const code = apiCode(e);
    if (code === "conflict" || code === "stale_revision" || code === "sandbox_held" || code === "archive_mismatch") {
      return finish(false, `retire refused (${code}); hold retained natively — resolve the divergence, then retry`);
    }
    return finish(false, `retire ambiguous: ${e instanceof Error ? e.message : String(e)} — retry to reconcile; hold retained`);
  }
  if (res.retired) return finish(true, `retired; shared object ${res.archive.key} retained`);
  return finish(false, "retire reported false without error; retry to reconcile");
}

/** Native error code when the client surfaces one, else null (transport/unknown). */
function apiCode(error: unknown): string | null {
  if (error instanceof SandboxApiError) return error.code;
  return null;
}

/** 404/405 = route absent on this host (older deployment, manifest unavailable). */
function isAbsentRoute(error: unknown): boolean {
  return error instanceof SandboxApiError && (error.status === 404 || error.status === 405);
}

export interface SourceManifest {
  key: string;
  sha256: string;
  size: number;
  revision: number;
  stoppedAt: string | null;
  /** Verbatim persisted config for the import (rev7 §11.1); absent = fail closed. */
  config: SandboxConfigManifest;
  /** Host identity the source manifest was served under; must equal the registry id. */
  hostId: string;
}

/** PUT source/hold with revision CAS. Never throws for expected outcomes (mapped instead). */
async function putSourceHold(
  client: SandboxClient,
  sandboxId: string,
  holder: string,
  expectedRevision: number | undefined,
): Promise<{ held: boolean; reason: string }> {
  const body: HoldRequest = {
    holder,
    reason: "guarded rehome quiescence",
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
  try {
    await client.json<SandboxInfoWire>("PUT", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/hold`, body);
    return { held: true, reason: "held" };
  } catch (e) {
    if (isAbsentRoute(e)) return { held: false, reason: "host lacks the hold API; fence required before retire" };
    const code = apiCode(e);
    if (code === "stale_revision" || code === "conflict") {
      return { held: false, reason: `source moved during hold (${code}); retry when quiescent` };
    }
    return { held: false, reason: `hold ambiguous: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** GET source/archive?verify=1 mapped to move/skip semantics. */
async function readSourceManifest(
  client: SandboxClient,
  sandboxId: string,
  holder: string,
): Promise<{ manifest: SourceManifest | null; reason: string }> {
  let ref: ArchiveReferenceWire;
  try {
    ref = await client.json<ArchiveReferenceWire>(
      "GET",
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/archive?verify=1`,
    );
  } catch (e) {
    if (isAbsentRoute(e)) return { manifest: null, reason: "host lacks the archive manifest API; fence required before retire" };
    return { manifest: null, reason: `archive reference unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Manifest sandbox identity: the reference must name the requested id before its
  // config/object claims are consumed — otherwise a mismatched-id manifest could
  // import another object's config under the requested SID before retire refuses.
  if (typeof ref.id !== "string" || ref.id.length === 0) {
    return { manifest: null, reason: "manifest omits its sandbox id; refusing" };
  }
  if (ref.id !== sandboxId) {
    return { manifest: null, reason: `manifest answers for ${ref.id}, not ${sandboxId}; refusing` };
  }
  if (ref.tier !== "archived" || ref.state !== "archived") {
    return { manifest: null, reason: `source is ${ref.state}, not archived; quiescence unproven` };
  }
  // Identity before content: never interpret archive/object/config claims from a host
  // that does not name itself.
  if (typeof ref.hostId !== "string" || ref.hostId.length === 0) {
    return { manifest: null, reason: "source manifest omits host identity; refusing" };
  }
  if (!ref.hold || ref.hold.holder !== holder) {
    return { manifest: null, reason: "source hold not held by this move; refusing" };
  }
  if (!ref.archive) {
    return { manifest: null, reason: "source row points at no archive object" };
  }
  if (!ref.object || ref.object.matches !== true) {
    return { manifest: null, reason: "archive object failed store verification (absent or checksum mismatch)" };
  }
  if (!ref.config) {
    return { manifest: null, reason: "source omits the persisted config manifest; upgrade the host" };
  }
  return {
    manifest: {
      key: ref.archive.key,
      sha256: ref.archive.sha256,
      size: ref.archive.size,
      revision: ref.revision,
      stoppedAt: ref.stoppedAt,
      config: ref.config,
      hostId: ref.hostId,
    },
    reason: "verified",
  };
}

/** Advance an existing stage row (best-effort, like all stage writes). */
export async function markRehomeStage(podId: string, stage: RehomeStage): Promise<void> {
  await query(`UPDATE pod_rehome_state SET stage = $2, updated_at = now() WHERE pod_id = $1`, [
    podId,
    stage,
  ]).catch(() => {});
}

/**
 * Manual hold release is DISABLED on the server (P0-B): every proof protocol audited
 * so far had holes (swallowed stage reads, transport-ambiguous target GETs, a --target
 * that need not match the recorded attempt, adopted-then-modified targets), and a
 * wrong release recreates the two-writer window. This function always refuses with the
 * safe next step. Recovery paths, in order: (1) retry the move — same holder and exact
 * body replay idempotently while held; (2) `retire-source` once the target provably
 * holds the exact object; (3) native host-side break-glass (operator responsibility,
 * outside any guarded server command — never added here).
 */
export async function releasePodHold(
  _deps: RetirementDeps,
  _args: { source: SandboxHostRow; podId: string; holder: string; targetUrl?: string },
): Promise<{ released: boolean; detail: string }> {
  return {
    released: false,
    detail:
      "server manual hold-release is disabled: retry the guarded move (same holder " +
      "replays idempotently while held) or run retire-source once the target provably " +
      "holds the exact object; host-side break-glass is a native-operator action",
  };
}

/** Canonical deep-equal for verbatim manifest config comparison. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(item as Record<string, unknown>).sort()) {
        sorted[k] = (item as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return item as unknown;
  });
}

export interface TargetManifestProof {
  ok: boolean;
  reason: string;
}

/**
 * Full target-manifest proof (not key/egress-only): after import, the target's verified
 * manifest must equal the source manifest in full — same id, archived tier/state,
 * exact archive key/SHA/size with a verified store match, and byte-identical persisted
 * config (image, digest, workdir, ceiling, egress, timers, labels, owner). A missing or
 * legacy manifest route (or a missing config/object section) refuses — never repoint on
 * partial proof, and never assume an unexposed field matches. Host identity is bound
 * to the registry by operator convention (see docs/sandbox-retirement.md): the
 * manifest's hostId must equal the expected registry id, so an aliased URL cannot
 * replay another host's exact data through the content checks.
 */
export function verifyTargetManifest(args: {
  sandboxId: string;
  source: SourceManifest & { config: SandboxConfigManifest };
  target: ArchiveReferenceWire | null;
  /** Registry id of the expected target host: the manifest must be served under it. */
  expectedTargetId: string;
}): TargetManifestProof {
  const { sandboxId, source, target, expectedTargetId } = args;
  if (!target) return { ok: false, reason: "target manifest unreadable; adoption unproven" };
  if (target.id !== sandboxId) {
    return { ok: false, reason: `target manifest answers for ${target.id}, not ${sandboxId}` };
  }
  if (typeof target.hostId !== "string" || target.hostId.length === 0) {
    return { ok: false, reason: "target manifest omits host identity; refusing" };
  }
  if (target.hostId !== expectedTargetId) {
    return {
      ok: false,
      reason: `target manifest served under host ${target.hostId}, expected registered host ${expectedTargetId} — possible alias; refusing repoint`,
    };
  }
  if (target.hold) {
    // A held target answers for another move's authority (or unknown custody): it is
    // not adoptable authority for this one. Never repoint onto a fenced row.
    return { ok: false, reason: `target row is held by ${target.hold.holder}; not adoptable authority` };
  }
  if (target.tier !== "archived" || target.state !== "archived") {
    return { ok: false, reason: `target serves ${target.state}, not archived; no repoint without proven adoption` };
  }
  if (!target.archive) {
    return { ok: false, reason: "target omits the archive reference; manifest proof unavailable — no repoint" };
  }
  if (target.archive.key !== source.key || target.archive.sha256 !== source.sha256 || target.archive.size !== source.size) {
    return {
      ok: false,
      reason: `target adopted ${target.archive.key}, not source object ${source.key}; refusing repoint`,
    };
  }
  if (!target.config) {
    return { ok: false, reason: "target omits the persisted config manifest — no repoint" };
  }
  if (canonicalJson(target.config) !== canonicalJson(source.config)) {
    return { ok: false, reason: "target persisted config differs from the source manifest — refusing repoint" };
  }
  if (!target.object || target.object.matches !== true) {
    return { ok: false, reason: "target object failed store verification (absent or checksum mismatch)" };
  }
  return { ok: true, reason: "verified" };
}

/** Compare archive stores where the hosts expose them; fail closed on provable mismatch. */
async function storesCompatible(source: SandboxClient, target: SandboxClient): Promise<boolean> {
  try {
    const [s, t] = await Promise.all([
      source.json<AuthzResponse>("GET", "/v1/authz"),
      target.json<AuthzResponse>("GET", "/v1/authz"),
    ]);
    // A host on local-only storage cannot serve an import to/from another machine: the
    // archive object would not be shared. s3-to-s3 across different buckets is NOT
    // provable here (bucket identity is not exposed) — that stays an operator-confirmed
    // runbook precondition alongside attestation.
    if (s.archiveStore !== t.archiveStore) return false;
    if (s.archiveStore === "local" || s.archiveStore === "none") return false;
    return true;
  } catch {
    // Authz unreadable: do not guess — the per-pod host GETs below still gate each move.
    return true;
  }
}

/**
 * Quiescence-gated rehome: move this host's archived pods onto the rest of the fleet.
 * NOT race-proof against a wake already holding the old URL (see module header): the
 * native hold is the only true fence, and every gate below fails closed on what it can
 * observe. The move additionally requires operator-attested quiescence. Per pod:
 *   0. DB transition must be quiet for minQuietSecs (heuristic, not proof).
 *   1. DB row must be archived with a sandbox id and a frozen URL naming this host.
 *   2. Source GET must report archived — record host revision + stoppedAt.
 *   3. Fenced exact import (rev7): PUT hold, verified manifest, import with the exact
 *      object + verbatim config. Target GET must show the same id archived with the
 *      SAME key plus policy equality — never "latest".
 *   4. Re-GET source: still archived AND revision+stoppedAt unchanged (any observable
 *      wake cycle during the move fails closed → skip, retry later).
 *   5. CAS repoint: UPDATE url WHERE id AND provider_state='archived' AND url=old.
 * Source rows are deleted only by the atomic retire-while-held after a committed
 * repoint; shared objects are never deleted here. Abort leaves the source row pointing
 * at the source (never two writers from this path).
 */
export async function guardedRehome(
  deps: RetirementDeps,
  hostId: string,
  args: {
    approved: boolean;
    /** Operator attests quiescence + shared archive store (the fence narrows but never
     * eliminates the pre-fence window; without attestation the move refuses outright). */
    quiescenceAttested: boolean;
    /** Heuristic only: skip pods whose DB transition is newer than this (default 300).
     * Shortens the race window; proves nothing — the fence is native-side. */
    minQuietSecs?: number;
    actorId: string | null;
    onProgress?: (message: string) => void;
  },
): Promise<GuardedRehomeResult> {
  if (!args.approved) throw new Error("refusing guarded rehome without explicit operator approval (--yes)");
  if (!args.quiescenceAttested) {
    throw new Error(
      "refusing guarded rehome without quiescence attestation (--quiescence-confirmed): " +
        "only an attested maintenance window with a confirmed shared store may move workspaces",
    );
  }
  const minQuietSecs = args.minQuietSecs ?? 300;
  const host = await getSandboxHost(hostId);
  if (!host) throw notFound(`no sandbox host "${hostId}"`);
  if (host.owner_user_id != null) throw new Error("owned Box rehome requires proven owner/shared storage; unsupported");
  if (!host.url) throw new Error("source host endpoint is not ready");
  const source = await hostClient(host, deps);
  const result: GuardedRehomeResult = { moved: [], skipped: [] };
  const skip = (pod: string, reason: string) => result.skipped.push({ pod, reason });

  for (const pod of await podsOnHost(host)) {
    // Cross-process per-pod serialization: concurrent operators (or a concurrent
    // concurrent operator command) cannot interleave host calls on this pod. Wakes do not take
    // this lock; the hold + re-verification + CAS chain is what fences them.
    await withPodMoveLock(pod.id, async () => {
    if (pod.provider_state !== "archived" || !pod.provider_sandbox_id) {
      skip(pod.id, `provider state is ${pod.provider_state}; only an archived workspace can move`);
      return;
    }
    const frozenUrl = frozenSandboxUrl(pod);
    if (!belongsToHost(pod, host)) {
      skip(pod.id, "frozen URL no longer names this host; leaving for its authoritative host");
      return;
    }
    const changed = await query<{ provider_state_changed_at: string }>(
      `SELECT provider_state_changed_at FROM pods WHERE id = $1`,
      [pod.id],
    );
    const changedAt = Date.parse(changed.rows[0]?.provider_state_changed_at ?? "");
    if (!Number.isFinite(changedAt) || changedAt >= Date.now() - minQuietSecs * 1000) {
      skip(
        pod.id,
        `DB transition too fresh for the maintenance window (min ${minQuietSecs}s quiet); retry later`,
      );
      return;
    }
    const holder = `rehome:${pod.id}`;
    // NEVER automatically release: no refusal code proves non-adoption (native replays
    // 409 for an existing same-archive row with divergent policy; a pre-existing
    // same-holder hold can already represent a prior adoption; deterministic holders do
    // not serialize concurrent operators). This abort is reachable only after a
    // successful hold PUT (the !hold.held branch skips directly), so the fence claim
    // below is precise; repair/retry/retire all run while held. Server manual release
    // is disabled — only retry or retire-source ever ends the fenced state.
    const abort = async (reason: string): Promise<void> => {
      skip(pod.id, `${reason} — source stays fenced; retry the move (same holder) to reconcile`);
    };
    let before: SandboxInfoWire | null;
    try {
      before = await fetchHostSandbox(source, pod.provider_sandbox_id);
    } catch (e) {
      skip(pod.id, `source unreadable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!before || before.state !== "archived") {
      skip(pod.id, `source reports ${before ? before.state : "unknown"}; quiescence unproven`);
      return;
    }
    // Explicit fleet (not env-driven): a retirement move must never fall back to
    // PI_POD_SANDBOX_URL. With no other host registered every pod skips fail-closed.
    const placementMode = "fleet" as const;
    let target: SandboxHostRow | null;
    try {
      // Explicit legacy compat for archived moves (capacity-owned screening
      // API): importing archived metadata reserves no admission budget —
      // restore-time admission and wake policy decide fitness later — so
      // pre-contract targets stay eligible here. Malformed, misidentified,
      // and floor-mode hosts stay excluded (evidence integrity upholds for
      // moves too). The guarded hold/verify/adopt/CAS chain below is what
      // makes the move safe, not the capacity screen.
      target = await placeSandboxHost(new Set([host.id]), placementMode, {
        allowLegacyHosts: true, kek: deps.kek, platformToken: deps.platformToken,
      });
    } catch (e) {
      skip(pod.id, e instanceof Error ? e.message : "no other active host is available");
      return;
    }
    if (!target) {
      skip(pod.id, "no other active host is registered");
      return;
    }
    if (target.owner_user_id != null) { skip(pod.id, "cross-owner target refused"); return; }
    const targetClient = await hostClient(target, deps);
    if (!(await storesCompatible(source, targetClient))) {
      skip(pod.id, `archive store mismatch between ${host.id} and ${target.id}; operator must confirm a shared store`);
      return;
    }
    // THE FENCE (rev5 §11.2): archived-only, revision CAS on the state just read.
    // 404/405 = manifest absent = fail closed (a host needs the fence API before retire).
    const hold = await putSourceHold(source, pod.provider_sandbox_id, holder, before.revision);
    if (!hold.held) {
      skip(pod.id, hold.reason);
      return;
    }
    await recordRehomeStage({
      podId: pod.id,
      holder,
      stage: "holding",
      targetUrl: null,
      sourceUrl: host.url,
      archiveKey: null,
    });
    // Source-authoritative reference with store verification (rev5 §11.1).
    const { manifest, reason: manifestReason } = await readSourceManifest(source, pod.provider_sandbox_id, holder);
    if (!manifest) {
      await abort(`source manifest unverified: ${manifestReason}`);
      return;
    }
    // Identity binding, source side: the manifest must be served under the source
    // registry id. Checked here — before any import — so a mispointed source URL can
    // never feed another host's object into the move.
    if (manifest.hostId !== host.id) {
      await abort(`source manifest served under host ${manifest.hostId}, expected registered host ${host.id} — refusing`);
      return;
    }
    await recordRehomeStage({
      podId: pod.id,
      holder,
      stage: "manifest_ok",
      targetUrl: null,
      sourceUrl: host.url,
      archiveKey: manifest.key,
    });
    // Verbatim manifest import (rev7 §11.1): every persisted field copied exactly as the
    // source host stores it — image + digest, workdir, FULL ceiling, egress, both timers,
    // labels, owner. Env is NEVER gathered: secrets do not cross the import wire; the
    // existing start path re-materializes leases from server-side custody. Partial
    // ceilings refuse rather than normalizing to host maximums (B4); an allowlist egress
    // is unrepresentable as open by construction (verbatim copy cannot open policy).
    const cfg = manifest.config;
    if (
      typeof cfg.resources.cpu !== "number" ||
      typeof cfg.resources.memoryGB !== "number" ||
      typeof cfg.resources.diskGB !== "number"
    ) {
      await abort("manifest ceiling incomplete; refusing rather than normalizing to host maximums");
      return;
    }
    const importBody = {
      id: pod.provider_sandbox_id,
      image: cfg.image,
      workdir: cfg.workdir,
      resources: { cpu: cfg.resources.cpu, memoryGB: cfg.resources.memoryGB, diskGB: cfg.resources.diskGB },
      ...(Object.keys(cfg.labels ?? {}).length > 0 ? { labels: cfg.labels } : {}),
      archiveAfterMinutes: cfg.archiveAfterMinutes,
      idleTimeoutMinutes: cfg.idleTimeoutMinutes,
      egress: cfg.egress,
      // Same owner the source recorded; legacy unowned rows omit it and keep the flat
      // layout — owner derivation/integration belongs to the capacity workstream.
      ...(cfg.owner ? { owner: cfg.owner } : {}),
      // Digest proof where the source is authoritative; omitted only when the source row
      // predates digest tracking (audited as digestProof:false).
      ...(cfg.imageDigest ? { imageDigest: cfg.imageDigest } : {}),
      archive: { key: manifest.key, sha256: manifest.sha256, size: manifest.size },
    } satisfies ImportSandboxRequest;
    // EVERY import error aborts with the fence held: no refusal code proves
    // non-adoption (native replays 409 even for an existing same-archive row with
    // divergent policy, and transport ambiguity may still have landed). An exact retry
    // succeeds 200 idempotently when the request truly matches; policy-divergent
    // replays keep 409ing and keep skipping. There is deliberately no GET-recovery
    // path that accepts anything less than the success flow below.
    try {
      await targetClient.json<unknown>("POST", "/v1/sandboxes/import", importBody);
    } catch (error) {
      const code = apiCode(error) ?? "transport";
      await abort(`target import refused (${code}); adoption unproven — source stays fenced; exact retry reconciles`);
      return;
    }
    // Full target-manifest proof on the success path only (rev7): verified manifest with
    // complete config equality — never key/egress-only, never "latest", never silent
    // first-wins. A legacy target without the manifest route fails closed here.
    let targetManifest: ArchiveReferenceWire | null = null;
    try {
      targetManifest = await targetClient.json<ArchiveReferenceWire>(
        "GET",
        `/v1/sandboxes/${encodeURIComponent(pod.provider_sandbox_id)}/archive?verify=1`,
      );
    } catch (error) {
      if (isAbsentRoute(error)) {
        await abort("target lacks the archive manifest API; manifest proof unavailable — no repoint");
        return;
      }
      await abort(`target manifest unreadable after import; adoption unproven — source stays fenced`);
      return;
    }
    // Registry distinctness + target identity binding: a target URL aliasing back to
    // the source replays the source's own exact data through every content check —
    // only the identity binding in verifyTargetManifest catches it.
    if (host.id === target.id) {
      await abort("source and target registry identities are not distinct; refusing");
      return;
    }
    const proof = verifyTargetManifest({
      sandboxId: pod.provider_sandbox_id,
      source: manifest,
      target: targetManifest,
      expectedTargetId: target.id,
    });
    if (!proof.ok) {
      await abort(proof.reason);
      return;
    }
    await recordRehomeStage({
      podId: pod.id,
      holder,
      stage: "imported",
      targetUrl: target.url,
      sourceUrl: host.url,
      archiveKey: manifest.key,
    });
    // Fence re-check (belt and braces — the hold is the fence): still held by us, same
    // revision, same key. Any observable move fails closed; the hold stays for reconcile.
    let recheck: ArchiveReferenceWire | null = null;
    try {
      recheck = await source.json<ArchiveReferenceWire>(
        "GET",
        `/v1/sandboxes/${encodeURIComponent(pod.provider_sandbox_id)}/archive`,
      );
    } catch (error) {
      await abort(`source re-check unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!recheck.hold || recheck.hold.holder !== holder) {
      await abort("source hold lost during the move; retry to reconcile (same holder is idempotent)");
      return;
    }
    if (recheck.revision !== manifest.revision || recheck.archive?.key !== manifest.key) {
      await abort("source revision/object moved during the move; retry when quiescent");
      return;
    }
    const repointed = await query(
      `UPDATE pods
          SET resolved_config = jsonb_set(
                resolved_config, '{config,providers,sandbox,url}', to_jsonb($2::text), true),
              sandbox_host_id = $4, updated_at = now()
        WHERE id = $1 AND provider_state = 'archived'
          AND resolved_config -> 'config' -> 'providers' -> 'sandbox' ->> 'url' = $3
          AND sandbox_host_id IS NOT DISTINCT FROM $5::text
          AND provider_sandbox_id = $6 AND updated_at = $7::timestamptz
        RETURNING id`,
      [pod.id, target.hosted_url ?? target.url, frozenUrl, target.id, pod.sandbox_host_id ?? null, pod.provider_sandbox_id, pod.updated_at],
    );
    if ((repointed.rowCount ?? 0) !== 1) {
      await abort("lost CAS race at repoint (row transitioned concurrently); retry later");
      return;
    }
    await recordRehomeStage({
      podId: pod.id,
      holder,
      stage: "repointed",
      targetUrl: target.url,
      sourceUrl: host.url,
      archiveKey: manifest.key,
    });
    // Committed pointer: now retire the fenced source row atomically (rev7 §11.5) with
    // the same holder and the verified adopted object. The hold is never released by us:
    // retire consumes it with the row, and every refusal/ambiguity retains it natively.
    // Audit carries key material, never secrets.
    const retire = await retireSourceRowExact(deps, {
      source: host,
      sandboxId: pod.provider_sandbox_id,
      holder,
      adoptedArchive: { key: manifest.key, sha256: manifest.sha256 },
      expectedRevision: manifest.revision,
    });
    if (retire.retired) {
      await markRehomeStage(pod.id, "retired");
    }
    await audit({
      orgId: pod.org_id,
      actorId: args.actorId,
      action: "pod.rehomed",
      targetType: "pod",
      targetId: pod.id,
      detail: {
        from: host.id,
        to: target.id,
        archiveKey: manifest.key,
        archiveSha256: manifest.sha256,
        sourceRevision: manifest.revision,
        sourceStoppedAt: manifest.stoppedAt,
        holder,
        retired: retire.retired,
        retireDetail: retire.detail,
        digestProof: importBody.imageDigest !== undefined,
        egress: importBody.egress,
        idleTimeoutMinutes: importBody.idleTimeoutMinutes,
        archiveAfterMinutes: importBody.archiveAfterMinutes,
      },
    }).catch(() => {});
    result.moved.push({ pod: pod.id, to: target.id, retired: retire.retired, retireDetail: retire.detail });
    args.onProgress?.(
      retire.retired
        ? `moved ${pod.name} (${pod.id}) to ${target.id} and retired the fenced source`
        : `moved ${pod.name} (${pod.id}) to ${target.id}; SOURCE RETIRE PENDING: ${retire.detail}`,
    );
    }).catch((e: unknown) => {
      // Unexpected failure (DB/placement defects, not host refusals): the fence state is
      // unknown here — the hold may never have been taken — so claim only what holds:
      // nothing was repointed or released by this path; re-run to reconcile.
      skip(pod.id, `move failed: ${e instanceof Error ? e.message : String(e)} — nothing repointed or released; re-run to reconcile`);
    });
  }
  return result;
}
