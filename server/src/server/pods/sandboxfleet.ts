/**
 * The fleet of self-hosted sandbox hosts.
 *
 * A pi-pod-sandbox host is one virtual machine that knows nothing about any other. The fleet
 * exists only here: a table of hosts, a choice of one at launch, and the drain/rehome steps
 * that let a machine be deleted. Stable sandbox_host_id is authoritative; the URL cached in
 * resolved config is history, except for unmapped legacy STATIC pods. Owned endpoints and
 * credentials are resolved afresh and sleeping Boats never receive fleet traffic.
 *
 * A pod is pinned to its host for as long as it holds a local workspace. Only an
 * ARCHIVED pod can move, because only then does its workspace live in the shared object store.
 */
import { PiPodError } from "../../core/errors.js";
import { PROVIDER_META } from "../../core/providers/meta.js";
import { SandboxClient } from "../../core/providers/sandbox/client.js";
import { resolveSandboxServiceUrl } from "../../core/providers/sandbox/index.js";
import type {
  CapacityReportV1,
  HealthResponse,
  ImportSandboxRequest,
} from "../../core/providers/sandbox/wire.js";
import { query, tx } from "../db/index.js";
import { audit } from "../audit.js";
import { badRequest, conflict, HttpError, notFound, serviceUnavailable } from "../httperrors.js";
import {
  describeProviderFailure,
  FLEET_UNAVAILABLE_CODE,
  FLEET_UNAVAILABLE_RETRY_AFTER_MS,
  sanitizeErrorDetails,
} from "../safe-errors.js";
import {
  checkRequestFit,
  checkOwnedBoatRequestFit,
  rankCandidates,
  validateCapacityReport,
  type CapacityFit,
  type ResolvedShape,
} from "./capacity.js";
import { shouldCheckTenantGrant } from "./cpu-fairness.js";
import type { ResolvedConfigReport } from "./types.js";
import { clientForHost, hostCanDial, requireHostAwake, type HostIdentity } from "./hostidentity.js";
import type { KekProvider } from "../secrets/crypto.js";

export interface FleetClientDeps { kek?: KekProvider; platformToken?: string | null }
/** Missing registrations or KEKs for host-specific auth fail closed. */
export async function sandboxFleetClient(host: SandboxHostRow, deps: FleetClientDeps): Promise<SandboxClient> {
  const synthetic = host.synthetic === true && host.id === DEFAULT_FLEET_PRELOAD_HOST_ID;
  if (!synthetic) {
    const current = await getSandboxHost(host.id);
    if (!current) throw conflict("host registration is missing");
    host = current;
  }
  requireHostAwake({ boat_state: host.boat_state ?? null });
  if (deps.kek && !synthetic) return clientForHost(host.id, deps.kek, deps.platformToken ?? null);
  if (host.owner_user_id != null || host.auth_ciphertext != null) {
    throw conflict("host-specific authentication requires a KEK");
  }
  const url = host.hosted_url ?? host.url;
  if (!url) throw serviceUnavailable("host endpoint is not ready");
  if (!deps.platformToken) throw conflict("host authentication is not configured");
  return new SandboxClient(url, deps.platformToken);
}

export const SANDBOX_PROVIDER_NAME = "sandbox";

/** Explicit placement mode (plan §4.1). `fleet` fails closed; `single` keeps dev fallback. */
export type SandboxPlacementMode = "single" | "fleet";

/** Resolve the effective placement mode from an explicit value, a ServerEnv slice, or the process env. */
export function sandboxPlacementMode(
  source?: Pick<{ SANDBOX_PLACEMENT_MODE?: unknown }, "SANDBOX_PLACEMENT_MODE"> | NodeJS.ProcessEnv | SandboxPlacementMode,
): SandboxPlacementMode {
  if (source === "single" || source === "fleet") return source;
  const raw =
    (source as Record<string, unknown> | undefined)?.["SANDBOX_PLACEMENT_MODE"] ??
    process.env["SANDBOX_PLACEMENT_MODE"];
  return raw === "fleet" ? "fleet" : "single";
}

/** Operator diagnostics: mode plus what it means for an empty fleet. Never includes secrets. */
export function describePlacementMode(mode: SandboxPlacementMode): string {
  return mode === "fleet"
    ? "fleet (empty/unreachable fleet fails closed; PI_POD_SANDBOX_URL is never a fallback)"
    : "single (empty fleet uses PI_POD_SANDBOX_URL as the single-host deployment)";
}

export type SandboxHostStatus = "active" | "draining";

export interface SandboxHostRow {
  /** Internal explicit marker; database rows never carry this fallback authority. */
  synthetic?: true;
  auth_ciphertext?: Buffer | null;
  owner_user_id?: string | null;
  boat_id?: string | null;
  boat_state?: HostIdentity["boat_state"];
  runtime_boot_id?: string | null;
  hosted_url?: string | null;
  id: string;
  url: string | null;
  status: SandboxHostStatus;
  created_at: string;
  updated_at: string;
}

/** A host's health plus the headroom a placement decision needs. */
export interface SandboxHostHealth {
  host: SandboxHostRow;
  reachable: boolean;
  health: HealthResponse | null;
  /** Whether the host reports its commitments at all; hosts predating fleets do not. */
  reportsCapacity: boolean;
  /** Free memory guarantee in bytes; the scarce axis given the fixed 512 MiB floor. */
  freeMemoryBytes: number;
  freeCpu: number;
  freeDiskBytes: number;
  /**
   * Validated versioned capacity report (§6.3), when the host embeds one in
   * healthz. Null for legacy hosts (compat path) and for hosts whose report
   * failed validation (treated as no usable report, never as headroom).
   */
  capacity: CapacityReportV1 | null;
  /**
   * Why `capacity` is (or is not) usable — absent and malformed MUST NOT be
   * confused (§6.4): a genuinely absent contract is the legacy compat path;
   * a present-but-unreadable or misidentified report is never eligible.
   * - `ok`: validated report, hostId bound to the probed candidate.
   * - `absent`: health carried no capacity object (pre-contract host).
   * - `malformed`: a capacity object was present but failed validation
   *   (wrong version, negative/NaN/non-finite numbers, bad shapes).
   * - `identity-mismatch`: the validated report names a different hostId
   *   than the registered candidate (misconfiguration or confused deputy).
   */
  capacityStatus: "ok" | "absent" | "malformed" | "identity-mismatch";
}

const PROBE_TIMEOUT_MS = 3_000;
const ARCHIVE_TIMEOUT_MS = 300_000;
/** Match the host deploy-root's 900s pull; a cold private base tag is slower than an archive. */
const PRELOAD_TIMEOUT_MS = 900_000;
/** The sandbox service's admission-control refusal; see its 507 contract. */
const SANDBOX_ADMISSION_DENIED = 507;
/** Synthetic id when no fleet is registered; not a row in sandbox_hosts. */
const DEFAULT_FLEET_PRELOAD_HOST_ID = "PI_POD_SANDBOX_URL";
const DEFAULT_SANDBOX_SERVICE_URL = "http://pi-pod-sandbox:8433";

export async function listSandboxHosts(status?: SandboxHostStatus): Promise<SandboxHostRow[]> {
  const rows = await query<SandboxHostRow>(
    status === undefined
      ? `SELECT * FROM sandbox_hosts ORDER BY id`
      : `SELECT * FROM sandbox_hosts WHERE status = $1 ORDER BY id`,
    status === undefined ? [] : [status],
  );
  return rows.rows;
}

