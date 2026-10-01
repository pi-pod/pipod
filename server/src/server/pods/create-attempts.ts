import { createHash, randomBytes, randomUUID } from "node:crypto";
import { query, tx, type Queryable } from "../db/index.js";
import { conflict, serviceUnavailable } from "../httperrors.js";
import {
  assertLaunchAllowed,
  LAUNCH_RECOVERY_PROTOCOL_VERSION,
} from "./launch-control.js";
import { SERVER_PROCESS_INCARNATION } from "./process-incarnation.js";
import { acquireQuotaLocks } from "./concurrency.js";

const OWNER_LEASE_SECONDS = 60;
const ALWAYS_HELD_PHASES = ["unknown", "initialization_interrupted", "legacy_unresolved", "delete_pending"];
const OPERATION_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export interface CreateAttemptRow {
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
  host_runtime_sha256: string | null;
  runtime_boot_id: string | null;
  static_host_url_sha256: string | null;
  expected_sandbox_id: string | null;
  sandbox_id: string | null;
  phase: string;
  owner_epoch: string;
  owner_instance_id: string | null;
  owner_token: string | null;
  owner_lease_until: string | null;
  dispatch_owner_epoch: string | null;
  launch_control_epoch: string | null;
  recovery_epoch: string;
  recovery_token: string | null;
  recovery_lease_until: string | null;
  reason_code: string | null;
}

export interface PreparedCreateAttempt {
  id: string;
  attemptNo: number;
  operationKey: string | null;
  ownerToken: string;
  ownerInstanceId: string;
  ownerEpoch: number;
  launchControlEpoch: number;
  provider: "sandbox" | "host";
  expectedSandboxId: string | null;
}

export function createOperationKey(): string {
  const key = `create-${randomBytes(24).toString("base64url")}`;
  if (!OPERATION_KEY.test(key)) throw new Error("cannot build a valid create-attempt key");
  return key;
}

export function staticHostUrlHash(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Provider URLs are transport identity, not credentials. Reject credential/query/hash
  // material before storing even a digest, so a malformed URL cannot smuggle a secret.
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return createHash("sha256").update(parsed.toString()).digest("hex");
}

function newOwnerToken(): string {
  return randomUUID();
}

