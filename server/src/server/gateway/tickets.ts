import { randomBytes } from "node:crypto";
import { query } from "../db/index.js";
import { unauthorized } from "../httperrors.js";
import { uuidv7 } from "../ids.js";

const TICKET_TTL_MS = 60 * 1000;

/**
 * One-shot WebSocket tickets (spec §4.1, §13): short expiry, bound to (user, pod), single
 * use — the JWT itself never appears in a URL.
 */
export async function mintTicket(userId: string, podId: string): Promise<{ ticket: string; expiresAt: string }> {
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();
  await query(
    "INSERT INTO ws_tickets (id, ticket, user_id, pod_id, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [uuidv7(), ticket, userId, podId, expiresAt],
  );
  return { ticket, expiresAt };
}

export async function consumeTicket(
  ticket: string,
  podId: string,
): Promise<{ userId: string; orgId: string }> {
  // Consume and recover routing metadata in one round-trip. The CTE keeps the one-shot
  // mutation atomic while avoiding a second pods lookup on every WebSocket attach.
  const rows = await query<{ user_id: string; org_id: string }>(
    `WITH consumed AS (
       UPDATE ws_tickets SET used_at = now()
       WHERE ticket = $1 AND pod_id = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id, pod_id
     )
     SELECT consumed.user_id, pods.org_id
     FROM consumed JOIN pods ON pods.id = consumed.pod_id`,
    [ticket, podId],
  );
  const row = rows.rows[0];
  if (!row) throw unauthorized("invalid, expired, or already-used ticket");
  return { userId: row.user_id, orgId: row.org_id };
}

/**
 * Un-spend a ticket whose attach failed server-side (pod stopped, lease busy): the user
 * paid for a session they never got, so the retry may reuse it within the original TTL.
 */
export async function refundTicket(ticket: string): Promise<void> {
  await query(
    "UPDATE ws_tickets SET used_at = NULL WHERE ticket = $1 AND expires_at > now()",
    [ticket],
  );
}