/**
 * Fleet-sweep listing (M6/M10): hosts whose runtime endpoint may be dialed
 * right now — static hosts (`boat_state IS NULL`) plus Boat hosts the vendor
 * reports `running`. Sleeping/transitional Boat hosts (`stopped`, `starting`,
 * `unknown`, …) are excluded IN SQL so a tick over thousands of mostly-stopped
 * hosts never pulls (or probes) the sleeping rows. Operator surfaces
 * (`fleet list`/`doctor`) and placement keep `listSandboxHosts`: they must
 * SEE sleeping hosts (as healthy-asleep) and explain refusals against the
 * full registry. `collectOnce` and every per-host client constructor keep
 * their own in-memory `hostCanDial`/`requireHostAwake` checks as defense in
 * depth against a row that fell asleep between the listing and the call.
 */
export async function listDiallableSandboxHosts(status?: SandboxHostStatus): Promise<SandboxHostRow[]> {
  const rows = await query<SandboxHostRow>(
    status === undefined
      ? `SELECT * FROM sandbox_hosts WHERE (boat_state IS NULL OR boat_state = 'running') ORDER BY id`
      : `SELECT * FROM sandbox_hosts WHERE status = $1 AND (boat_state IS NULL OR boat_state = 'running') ORDER BY id`,
    status === undefined ? [] : [status],
  );
  return rows.rows;
}

export async function getSandboxHost(id: string): Promise<SandboxHostRow | null> {
  const rows = await query<SandboxHostRow>(`SELECT * FROM sandbox_hosts WHERE id = $1`, [id]);
  return rows.rows[0] ?? null;
}

export async function addSandboxHost(id: string, url: string): Promise<SandboxHostRow> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw badRequest(`"${id}" is not a host id`, "use the host's PI_POD_SANDBOX_HOST_ID");
  }
  // Same validation the provider applies, so a host that cannot be dialed is never registered.
  const normalized = resolveSandboxServiceUrl(url, undefined);
  const existing = await query<SandboxHostRow>(
    `SELECT * FROM sandbox_hosts WHERE id = $1 OR url = $2`,
    [id, normalized],
  );
  if (existing.rows.length > 0) {
    throw conflict(`a sandbox host with that id or URL is already registered`);
  }
  const inserted = await query<SandboxHostRow>(
    `INSERT INTO sandbox_hosts (id, url) VALUES ($1, $2) RETURNING *`,
    [id, normalized],
  );
  return inserted.rows[0]!;
}

export async function setSandboxHostStatus(
  id: string,
  status: SandboxHostStatus,
): Promise<SandboxHostRow> {
  const updated = await query<SandboxHostRow>(
    `UPDATE sandbox_hosts SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status],
  );
  const row = updated.rows[0];
  if (!row) throw notFound(`no sandbox host "${id}"`);
  return row;
}

/**
 * Forget a host. Refused while pods still point at it: the row is what tells an operator
 * where those pods are, and a pod whose host is gone from the table cannot be rehomed.
 */
/** Minimal executor surface for host-row destruction inside a caller-owned transaction. */
export interface HostRowExecutor {
  query: <R extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
    text: string, params?: unknown[],
  ) => Promise<import("pg").QueryResult<R>>;
}

export async function removeSandboxHostIn(db: HostRowExecutor, id: string): Promise<void> {
  const host = (await db.query<SandboxHostRow>(`SELECT * FROM sandbox_hosts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!host) throw notFound(`no sandbox host "${id}"`);
  const pods = await db.query(`SELECT id FROM pods WHERE provider = 'sandbox'
      AND provider_state <> 'gone' AND (sandbox_host_id = $1 OR
        (sandbox_host_id IS NULL AND $3::boolean AND resolved_config #>> '{config,providers,sandbox,url}' = $2)) FOR UPDATE`,
    [id, host.url, host.owner_user_id == null]);
  if (pods.rows.length) throw conflict(`${pods.rows.length} pod(s) still point at sandbox host "${id}"`, "rehome or delete them first");
  // Keep the immutable report/history; only terminal FK assignments may detach.
  await db.query(`UPDATE pods SET sandbox_host_id = NULL WHERE sandbox_host_id = $1 AND provider_state = 'gone'`, [id]);
  await db.query(`DELETE FROM sandbox_hosts WHERE id = $1`, [id]);
}

export async function removeSandboxHost(id: string): Promise<void> {
  await tx(async (db) => removeSandboxHostIn(db, id));
}

export interface DeadHostReconcileOptions {
  /** Defaults to a read-only inventory. No unreachable-host inference is made. */
  dryRun?: boolean;
  expectedUrl?: string;
  hostDeletedConfirmed?: boolean;
  quiescenceConfirmed?: boolean;
  acceptWorkspaceLoss?: boolean;
  /** Operator identity / incident or infrastructure deletion evidence; never credentials. */
  reason?: string;
}

export interface DeadHostReconcileResult {
  dryRun: boolean;
  hostId: string;
  url: string | null;
  pods: Array<{ id: string; state: string; providerState: string; action: "converge" | "unchanged" | "refuse" }>;
}

/**
 * Break-glass convergence for a PERMANENTLY DELETED host, not a network outage.
 * Archived metadata is not proof an archive can be recovered without its host. This
 * deliberately abandons recovery, records that decision, and never imports/deletes an
 * object. Frozen routing and provider IDs remain historical evidence; gone excludes
 * these rows from fleet custody and ordinary remove can then retire the host row.
 *
 * Operator must stop all lifecycle/provisioning workers and requests, and wait for
 * in-flight calls to finish. Row locks serialize DB writers during this transaction,
 * but cannot fence an already-running remote operation or a future stale writer.
 */
export async function reconcileDeadSandboxHost(
  id: string,
  options: DeadHostReconcileOptions = {},
): Promise<DeadHostReconcileResult> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && (
    options.hostDeletedConfirmed !== true || options.quiescenceConfirmed !== true ||
    options.acceptWorkspaceLoss !== true || !options.expectedUrl || !options.reason?.trim()
  )) {
    throw badRequest("dead-host apply requires exact expected URL, deletion and quiescence confirmations, acceptance of workspace loss, and an operator reason");
  }
  if ((options.reason?.length ?? 0) > 2000) throw badRequest("operator reason must be at most 2000 characters");
  return await tx(async (client) => {
    const host = (await client.query<SandboxHostRow>(
      `SELECT * FROM sandbox_hosts WHERE id = $1${dryRun ? "" : " FOR UPDATE"}`, [id],
    )).rows[0];
    if (!host) throw notFound(`no sandbox host "${id}"`);
    if (options.expectedUrl !== undefined && host.url !== options.expectedUrl) {
      throw conflict("dead-host expected URL does not match registered host");
    }
    if (!dryRun && host.status !== "draining") {
      throw conflict("dead-host apply requires a drained host", "run fleet drain first; stop writers before applying");
    }
    // Include gone rows too: active+gone still consumes logical quota, and the
    // ordinary podsOnHost inventory intentionally omits terminal provider rows.
    const rows = (await client.query<PodOnHost>(
      `SELECT id, org_id, name, state, provider_state, provider_sandbox_id, resolved_config
         FROM pods WHERE provider = 'sandbox'
          AND (sandbox_host_id = $2 OR (sandbox_host_id IS NULL AND $3::boolean
            AND resolved_config #>> '{config,providers,sandbox,url}' = $1))
        ORDER BY id${dryRun ? "" : " FOR UPDATE"}`, [host.url, host.id, host.owner_user_id == null],
    )).rows;
    const pods: DeadHostReconcileResult["pods"] = rows.map((pod) => ({
      id: pod.id, state: pod.state, providerState: pod.provider_state,
      action: !["active", "archived"].includes(pod.state) || !["archived", "gone"].includes(pod.provider_state)
        ? "refuse" : pod.state === "archived" && pod.provider_state === "gone" ? "unchanged" : "converge",
    }));
    if (dryRun) return { dryRun, hostId: host.id, url: host.url, pods };
    if (pods.some((pod) => pod.action === "refuse")) {
      throw conflict("dead-host inventory contains unexpected logical/provider states; no rows changed", "review dry-run; this command only handles active/archived + archived/gone");
    }
    for (const [index, pod] of rows.entries()) {
      if (pods[index]!.action !== "converge") continue;
      await client.query(
        `UPDATE pods SET state = 'archived', provider_state = 'gone',
           archived_at = COALESCE(archived_at, now()),
           provider_state_changed_at = CASE WHEN provider_state <> 'gone' THEN now() ELSE provider_state_changed_at END,
           state_reason = 'operator confirmed host permanently deleted; workspace recovery abandoned',
           work_lease_until = NULL, updated_at = now()
         WHERE id = $1`, [pod.id],
      );
      await audit({
        orgId: pod.org_id, actorId: null, action: "pod.reconcile_dead_host",
        targetType: "pod", targetId: pod.id,
        detail: {
          hostId: host.id, hostUrl: host.url, operatorReason: options.reason!.trim(),
          hostDeletedConfirmed: true, quiescenceConfirmed: true, workspaceLossAccepted: true,
          fromState: pod.state, fromProviderState: pod.provider_state,
          toState: "archived", toProviderState: "gone", providerSandboxId: pod.provider_sandbox_id,
        },
      }, client);
    }
    return { dryRun, hostId: host.id, url: host.url, pods };
  });
}

