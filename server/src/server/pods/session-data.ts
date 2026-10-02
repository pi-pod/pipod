import { tx, type Queryable } from "../db/index.js";
import { conflict } from "../httperrors.js";

export interface PurgedPodSessionDataCounts {
  sessionEvents: number;
  sessions: number;
  queuedPrompts: number;
  forkSeeds: number;
}

/**
 * Same-client form used when sandbox finalization, transcript deletion and the
 * caller's audit must commit atomically. The caller owns the transaction.
 */
export async function purgePodSessionDataIn(
  client: Queryable,
  podId: string,
): Promise<PurgedPodSessionDataCounts> {
  const held = await client.query<{ phase: string }>(
    `SELECT phase FROM pod_create_attempts
      WHERE pod_id=$1 AND phase IN ('prepared','dispatching','unknown','sandbox_known',
        'initialization_interrupted','legacy_unresolved','delete_pending')
      LIMIT 1`,
    [podId],
  );
  if (held.rows[0]) {
    throw conflict("session data is retained while the provider create outcome is unresolved", {
      code: "launch_recovery_required",
    });
  }
  const sessionEvents = await client.query(
    `DELETE FROM session_events e USING sessions s
      WHERE e.session_id = s.id AND s.pod_id = $1`,
    [podId],
  );
  const sessions = await client.query(`DELETE FROM sessions WHERE pod_id = $1`, [podId]);
  const queuedPrompts = await client.query(`DELETE FROM queued_prompts WHERE pod_id = $1`, [podId]);
  const forkSeeds = await client.query(`DELETE FROM pod_fork_seeds WHERE pod_id = $1`, [podId]);
  return {
    sessionEvents: sessionEvents.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0,
    queuedPrompts: queuedPrompts.rowCount ?? 0,
    forkSeeds: forkSeeds.rowCount ?? 0,
  };
}

/** Delete only still-usable tickets. Expired ticket rows remain harmless history. */
export async function purgeUnexpiredPodTicketsIn(client: Queryable, podId: string): Promise<number> {
  const result = await client.query(
    "DELETE FROM ws_tickets WHERE pod_id=$1 AND expires_at>now()",
    [podId],
  );
  return result.rowCount ?? 0;
}

/** Drop a pod's transcript and adjacent session rows after the sandbox is gone. */
export async function purgePodSessionData(podId: string): Promise<void> {
  await tx(async (client) => {
    await purgePodSessionDataIn(client, podId);
  });
}
