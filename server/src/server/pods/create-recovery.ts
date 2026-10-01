import { randomUUID } from "node:crypto";
import type { OperationStatusWire } from "../../core/providers/sandbox/wire.js";
import { parseHostSandboxId } from "../../core/providers/host.js";
import type { SandboxInfo } from "../../core/providers/types.js";
import type { ServerEnv } from "../env.js";
import { query, tx } from "../db/index.js";
import { sanitizeFailureMessage } from "../safe-errors.js";
import type { KekProvider } from "../secrets/crypto.js";
import { platformCredentialsOf, withProviderCredential } from "./providercred.js";
import { buildCreateOwner } from "./owner-identity.js";
import {
  clientForHost,
  hostById,
  hostForPod,
  hostCanDial,
  requireHostAwake,
  type HostIdentity,
} from "./hostidentity.js";
import { lookupOriginalOperation, platformSandboxClient, platformToken } from "./operations.js";
import { getPod } from "./store.js";
import { acquireQuotaLocks } from "./concurrency.js";
import { staticHostUrlHash } from "./create-attempts.js";
import { withHostMachineProviderReadOnly } from "./hostmachine.js";
import type { PodRow } from "./types.js";

const RECOVERY_LEASE_SECONDS = 90;
const RECOVERY_BATCH_SIZE = 20;
const UNRESOLVED_PHASES = [
  "prepared",
  "dispatching",
  "unknown",
  "sandbox_known",
  "legacy_unresolved",
] as const;

interface RecoveryAttempt {
  id: string;
  pod_id: string;
  org_id: string;
  user_id: string;
  provider: "sandbox" | "host";
  attempt_no: number;
  operation_key: string | null;
  sandbox_host_id: string | null;
  host_pod_id: string | null;
  host_generation: string | null;
  runtime_boot_id: string | null;
  static_host_url_sha256: string | null;
  expected_sandbox_id: string | null;
  observed_candidate_sandbox_id: string | null;
  observed_match_count: number | null;
  sandbox_id: string | null;
  phase: string;
  owner_epoch: string;
  owner_instance_id: string | null;
  owner_token: string | null;
  owner_lease_until: string | null;
  recovery_epoch: string;
  recovery_token: string | null;
  recovery_lease_until: string | null;
  reason_code: string | null;
}

export interface CreateRecoveryDeps {
  env: ServerEnv;
  kek: KekProvider;
  log: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void };
}

function statusErrorCode(status: OperationStatusWire | null): string | null {
  const code = status?.error?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : null;
}

export function createStatusIdentityMatches(args: {
  status: OperationStatusWire;
  attempt: Pick<RecoveryAttempt, "pod_id" | "org_id" | "user_id">;
}): boolean {
  const id = args.status.sandboxId;
  const info = args.status.result;
  if (!id || !info || info.id !== id) return false;
  if (info.labels["pi-pod-server/pod"] !== args.attempt.pod_id) return false;
  if (info.labels["pi-pod-server/org"] !== args.attempt.org_id) return false;
  const owner = buildCreateOwner({ userId: args.attempt.user_id });
  return info.owner?.userKey === owner.userKey;
}

export function safeCreateTerminal(status: OperationStatusWire): boolean {
  return (status.status === "failed" || status.status === "cancelled") &&
    status.crossHostRetrySafe &&
    status.resolution !== "quarantined" &&
    status.error?.code !== "interrupted";
}

async function loadOriginalHost(args: {
  attempt: RecoveryAttempt;
  pod: PodRow;
  deps: CreateRecoveryDeps;
}): Promise<{ host: HostIdentity | null; client: ReturnType<typeof platformSandboxClient> }> {
  const token = platformToken(args.deps.env);
  if (args.attempt.sandbox_host_id) {
    const host = await hostById(args.attempt.sandbox_host_id);
    if (!host || !hostCanDial(host)) return { host, client: null };
    if (
      args.attempt.host_generation !== null &&
      String(host.generation) !== String(args.attempt.host_generation)
    ) return { host, client: null };
    requireHostAwake(host);
    return {
      host,
      client: await clientForHost(host.id, args.deps.kek, token).catch(() => null),
    };
  }

  const url = args.pod.resolved_config.config.providers?.sandbox?.url;
  if (typeof url !== "string" || staticHostUrlHash(url) !== args.attempt.static_host_url_sha256) {
    return { host: null, client: null };
  }
  return { host: null, client: platformSandboxClient(url, token) };
}