export interface PodOnHost {
  sandbox_host_id?: string | null;
  user_id?: string;
  updated_at?: string;
  id: string;
  org_id: string;
  name: string;
  state: string;
  provider_state: string;
  provider_sandbox_id: string | null;
  resolved_config: ResolvedConfigReport;
}

/** Stable assignment wins; URL fallback is only for unmapped historical STATIC pods. */
export async function podsOnHost(host: SandboxHostRow): Promise<PodOnHost[]> {
  const rows = await query<PodOnHost>(
    `SELECT id, org_id, user_id, sandbox_host_id, updated_at::text, name, state, provider_state, provider_sandbox_id, resolved_config
       FROM pods
      WHERE provider = $1
        AND provider_state <> 'gone'
        AND (sandbox_host_id = $3 OR (sandbox_host_id IS NULL AND $4::boolean
          AND resolved_config #>> '{config,providers,sandbox,url}' = $2))
      ORDER BY created_at`,
    [SANDBOX_PROVIDER_NAME, host.url, host.id, host.owner_user_id == null],
  );
  return rows.rows;
}

export async function probeSandboxHost(host: SandboxHostRow, deps: FleetClientDeps = {}): Promise<SandboxHostHealth> {
  const unreachable: SandboxHostHealth = {
    host,
    reachable: false,
    health: null,
    reportsCapacity: false,
    freeMemoryBytes: 0,
    freeCpu: 0,
    freeDiskBytes: 0,
    capacity: null,
    capacityStatus: "absent",
  };
  if (!hostCanDial({ boat_state: host.boat_state ?? null }) || !(host.hosted_url ?? host.url)) return unreachable;
  let health: HealthResponse;
  try {
    const client = deps.kek || host.owner_user_id != null
      ? await sandboxFleetClient(host, deps)
      : new SandboxClient((host.hosted_url ?? host.url)!, "", { timeoutMs: PROBE_TIMEOUT_MS, readRetries: 0 });
    health = deps.kek || host.owner_user_id != null
      ? await client.json<HealthResponse>("GET", "/v1/healthz")
      : await client.publicJson<HealthResponse>("/v1/healthz");
    if (!health || health.ok !== true || !health.host || typeof health.host !== "object") return unreachable;
  } catch {
    return unreachable;
  }
  // A host that predates fleet support reports no commitments. Treating its headroom as zero
  // would exclude it from placement forever, so it is admitted with no claim about capacity
  // and its own admission control gets the final say.
  const capacity = health.host.guaranteeCapacity;
  const committed = health.host.committed;
  // The versioned capacity contract rides along on healthz (host aggregates
  // only, no tenant data). Absent vs malformed vs misidentified are distinct
  // verdicts (§6.4): only a validated, identity-bound report is usable, and
  // only a genuinely absent one may take the legacy compat path.
  const rawCapacity: unknown = (health as { capacity?: unknown }).capacity;
  const validated = validateCapacityReport(rawCapacity);
  let probedCapacity: CapacityReportV1 | null = null;
  let capacityStatus: SandboxHostHealth["capacityStatus"] = "absent";
  if (rawCapacity !== undefined && rawCapacity !== null) {
    if (validated === null) {
      capacityStatus = "malformed";
    } else if (validated.hostId !== host.id) {
      capacityStatus = "identity-mismatch";
    } else {
      probedCapacity = validated;
      capacityStatus = "ok";
    }
  }
  return {
    host,
    reachable: true,
    health,
    reportsCapacity: capacity !== undefined && committed !== undefined,
    freeMemoryBytes: Math.max(0, (capacity?.memoryBytes ?? 0) - (committed?.memoryBytes ?? 0)),
    freeCpu: Math.max(0, (capacity?.cpu ?? 0) - (committed?.cpu ?? 0)),
    freeDiskBytes: Math.max(
      0,
      (health.host.diskCapacityBytes ?? 0) - (committed?.diskBytes ?? 0),
    ),
    capacity: probedCapacity,
    capacityStatus,
  };
}

/**
 * Default probe fan-out bound for recurring sweeps (M6/M10). Matches the
 * usage collector's `USAGE_COLLECTION_MAX_HOSTS` default (4) and the boat
 * activity tick's batch of 4: a sweep must never open one connection per
 * host when the fleet is thousands of rows. Callers that probe a handful of
 * placement candidates or answer one operator command omit the bound and
 * keep the previous unbounded fan-out.
 */
export const FLEET_SWEEP_PROBE_CONCURRENCY = 4;

export async function probeSandboxHosts(
  hosts: SandboxHostRow[],
  deps: FleetClientDeps = {},
  opts: { maxConcurrency?: number } = {},
): Promise<SandboxHostHealth[]> {
  const bound = opts.maxConcurrency === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(opts.maxConcurrency));
  if (!Number.isFinite(bound) || bound >= hosts.length) {
    return await Promise.all(hosts.map((host) => probeSandboxHost(host, deps)));
  }
  // Bounded worker pool over stable input order: results align with `hosts`
  // by index, exactly like `Promise.all`. Index handoff is synchronous
  // between awaits, so no two workers share a slot.
  const out = new Array<SandboxHostHealth>(hosts.length);
  let next = 0;
  const runOne = async (): Promise<void> => {
    while (next < hosts.length) {
      const index = next;
      next += 1;
      out[index] = await probeSandboxHost(hosts[index]!, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(bound, hosts.length) }, () => runOne()));
  return out;
}

/** Legacy STATIC URL lookup. Owned hosts require an explicit stable assignment. */
export async function sandboxHostByUrl(url: unknown): Promise<SandboxHostRow | null> {
  if (typeof url !== "string" || url === "") return null;
  const rows = await query<SandboxHostRow>(`SELECT * FROM sandbox_hosts WHERE owner_user_id IS NULL AND (url = $1 OR hosted_url = $1)`, [url]);
  return rows.rows[0] ?? null;
}

