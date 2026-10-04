import type { Sandbox, SandboxProvider, SandboxState } from "../../core/providers/types.js";
import { PiPodError } from "../../core/errors.js";
import { SandboxApiError } from "../../core/providers/sandbox/client.js";
import { audit } from "../audit.js";
import { hostForPod, hostCanDial, requireHostAwake, currentHostUrl, clientForHost, type HostIdentity } from "./hostidentity.js";
import { assertPersonalPodAccess, edition } from "../edition.js";
import { requestCpuAllocatorWake } from "../workers/cpu-allocator.js";
import { query, tx } from "../db/index.js";
import { acquireLease } from "../model-credentials/lease.js";
import {
  materializeCredentialLease,
  readPodCredentialContract,
} from "../model-credentials/materializer.js";
import { MIN_VALIDITY_MS } from "../model-credentials/refresh.js";
import { acquireQuotaLocks, orgConcurrencyCapTx, assertQuotaRoomTx, assertRoomToWake } from "./concurrency.js";
import { isHostPod, withHostChildSandbox } from "./hostmachine.js";
import { HttpError, conflict, notFound, serviceUnavailable } from "../httperrors.js";

export function isHostStartingRetryable(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.statusCode === 503 &&
    typeof error.detail === "object" &&
    error.detail !== null &&
    (error.detail as { reason?: unknown }).reason === "host_starting"
  );
}
import { observeCapacityWait, withProviderOperation } from "../metrics.js";
import { truncate } from "../push/copy.js";
import { sanitizeFailureMessage } from "../safe-errors.js";
import {
  SOURCE_SESSION_UNREACHABLE,
  readSessionJsonl,
} from "./fork-seed.js";
import { revokePodToken } from "./podtoken.js";
import { platformCredentialsOf, withProviderCredential } from "./providercred.js";
import {
  cancelCapacityWait,
  capacityWaitConfig,
  capacityWaitDisplay,
  enqueueCapacityWait,
  expiredWaitTerminal,
  finishCapacityWait,
  finishWaitExpired,
  getCapacityWait,
  heartbeatCapacityWait,
  recordWaitAttempt,
  tryClaimAttempt,
  waitBackoffMs,
  wakeWaitOperationKey,
  wakeWaitRefusal,
} from "./capacity-wait.js";
import {
  CAPACITY_WAIT_EXPIRED_CODE,
  formatLaunchFailure,
  renderCapacityWaitTerminal,
} from "./provision-failure.js";
import { getPod, setProviderState } from "./store.js";
import { buildCreateOwner } from "./owner-identity.js";
import { abandonUnsentCreateTx, assertPodLifecycleAction } from "./create-attempts.js";
import { assertLaunchGateOpen } from "./launch-control.js";
import { platformSandboxClient, platformToken } from "./operations.js";
import {
  SANDBOX_PROVIDER_NAME,
  checkPinnedHostEvidence,
  classifyPinnedCustody,
  pinnedEvidenceRefusal,
  sandboxHostByUrl,
  sandboxPlacementMode,
} from "./sandboxfleet.js";
import { readRetentionRecord } from "./retention-policy.js";
import type { PodRow, PodServiceDeps, WorkspaceSeedReport } from "./types.js";

export const START_TIMEOUT_MS = 5 * 60 * 1000;
export const STOP_TIMEOUT_MS = 60 * 1000;
const POD_OPERATION_LEASE_SECONDS = 90;
const POD_OPERATION_HEARTBEAT_MS = 20 * 1000;

const UNAVAILABLE_SANDBOX_MESSAGE = /\bsandbox\b.*\b(stopped|not found|gone|not running|isn't running|does not exist|unavailable)\b/i;

/** Provider SDKs disagree on error types, but all preserve HTTP status or a sandbox-state message. */
export function isUnavailableSandboxError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown; status?: unknown })?.statusCode ??
    (error as { status?: unknown })?.status;
  if (status === 404 || status === 410) return true;
  const message = error instanceof Error ? error.message : String(error);
  return UNAVAILABLE_SANDBOX_MESSAGE.test(message);
}
/** Wake the source sandbox if needed and read its session JSONL for a fork seed. */
export async function fetchForkSeedFromPod(
  deps: PodServiceDeps,
  source: PodRow,
  sessionPath: string | undefined,
  actorId: string | null,
): Promise<{ sourcePath: string; content: Buffer }> {
  let pod: PodRow;
  try {
    pod = await ensureProviderPodStarted(deps, source, actorId);
  } catch (error) {
    if (error instanceof HttpError && (error.statusCode === 409 || error.statusCode === 404)) {
      throw conflict(SOURCE_SESSION_UNREACHABLE);
    }
    throw error;
  }
  try {
    return await withPodActivityLease(deps, pod, () =>
      withPodSandbox(deps, pod, (sandbox) => readSessionJsonl(sandbox, sessionPath)),
    );
  } catch (error) {
    if (
      error instanceof HttpError &&
      (error.statusCode === 404 ||
        (error.statusCode === 409 && /no provider sandbox|unavailable during provider work/.test(error.message)))
    ) {
      throw conflict(SOURCE_SESSION_UNREACHABLE);
    }
    throw error;
  }
}

/** "Gone" is terminal for a pod, so a provider 404 must be observed twice this far apart. */
export const PROVIDER_GONE_RECHECK_DELAY_MS = 2_000;

/**
 * Re-acquire the provider handle for an existing pod.
 *
 * Provider process state can change without the control plane observing it (for example when a
 * sandbox service restart stops every resident process). The row is still the fast path, but a
 * provider operation that proves the sandbox is at rest repairs that cache, takes the normal
 * audited start path, and retries the operation once. The retry is deliberately inline rather
 * than recursive: a broken provider must not turn one request into an unbounded restart loop.
 */