async function providerHasVerifiedSandbox(args: {
  id: string;
  attempt: RecoveryAttempt;
  pod: PodRow;
  deps: CreateRecoveryDeps;
}): Promise<boolean> {
  return withProviderCredential({
    pod: args.pod,
    sandboxHostId: args.attempt.sandbox_host_id,
    ownerUserId: args.attempt.user_id,
    kek: args.deps.kek,
    platformEnv: platformCredentialsOf(args.deps),
    orgId: args.attempt.org_id,
    provider: "sandbox",
    providerConfig: args.pod.resolved_config.config.providers?.sandbox ?? {},
    fn: async (provider) => Boolean(
      await provider.get(args.id, { workdir: args.pod.resolved_config.workdir }).catch(() => null),
    ),
  });
}

async function markUnknown(args: {
  attempt: RecoveryAttempt;
  token: string;
  reason: string;
  status?: OperationStatusWire | null;
  matchCount?: number;
  candidateId?: string | null;
}): Promise<void> {
  const status = args.status ?? null;
  await query(
    `UPDATE pod_create_attempts
        SET phase = CASE WHEN phase IN ('dispatching','unknown') THEN 'unknown' ELSE phase END,
            owner_token = NULL, owner_lease_until = NULL,
            recovery_token = NULL, recovery_lease_until = NULL,
            reason_code = $3,
            last_provider_status = $4,
            last_provider_resolution = $5,
            last_provider_error_code = $6,
            observed_match_count = COALESCE($7, observed_match_count),
            observed_candidate_sandbox_id = CASE WHEN $7 = 1 THEN $8 ELSE NULL END,
            last_observed_at = now(), next_observe_at = now() + interval '30 seconds', updated_at = now()
      WHERE id = $1 AND recovery_token = $2
        AND phase IN ('prepared', 'dispatching', 'unknown', 'sandbox_known', 'legacy_unresolved')`,
    [
      args.attempt.id,
      args.token,
      args.reason,
      status?.status ?? null,
      status?.resolution ?? null,
      statusErrorCode(status),
      args.matchCount ?? null,
      args.candidateId ?? null,
    ],
  );
}

async function bindInterruptedSandbox(args: {
  attempt: RecoveryAttempt;
  token: string;
  sandboxId: string;
  reason: string;
  status: OperationStatusWire | null;
}): Promise<void> {
  await tx(async (client) => {
    await acquireQuotaLocks(client, args.attempt.org_id, args.attempt.user_id);
    const recorded = await client.query(
      `UPDATE pod_create_attempts
          SET phase='initialization_interrupted', sandbox_id=$3,
              owner_token=NULL, owner_lease_until=NULL,
              recovery_token=NULL, recovery_lease_until=NULL,
              reason_code=$4, last_provider_status=$5,
              last_provider_resolution=$6, last_provider_error_code=$7,
              last_observed_at=now(), next_observe_at=NULL,
              bound_at=COALESCE(bound_at,now()), updated_at=now()
        WHERE id=$1 AND recovery_token=$2
          AND phase IN ('dispatching','unknown','sandbox_known')
          AND (sandbox_id IS NULL OR sandbox_id=$3)
        RETURNING pod_id, org_id`,
      [
        args.attempt.id,
        args.token,
        args.sandboxId,
        args.reason,
        args.status?.status ?? null,
        args.status?.resolution ?? null,
        statusErrorCode(args.status),
      ],
    );
    const row = recorded.rows[0] as { pod_id: string; org_id: string } | undefined;
    if (!row) return;
    await client.query(
      `UPDATE pods SET provider_sandbox_id=COALESCE(provider_sandbox_id,$3),
          provider_state='error', provider_state_changed_at=now(),
          state_reason='launch recovery found a sandbox but initialization did not complete',
          updated_at=now()
        WHERE id=$1 AND org_id=$2 AND state='active'
          AND (provider_sandbox_id IS NULL OR provider_sandbox_id=$3)`,
      [row.pod_id, row.org_id, args.sandboxId],
    );
  });
}

