import { remoteUiFrameFromExtensionRequest } from "../../core/remote-ui-protocol.js";
import { query } from "../db/index.js";
import { MAX_PENDING_INTERACTION_RESENDS } from "./session-state.js";
import type { ServerMessage } from "./stream-fanout.js";

/**
 * A UI request that awaits an answer is an interaction unless it is on the allowlist of
 * known fire-and-forget methods. Inverted deliberately: an unrecognized blocking method
 * must surface as an approval card (and a push), never as a silently hung agent.
 */
const NON_BLOCKING_UI_METHODS = new Set([
  "notify",
  "setStatus",
  "set_status",
  "setWidget",
  "set_widget",
  "setTitle",
  "set_title",
  "set_editor_text",
  "setEditorText",
]);

export function isInteractionEvent(kind: string, event: unknown): boolean {
  // Remote UI long-polls are terminal transport, not user-facing approval cards. In account
  // mode they are handled ephemerally before this classifier, and this guard protects callers.
  if (remoteUiFrameFromExtensionRequest((event ?? {}) as never)) return false;
  if (/approval|request_input|permission/i.test(kind)) return true;
  if (!/extension_ui|ui_request/i.test(kind)) return false;
  const method = (event as { method?: unknown } | null)?.method;
  if (typeof method === "string" && NON_BLOCKING_UI_METHODS.has(method)) return false;
  return true;
}

export function interactionKind(kind: string, event: unknown): string {
  if (/approval|permission/i.test(kind)) return "tool_approval";
  const method = (event as { method?: unknown } | null)?.method;
  if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
    return method;
  }
  if (/input/i.test(kind)) return "input";
  return "extension_ui";
}

/**
 * The dialogs pi is still blocked on, as the ephemeral frames an attaching client renders.
 *
 * `resolution IS NULL AND delivered_at IS NULL` is the whole contract: an answer recorded by
 * REST sets the first, a live ws answer sets both, and the delivery claim sets the second — so
 * anything either path has touched stays off a later attach, however it was answered and
 * whichever surface answered it.
 */
export async function unansweredInteractionFrames(
  sessionId: string,
  limit = MAX_PENDING_INTERACTION_RESENDS,
): Promise<ServerMessage[]> {
  const rows = await query<{ payload: unknown }>(
    `SELECT payload FROM pending_interactions
     WHERE session_id = $1 AND resolution IS NULL AND delivered_at IS NULL
     ORDER BY seq LIMIT $2`,
    [sessionId, limit],
  );
  return rows.rows.map((row) => ({
    type: "ephemeral",
    kind: (row.payload as { type?: string } | null)?.type ?? "extension_ui_request",
    payload: row.payload,
  }));
}