export async function withPodSandbox<T>(
  deps: PodServiceDeps,
  pod: PodRow,
  fn: (sandbox: Sandbox, provider: SandboxProvider) => Promise<T>,
  options: {
    recoverStaleProviderState?: boolean;
    goneRecheckDelayMs?: number;
    /** Only explicit user stop/delete on an identified resource may pass the cutover hold. */
    allowDuringLaunchHold?: boolean;
  } = {},
): Promise<T> {
  if (!options.allowDuringLaunchHold) {
    await (deps.launchAdmissionCheck ?? assertLaunchGateOpen)();
  }
  if (!pod.provider_sandbox_id) throw conflict("pod has no provider sandbox yet");

  const failed = { sandbox: null as Sandbox | null, target: pod, host: null as HostIdentity | null };
  const assertObservationCurrent = async (target: PodRow, observedHost: HostIdentity | null): Promise<void> => {
    const current = await getPod(target.org_id,target.id);
    const host = await hostForPod(current);
    if (host) requireHostAwake(host);
    if (current.provider_sandbox_id !== target.provider_sandbox_id ||
        (current.sandbox_host_id ?? null) !== (target.sandbox_host_id ?? null) ||
        (host?.id ?? null) !== (observedHost?.id ?? null) || String(host?.generation) !== String(observedHost?.generation)) {
      throw serviceUnavailable("host transport or pod assignment changed; retry the operation");
    }
  };
  const updateObservedPod = async (host: HostIdentity | null, sql: string, values: unknown[]) => tx(async (client) => {
    if (host) {
      const current=(await client.query<HostIdentity>("SELECT * FROM sandbox_hosts WHERE id=$1 FOR SHARE",[host.id])).rows[0];
      if (!current || String(current.generation)!==String(host.generation)) throw serviceUnavailable("host transport changed during provider work");
      requireHostAwake(current);
    }
    return client.query(sql,values);
  });
  const runOnce = async (snapshot: PodRow): Promise<T> => {
    const target = await getPod(snapshot.org_id, snapshot.id);
    if (!target.provider_sandbox_id) throw conflict("pod has no provider sandbox yet");
    const observedHost = await hostForPod(target);
    failed.target = target;
    failed.host = observedHost;
    return isHostPod(target)
      ? withHostChildSandbox(deps, target, async (sandbox, provider) => {
          failed.sandbox = sandbox;
          return fn(sandbox, provider);
        })
      : withProviderCredential({
          pod: target,
          kek: deps.kek,
          platformEnv: platformCredentialsOf(deps),
          orgId: target.org_id,
          provider: target.provider,
          providerConfig: target.resolved_config.config.providers?.[target.provider] ?? {},
          // Boot snapshot: the async org-secret lookup below yields, and a
          // live process.env reference could then read another org's overlay.
          fn: async (provider) => {
            let sandbox = await provider.get(target.provider_sandbox_id!, { workdir: target.resolved_config.workdir });
            if (!sandbox) {
              // A provider control-plane hiccup can briefly 404 a sandbox that still exists.
              await new Promise((resolve) =>
                setTimeout(resolve, options.goneRecheckDelayMs ?? PROVIDER_GONE_RECHECK_DELAY_MS),
              );
              await assertObservationCurrent(target,observedHost);
              sandbox = await provider.get(target.provider_sandbox_id!, { workdir: target.resolved_config.workdir });
            }
            if (!sandbox) {
              await assertObservationCurrent(target,observedHost);
              const gone = await updateObservedPod(observedHost,`UPDATE pods SET provider_state='gone', provider_state_changed_at=now(),
                state_reason='the provider no longer knows this pod', updated_at=now()
                WHERE id=$1 AND provider_sandbox_id=$2 AND sandbox_host_id IS NOT DISTINCT FROM $3
                  AND provider_state=$4
                  AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM sandbox_hosts h WHERE h.id=$5 AND h.generation=$6::bigint
                    AND (h.boat_state IS NULL OR h.boat_state='running'))) RETURNING id`,
              [target.id,target.provider_sandbox_id,target.sandbox_host_id ?? null,target.provider_state,observedHost?.id ?? null,observedHost?.generation ?? null]);
              if (gone.rows.length !== 1) throw conflict("pod assignment changed during provider work");
              throw notFound("the provider no longer knows this pod");
            }
            failed.sandbox = sandbox;
            return fn(sandbox, provider);
          },
        });
  };

  try {
    return await runOnce(pod);
  } catch (error) {
    if (options.recoverStaleProviderState === false || !failed.sandbox || !isUnavailableSandboxError(error)) {
      throw error;
    }

    await assertObservationCurrent(failed.target,failed.host);
    const providerState = await failed.sandbox.state().catch(() => null);
    if (providerState !== "stopped" && providerState !== "archived" && providerState !== "gone") {
      throw error;
    }

    await assertObservationCurrent(failed.target,failed.host);
    const reason =
      providerState === "gone"
        ? "the provider no longer knows this sandbox"
        : `provider reported the sandbox ${providerState} during an operation`;
    const repaired = await updateObservedPod(failed.host,
      `UPDATE pods SET provider_state = $2, provider_state_changed_at = now(), state_reason = $3,
         last_stop_cause = CASE WHEN $2 = 'archived' THEN 'provider_archived'
           WHEN $2 = 'stopped' THEN 'provider_stopped' ELSE last_stop_cause END,
         reaped_at = CASE WHEN $2 = 'gone' THEN now() ELSE reaped_at END, updated_at = now()
       WHERE id = $1 AND provider_state = 'started' AND provider_sandbox_id=$4
         AND sandbox_host_id IS NOT DISTINCT FROM $5::text
         AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM sandbox_hosts h WHERE h.id=$6 AND h.generation=$7::bigint
           AND (h.boat_state IS NULL OR h.boat_state='running'))) RETURNING id`,
      [failed.target.id, providerState, reason, failed.target.provider_sandbox_id,failed.target.sandbox_host_id ?? null,
        failed.host?.id ?? null,failed.host?.generation ?? null],
    );
    if (repaired.rows.length !== 1) throw serviceUnavailable("pod assignment changed during provider recovery");

    if (providerState === "gone") {
      throw conflict("the provider no longer knows this pod, so its sandbox cannot be restarted");
    }

    let started: PodRow;
    try {
      started = await ensureProviderPodStarted(deps, pod, null);
    } catch (startError) {
      if (startError instanceof HttpError && startError.statusCode === 409 && /restore the pod/i.test(startError.message)) {
        throw startError;
      }
      // Fail-closed: the restart failure's provider prose never enters the thrown
      // message (it would otherwise reach logs/client errors); the static text keeps
      // the product explanation and the 503 status keeps the retry contract.
      throw serviceUnavailable(
        "the provider stopped this pod outside pi pod, and automatic restart failed",
      );
    }

    failed.sandbox = null;
    try {
      return await runOnce(started);
    } catch (retryError) {
      // Fail-closed: same as above — static product message, no provider prose.
      throw serviceUnavailable("the pod restarted, but the provider operation still failed");
    }
  }
}