/**
 * Another host for a launch its own host just refused, or null to let the refusal stand.
 *
 * Only a sandbox host's admission control (HTTP 507) earns a second attempt. Any other failure
 * would repeat on the next host, and retrying it would turn one broken launch into several.
 * `refused` accumulates across attempts, so a full fleet is walked once rather than cycled.
 */
export async function placeAfterRefusal(
  providerName: string,
  providerConfig: Record<string, unknown>,
  error: unknown,
  refused: Set<string>,
  placementMode: SandboxPlacementMode = sandboxPlacementMode(),
  deps: FleetClientDeps = {},
): Promise<SandboxHostRow | null> {
  if (providerName !== SANDBOX_PROVIDER_NAME) return null;
  if (!(error instanceof PiPodError) || error.status !== SANDBOX_ADMISSION_DENIED) return null;
  const host = await sandboxHostByUrl(providerConfig["url"]);
  if (!host) return null;
  refused.add(host.id);
  try {
    return await placeSandboxHost(refused, placementMode, deps);
  } catch {
    // The fleet has nothing left to offer; the caller reports the refusal it already has.
    return null;
  }
}

/**
 * Evidence screening shared by every fleet placement path (§6.4).
 *
 * Waiting controls queueing — never whether evidence is verified: this runs
 * identically for first placements, failovers, and provisional picks. Verdicts:
 * - malformed / identity-mismatch: never eligible, any mode. Invalid or
 *   misidentified evidence must never degrade into legacy trust.
 * - absent (genuinely pre-contract): eligible only in single mode (deliberate
 *   single-host/BYOK compat) or with explicit `allowLegacyHosts` (fleet
 *   rolling-upgrade compat); otherwise refused as `legacy_contract`.
 * - floor admission: refused as `unsupported_admission` wherever a contract
 *   is present — a host accounting only the floor cannot uphold
 *   full-ceiling platform admission under concurrency, in any mode.
 *   Hosts with no contract at all keep the legacy compat above (their
 *   accounting is unknown, and their own admission stays final).
 * Malformed/mismatch/floor/legacy refusals are all non-retryable: no
 * bounded wait can fix evidence or configuration.
 */
export function screenHostEvidence(
  probed: SandboxHostHealth[],
  opts: { placementMode: SandboxPlacementMode; allowLegacyHosts: boolean; ownerUserId?: string },
): { eligible: SandboxHostHealth[]; refusals: PlacementRefusal[] } {
  const eligible: SandboxHostHealth[] = [];
  const refusals: PlacementRefusal[] = [];
  const refuse = (
    candidate: SandboxHostHealth,
    reason: "legacy_contract" | "malformed_capacity" | "host_mismatch" | "unsupported_admission",
    detailReason: string,
  ): void => {
    refusals.push({
      hostId: candidate.host.id,
      reason,
      detail: {
        kind: "admission",
        reason: detailReason,
        resource: reason === "unsupported_admission" ? "memory" : "transitions",
        unit: reason === "unsupported_admission" ? "bytes" : "count",
        retryable: false,
      },
    });
  };
  for (const candidate of probed) {
    const report = candidate.capacity;
    if (!report) {
      if (candidate.capacityStatus === "absent") {
        if (opts.placementMode !== "fleet" || opts.allowLegacyHosts) {
          eligible.push(candidate);
        } else {
          refuse(candidate, "legacy_contract", "legacy_contract");
        }
        continue;
      }
      refuse(
        candidate,
        candidate.capacityStatus === "identity-mismatch" ? "host_mismatch" : "malformed_capacity",
        candidate.capacityStatus === "identity-mismatch" ? "host_mismatch" : "malformed_capacity",
      );
      continue;
    }
    if (opts.ownerUserId !== undefined && (candidate.host.owner_user_id !== opts.ownerUserId ||
        candidate.host.boat_state !== "running" || !candidate.host.boat_id || !candidate.host.runtime_boot_id ||
        report.bootId !== candidate.host.runtime_boot_id || report.hostId !== candidate.host.id)) {
      refuse(candidate, "host_mismatch", "host_mismatch");
      continue;
    }
    if (opts.ownerUserId !== undefined ? report.capabilities.boat !== true : report.capabilities.memoryAdmission !== "ceiling") {
      refuse(candidate, "unsupported_admission", "unsupported_admission");
      continue;
    }
    eligible.push(candidate);
  }
  return { eligible, refusals };
}

/**
 * Choose the host a new sandbox should be created on, or null when no fleet is registered.
 *
 * Null is the single-host deployment: nothing was ever registered, so the caller keeps using
 * the deployment's configured URL. In `fleet` mode there is no null: zero eligible active
 * hosts is a typed capacity/unavailable result, never a silent fallback to
 * PI_POD_SANDBOX_URL (plan §4.1). Every candidate is probed in fleet mode —
 * including a lone one: admission policy, identity, and contract evidence
 * are verified whether waiting controls queueing or not. Single mode keeps
 * the unprobed shortcut for its lone-host deployment.
 * Once a host has refused, every remaining candidate is probed:
 * handing back an unreachable host would replace a truthful capacity error with a connection
 * error.
 */
/**
 * Server-constructed fleet-unavailable throw (plan §4.1: zero eligible or
 * reachable workers in fleet mode).
 *
 * The message stays throw-site-specific (server-side only — the HTTP
 * boundary renders {@link FLEET_UNAVAILABLE_MESSAGE} instead, never this
 * text); the detail is the allowlisted `fleet_unavailable` shape the HTTP
 * boundary answers as a retryable 503. `kind: "fleet"` keeps it out of
 * admission-evidence classification: the wait queue still treats an
 * unreachable fleet as fail-fast, exactly as before.
 */
export function fleetUnavailableError(message: string): HttpError {
  return serviceUnavailable(message, {
    kind: "fleet",
    code: FLEET_UNAVAILABLE_CODE,
    reason: FLEET_UNAVAILABLE_CODE,
    retryable: true,
    retryAfterMs: FLEET_UNAVAILABLE_RETRY_AFTER_MS,
  });
}

