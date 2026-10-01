/**
 * Pod-level conversation history: gateway sessions are an implementation detail, but the
 * phone shows one continuous transcript. This module merges those per-session event logs
 * into a single chronological stream with stable (sessionId, seq) cursors.
 */

export interface ConversationEvent {
  sessionId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface ConversationCursor {
  sessionId: string;
  seq: number;
}

export interface ConversationPage {
  events: ConversationEvent[];
  nextBefore: ConversationCursor | null;
}

export function parseConversationCursor(raw: string | undefined): ConversationCursor | null {
  if (raw === undefined || raw === "") return null;
  const separator = raw.lastIndexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(`conversation cursor must be sessionId:seq, got "${raw}"`);
  }
  const sessionId = raw.slice(0, separator);
  const seq = Number(raw.slice(separator + 1));
  if (!sessionId || !Number.isInteger(seq) || seq < 0) {
    throw new Error(`conversation cursor must be sessionId:seq, got "${raw}"`);
  }
  return { sessionId, seq };
}

export function formatConversationCursor(cursor: ConversationCursor): string {
  return `${cursor.sessionId}:${cursor.seq}`;
}

export function encodeConversationEvent(row: {
  session_id: string;
  seq: string | number;
  kind: string;
  payload: unknown;
  created_at: string | Date;
}): ConversationEvent {
  return {
    sessionId: row.session_id,
    seq: Number(row.seq),
    kind: row.kind,
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Oldest event of a newest-first page becomes the next `before` cursor. */
export function conversationNextBefore(events: ConversationEvent[]): ConversationCursor | null {
  const oldest = events[0];
  if (!oldest) return null;
  return { sessionId: oldest.sessionId, seq: oldest.seq };
}

export function conversationPageFromRows(
  rows: Array<{
    session_id: string;
    seq: string | number;
    kind: string;
    payload: unknown;
    created_at: string | Date;
  }>,
  limit: number,
): ConversationPage {
  const chronological = rows.map(encodeConversationEvent).reverse();
  return {
    events: chronological,
    nextBefore: rows.length === limit ? conversationNextBefore(chronological) : null,
  };
}

/** SQL + params for a newest-first page of pod events, optionally strictly before a cursor. */
export function conversationEventsQuery(args: {
  podId: string;
  before: ConversationCursor | null;
  limit: number;
}): { text: string; params: unknown[] } {
  if (args.before) {
    return {
      text: `SELECT e.session_id, e.seq, e.kind, e.payload, e.created_at
             FROM session_events e
             JOIN sessions s ON s.id = e.session_id
             JOIN sessions cursor_s ON cursor_s.id = $2 AND cursor_s.pod_id = $1
             WHERE s.pod_id = $1
               AND (s.started_at, e.session_id, e.seq)
                 < (cursor_s.started_at, cursor_s.id, $3::bigint)
             ORDER BY s.started_at DESC, e.session_id DESC, e.seq DESC
             LIMIT $4`,
      params: [args.podId, args.before.sessionId, args.before.seq, args.limit],
    };
  }
  return {
    text: `SELECT e.session_id, e.seq, e.kind, e.payload, e.created_at
           FROM session_events e
           JOIN sessions s ON s.id = e.session_id
           WHERE s.pod_id = $1
           ORDER BY s.started_at DESC, e.session_id DESC, e.seq DESC
           LIMIT $2`,
    params: [args.podId, args.limit],
  };
}