/** Keep database inactivity authority fresh during long non-gateway provider/filesystem work. */
export async function withPodActivityLease<T>(
  deps: Pick<PodServiceDeps, "log">,
  pod: PodRow,
  work: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  let tail: Promise<void> = Promise.resolve();
  const renew = async (): Promise<void> => {
    if (stopped) return;
    const result = await query(
      `UPDATE pods SET last_activity_at = now(),
         work_lease_until = now() + make_interval(secs => $2), updated_at = now()
       WHERE id = $1 AND state = 'active' AND provider_state = 'started' RETURNING id`,
      [pod.id, POD_OPERATION_LEASE_SECONDS],
    );
    if ((result.rowCount ?? 0) === 0) throw conflict("pod became unavailable during provider work");
  };
  await renew();
  const timer = setInterval(() => {
    tail = tail
      .then(renew)
      .catch((e) =>
        deps.log.warn(sanitizeFailureMessage(e, { prefix: `pod activity lease failed for ${pod.id}` })),
      );
  }, POD_OPERATION_HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await work();
  } finally {
    stopped = true;
    clearInterval(timer);
    await tail;
    await query(
      `UPDATE pods SET last_activity_at = now(), work_lease_until = NULL, updated_at = now()
       WHERE id = $1 AND provider_state = 'started'`,
      [pod.id],
    ).catch((e) =>
      deps.log.warn(sanitizeFailureMessage(e, { prefix: `could not release pod activity lease for ${pod.id}` })),
    );
  }
}

export type ProviderPodCommand = "stop" | "start" | "archive" | "delete";
export type PodLifecycleAction = "archive" | "restore";

/**
 * Refresh the server-owned credential lease on a live filesystem without making wake/attach
 * depend on provider availability. Launch and reuse use the strict readiness path; here the
 * existing access token may still be usable, so any broker failure deliberately leaves it in
 * place and lets Pi surface provider auth at the next model call.
 */
export async function materializePodCredentialLeaseBestEffort(
  deps: Pick<PodServiceDeps, "kek" | "log">,
  pod: Pick<PodRow, "id" | "org_id" | "user_id" | "credential_providers">,
  sandbox: Sandbox,
  env?: Record<string, string>,
): Promise<void> {
  const providers = await readPodCredentialContract(pod);
  if (providers.length === 0) return;
  try {
    const { lease } = await acquireLease(
      deps.kek,
      { orgId: pod.org_id, userId: pod.user_id },
      providers,
      MIN_VALIDITY_MS,
    );
    await materializeCredentialLease(sandbox, lease, env);
  } catch {
    deps.log.warn(`pod ${pod.id} credential lease refresh was unavailable; keeping its existing auth file`);
  }
}

/**
 * Re-apply the lease in the owner's started pods that contract `providerId`, so a removed
 * account credential leaves them now rather than at their next ten-minute lease poll. A pod
 * this misses — asleep, or its host unreachable — drops it on wake, or at that poll once the
 * pod has a lease record (`POD_LEASED_PROVIDERS_PATH`).
 */
export async function reapplyCredentialLeaseInStartedPods(
  deps: PodServiceDeps,
  subject: { orgId: string; userId: string },
  providerId: string,
): Promise<void> {
  const pods = await query<PodRow>(
    `SELECT * FROM pods
      WHERE org_id = $1 AND user_id = $2 AND state = 'active' AND provider_state = 'started'
        AND provider_sandbox_id IS NOT NULL AND $3 = ANY(credential_providers)`,
    [subject.orgId, subject.userId, providerId],
  );
  for (const pod of pods.rows) {
    await withPodSandbox(deps, pod, (sandbox) => materializePodCredentialLeaseBestEffort(deps, pod, sandbox)).catch(() => {
      deps.log.warn(`pod ${pod.id} was unreachable to drop a removed ${providerId} credential; it drops it on wake`);
    });
  }
}

/** @deprecated Provider state is no longer projected into logical lifecycle state. */
export function stateAfterPodCommand(_command: ProviderPodCommand, providerState: SandboxState): SandboxState {
  return providerState;
}

/** Merge measured durations into the pod's persisted timings without disturbing the report. */
export async function recordPodTimings(podId: string, timings: Record<string, number>): Promise<void> {
  await query(
    `UPDATE pods SET resolved_config = jsonb_set(coalesce(resolved_config, '{}'::jsonb), '{timings}',
       coalesce(resolved_config->'timings', '{}'::jsonb) || $2::jsonb), updated_at = now()
     WHERE id = $1`,
    [podId, JSON.stringify(timings)],
  ).catch(() => {});
}

/**
 * Replace the frozen report's workspace-seed block. Best-effort like timings: the seed itself
 * already happened (or failed) in the sandbox, and a lost status write must not undo it.
 */
export async function recordWorkspaceSeed(podId: string, seed: WorkspaceSeedReport): Promise<void> {
  await query(
    `UPDATE pods SET resolved_config = jsonb_set(coalesce(resolved_config, '{}'::jsonb), '{workspaceSeed}',
       $2::jsonb, true), updated_at = now()
     WHERE id = $1`,
    [podId, JSON.stringify(seed)],
  ).catch(() => {});
}

/** A launch can be canceled before its asynchronous provider create has returned an id. */
export function canAbandonPodBeforeSandbox(
  pod: Pick<PodRow, "provider_state" | "provider_sandbox_id">,
): boolean {
  return (
    pod.provider_sandbox_id === null &&
    ["preparing_image", "provisioning", "starting", "error"].includes(pod.provider_state)
  );
}