/** Create the journal row in the same transaction as the newly admitted pod. */
export async function prepareCreateAttemptTx(
  client: Queryable,
  args: {
    podId: string;
    orgId: string;
    userId: string;
    provider: "sandbox" | "host";
    hostId: string | null;
    hostPodId?: string | null;
    hostGeneration?: string | number | null;
    hostRuntimeSha256?: string | null;
    runtimeBootId?: string | null;
    hostUrl?: string | null;
    expectedSandboxId?: string | null;
  },
): Promise<PreparedCreateAttempt> {
  const gate = await assertLaunchAllowed(client, args.userId);
  const attemptNoResult = await client.query<{ next_attempt_no: number }>(
    `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_attempt_no
       FROM pod_create_attempts WHERE pod_id = $1`,
    [args.podId],
  );
  const attemptNo = attemptNoResult.rows[0]?.next_attempt_no ?? 1;
  const operationKey = args.provider === "sandbox" ? createOperationKey() : null;
  const ownerToken = newOwnerToken();
  const ownerInstanceId = SERVER_PROCESS_INCARNATION;
  const ownerEpoch = 1;
  const result = await client.query<{ id: string }>(
    `INSERT INTO pod_create_attempts
       (pod_id, org_id, user_id, provider, attempt_no, operation_key,
        sandbox_host_id, host_pod_id, host_generation, host_runtime_sha256,
        runtime_boot_id, static_host_url_sha256, expected_sandbox_id, phase,
        owner_epoch, owner_instance_id, owner_token, owner_lease_until,
        launch_control_epoch, reason_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'prepared',
             $14,$15,$16,now() + make_interval(secs => $17),$18,'launch_prepared')
     RETURNING id`,
    [
      args.podId,
      args.orgId,
      args.userId,
      args.provider,
      attemptNo,
      operationKey,
      args.hostId,
      args.hostPodId ?? null,
      args.hostGeneration ?? null,
      args.hostRuntimeSha256 ?? null,
      args.runtimeBootId ?? null,
      staticHostUrlHash(args.hostUrl),
      args.expectedSandboxId ?? null,
      ownerEpoch,
      ownerInstanceId,
      ownerToken,
      OWNER_LEASE_SECONDS,
      gate.epoch,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("create attempt journal insert returned no row");
  return {
    id: row.id,
    attemptNo,
    operationKey,
    ownerToken,
    ownerInstanceId,
    ownerEpoch,
    launchControlEpoch: Number(gate.epoch),
    provider: args.provider,
    expectedSandboxId: args.expectedSandboxId ?? null,
  };
}

/** Mark the exact provider request as dispatched before its one allowed POST. */
export async function markCreateAttemptDispatchingTx(
  client: Queryable,
  args: { attemptId: string; ownerToken: string; orgId: string; userId: string; ownerInstanceId?: string },
): Promise<void> {
  await acquireQuotaLocks(client, args.orgId, args.userId);
  await assertLaunchAllowed(client, args.userId, args.attemptId);
  const result = await client.query(
    `UPDATE pod_create_attempts
        SET phase = 'dispatching', dispatch_committed_at = clock_timestamp(),
            dispatch_owner_epoch = owner_epoch,
            owner_lease_until = clock_timestamp() + make_interval(secs => $4),
            next_observe_at = clock_timestamp() + interval '2 seconds',
            updated_at = now(), reason_code = NULL
      WHERE id = $1 AND phase = 'prepared' AND owner_token = $2
        AND owner_instance_id = $3 AND owner_lease_until > clock_timestamp()
        AND recovery_token IS NULL
        AND EXISTS (SELECT 1 FROM launch_recovery_control
                     WHERE singleton = true AND mode = 'open' AND required_protocol <= $5)
        AND NOT EXISTS (SELECT 1 FROM pod_create_attempts AS other
                         WHERE other.user_id = pod_create_attempts.user_id
                           AND other.id <> pod_create_attempts.id
                           AND (other.phase = ANY($6::text[]) OR
                             (other.phase IN ('dispatching','sandbox_known') AND (
                               other.owner_token IS NULL OR other.owner_instance_id IS NULL
                               OR other.owner_lease_until IS NULL
                               OR other.owner_lease_until <= clock_timestamp()
                               OR other.recovery_token IS NOT NULL))))
        AND EXISTS (SELECT 1 FROM pods AS p WHERE p.id = pod_create_attempts.pod_id
                     AND p.state = 'active' AND p.provider_state IN ('preparing_image','provisioning')
                     AND p.provider_sandbox_id IS NULL)
      RETURNING id`,
    [
      args.attemptId,
      args.ownerToken,
      args.ownerInstanceId ?? SERVER_PROCESS_INCARNATION,
      OWNER_LEASE_SECONDS,
      LAUNCH_RECOVERY_PROTOCOL_VERSION,
      ALWAYS_HELD_PHASES,
    ],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw conflict("launch ownership changed before provider dispatch", { code: "launch_recovery_required" });
  }
}

/** A provider-confirmed pre-allocation outcome is the only automatic retry/failover release. */
export async function markCreateAttemptFailedSafeTx(
  client: Queryable,
  args: { attemptId: string; ownerToken: string; ownerInstanceId?: string; orgId: string; userId: string; reasonCode: string },
): Promise<void> {
  await acquireQuotaLocks(client, args.orgId, args.userId);
  const result = await client.query(
    `UPDATE pod_create_attempts
        SET phase = 'failed_safe', reason_code = $3, owner_token = NULL,
            owner_lease_until = NULL, next_observe_at = NULL,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND owner_token = $2
        AND owner_instance_id = $4 AND owner_lease_until > clock_timestamp()
        AND recovery_token IS NULL AND phase = 'dispatching'
      RETURNING id`,
    [args.attemptId, args.ownerToken, args.reasonCode, args.ownerInstanceId ?? SERVER_PROCESS_INCARNATION],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw conflict("launch ownership changed while recording a provider refusal", {
      code: "launch_recovery_required",
    });
  }
}

/** Unknown means held forever until positive original-host evidence changes it. */
export async function markCreateAttemptUnknownTx(
  client: Queryable,
  args: {
    attemptId: string;
    ownerToken: string;
    ownerInstanceId?: string;
    orgId: string;
    userId: string;
    reasonCode: string;
    observedAt?: boolean;
    clearOwner?: boolean;
  },
): Promise<void> {
  await acquireQuotaLocks(client, args.orgId, args.userId);
  const result = await client.query(
    `UPDATE pod_create_attempts
        SET phase = 'unknown', reason_code = $2,
            owner_token = CASE WHEN $4 THEN NULL ELSE owner_token END,
            owner_lease_until = CASE WHEN $4 THEN NULL ELSE owner_lease_until END,
            last_observed_at = CASE WHEN $3 THEN now() ELSE last_observed_at END,
            next_observe_at = now() + interval '30 seconds', updated_at = now()
      WHERE id = $1 AND owner_token=$5 AND owner_instance_id=$6
        AND owner_lease_until > clock_timestamp() AND recovery_token IS NULL
        AND phase IN ('dispatching', 'unknown', 'sandbox_known')`,
    [
      args.attemptId,
      args.reasonCode,
      args.observedAt ?? false,
      args.clearOwner ?? false,
      args.ownerToken,
      args.ownerInstanceId ?? SERVER_PROCESS_INCARNATION,
    ],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw conflict("launch ownership changed while recording uncertainty", { code: "launch_recovery_required" });
  }
}

/** Evidence update only: a late response may reveal identity but cannot reacquire execution. */
export async function recordObservedSandboxTx(
  client: Queryable,
  args: { attemptId: string; sandboxId: string; reasonCode?: string },
): Promise<CreateAttemptRow | null> {
  const result = await client.query<CreateAttemptRow>(
    `UPDATE pod_create_attempts
        SET sandbox_id = COALESCE(sandbox_id, $2),
            phase = CASE WHEN phase IN ('dispatching', 'unknown') THEN 'sandbox_known' ELSE phase END,
            reason_code = COALESCE($3, reason_code), bound_at = COALESCE(bound_at, now()),
            last_observed_at = now(), next_observe_at = NULL, updated_at = now()
      WHERE id = $1 AND (sandbox_id IS NULL OR sandbox_id = $2)
      RETURNING *`,
    [args.attemptId, args.sandboxId, args.reasonCode ?? null],
  );
  return result.rows[0] ?? null;
}

/** Verify the original execution owner still has authority before another local/provider phase. */
export async function assertCreateAttemptOwner(args: {
  attemptId: string;
  ownerToken: string;
  ownerInstanceId?: string;
  allowedPhases?: readonly string[];
}): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT a.id FROM pod_create_attempts AS a
       JOIN pods AS p ON p.id = a.pod_id
      WHERE a.id = $1 AND a.owner_token = $2 AND a.owner_instance_id = $3
        AND a.owner_lease_until > clock_timestamp() AND a.recovery_token IS NULL
        AND a.phase = ANY($4::text[])
        AND p.state = 'active' AND p.provider_state IN ('preparing_image','provisioning','starting')
        AND (p.provider_sandbox_id IS NULL OR p.provider_sandbox_id = a.sandbox_id)
        AND EXISTS (SELECT 1 FROM launch_recovery_control AS c
                     WHERE c.singleton = true AND c.mode = 'open'
                       AND c.required_protocol <= $5)`,
    [
      args.attemptId,
      args.ownerToken,
      args.ownerInstanceId ?? SERVER_PROCESS_INCARNATION,
      [...(args.allowedPhases ?? ["prepared", "dispatching", "sandbox_known"])],
      LAUNCH_RECOVERY_PROTOCOL_VERSION,
    ],
  );
  if (!result.rows[0]) {
    throw serviceUnavailable("launch ownership changed; recovery is required", {
      code: "launch_recovery_required",
    });
  }
}

/** Heartbeat the attempt owner and the legacy pod heartbeat together. */
export async function assertPodLifecycleAction(args: {
  podId: string;
  providerState: string;
  providerSandboxId: string | null;
  action: "start" | "stop" | "archive" | "restore" | "delete";
}): Promise<void> {
  const result = await query<{ phase: string; sandbox_id: string | null }>(
    `SELECT phase, sandbox_id FROM pod_create_attempts
      WHERE pod_id=$1 ORDER BY attempt_no DESC LIMIT 1`,
    [args.podId],
  );
  const attempt = result.rows[0];
  if (!attempt) {
    if (
      args.providerSandboxId === null &&
      ["preparing_image", "provisioning", "starting", "error"].includes(args.providerState)
    ) {
      throw conflict("this launch has no durable outcome record; operator recovery is required", {
        code: "launch_recovery_required",
      });
    }
    return;
  }
  if (!["prepared", "dispatching", "unknown", "sandbox_known", "initialization_interrupted", "legacy_unresolved", "delete_pending"].includes(attempt.phase)) return;
  if (attempt.phase === "prepared" && args.action === "delete" && args.providerSandboxId === null) return;
  const identityKnown = args.providerSandboxId !== null && attempt.sandbox_id === args.providerSandboxId;
  if (identityKnown && (args.action === "delete" || args.action === "stop")) return;
  throw conflict("this launch outcome is unresolved; lifecycle changes are paused until recovery completes", {
    code: "launch_recovery_required",
  });
}

/** Atomically cancel only a prepared attempt that has never been authorized to POST. */
export async function abandonUnsentCreateTx(
  client: Queryable,
  args: { podId: string; orgId: string; userId: string; providerState: string },
): Promise<boolean> {
  await acquireQuotaLocks(client, args.orgId, args.userId);
  const current = await client.query<CreateAttemptRow>(
    `SELECT * FROM pod_create_attempts WHERE pod_id=$1
      ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`,
    [args.podId],
  );
  const attempt = current.rows[0];
  if (attempt?.phase === "prepared") {
    await client.query(
      `UPDATE pod_create_attempts SET phase='aborted_unsent',
         reason_code='user_cancelled_before_dispatch', owner_token=NULL,
         owner_lease_until=NULL, next_observe_at=NULL, finished_at=now(), updated_at=now()
        WHERE id=$1 AND phase='prepared'`,
      [attempt.id],
    );
  } else if (attempt && !["failed_safe", "aborted_unsent", "deleted"].includes(attempt.phase)) {
    throw conflict("a provider create may still be running; deletion is paused until its identity is recovered", {
      code: "launch_recovery_required",
    });
  } else if (
    !attempt && ["preparing_image", "provisioning", "starting", "error"].includes(args.providerState)
  ) {
    throw conflict("this launch has no durable outcome record; operator recovery is required", {
      code: "launch_recovery_required",
    });
  }
  const result = await client.query(
    `UPDATE pods SET provider_state='gone', provider_state_changed_at=now(), updated_at=now()
      WHERE id=$1 AND org_id=$2 AND state='active' AND provider_state=$3
        AND provider_sandbox_id IS NULL RETURNING id`,
    [args.podId, args.orgId, args.providerState],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function heartbeatCreateAttempt(args: {
  attemptId: string;
  podId: string;
  ownerToken: string;
  ownerInstanceId?: string;
}): Promise<boolean> {
  return tx(async (client) => {
    const attempt = await client.query(
      `UPDATE pod_create_attempts
          SET owner_lease_until = now() + make_interval(secs => $4), updated_at = now()
        WHERE id = $1 AND owner_token = $2 AND owner_instance_id = $3
          AND phase IN ('prepared', 'dispatching', 'sandbox_known')
          AND owner_lease_until > clock_timestamp() AND recovery_token IS NULL
        RETURNING id`,
      [
        args.attemptId,
        args.ownerToken,
        args.ownerInstanceId ?? SERVER_PROCESS_INCARNATION,
        OWNER_LEASE_SECONDS,
      ],
    );
    if ((attempt.rowCount ?? 0) !== 1) return false;
    const pod = await client.query(
      `UPDATE pods SET provisioning_heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'active'
          AND provider_state IN ('preparing_image', 'provisioning', 'starting')`,
      [args.podId],
    );
    if ((pod.rowCount ?? 0) === 1) return true;
    await client.query(
      `UPDATE pod_create_attempts SET owner_token=NULL, owner_lease_until=NULL, updated_at=now()
        WHERE id=$1 AND owner_token=$2`,
      [args.attemptId, args.ownerToken],
    );
    return false;
  });
}

/** Finish a fully initialized launch and atomically release its owner hold. */
export async function finishCreateAttemptTx(
  client: Queryable,
  args: { attemptId: string; ownerToken: string; ownerInstanceId?: string; sandboxId: string },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE pod_create_attempts
        SET phase = 'ready', sandbox_id = COALESCE(sandbox_id, $3),
            owner_token = NULL, owner_lease_until = NULL, next_observe_at = NULL,
            reason_code = NULL, finished_at = now(), updated_at = now()
      WHERE id = $1 AND owner_token = $2
        AND owner_instance_id = $4 AND owner_lease_until > clock_timestamp()
        AND recovery_token IS NULL AND phase = 'sandbox_known'
        AND (sandbox_id IS NULL OR sandbox_id = $3)
      RETURNING id`,
    [args.attemptId, args.ownerToken, args.sandboxId, args.ownerInstanceId ?? SERVER_PROCESS_INCARNATION],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Preserve a known sandbox after interrupted initialization; never stop or delete it here. */
export async function interruptCreateAttemptTx(
  client: Queryable,
  args: { attemptId: string; ownerToken: string; reasonCode: string },
): Promise<void> {
  await client.query(
    `UPDATE pod_create_attempts
        SET phase = 'initialization_interrupted', reason_code = $3,
            owner_token = NULL, owner_lease_until = NULL,
            next_observe_at = NULL, updated_at = now()
      WHERE id = $1 AND owner_token = $2 AND phase = 'sandbox_known'`,
    [args.attemptId, args.ownerToken, args.reasonCode],
  );
}

/** Repoint an unsent attempt, or create a new attempt after a confirmed safe failure. */
export async function assignCreateAttemptTx(
  client: Queryable,
  args: {
    previous: PreparedCreateAttempt;
    podId: string;
    orgId: string;
    userId: string;
    provider: "sandbox" | "host";
    hostId: string | null;
    hostPodId?: string | null;
    hostGeneration?: string | number | null;
    hostRuntimeSha256?: string | null;
    runtimeBootId?: string | null;
    hostUrl?: string | null;
    expectedSandboxId?: string | null;
  },
): Promise<PreparedCreateAttempt> {
  await acquireQuotaLocks(client, args.orgId, args.userId);
  const gate = await assertLaunchAllowed(client, args.userId, args.previous.id);
  const previous = await client.query<CreateAttemptRow>(
    `SELECT * FROM pod_create_attempts WHERE id = $1 FOR UPDATE`,
    [args.previous.id],
  );
  const row = previous.rows[0];
  if (!row || row.owner_instance_id !== args.previous.ownerInstanceId) {
    throw conflict("launch ownership changed while assigning a host", { code: "launch_recovery_required" });
  }
  if (row.phase === "prepared") {
    if (row.owner_token !== args.previous.ownerToken) {
      throw conflict("launch ownership changed while assigning a host", { code: "launch_recovery_required" });
    }
    // No dispatch was committed: it is safe to update the original assignment and keep its key.
    const updated = await client.query(
      `UPDATE pod_create_attempts
          SET sandbox_host_id=$2, host_pod_id=$3, host_generation=$4,
              host_runtime_sha256=$5, runtime_boot_id=$6, static_host_url_sha256=$7,
              expected_sandbox_id=$8, launch_control_epoch=$9, updated_at=now()
        WHERE id=$1 AND phase='prepared' AND owner_token=$10
        RETURNING id`,
      [
        row.id,
        args.hostId,
        args.hostPodId ?? null,
        args.hostGeneration ?? null,
        args.hostRuntimeSha256 ?? null,
        args.runtimeBootId ?? null,
        staticHostUrlHash(args.hostUrl),
        args.expectedSandboxId ?? null,
        gate.epoch,
        args.previous.ownerToken,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) throw conflict("launch assignment changed", { code: "launch_recovery_required" });
    return {
      ...args.previous,
      launchControlEpoch: Number(gate.epoch),
      expectedSandboxId: args.expectedSandboxId ?? null,
    };
  }
  if (row.phase !== "failed_safe") {
    throw conflict("an uncertain create cannot be assigned to another host", {
      code: "launch_recovery_required",
    });
  }
  const attemptNo = row.attempt_no + 1;
  const ownerToken = newOwnerToken();
  const operationKey = args.provider === "sandbox" ? createOperationKey() : null;
  const result = await client.query<{ id: string }>(
    `INSERT INTO pod_create_attempts
       (pod_id, org_id, user_id, provider, protocol_version, attempt_no, operation_key,
        sandbox_host_id, host_pod_id, host_generation, host_runtime_sha256,
        runtime_boot_id, static_host_url_sha256, expected_sandbox_id, phase,
        owner_epoch, owner_instance_id, owner_token, owner_lease_until, launch_control_epoch, reason_code)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,'prepared',
             $14,$15,$16,now() + make_interval(secs => $17),$18,'launch_prepared')
     RETURNING id`,
    [
      args.podId,
      args.orgId,
      args.userId,
      args.provider,
      attemptNo,
      operationKey,
      args.hostId,
      args.hostPodId ?? null,
      args.hostGeneration ?? null,
      args.hostRuntimeSha256 ?? null,
      args.runtimeBootId ?? null,
      staticHostUrlHash(args.hostUrl),
      args.expectedSandboxId ?? null,
      Number(row.owner_epoch) + 1,
      SERVER_PROCESS_INCARNATION,
      ownerToken,
      OWNER_LEASE_SECONDS,
      gate.epoch,
    ],
  );
  const inserted = result.rows[0];
  if (!inserted) throw new Error("next create attempt insert returned no row");
  // The previous attempt is terminal before the partial unique index permits this insert.
  const closed = await client.query(
    `UPDATE pod_create_attempts SET reason_code='safe_refusal_followed', updated_at=now()
      WHERE id=$1 AND phase='failed_safe'`,
    [row.id],
  );
  if ((closed.rowCount ?? 0) !== 1) throw conflict("safe refusal changed during reassignment");
  return {
    id: inserted.id,
    attemptNo,
    operationKey,
    ownerToken,
    ownerInstanceId: SERVER_PROCESS_INCARNATION,
    ownerEpoch: Number(row.owner_epoch) + 1,
    launchControlEpoch: Number(gate.epoch),
    provider: args.provider,
    expectedSandboxId: args.expectedSandboxId ?? null,
  };
}