export async function placeSandboxHost(
  exclude: ReadonlySet<string> = new Set(),
  placementMode: SandboxPlacementMode = sandboxPlacementMode(),
  opts: FleetClientDeps & { allowLegacyHosts?: boolean } = {},
): Promise<SandboxHostRow | null> {
  const registered = await listSandboxHosts();
  const active = registered.filter((host) => host.status === "active" && host.owner_user_id == null && !!host.url && hostCanDial({ boat_state: host.boat_state ?? null }) && !exclude.has(host.id));
  if (!active.length && registered.length && placementMode === "single") throw fleetUnavailableError("no eligible static sandbox host is awake");
  if (active.length === 0) {
    if (exclude.size > 0) {
      throw serviceUnavailable(
        "every active sandbox host refused this pod",
        "the fleet is at capacity; register another host or free one",
      );
    }
    if (placementMode === "fleet") {
      // Typed fleet-unavailable: plan-time callers (resolve, POST /pods)
      // surface this as a retryable 503 instead of a genericized 500.
      // Message unchanged (existing tests match it).
      throw fleetUnavailableError("no active sandbox host is available");
    }
    return null;
  }
  if (active.length === 1 && exclude.size === 0 && placementMode !== "fleet") return active[0]!;

  const probed = await probeSandboxHosts(active, opts);
  const reachable = probed.filter((candidate) => candidate.reachable);
  if (reachable.length === 0) {
    // Host ids stay server-side (fail-closed: never raw text on the wire);
    // the tried-count survives in the message for operator logs.
    throw fleetUnavailableError(
      `no sandbox host in the fleet answered with room for a sandbox (tried ${active.length} host(s))`,
    );
  }
  // Evidence first (§6.4): malformed/misidentified reports never place;
  // legacy and floor admission follow the fleet compat policy below.
  const { eligible: evidenced, refusals } = screenHostEvidence(reachable, {
    placementMode,
    allowLegacyHosts: opts.allowLegacyHosts ?? false,
  });
  const shortlisted = evidenced.filter(
    (candidate) =>
      // A host out of state-filesystem headroom would 507 every create.
      // Skipping it here costs one round trip; choosing it costs a failed
      // attempt. Hosts that report no commitments at all (!reportsCapacity)
      // are not judged on numbers they never sent.
      !candidate.reportsCapacity || candidate.freeDiskBytes > 0,
  );
  if (shortlisted.length === 0) {
    if (refusals.length > 0 && refusals.every((refusal) => refusal.reason === "legacy_contract")) {
      throw serviceUnavailable(
        "all fleet hosts predate the capacity contract",
        "upgrade the hosts or explicitly allow legacy placement with SANDBOX_ALLOW_LEGACY_HOSTS=true",
      );
    }
    if (refusals.length > 0 && refusals.every((refusal) => refusal.reason === "unsupported_admission")) {
      throw serviceUnavailable(
        "all fleet hosts admit with floor accounting, which cannot uphold full-ceiling placement",
        "configure the hosts for ceiling memory admission",
      );
    }
    throw serviceUnavailable(
      "no sandbox host in the fleet answered with room for a sandbox",
      `tried ${active.length} host(s): ${active.map((host) => host.id).join(", ")}`,
    );
  }
  // Memory is the binding constraint: every sandbox holds the same fixed floor, so the host
  // with the most free memory guarantee is the one that can take the most more sandboxes.
  return shortlisted.sort(
    (left, right) =>
      right.freeMemoryBytes - left.freeMemoryBytes || left.host.id.localeCompare(right.host.id),
  )[0]!.host;
}

/** How old a capacity sample may be before placement stops trusting it. */
export const DEFAULT_CAPACITY_FRESHNESS_MS = 30_000;

/**
 * Ask a fairness-degraded host whether one specific tenant holds an ACTIVE
 * grant there (then per-tenant gating admits it despite degraded mode).
 * False for unknown tenants (no grant yet — the allocator must issue one
 * first; the bounded wait covers that race), for non-active grants, and for
 * any lookup failure (conservative: degraded stays excluded).
 *
 * Token is explicit (boot snapshot from the caller): this runs on server hot
 * paths where ambient process.env may hold a BYO overlay.
 */
export async function checkTenantGrantActive(
  host: SandboxHostRow,
  ownerKey: string,
  platformTokenValue?: string | null,
  kek?: KekProvider,
): Promise<boolean> {
  const token = platformTokenValue ?? null;
  if (!token && !kek) return false;
  try {
    const status = await (await sandboxFleetClient(host, { platformToken: token, ...(kek ? { kek } : {}) })).getTenantStatus(ownerKey);
    return status.grant !== null && status.grant.state === "active" && status.degraded === false;
  } catch {
    return false;
  }
}

/**
 * Pinned-wake/host evidence verdict for platform-fleet cold admission.
 *
 * Same policy as placement screening, adapted for pinned routing: the
 * workspace cannot move, so every verdict either admits or fails fast with
 * a non-destructive typed error — there is no wait queue and no fallback
 * host. `unknown` covers probe failures and unreadable bodies: evidence we
 * cannot read is evidence we cannot trust.
 */
export type PinnedEvidenceVerdict =
  | "ok"
  | "missing"
  | "malformed"
  | "mismatch"
  | "stale"
  | "floor"
  | "unknown";

export async function checkPinnedHostEvidence(
  url: string,
  hostId: string,
  freshnessMs: number = DEFAULT_CAPACITY_FRESHNESS_MS,
  nowMs?: number,
  client?: SandboxClient,
  ownedBoat?: { bootId: string },
): Promise<PinnedEvidenceVerdict> {
  let health: { capacity?: unknown };
  try {
    health = client ? await client.json<{ capacity?: unknown }>("GET", "/v1/healthz")
      : await new SandboxClient(url, "").publicJson<{ capacity?: unknown }>("/v1/healthz");
  } catch {
    return "unknown";
  }
  // Reference time is taken AFTER the probe: the sample is generated during
  // the fetch, so a call-time timestamp would read every fresh sample as
  // future-dated (negative age) and misreport it stale.
  const effectiveNow = nowMs ?? Date.now();
  const raw = health.capacity;
  if (raw === undefined || raw === null) return "missing";
  const report = validateCapacityReport(raw);
  if (!report) return "malformed";
  if (report.hostId !== hostId) return "mismatch";
  const ageMs = effectiveNow - Date.parse(report.sampledAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > freshnessMs) return "stale";
  if (ownedBoat) {
    if (report.bootId !== ownedBoat.bootId) return "mismatch";
    if (report.capabilities.boat !== true) return "floor";
  } else if (report.capabilities.memoryAdmission !== "ceiling") return "floor";
  return "ok";
}

/**
 * Human + typed rendering of a pinned-evidence refusal. Messages name the
 * remedy; details stay numeric/enum-only for clients. All non-retryable:
 * evidence and configuration do not heal inside a wait deadline.
 */
export function pinnedEvidenceRefusal(
  hostId: string,
  verdict: Exclude<PinnedEvidenceVerdict, "ok">,
): [message: string, detail: Record<string, unknown>] {
  switch (verdict) {
    case "floor":
      return [
        "this pod's host admits with floor accounting, which cannot uphold full-ceiling placement",
        { kind: "admission", reason: "unsupported_admission", resource: "memory", unit: "bytes", retryable: false },
      ];
    case "missing":
      return [
        `sandbox host "${hostId}" reports no capacity contract; upgrade the host to place or wake platform workloads there`,
        { kind: "admission", reason: "legacy_contract", resource: "transitions", unit: "count", retryable: false },
      ];
    case "malformed":
      return [
        `sandbox host "${hostId}" reports an unreadable capacity contract; fix the host before placing or waking platform workloads there`,
        { kind: "admission", reason: "malformed_capacity", resource: "transitions", unit: "count", retryable: false },
      ];
    case "mismatch":
      return [
        `sandbox host "${hostId}" reports capacity for a different host identity; check HOST_ID configuration`,
        { kind: "admission", reason: "host_mismatch", resource: "transitions", unit: "count", retryable: false },
      ];
    case "stale":
      return [
        `sandbox host "${hostId}" reports a stale capacity sample; check host clocks and retry`,
        { kind: "admission", reason: "transition_capacity", resource: "transitions", unit: "count", retryable: false },
      ];
    case "unknown":
      return [
        `sandbox host "${hostId}" did not answer a readable capacity report; check the host before waking platform workloads there`,
        { kind: "admission", reason: "malformed_capacity", resource: "transitions", unit: "count", retryable: false },
      ];
  }
}