/** Provider mutations are internal policy/attach mechanics and never define API lifecycle state. */
export async function runProviderPodCommand(
  deps: PodServiceDeps,
  pod: PodRow,
  command: ProviderPodCommand,
  actorId: string | null,
  options: { alreadyClaimedFrom?: string } = {},
): Promise<SandboxState | "gone"> {
  await assertPodLifecycleAction({
    podId: pod.id,
    providerState: pod.provider_state,
    providerSandboxId: pod.provider_sandbox_id,
    action: command,
  });
  const startPreflight = async () => {
    if (actorId !== null) await assertPersonalPodAccess(pod, actorId);
    await edition().ensurePodHostReady(deps, pod);
  };
  if (command === "start" && options.alreadyClaimedFrom === undefined) await startPreflight();
  const transition = { start: "starting", stop: "stopping", archive: "archiving", delete: "deleting" }[command];
  let abandonedBeforeSandbox = false;
  if (command === "delete" && canAbandonPodBeforeSandbox(pod)) {
    // A prepared attempt is provably unsent; dispatching/unknown attempts are
    // held and cannot be converted into a silent delete or data purge.
    const abandoned = await tx((client) => abandonUnsentCreateTx(client, {
      podId: pod.id,
      orgId: pod.org_id,
      userId: pod.user_id,
      providerState: pod.provider_state,
    }));
    if (!abandoned) {
      return runProviderPodCommand(deps, await getPod(pod.org_id, pod.id), command, actorId, options);
    }
    abandonedBeforeSandbox = true;
  }
  const skipProviderDelete =
    command === "delete" && (pod.provider_state === "gone" || abandonedBeforeSandbox);
  if (!skipProviderDelete && options.alreadyClaimedFrom === undefined) {
    const claimed = await query(
      `UPDATE pods SET provider_state = $2, provider_state_changed_at = now(), updated_at = now()
       WHERE id = $1 AND provider_state = $3 RETURNING id`,
      [pod.id, transition, pod.provider_state],
    );
    if ((claimed.rowCount ?? 0) === 0) {
      throw conflict(`pod sandbox state changed while ${command} was starting`);
    }
  }

  let resumeMs: number | null = null;
  let providerState: SandboxState | "gone";
  try {
    // A host stop may win after the quota transaction claimed this pod. Keep
    // that preflight inside rollback protection rather than stranding starting.
    if (command === "start" && options.alreadyClaimedFrom !== undefined) await startPreflight();
    providerState = skipProviderDelete
      ? "gone"
      : await withProviderOperation(pod.provider, command, () =>
          withPodSandbox(
            deps,
            pod,
            async (sandbox) => {
              switch (command) {
                case "stop":
                  await sandbox.stop(STOP_TIMEOUT_MS);
                  break;
                case "start": {
                  const resumeStartedAt = Date.now();
                  await sandbox.start(START_TIMEOUT_MS);
                  resumeMs = Date.now() - resumeStartedAt;
                  await materializePodCredentialLeaseBestEffort(deps, pod, sandbox);
                  deps.onPodStarted?.(pod.id);
                  break;
                }
                case "archive":
                  await sandbox.archive(START_TIMEOUT_MS);
                  break;
                case "delete":
                  await sandbox.delete();
                  return "gone" as const;
              }
              return sandbox.state();
            },
            {
              recoverStaleProviderState: false,
              allowDuringLaunchHold: actorId !== null && (command === "stop" || command === "delete"),
            },
          ),
        );
  } catch (e) {
    if (!skipProviderDelete) {
      await query(
        `UPDATE pods SET provider_state = $2, provider_state_changed_at = now(),
           state_reason = $3, updated_at = now()
         WHERE id = $1 AND provider_state = $4`,
        [
          pod.id,
          options.alreadyClaimedFrom ?? pod.provider_state,
          truncate(sanitizeFailureMessage(e, { prefix: `pod ${command} failed` }), 500),
          transition,
        ],
      ).catch(() => {});
    }
    throw e;
  }
  if (command === "delete") {
    await revokePodToken(pod.id);
    // Its jobs were authorized by a token that no longer exists; a person can resume them.
    await query(
      `UPDATE jobs SET status = 'paused', next_run_at = NULL, updated_at = now()
       WHERE created_from_pod = $1 AND status = 'active' AND archived_at IS NULL`,
      [pod.id],
    );
  }
  const persisted = await tx(async (client) => {
    const result = await client.query(
      `UPDATE pods SET provider_state = $2, provider_state_changed_at = now(), state_reason = NULL,
         provider_sandbox_id = CASE WHEN $2 = 'gone' THEN NULL ELSE provider_sandbox_id END,
         reaped_at = CASE WHEN $2 = 'gone' THEN now() ELSE reaped_at END,
         last_activity_at = CASE WHEN $5 = 'start' THEN now() ELSE last_activity_at END,
         work_lease_until = CASE WHEN $5 = 'start' THEN NULL ELSE work_lease_until END,
         last_stop_cause = CASE WHEN $5 = 'start' THEN NULL ELSE last_stop_cause END,
         updated_at = now()
       WHERE id = $1 AND ($3::boolean OR provider_state = $4) RETURNING id`,
      [pod.id, providerState, skipProviderDelete, transition, command],
    );
    if ((result.rowCount ?? 0) === 1 && command === "delete") {
      await client.query(
        `UPDATE pod_create_attempts SET phase='deleted', owner_token=NULL,
           owner_lease_until=NULL, recovery_token=NULL, recovery_lease_until=NULL,
           next_observe_at=NULL, finished_at=now(), updated_at=now()
          WHERE pod_id=$1 AND phase IN ('sandbox_known','initialization_interrupted','ready')
            AND (sandbox_id IS NULL OR sandbox_id=$2)`,
        [pod.id, pod.provider_sandbox_id],
      );
    }
    return result;
  });
  if ((persisted.rowCount ?? 0) === 0) throw conflict(`pod sandbox state changed while ${command} was running`);
  // A host taking its machine down takes its co-located children's processes with it, so
  // their rows must say so. Always row-level; session closes ride the callers that hold a
  // gateway (elsewhere the children's dead transports end their sessions).
  if (command !== "start" && (providerState === "stopped" || providerState === "archived" || providerState === "gone")) {
    await cascadeHostChildrenRows(pod.id, providerState).catch((e) =>
      deps.log.warn(sanitizeFailureMessage(e, { prefix: `could not cascade host children of ${pod.id}` })),
    );
  }
  if (resumeMs !== null) {
    const key = pod.provider_state === "archived" ? "resume_archived" : "resume_stopped";
    await recordPodTimings(pod.id, { [key]: resumeMs });
    deps.log.info(`pod ${pod.id} sandbox resumed from ${pod.provider_state} in ${resumeMs}ms`);
  }
  await audit({
    orgId: pod.org_id,
    actorId,
    action: `pod.provider_${command}`,
    targetType: "pod",
    targetId: pod.id,
  });
  return providerState;
}