async function closePreparedAttempt(args: { attempt: RecoveryAttempt; token: string }): Promise<void> {
  await tx(async (client) => {
    await acquireQuotaLocks(client, args.attempt.org_id, args.attempt.user_id);
    const closed = await client.query(
      `UPDATE pod_create_attempts SET phase='aborted_unsent', reason_code='owner_exited_before_dispatch',
         owner_token=NULL, owner_lease_until=NULL, recovery_token=NULL, recovery_lease_until=NULL,
         next_observe_at=NULL, finished_at=now(), last_observed_at=now(), updated_at=now()
        WHERE id=$1 AND recovery_token=$2 AND phase='prepared' RETURNING pod_id,org_id`,
      [args.attempt.id, args.token],
    );
    const row = closed.rows[0] as { pod_id: string; org_id: string } | undefined;
    if (!row) return;
    await client.query(
      `UPDATE pods SET state='archived', archived_at=COALESCE(archived_at,now()),
         provider_state='gone', provider_state_changed_at=now(), reaped_at=now(),
         state_reason='launch owner exited before provider dispatch; no sandbox request was sent',
         updated_at=now()
        WHERE id=$1 AND org_id=$2 AND state='active' AND provider_sandbox_id IS NULL
          AND provider_state IN ('preparing_image','provisioning','starting')`,
      [row.pod_id, row.org_id],
    );
  });
}

async function closeSafeFailure(args: {
  attempt: RecoveryAttempt;
  token: string;
  status: OperationStatusWire;
}): Promise<void> {
  await tx(async (client) => {
    await acquireQuotaLocks(client, args.attempt.org_id, args.attempt.user_id);
    const result = await client.query(
      `UPDATE pod_create_attempts SET phase='failed_safe', reason_code='provider_preallocation_confirmed',
         owner_token=NULL, owner_lease_until=NULL, recovery_token=NULL, recovery_lease_until=NULL,
         next_observe_at=NULL, finished_at=now(), last_observed_at=now(),
         last_provider_status=$3, last_provider_resolution=$4, last_provider_error_code=$5, updated_at=now()
        WHERE id=$1 AND recovery_token=$2 AND phase IN ('dispatching','unknown')
          AND sandbox_id IS NULL RETURNING pod_id,org_id`,
      [
        args.attempt.id,
        args.token,
        args.status.status,
        args.status.resolution,
        statusErrorCode(args.status),
      ],
    );
    const row = result.rows[0] as { pod_id: string; org_id: string } | undefined;
    if (!row) return;
    await client.query(
      `UPDATE pods SET state='archived', archived_at=COALESCE(archived_at,now()),
         provider_state='gone', provider_state_changed_at=now(), reaped_at=now(),
         state_reason='the original host confirmed the create failed before allocation', updated_at=now()
        WHERE id=$1 AND org_id=$2 AND state='active' AND provider_sandbox_id IS NULL
          AND provider_state IN ('preparing_image','provisioning','starting')`,
      [row.pod_id, row.org_id],
    );
  });
}

async function observeHostChild(args: {
  attempt: RecoveryAttempt;
  token: string;
  pod: PodRow;
  deps: CreateRecoveryDeps;
}): Promise<void> {
  const hostPodId = args.attempt.host_pod_id ?? args.pod.host_pod_id;
  const expectedId = args.attempt.expected_sandbox_id;
  if (!hostPodId || !expectedId) {
    await markUnknown({ attempt: args.attempt, token: args.token, reason: "host_child_identity_unavailable" });
    return;
  }
  const host = await getPod(args.attempt.org_id, hostPodId);
  const parsed = parseHostSandboxId(expectedId);
  if (!parsed || parsed.hostId !== host.id || parsed.childId !== args.pod.id) {
    await markUnknown({ attempt: args.attempt, token: args.token, reason: "host_child_identity_mismatch" });
    return;
  }
  const observed = await withHostMachineProviderReadOnly(
    { env: args.deps.env, kek: args.deps.kek, log: args.deps.log },
    host,
    async (provider, machine) => {
      if ((await machine.state()) !== "started") return false;
      const sandbox = await provider.get(expectedId, { workdir: args.pod.resolved_config.workdir });
      if (!sandbox) return false;
      const state = await sandbox.state();
      return state !== "gone";
    },
  );
  if (observed) {
    await bindInterruptedSandbox({
      attempt: args.attempt,
      token: args.token,
      sandboxId: expectedId,
      reason: "host_child_observed_after_owner_exit",
      status: null,
    });
    return;
  }
  await markUnknown({ attempt: args.attempt, token: args.token, reason: "host_child_not_observed" });
}