/**
 * Pinned-workspace custody classification (who funds this pod, authoritatively).
 *
 * Pure decision table so it can be evaluated without a database. Inputs:
 * - provider: only `sandbox` platform launches are gated; all other
 *   providers keep their own admission untouched.
 * - placementMode: single mode preserves deliberate compat (dev/BYOK).
 * - hasUrl: whether the frozen launch mapping names a host URL. A missing
 *   mapping is not single/BYOK evidence — in fleet mode it refuses exactly
 *   like an unregistered URL for platform/unknown custody.
 * - hostRowPresent: the frozen URL names a registered fleet host.
 * - credentialSource: the pod's authoritative launch custody
 *   (`pod_retention.credential_source`; null = legacy/unknown).
 *
 * Outcomes:
 * - `fleet-gated`: run the full evidence gate (validated/fresh/bound/ceiling).
 * - `compat-skip`: genuine BYOK/single paths proceed on host admission.
 * - `refuse-unregistered`: fleet mode, sandbox provider, NO registered
 *   host (or no frozen URL at all), and custody is `platform` or unknown —
 *   a known-or-possibly platform workspace whose host mapping is gone must
 *   fail non-destructively, never silently become BYOK or fall through to
 *   default-provider routing. Unknown custody cannot justify platform
 *   credential admission (fail closed).
 *
 * DB/registry read failures never reach this function: callers propagate
 * them (a failed lookup is not BYOK evidence).
 */
export type PinnedCustody = "fleet-gated" | "compat-skip" | "refuse-unregistered";

export function classifyPinnedCustody(args: {
  provider: string;
  placementMode: SandboxPlacementMode;
  hasUrl: boolean;
  hostRowPresent: boolean;
  credentialSource: "platform" | "org-secret" | null;
}): PinnedCustody {
  if (args.provider !== SANDBOX_PROVIDER_NAME) return "compat-skip";
  if (args.placementMode !== "fleet") return "compat-skip";
  // Genuine BYOK first: an org-funded service proceeds on host admission
  // (which resolves org credentials first), with or without a frozen URL.
  if (args.credentialSource === "org-secret") return "compat-skip";
  // Platform or unknown custody needs a registered pinned host: a missing
  // frozen URL is a missing mapping, never single/BYOK evidence, so it
  // refuses exactly like an unregistered URL — never default routing.
  if (args.hasUrl && args.hostRowPresent) return "fleet-gated";
  return "refuse-unregistered";
}

export function capacityFreshnessMs(env?: { CAPACITY_FRESHNESS_SECONDS?: unknown }): number {
  const seconds = env?.CAPACITY_FRESHNESS_SECONDS;
  if (typeof seconds === "number" && Number.isFinite(seconds)) {
    return Math.min(300, Math.max(5, Math.floor(seconds))) * 1000;
  }
  return DEFAULT_CAPACITY_FRESHNESS_MS;
}

export interface RequestPlacement extends FleetClientDeps {
  /** Server-authenticated personal acquisition; never supplied from request JSON. */
  ownerUserId?: string;
  /** When set, only this host may be chosen. A refusal does not fall through. */
  exactHostId?: string;
  /** Resolved request shape (omitted fields already defaulted to standard). */
  shape: ResolvedShape;
  exclude?: ReadonlySet<string>;
  placementMode?: SandboxPlacementMode;
  /** Freshness window for capacity samples; older samples are assumed to have no headroom. */
  freshnessMs?: number;
  nowMs?: number;
  /**
   * Explicit opt-in to legacy hosts (no capacity contract) in fleet mode.
   * Default off: fleet placement requires the versioned contract once the
   * fleet speaks it. Single mode always keeps the legacy compat path.
   */
  allowLegacyHosts?: boolean;
  /**
   * Requesting owner's opaque key (when known). Used ONLY to ask a
   * fairness-degraded host whether THIS tenant holds an active grant
   * (then the host can take it despite degraded mode); never for identity.
   */
  ownerKey?: string;
  /**
   * Boot-snapshot platform token for the per-tenant degraded check above.
   * Omitted (tests/CLI): the check conservatively reports false.
   */
  platformToken?: string | null;
}

export interface PlacedHost {
  host: SandboxHostRow;
  /** Validated capacity report, or null for legacy hosts (compat path). */
  capacity: CapacityReportV1 | null;
}

export interface PlacementRefusal {
  hostId: string;
  reason: string;
  detail: Record<string, unknown> | null;
}

/**
 * Request-aware placement (§6.4): filter workers by capability AND actual
 * request fit, then rank by documented headroom + validated CPU pressure.
 *
 * Unlike the legacy path, every candidate is probed — including a lone one.
 * A single stale/unreachable candidate must surface as a truthful capacity
 * error, not as a blind create that times out. A health probe stays advisory:
 * the host's atomic admission is final, so callers still handle 507/400.
 *
 * Throws typed errors the caller renders without provider prose:
 * - 503 (retryable, wait-eligible) when hosts refuse with capacity reasons;
 * - 400 `unsupported_shape` when every reachable host refuses the shape
 *   itself (never silently clamped, never queued — shrinking or another
 *   fleet is the only remedy).
 */