/**
 * Row transitions for co-located children when their host's machine leaves `started`.
 * A deleted host reports its children `stopped` (their disk was the host's; the rows remain
 * for history until deleted themselves). Lazy wake is the asymmetry: a host start never
 * cascades — children restart only when someone attaches or starts them.
 */
export async function cascadeHostChildrenRows(
  hostPodId: string,
  hostState: "stopped" | "archived" | "gone",
): Promise<string[]> {
  const targetState = hostState === "gone" ? "stopped" : hostState;
  const cause = hostState === "archived" ? "host_archived" : "host_stopped";
  const rows = await query<{ id: string }>(
    `UPDATE pods SET provider_state = $2, provider_state_changed_at = now(),
       last_stop_cause = $3, state_reason = $3, work_lease_until = NULL, updated_at = now()
     WHERE host_pod_id = $1 AND provider_state IN ('started', 'starting')
       AND NOT EXISTS (SELECT 1 FROM pod_create_attempts AS a WHERE a.pod_id=pods.id
         AND a.phase IN ('prepared','dispatching','unknown','sandbox_known',
                         'initialization_interrupted','legacy_unresolved','delete_pending'))
     RETURNING id`,
    [hostPodId, targetState, cause],
  );
  return rows.rows.map((row) => row.id);
}