async function observeLegacyCandidate(args: {
  attempt: RecoveryAttempt;
  token: string;
  pod: PodRow;
  deps: CreateRecoveryDeps;
}): Promise<void> {
  if (args.attempt.provider !== "sandbox") {
    await markUnknown({ attempt: args.attempt, token: args.token, reason: "legacy_host_child_requires_review" });
    return;
  }
  const host = await hostForPod(args.pod);
  if (host && !hostCanDial(host)) {
    await markUnknown({ attempt: args.attempt, token: args.token, reason: "legacy_original_host_unavailable" });
    return;
  }
  const providerConfig = args.pod.resolved_config.config.providers?.sandbox ?? {};
  const matches = await withProviderCredential({
    pod: args.pod,
    sandboxHostId: args.attempt.sandbox_host_id,
    ownerUserId: args.attempt.user_id,
    kek: args.deps.kek,
    platformEnv: platformCredentialsOf(args.deps),
    orgId: args.attempt.org_id,
    provider: "sandbox",
    providerConfig,
    fn: async (provider) => {
      const rows: SandboxInfo[] = await provider.list({ "pi-pod-server/pod": args.pod.id });
      return rows.filter((row) =>
        row.labels["pi-pod-server/pod"] === args.pod.id &&
        row.labels["pi-pod-server/org"] === args.pod.org_id,
      );
    },
  });
  await markUnknown({
    attempt: args.attempt,
    token: args.token,
    reason: matches.length === 0 ? "legacy_no_label_match" : matches.length === 1
      ? "legacy_candidate_requires_review" : "legacy_multiple_label_matches",
    matchCount: matches.length,
    candidateId: matches.length === 1 ? matches[0]!.id : null,
  });
}

async function observeCreateAttempt(args: {
  attempt: RecoveryAttempt;
  token: string;
  deps: CreateRecoveryDeps;
}): Promise<void> {
  const { attempt } = args;
  const pod = await getPod(attempt.org_id, attempt.pod_id);
  if (attempt.phase === "prepared") {
    await closePreparedAttempt(args);
    return;
  }
  if (attempt.phase === "sandbox_known" && attempt.sandbox_id) {
    await bindInterruptedSandbox({
      attempt,
      token: args.token,
      sandboxId: attempt.sandbox_id,
      reason: "create_response_recorded_before_owner_exit",
      status: null,
    });
    return;
  }
  if (attempt.phase === "legacy_unresolved") {
    await observeLegacyCandidate({ ...args, pod, deps: args.deps });
    return;
  }
  if (attempt.provider === "host") {
    await observeHostChild({ attempt, token: args.token, pod, deps: args.deps });
    return;
  }
  if (!attempt.operation_key) {
    await markUnknown({ attempt, token: args.token, reason: "provider_operation_key_missing" });
    return;
  }

  const { host, client } = await loadOriginalHost({ attempt, pod, deps: args.deps });
  if (!client) {
    await markUnknown({ attempt, token: args.token, reason: host ? "original_host_unavailable" : "original_host_identity_unavailable" });
    return;
  }
  const lookup = await lookupOriginalOperation(client, attempt.operation_key);
  if (host && attempt.host_generation !== null) {
    const current = await hostById(host.id).catch(() => null);
    if (!current || String(current.generation) !== String(attempt.host_generation)) {
      await markUnknown({ attempt, token: args.token, reason: "original_host_changed_during_observation", status: lookup.status });
      return;
    }
  }
  const status = lookup.status;
  if (status?.status === "succeeded") {
    if (!createStatusIdentityMatches({ status, attempt })) {
      await markUnknown({ attempt, token: args.token, reason: "provider_success_identity_unverified", status });
      return;
    }
    const sandboxId = status.sandboxId!;
    const exists = await providerHasVerifiedSandbox({ id: sandboxId, attempt, pod, deps: args.deps }).catch(() => false);
    if (!exists) {
      await markUnknown({ attempt, token: args.token, reason: "provider_success_sandbox_not_observable", status });
      return;
    }
    if (host && (!hostCanDial(host) || String((await hostById(host.id))?.generation) !== String(host.generation))) {
      await markUnknown({ attempt, token: args.token, reason: "original_host_changed_during_observation", status });
      return;
    }
    await bindInterruptedSandbox({
      attempt,
      token: args.token,
      sandboxId,
      reason: "provider_create_succeeded_after_owner_exit",
      status,
    });
    return;
  }
  if (status && safeCreateTerminal(status)) {
    await closeSafeFailure({ attempt, token: args.token, status });
    return;
  }
  const reason = status?.status === "pending"
    ? "provider_operation_pending"
    : status?.error?.code === "interrupted"
      ? "provider_operation_interrupted"
      : lookup.fetchError?.status === 404
        ? "provider_operation_not_found"
        : status ? "provider_terminal_outcome_not_safe" : "provider_operation_unavailable";
  await markUnknown({ attempt, token: args.token, reason, status });
}