export async function placeSandboxHostForRequest(args: RequestPlacement): Promise<PlacedHost | null> {
  const exclude = args.exclude ?? new Set<string>();
  const placementMode = args.placementMode ?? sandboxPlacementMode();
  const freshnessMs = args.freshnessMs ?? DEFAULT_CAPACITY_FRESHNESS_MS;
  const registeredAll = args.ownerUserId === undefined ? await listSandboxHosts() :
    (await query<SandboxHostRow>("SELECT * FROM sandbox_hosts WHERE owner_user_id=$1", [args.ownerUserId])).rows;
  const registered = args.exactHostId ? registeredAll.filter((host) => host.id === args.exactHostId) : registeredAll;
  if (args.exactHostId && registered.length === 0) {
    throw serviceUnavailable("this pod's boat is not eligible", {
      kind: "admission", reason: "transition_capacity", resource: "transitions", unit: "count", retryable: true,
      hostId: args.exactHostId,
    });
  }
  const active = registered.filter((host) => host.status === "active" &&
    (args.ownerUserId === undefined ? host.owner_user_id == null : host.owner_user_id === args.ownerUserId) &&
    !!host.url && hostCanDial({ boat_state: host.boat_state ?? null }) && !exclude.has(host.id));
  if (!active.length && registered.length && placementMode === "single") throw fleetUnavailableError("no eligible static sandbox host is awake");
  if (active.length === 0) {
    if (exclude.size > 0) {
      throw serviceUnavailable(
        "every active sandbox host refused this pod",
        "the fleet is at capacity; register another host or free one",
      );
    }
    if (placementMode === "fleet") {
      // Same typed shape as the legacy path: zero eligible/reachable
      // workers read as fleet-unavailable at every plan-time surface.
      throw fleetUnavailableError("no active sandbox host is available");
    }
    // Single-host deployment with an empty fleet: null keeps the caller on the
    // deployment's configured URL (legacy behavior, unchanged).
    return null;
  }

  const probed = await probeSandboxHosts(active, args);
  const reachable = probed.filter((candidate) => candidate.reachable);
  // Reference time is taken AFTER probing: a sample generated during the probe
  // must not read as future-dated (negative age) against an earlier timestamp.
  const nowMs = args.nowMs ?? Date.now();
  if (reachable.length === 0) {
    throw fleetUnavailableError(
      `no sandbox host in the fleet answered with room for a sandbox (tried ${active.length} host(s))`,
    );
  }

  const allowLegacyHosts = args.allowLegacyHosts ?? false;
  // Evidence first, shared with the legacy path (screenHostEvidence):
  // malformed/misidentified reports never place; legacy needs explicit
  // fleet compat; floor-mode hosts cannot uphold ceiling admission. Waiting
  // controls queueing, never whether this verification happens.
  const screened = screenHostEvidence(reachable, { placementMode, allowLegacyHosts, ownerUserId: args.ownerUserId });
  const refusals: PlacementRefusal[] = [...screened.refusals];
  const eligible: Array<{ health: (typeof reachable)[number]; fit: CapacityFit }> = [];
  for (const candidate of screened.eligible) {
    const report = candidate.capacity;
    if (!report) {
      // Explicit legacy compat (single mode, or fleet with the flag): no
      // contract to check freshness, fairness, or fit against. Ranked last;
      // the host's own admission stays final.
      eligible.push({ health: candidate, fit: { fits: true } });
      continue;
    }
    const ageMs = nowMs - Date.parse(report.sampledAt);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > freshnessMs) {
      // Stale snapshot: assume no headroom rather than placing on old news.
      refusals.push({
        hostId: candidate.host.id,
        reason: "stale_capacity",
        detail: { kind: "admission", reason: "transition_capacity", resource: "transitions", unit: "count", retryable: true },
      });
      continue;
    }
    if (report.fairness && shouldCheckTenantGrant(report.fairness)) {
      // Any managed host with its admission gate on refuses grantless
      // tenants at create time (W12: mode alone never answers for THIS
      // owner — `grants` with zero degraded tenants still refused the
      // incident's first create), so ask the host — but only when we know
      // who is asking and hold the platform token. An owner WITH an active
      // grant is still admitted; anything uncertain stays excluded
      // (conservative). Gate-off hosts (documented rollback) skip this:
      // the host admits everyone onto the bounded fallback.
      const tenantOk =
        args.ownerKey !== undefined && args.ownerKey !== ""
          ? await checkTenantGrantActive(candidate.host, args.ownerKey, args.platformToken, args.kek).catch(() => false)
          : false;
      if (!tenantOk) {
        refusals.push({
          hostId: candidate.host.id,
          reason: "fairness_degraded",
          detail: { kind: "admission", reason: "fairness_degraded", resource: "fairness", unit: "count", retryable: true },
        });
        continue;
      }
    }
    const fit = args.ownerUserId === undefined ? checkRequestFit(report, args.shape) : checkOwnedBoatRequestFit(report, args.shape);
    if (!fit.fits) {
      refusals.push({
        hostId: candidate.host.id,
        reason: fit.reason ?? "unknown",
        detail: {
          kind: "admission",
          reason: fit.reason,
          resource:
            fit.reason === "memory_capacity" || fit.reason === "memory_debt"
              ? "memory"
              : fit.reason === "cpu_capacity" ? "cpu" : fit.reason === "disk_capacity"
                ? "disk"
                : fit.reason === "transition_capacity"
                  ? "transitions"
                  : fit.reason === "unsupported_admission"
                    ? "memory"
                    : "shape",
          unit:
            fit.reason === "cpu_capacity" ? "cores" : fit.reason === "transition_capacity"
              ? "count"
              : fit.reason === "unsupported_shape"
                ? "gb"
                : "bytes",
          // Only genuinely transient pressure (capacity, debt draining,
          // transitions) waits. A too-large shape or a floor-accounting host
          // needs request or operator changes, not a 60s queue.
          retryable: fit.reason !== "unsupported_shape" && fit.reason !== "unsupported_admission",
          ...(fit.requiredBytes === undefined ? {} : { required: fit.requiredBytes }),
          ...(fit.availableBytes === undefined ? {} : { available: fit.availableBytes }),
        },
      });
      continue;
    }
    eligible.push({ health: candidate, fit });
  }

  if (eligible.length === 0) {
    // Every reachable host refused the shape itself: not a capacity condition,
    // never queued, never retried — shrink the request or grow the fleet.
    if (refusals.length > 0 && refusals.every((refusal) => refusal.reason === "unsupported_shape")) {
      throw badRequest(
        "this sandbox size is not supported on the available hosts",
        "request a smaller shape or register a host with a larger maximum",
      );
    }
    // Uniform deployment conditions get actionable messages instead of the
    // generic capacity sentence: each names the remedy (upgrade hosts,
    // reconfigure admission, fix the deployment).
    if (refusals.length > 0 && refusals.every((refusal) => refusal.reason === "legacy_contract")) {
      throw serviceUnavailable(
        "all fleet hosts predate the capacity contract",
        "upgrade the hosts or explicitly allow legacy placement with SANDBOX_ALLOW_LEGACY_HOSTS=true",
      );
    }
    if (refusals.length > 0 && refusals.every((refusal) => refusal.reason === "unsupported_admission")) {
      throw serviceUnavailable(
        "all fleet hosts admit with floor accounting, which cannot uphold full-ceiling placement",
        "configure the hosts for ceiling memory admission",
      );
    }
    const first = refusals.find((refusal) => refusal.reason !== "stale_capacity") ?? refusals[0];
    // Carry the first refusal's typed detail (validated numbers/enums) so
    // wait rows and clients render the real condition; the message keeps the
    // per-host summary operators need (first few, not the whole fleet).
    const summary = refusals
      .slice(0, 3)
      .map((refusal) => `${refusal.hostId} (${refusal.reason})`)
      .join(", ");
    const remainder = refusals.length > 3 ? ` +${refusals.length - 3} more` : "";
    throw serviceUnavailable(
      "the fleet is at capacity; retry shortly",
      {
        hosts: `${summary}${remainder}`,
        ...(first?.detail ?? {}),
      },
    );
  }

  const ranked = rankCandidates(
    eligible.map(({ health, fit }) => ({
      hostId: health.host.id,
      memoryHeadroomBytes:
        health.capacity !== null
          ? Math.max(0, health.capacity.memory.availableBytes - args.shape.memoryBytes)
          : 0,
      diskHeadroomBytes:
        health.capacity !== null
          ? Math.max(0, health.capacity.disk.availableBytes - args.shape.diskBytes)
          : 0,
      cpuPressure: health.capacity?.cpu.pressureAvg10 ?? -1,
      legacy: health.capacity === null,
    })),
  );
  const winner = eligible.find((entry) => entry.health.host.id === ranked[0]!.hostId)!;
  return { host: winner.health.host, capacity: winner.health.capacity };
}

/**
 * Extract the validated typed detail from a host refusal, if it carried one.
 * Render user messages from this (validated numbers/enums), never from the
 * host's free-form message — the sanitizer may already have dropped that.
 */
export function typedRefusalDetail(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof PiPodError) {
    const cause = (error as { cause?: unknown }).cause;
    const details = sanitizeErrorDetails(cause ?? error);
    if (details) return details;
    // PiPodError from the adapter wraps SandboxApiError as cause; the details
    // ride on the inner error's `details` field.
    const inner = (cause as { details?: unknown } | null)?.details;
    if (inner !== undefined) return sanitizeErrorDetails({ details: inner });
  }
  return sanitizeErrorDetails(error);
}

/**
 * Fleet hosts are platform infrastructure and all accept the platform token, which is also
 * what makes an archived workspace portable between them. An organization that brings its own
 * sandbox token is pointing at its own service through an explicit `providers.sandbox.url`,
 * and placement leaves those launches alone.
 *
 * The token is explicit (a boot snapshot from the caller: CLI reads once in
 * run(), server workers pass deps). No ambient fallback: fleet operations
 * are safety-critical (archive/rehome/import) and must never run under a
 * transient BYO overlay key.
 */