/** Children currently running on a host's machine — the sessions to close before it stops. */
export async function startedHostChildIds(hostPodId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM pods WHERE host_pod_id = $1 AND provider_state IN ('started', 'starting')`,
    [hostPodId],
  );
  return rows.rows.map((row) => row.id);
}

export function podLifecycleActionMessage(action: PodLifecycleAction): string {
  return action === "archive"
    ? "pod stopped and hidden from active lists; its files are kept"
    : "pod restored to active lists; attach starts its sandbox when needed";
}

/**
 * Logical archive/restore of a host hides or unhides its machine group together.
 * Independently archived children come back with a host restore — the group is the unit.
 * Gone children are left alone. Provider state is untouched (compute stays as it is).
 */
export async function cascadeHostChildrenLogicalState(
  hostPodId: string,
  state: "active" | "archived",
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `UPDATE pods SET state = $2,
       archived_at = CASE WHEN $2 = 'archived' THEN COALESCE(archived_at, now()) ELSE NULL END,
       updated_at = now()
     WHERE host_pod_id = $1 AND state <> $2 AND provider_state <> 'gone'
       AND NOT EXISTS (SELECT 1 FROM pod_create_attempts AS a WHERE a.pod_id=pods.id
         AND a.phase IN ('prepared','dispatching','unknown','sandbox_known',
                         'initialization_interrupted','legacy_unresolved','delete_pending'))
     RETURNING id`,
    [hostPodId, state],
  );
  return rows.rows.map((row) => row.id);
}

/** Archive/restore only changes the user-owned lifecycle state. */
export async function runPodLifecycleAction(
  pod: PodRow,
  action: PodLifecycleAction,
  actorId: string,
): Promise<{ state: "active" | "archived"; cascaded: string[] }> {
  const state = action === "archive" ? "archived" : "active";
  await query(
    `UPDATE pods SET state = $2, archived_at = CASE WHEN $2 = 'archived' THEN COALESCE(archived_at, now()) ELSE NULL END,
       updated_at = now() WHERE id = $1`,
    [pod.id, state],
  );
  const cascaded = await cascadeHostChildrenLogicalState(pod.id, state);
  await audit({
    orgId: pod.org_id,
    actorId,
    action: `pod.${action}`,
    targetType: "pod",
    targetId: pod.id,
  });
  return { state, cascaded };
}

/** Transparently wake/restore an active pod before a session or file operation. */
/** True when a start failed only because the host requires an owner (native REQUIRE_OWNER). */
function isOwnerRequiredRefusal(error: unknown): boolean {
  if (!(error instanceof PiPodError) || error.status !== 400) return false;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof SandboxApiError && cause.code === "owner_required";
}

function frozenSandboxUrl(pod: PodRow): string | null {
  const url = (pod.resolved_config as unknown as { config?: { providers?: { sandbox?: { url?: unknown } } } })
    .config?.providers?.sandbox?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Start a quota-claimed pod, healing a legacy unowned sandbox on the way
 * (§7.2 rev3): when the host refuses with `400 owner_required`, run the
 * same one-time null→userKey CAS the sweep uses (trusted pod owner, never
 * labels), then retry the start exactly once. Any other outcome — including
 * a failed CAS — rethrows the ORIGINAL refusal, which the sweep covers
 * within 60s. The quota slot stays claimed across the retry (no double
 * charge, no release of a sandbox that may be starting).
 */
async function startClaimedPod(
  deps: PodServiceDeps,
  pod: PodRow,
  actorId: string | null,
  alreadyClaimedFrom?: string,
): Promise<void> {
  const opts = alreadyClaimedFrom === undefined ? {} : { alreadyClaimedFrom };
  try {
    await runProviderPodCommand(deps, pod, "start", actorId, opts);
    return;
  } catch (error) {
    if (!isOwnerRequiredRefusal(error)) throw error;
    if (pod.provider !== SANDBOX_PROVIDER_NAME || !pod.provider_sandbox_id) throw error;
    const url = frozenSandboxUrl(pod);
    // Boot snapshot token: a BYO credential overlay mid-wake must not reroute
    // this control-plane CAS onto another org's custody (or fail it spuriously).
    const host = await hostForPod(pod);
    const client = host
      ? await clientForHost(host.id, deps.kek, platformToken(deps.env)).catch(() => null)
      : url ? platformSandboxClient(url, platformToken(deps.env)) : null;
    if (!client) throw error;
    const { userKey } = buildCreateOwner({ userId: pod.user_id });
    try {
      await client.initializeOwner(pod.provider_sandbox_id, userKey);
    } catch {
      throw error;
    }
    deps.log.info(`pod ${pod.id} owner initialized on wake; retrying start`);
    // Fresh claim (no alreadyClaimedFrom): the failed attempt rolled the row
    // back to its pre-wake state, so the retry re-claims it honestly — a row
    // that moved on meanwhile fails the claim instead of being forced.
    await runProviderPodCommand(deps, await getPod(pod.org_id, pod.id), "start", actorId);
  }
}

/**
 * Bounded wait for a wake refused with retryable admission detail (plan
 * §6.6 wake/restore coverage, §7.3 grant-TTL cold-wake bootstrap).
 *
 * Invariants (wake-specific, stricter than the create path):
 * - the host assignment is PRESERVED: the workspace is pinned, so attempts
 *   re-run `start` on the frozen URL only — never re-place, never fail over
 *   to another host (there is nothing to restore elsewhere without moving
 *   data, and restore-before-grant is exactly the deadlock this drains);
 * - each refused attempt rolls its quota claim back to stopped/archived;
 *   each retry must honestly re-claim quota. The bounded wake wait supplies
 *   CPU bootstrap demand between attempts without pretending compute is live;
 * - wake cancellation ends the WAITING only: no host operation is ever
 *   cancelled (the waiter never records `last_host_url`, and the sweep
 *   refuses host cleanup for wake rows) — the workspace, its archive, and
 *   any active job are untouched. A stuck `starting` claim rolls back to
 *   `fromState` via the attempt-failure path, or via sweep intent on orphan;
 * - ambiguity never waits: only classified admission refusals enter the
 *   loop, so a timed-out/uncertain start is surfaced, not retried blind.
 *
 * Visible outcome: success returns (admitted); deadline expiry throws a
 * typed 503 that counts as visible capacity pressure (never a hidden retry
 * inside a 200); cancellation throws a typed conflict. Neither requires a
 * manual retry once the allocator issues the missing grant.
 */
async function waitForWakeCapacity(
  deps: PodServiceDeps,
  args: {
    podId: string;
    orgId: string;
    userId: string;
    fromState: string;
    reason: string;
    detail: Record<string, unknown>;
    attempt: (claimFrom: string) => Promise<void>;
    currentState: () => Promise<PodRow | null>;
  },
): Promise<void> {
  const dbq = { query: (text: string, params?: unknown[]) => query(text, params ?? []) };
  const waitCfg = capacityWaitConfig(deps.env);
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  let row = await enqueueCapacityWait(dbq, {
    podId: args.podId,
    orgId: args.orgId,
    userId: args.userId,
    // Waiter-identity marker only: wake cancellation must never reach
    // native DELETE-by-key (that deletes the whole existing workspace).
    operationKey: wakeWaitOperationKey(args.podId),
    kind: "wake",
    intent: { fromState: args.fromState },
    reason: args.reason,
    detail: args.detail,
    waitSeconds: waitCfg.waitSeconds,
  });
  if (args.reason === "fairness_degraded") {
    requestCpuAllocatorWake(`fairness-wake:${args.podId}`);
  }
  deps.log.warn(
    `pod ${args.podId} waiting for wake capacity (reason ${args.reason}, deadline ${waitCfg.waitSeconds}s); workspace pinned`,
  );
  for (;;) {
    if (Date.parse(row.deadline_at) - Date.now() <= 0) {
      // Guarded exactly like the create path: a concurrent synchronous cancel
      // wins over a late expiry — count the outcome the row actually holds.
      const expired = await finishWaitExpired(dbq, args.podId).catch(() => null);
      if (!expired) {
        throw conflict("wake cancelled while waiting for capacity; workspace untouched");
      }
      // Typed terminal, exactly like the create path: the HTTP boundary
      // recognizes this shape (503 + allowlisted code + validated numbers)
      // and answers 503 instead of genericizing to 500; the failure
      // recorder's rendering lands on `state_reason` so attach/wake prints
      // the typed "capacity wait expired … (waited Ns for <last reason>)"
      // copy. Same rule as the create path: the last recorded refusal
      // wins; the enqueue reason only stands when no attempt was recorded.
      const terminalRefusal = expiredWaitTerminal({
        enqueueReason: args.reason,
        enqueueDetail: args.detail,
        row: expired,
      });
      const display = capacityWaitDisplay(terminalRefusal);
      const terminalReason = display.reason ?? "fleet_capacity";
      deps.log.warn(
        `pod ${args.podId} wake capacity wait expired after ${expired.attempts} attempt(s) ` +
          `(first ${args.reason}, last ${terminalReason}); reporting last refusal`,
      );
      // The quota claim already rolled back to `fromState` via the
      // attempt-failure path; leave the workspace exactly there and record
      // the typed outcome where clients poll it. Guarded to the waitable
      // states so a row that moved on keeps its own reason; best-effort so
      // a failed write never masks the typed throw below.
      await query(
        `UPDATE pods SET state_reason = $2, updated_at = now()
         WHERE id = $1 AND provider_state IN ('stopped', 'archived')`,
        [
          args.podId,
          truncate(
            formatLaunchFailure(
              CAPACITY_WAIT_EXPIRED_CODE,
              renderCapacityWaitTerminal({ reason: terminalReason, waitedSeconds: waitCfg.waitSeconds }),
            ),
            500,
          ),
        ],
      ).catch(() => {});
      throw serviceUnavailable("the host is still at capacity; retry the wake shortly", {
        code: CAPACITY_WAIT_EXPIRED_CODE,
        reason: terminalReason,
        ...(display.required !== undefined ? { required: display.required } : {}),
        ...(display.available !== undefined ? { available: display.available } : {}),
        ...(display.unit !== undefined ? { unit: display.unit } : {}),
        waitedSeconds: waitCfg.waitSeconds,
      });
    }
    // Heartbeat doubles as the cancel check: null means cancelled/expired.
    const beat = await heartbeatCapacityWait(dbq, args.podId);
    if (!beat) {
      await cancelCapacityWait(dbq, args.podId).catch(() => null);
      throw conflict("wake cancelled while waiting for capacity; workspace untouched");
    }
    // The row moved on? Started elsewhere is success (the tail re-reads and
    // returns it); anything else ends the wait without touching the host.
    const current = await getPod(args.orgId, args.podId).catch(() => null);
    if (current && current.provider_state === "started") {
      await cancelCapacityWait(dbq, args.podId).catch(() => null);
      return;
    }
    if (
      !current ||
      current.state !== "active" ||
      current.provider_sandbox_id === null ||
      !(current.provider_state === "stopped" || current.provider_state === "archived")
    ) {
      await cancelCapacityWait(dbq, args.podId).catch(() => null);
      throw conflict("pod stopped waiting for wake capacity");
    }
    await sleep(waitBackoffMs({ attempts: row.attempts, baseMs: waitCfg.retryBaseMs, deadlineInMs: Date.parse(row.deadline_at) - Date.now() }));
    // Round-robin turn shared with create waiters: one user's wakes cannot
    // lap another user's launches.
    const turn = await tryClaimAttempt(dbq, args.podId);
    if (!turn) {
      row = (await getCapacityWait(dbq, args.podId)) ?? row;
      continue;
    }
    // Re-check the claimable state right before each attempt: the row may
    // have legitimately moved (stopped↔archived) while waiting.
    const attemptFrom = await args.currentState();
    if (
      !attemptFrom ||
      attemptFrom.provider_state === "started" ||
      !(attemptFrom.provider_state === "stopped" || attemptFrom.provider_state === "archived")
    ) {
      await cancelCapacityWait(dbq, args.podId).catch(() => null);
      if (attemptFrom && attemptFrom.provider_state === "started") return;
      throw conflict("pod stopped waiting for wake capacity");
    }
    try {
      await args.attempt(attemptFrom.provider_state);
      const admitted = await finishCapacityWait(dbq, args.podId, "admitted").catch(() => null);
      if (admitted) observeCapacityWait("admitted");
      return;
    } catch (error) {
      if (isHostStartingRetryable(error)) {
        // Host boot has its own durable operation/status, not this
        // request's old capacity budget. Cancelling only the wake
        // waiter; the durable host operation still runs independently.
        await cancelCapacityWait(dbq, args.podId).catch(() => null);
        throw error;
      }
      const refusal = wakeWaitRefusal(error);
      if (!refusal) throw error;
      row =
        (await recordWaitAttempt(dbq, args.podId, {
          reason: (refusal["reason"] as string | undefined) ?? args.reason,
          detail: refusal,
        })) ?? row;
    }
  }
}

export async function ensureProviderPodStarted(
  deps: PodServiceDeps,
  pod: Pick<PodRow, "org_id" | "id">,
  actorId: string | null,
): Promise<PodRow> {
  return (await ensureProviderPodStartedWithResult(deps, pod, actorId)).pod;
}

/** The same operation plus whether this call had to replace provider process state. */
export async function ensureProviderPodStartedWithResult(
  deps: PodServiceDeps,
  pod: Pick<PodRow, "org_id" | "id">,
  actorId: string | null,
  options: { resumeHost?: boolean } = {},
): Promise<{ pod: PodRow; restarted: boolean }> {
  const fresh = await getPod(pod.org_id, pod.id);
  if (fresh.state !== "active") throw conflict("restore the pod before using it");
  // Null is reserved for trusted server jobs/gateway work after request/ticket
  // authorization. A supplied human actor never inherits the pod owner's rights.
  if (actorId !== null) await assertPersonalPodAccess(fresh, actorId);
  // Queue durable host resume before the pod-state fast path or asleep-aware
  // evidence gate. An HTTP timeout never cancels the host's operation.
  if (options.resumeHost === false) {
    const host = await hostForPod(fresh);
    if (host) requireHostAwake(host);
    // Timer recovery may reconnect a live supervisor, never restart owned
    // workloads/hosts. Every actual wake must originate in user/job demand.
    if (host?.owner_user_id != null && fresh.provider_state !== "started") {
      throw serviceUnavailable("the pod is asleep; user demand is required to resume");
    }
  } else {
    try { await edition().ensurePodHostReady(deps, fresh); }
    catch (error) {
      if (isHostStartingRetryable(error)) {
        await query(`UPDATE pod_capacity_wait SET status='cancelled',updated_at=now()
          WHERE pod_id=$1 AND kind='wake' AND status='waiting'`,[fresh.id]);
      }
      throw error;
    }
  }
  if (fresh.provider_state === "started") return { pod: fresh, restarted: false };
  if (["preparing_image", "provisioning", "starting"].includes(fresh.provider_state)) {
    // Owned Boat: a sandbox still coming up after the machine is running is waitable
    // host admission (4420), not a 409/4409 "pod unavailable" that looks like a lost disk.
    const host = await hostForPod(fresh);
    if (host?.owner_user_id != null) {
      if (!hostCanDial(host)) requireHostAwake(host);
      throw serviceUnavailable("Your workstation is starting. This may take several minutes", {
        kind: "admission",
        reason: "host_starting",
        resource: "transitions",
        unit: "count",
        retryable: true,
        hostId: host.id,
        statusHref: `/v1/workstations/${encodeURIComponent(host.id)}`,
        state: host.boat_state,
        retryAfterMs: 10_000,
      });
    }
    throw conflict("pod is temporarily unavailable; retry shortly");
  }
  if (["stopping", "archiving", "deleting"].includes(fresh.provider_state)) {
    throw conflict("pod is temporarily unavailable; retry shortly");
  }
  if (!["stopped", "archived"].includes(fresh.provider_state)) {
    throw conflict("pod is unavailable");
  }
  // A wake is new work on the boat. A missing HTTP actor is not free compute:
  // on a personal Boat the owner is on the pod row. Gate the owner so an
  // internal call with actorId=null cannot bypass trial/cap/storage. Already-
  // started pods returned above; stop/fetch never enter this claim. Retention
  // and cleanup do not call this function.
  const billingUserId = actorId ?? fresh.user_id;
  await edition().admitPodWork(deps.env, billingUserId);
  // Every wake in the server funnels through here, which is what makes the concurrency caps
  // caps on running compute: a sleeping pod costs nothing, so it gave its slot back and has to
  // win one again — from the global per-user budget and the org aggregate alike. Lineage caps
  // are deliberately not re-checked: they bound how far a supervisor may fan out, not whether a
  // person may resume the pod in front of them.
  //
  // Atomic (plan §7.1): the quota check and the stopped/archived → starting claim commit in
  // one transaction under canonical quota locks, so 21 simultaneous wakes cannot all win. The
  // slot is charged to the pod owner, not the waker. Host children are exempt (no slot).
  // Provider I/O (the actual start) runs after commit via the already-claimed path.
  if (fresh.provider !== "host") {
    const fromState = fresh.provider_state;
    // Pinned platform-fleet evidence gate (fail closed, never cross-host):
    // a cold wake/restore needs a validated, fresh, identity-matched
    // ceiling contract BEFORE admission — the same policy as placement.
    // Custody first: the registry read MUST NOT fail open (a DB error is
    // not BYOK evidence — it propagates), and an unregistered URL is BYOK
    // only with org-secret custody to prove it. Platform or unknown custody
    // without a host row — or without any frozen URL at all — refuses
    // non-destructively (mapping/SID intact), never falling through to
    // default-provider routing.
    // Every refusal is typed: the frozen host URL, sandbox id, and archive
    // stay exactly where they are, so the operator repairs the host/report
    // and retries, or moves the stopped workspace with the guarded rehome.
    // Refusing unsafe admission loses nothing authoritative; admitting
    // blind could overbook RAM against live workloads (§6). BYOK/single-host
    // compat is explicit (never inferred from a failed lookup).
    // Already-running jobs return before this point and are never touched:
    // nothing here stops, deletes, or force-archives. Wakes never wait on
    // evidence (configuration/reporting, not pressure).
    if (fresh.provider === SANDBOX_PROVIDER_NAME && fresh.provider_sandbox_id) {
      const identityHost = await hostForPod(fresh);
      if (sandboxPlacementMode(deps.env) === "fleet" || identityHost?.owner_user_id != null) {
        if (identityHost) requireHostAwake(identityHost);
        const pinnedUrl = identityHost ? currentHostUrl(identityHost) : frozenSandboxUrl(fresh);
        // No catch on either read: a failed registry or custody lookup
        // propagates (retryable 500, no state touched pre-claim) instead of
        // degrading into an unregistered-URL compat skip or a misleading
        // refusal. Only a successfully-read ABSENT row/record means
        // unregistered/unknown. No URL means no lookup — the missing
        // mapping itself is the verdict input, never a reason to skip.
        const pinnedHost = identityHost ?? (pinnedUrl ? await sandboxHostByUrl(pinnedUrl) : null);
        const custodyRecord = await readRetentionRecord(fresh.id);
        const custody = classifyPinnedCustody({
          provider: fresh.provider,
          placementMode: "fleet",
          hasUrl: pinnedUrl !== null,
          hostRowPresent: pinnedHost !== null,
          credentialSource:
            custodyRecord?.credential_source === "platform" || custodyRecord?.credential_source === "org-secret"
              ? custodyRecord.credential_source
              : null,
        });
        if (custody === "refuse-unregistered") {
          throw serviceUnavailable(
            pinnedUrl
              ? "this pod's platform host is not registered; re-register the host or move the stopped workspace with the guarded rehome"
              : "this pod has no pinned platform host mapping; move the stopped workspace with the guarded rehome, never the default route",
            {
              kind: "admission",
              reason: "host_unregistered",
              resource: "transitions",
              unit: "count",
              retryable: false,
            },
          );
        }
        if (custody === "fleet-gated" && pinnedHost && pinnedUrl) {
          const evidenceClient = identityHost?.auth_ciphertext
            ? await clientForHost(identityHost.id, deps.kek, platformToken(deps.env)) : undefined;
          if (identityHost?.owner_user_id != null && !identityHost.runtime_boot_id) throw serviceUnavailable("host boot readiness is missing");
          const verdict = await checkPinnedHostEvidence(pinnedUrl, pinnedHost.id, undefined, undefined, evidenceClient,
            identityHost?.owner_user_id != null ? { bootId: identityHost.runtime_boot_id! } : undefined).catch(
            () => "unknown" as const,
          );
          if (verdict !== "ok") {
            throw serviceUnavailable(...pinnedEvidenceRefusal(pinnedHost.id, verdict));
          }
        }
      }
    }
    // One attempt = honestly re-claim the quota slot, then start. Every
    // failed attempt rolls itself back to `fromState` inside
    // runProviderPodCommand, so retries never stack claims and the waiter
    // below only ever retries a cleanly stopped/archived row.
    const claimAndStart = async (claimFrom: string): Promise<void> => {
      // Resolved outside the transaction: a plan lookup takes no locks and must not
      // borrow a second pool connection while one is held.
      const perUserCap = await edition().perUserPodCap(deps.env, fresh.user_id);
      await tx(async (client) => {
        await acquireQuotaLocks(client, fresh.org_id, fresh.user_id);
        await assertQuotaRoomTx(client, {
          orgId: fresh.org_id,
          userId: fresh.user_id,
          perUserCap,
          // Fresh inside the tx under the locks (P2): pre-tx policy reads are preflight only.
          orgCap: await orgConcurrencyCapTx(client, fresh.org_id),
        });
        const claimed = await client.query(
          `UPDATE pods SET provider_state = 'starting', provider_state_changed_at = now(),
             state_reason = NULL, work_lease_until = NULL, last_stop_cause = NULL, updated_at = now()
           WHERE id = $1 AND provider_state = $2 RETURNING id`,
          [fresh.id, claimFrom],
        );
        if ((claimed.rowCount ?? 0) !== 1) {
          throw conflict("pod sandbox state changed while wake was starting");
        }
      });
      const claimedRow = await getPod(pod.org_id, pod.id);
      await startClaimedPod(deps, claimedRow, actorId, claimFrom);
    };
    try {
      await claimAndStart(fromState);
    } catch (error) {
      // Bounded wake wait (§6.6/§7.3): a retryable admission refusal
      // (fairness_degraded after a grant TTL lapse included) waits on the
      // PINNED host — stopped workspaces never migrate to fix placement —
      // re-claiming quota on each attempt, instead of failing visibly and
      // demanding a manual retry for the first cold wake. Anything else
      // (shapes, auth, quota, conflicts, timeouts/ambiguity) rethrows at
      // once: waiting cannot change it, and an ambiguous start must never
      // be retried blind. Disabled with CAPACITY_WAIT_ENABLED=false.
      const refusal = wakeWaitRefusal(error);
      if (!capacityWaitConfig(deps.env).enabled || isHostStartingRetryable(error) || !refusal) throw error;
      await waitForWakeCapacity(deps, {
        podId: fresh.id,
        orgId: fresh.org_id,
        userId: fresh.user_id,
        fromState,
        reason: (refusal["reason"] as string | undefined) ?? "fleet_capacity",
        detail: refusal,
        attempt: claimAndStart,
        currentState: () => getPod(pod.org_id, pod.id).catch(() => null),
      });
    }
  } else {
    await assertRoomToWake(fresh, await edition().perUserPodCap(deps.env, fresh.user_id));
    await startClaimedPod(deps, fresh, actorId);
  }
  const started = await getPod(pod.org_id, pod.id);
  if (started.state !== "active") throw conflict("pod was archived while its sandbox was starting");
  return { pod: started, restarted: true };
}