async function claimAttempt(id: string): Promise<{ attempt: RecoveryAttempt; token: string } | null> {
  const token = randomUUID();
  const result = await query<RecoveryAttempt>(
    `UPDATE pod_create_attempts AS a
        SET recovery_epoch=a.recovery_epoch+1, recovery_token=$2,
            recovery_lease_until=clock_timestamp()+make_interval(secs => $3),
            owner_epoch=a.owner_epoch+1, owner_token=NULL, owner_lease_until=NULL,
            updated_at=now()
      WHERE a.id=$1 AND a.phase=ANY($4::text[])
        AND (a.owner_token IS NULL OR a.owner_lease_until < clock_timestamp())
        AND (a.recovery_token IS NULL OR a.recovery_lease_until < clock_timestamp())
        AND (a.next_observe_at IS NULL OR a.next_observe_at <= clock_timestamp())
      RETURNING a.*`,
    [id, token, RECOVERY_LEASE_SECONDS, [...UNRESOLVED_PHASES]],
  );
  const attempt = result.rows[0];
  return attempt ? { attempt, token } : null;
}

/** GET-only observer for ambiguous and legacy create attempts. Never creates, starts, cancels, or deletes. */
export async function runCreateRecovery(deps: CreateRecoveryDeps): Promise<void> {
  try {
    const due = await query<{ id: string }>(
      `SELECT id FROM pod_create_attempts
        WHERE phase=ANY($1::text[])
          AND (owner_token IS NULL OR owner_lease_until < clock_timestamp())
          AND (recovery_token IS NULL OR recovery_lease_until < clock_timestamp())
          AND (next_observe_at IS NULL OR next_observe_at <= clock_timestamp())
        ORDER BY COALESCE(next_observe_at,created_at), created_at
        LIMIT $2`,
      [[...UNRESOLVED_PHASES], RECOVERY_BATCH_SIZE]
    );
    for (const { id } of due.rows) {
      const claimed = await claimAttempt(id).catch(() => null);
      if (!claimed) continue;
      try {
        await observeCreateAttempt({ ...claimed, deps });
      } catch (error) {
        deps.log.warn(sanitizeFailureMessage(error, { prefix: "launch recovery observation failed" }));
        await markUnknown({ attempt: claimed.attempt, token: claimed.token, reason: "recovery_observation_failed" }).catch(() => {});
      }
    }
  } catch (error) {
    deps.log.error(sanitizeFailureMessage(error, { prefix: "launch recovery worker failed" }));
  }
}