async function fleetClient(host: SandboxHostRow, platformTokenValue: string | null, kek?: KekProvider): Promise<SandboxClient> {
  if (!platformTokenValue && !kek) {
    throw badRequest(
      `${PROVIDER_META.sandbox.credentialEnv} is not set in this server's environment`,
      "fleet operations use the platform token every host accepts",
    );
  }
  return sandboxFleetClient(host, { platformToken: platformTokenValue, ...(kek ? { kek } : {}) });
}

/**
 * Stop taking new sandboxes. Existing pods keep working: their workspaces are local to this
 * host, so the host empties as their own retention timers archive them.
 */
export async function drainSandboxHost(id: string): Promise<SandboxHostRow> {
  return await setSandboxHostStatus(id, "draining");
}

/**
 * Archive every pod still holding a workspace on this host, so it can be emptied now rather
 * than when retention timers say so. This interrupts running work — a drain that waits does
 * not — which is why it is a separate, explicit step.
 */
export async function archivePodsOnHost(
  host: SandboxHostRow,
  platformTokenValue: string | null,
  onProgress?: (message: string) => void,
  kek?: KekProvider,
): Promise<{ archived: string[]; failed: Array<{ pod: string; reason: string }> }> {
  const client = await fleetClient(host, platformTokenValue, kek);
  const archived: string[] = [];
  const failed: Array<{ pod: string; reason: string }> = [];
  for (const pod of await podsOnHost(host)) {
    if (!pod.provider_sandbox_id) continue;
    if (pod.provider_state === "archived") continue;
    try {
      await client.json<void>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(pod.provider_sandbox_id)}/archive`,
        { timeoutMs: ARCHIVE_TIMEOUT_MS },
      );
      archived.push(pod.id);
      onProgress?.(`archived ${pod.name} (${pod.id})`);
    } catch (error) {
      failed.push({ pod: pod.id, reason: describeFailure(error) });
    }
  }
  return { archived, failed };
}

/**
 * The host production's `preload-image` talks to when `sandbox_hosts` is empty: the same URL
 * a single-host deployment already dials. Not inserted into the table — registering it would
 * change placement, which this pull must not.
 */
function defaultSandboxHost(): SandboxHostRow {
  return {
    id: DEFAULT_FLEET_PRELOAD_HOST_ID,
    synthetic: true,
    url: resolveSandboxServiceUrl(
      undefined,
      process.env["PI_POD_SANDBOX_URL"] ?? DEFAULT_SANDBOX_SERVICE_URL,
    ),
    status: "active",
    created_at: "",
    updated_at: "",
  };
}

/**
 * Pull one image into every registered host's content store.
 *
 * A host that has never been asked for the private base image cannot boot a pod on it, and the
 * launch-time error correctly says so rather than guessing. This is the fleet-wide form of the
 * rollout preload: the production deploy workflow runs it after a healthy server rollout and
 * does not complete until the newly published tag reaches every machine. Registry `auth` is
 * forwarded on that POST only; it is never written down.
 *
 * With no hosts registered, the deployment's `PI_POD_SANDBOX_URL` is preloaded instead, which
 * is the single-host path the empty table already means.
 */
export async function preloadImageOnFleet(
  ref: string,
  auth: { username: string; password: string } | null,
  platformTokenValue: string | null,
  onProgress?: (message: string) => void,
  placementMode: SandboxPlacementMode = sandboxPlacementMode(),
  kek?: KekProvider,
): Promise<{ preloaded: string[]; failed: Array<{ host: string; reason: string }> }> {
  const preloaded: string[] = [];
  const failed: Array<{ host: string; reason: string }> = [];
  const hosts = await listSandboxHosts();
  if (hosts.length === 0 && placementMode === "fleet") {
    throw serviceUnavailable(
      "no active sandbox host is available",
      "the fleet is empty; register a worker before preloading images",
    );
  }
  const targets = hosts.length > 0 ? hosts : [defaultSandboxHost()];
  // Pull concurrently: each machine has its own network and content store, while serial cold
  // pulls could exceed the production deploy job's fixed timeout as the fleet grows.
  const outcomes = await Promise.all(
    targets.filter((host) => hostCanDial({ boat_state: host.boat_state ?? null })).map(async (host) => {
      try {
        await (await fleetClient(host, platformTokenValue, host.id === DEFAULT_FLEET_PRELOAD_HOST_ID ? undefined : kek)).json<unknown>("POST", "/v1/images", {
          ref,
          ...(auth === null ? {} : { auth }),
          timeoutMs: PRELOAD_TIMEOUT_MS,
        });
        onProgress?.(`preloaded ${ref} on ${host.id}`);
        return { preloaded: host.id } as const;
      } catch (error) {
        return { failure: { host: host.id, reason: describeFailure(error) } } as const;
      }
    }),
  );
  for (const outcome of outcomes) {
    if (outcome.preloaded !== undefined) preloaded.push(outcome.preloaded);
    else failed.push(outcome.failure);
  }
  return { preloaded, failed };
}

export interface RehomeResult {
  moved: Array<{ pod: string; to: string }>;
  skipped: Array<{ pod: string; reason: string }>;
}

/**
 * Move this host's archived pods onto the rest of the fleet, which is what lets the machine be
 * deleted. Each pod is adopted by its new host and its frozen URL rewritten, in that order: a
 * rewrite without a successful adoption would point the pod at a host that cannot serve it.
 *
 * A pod that still holds a local workspace is skipped and named. Its data is on this host and
 * nowhere else, so moving it would mean losing it.
 */
export async function rehomeSandboxHost(
  id: string,
  onProgress?: (message: string) => void,
  placementMode: SandboxPlacementMode = sandboxPlacementMode(),
  guard?: {
    quiescenceAttested: boolean;
    platformToken: string | null;
    kek?: KekProvider;
    publicUrl?: string;
    minQuietSecs?: number;
    actorId?: string | null;
  },
): Promise<RehomeResult> {
  void placementMode;
  if (!guard?.quiescenceAttested || (!guard?.platformToken && !guard?.kek)) {
    throw serviceUnavailable(
      "legacy fleet rehome is retired: use fleet rehome-guarded <host> --yes --quiescence-confirmed",
      "unattested moves cannot prove same-object adoption or fence wakes; the guarded path " +
        "holds, verifies, and CAS-repoints with the source hold kept",
    );
  }
  // Same guarded implementation, same proofs — one move path, no duplicate unfenced copy.
  // Dynamic import: sandbox-retirement.ts reads this module's helpers; a static import
  // would cycle.
  const { guardedRehome } = await import("./sandbox-retirement.js");
  return guardedRehome({ platformToken: guard.platformToken, ...(guard.kek ? { kek: guard.kek } : {}) }, id, {
    approved: true,
    quiescenceAttested: true,
    ...(guard.minQuietSecs === undefined ? {} : { minQuietSecs: guard.minQuietSecs }),
    ...(guard.publicUrl === undefined ? {} : { publicUrl: guard.publicUrl }),
    actorId: guard.actorId ?? null,
    ...(onProgress === undefined ? {} : { onProgress }),
  });
}

/** RETIRED: the unfenced inline rehome body lived here (see git history for the exact
 * removed shape). Do not resurrect it: rehomeSandboxHost above delegates to the guarded
 * implementation, and any duplicate unfenced path is a handoff blocker. */

// Fleet outcomes are returned to operators in HTTP JSON: keep the transport code (capacity
// is actionable) and sanitize the message the sandbox host or SDK produced.
function describeFailure(error: unknown): string {
  return describeProviderFailure(error);
}
