import { remoteUiFrameFromExtensionRequest } from "../../core/remote-ui-protocol.js";

/**
 * pi's extension UI methods that do not wait for an answer. Every other method is treated
 * as a blocking dialog, the same inverted allowlist the pod-side shim uses: a dialog that
 * nobody can see is a turn that never moves again.
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

/** pi resolves a timed dialog itself; the grace covers clock skew before we stop replaying it. */
const DIALOG_EXPIRY_GRACE_MS = 30_000;

/** A dialog pi is parked inside, kept until a client answers it or pi's own timeout passes. */
export interface OpenDialog {
  request: unknown;
  expiresAt: number | null;
}

/**
 * The request id of an `extension_ui_request` that blocks pi until a client answers it, or
 * null. Remote UI long-polls are terminal transport with their own cache, and a request
 * without an id cannot be answered, so neither is an open dialog.
 */
export function blockingDialogId(kind: string, event: unknown): string | null {
  if (kind !== "extension_ui_request") return null;
  if (remoteUiFrameFromExtensionRequest((event ?? {}) as never)) return null;
  const { id, method, timeout } = (event ?? {}) as { id?: unknown; method?: unknown; timeout?: unknown };
  if (typeof id !== "string" || id === "") return null;
  if (method === "select" || method === "confirm" || method === "input" || method === "editor") return id;
  if (typeof method === "string" && NON_BLOCKING_UI_METHODS.has(method)) return null;
  return timeout === undefined ? id : null;
}

export function openDialog(request: unknown, now = Date.now()): OpenDialog {
  const timeout = (request as { timeout?: unknown }).timeout;
  return {
    request,
    expiresAt: typeof timeout === "number" && timeout > 0 ? now + timeout + DIALOG_EXPIRY_GRACE_MS : null,
  };
}

/** The dialogs still worth showing an attaching client, oldest first; drops expired ones. */
export function liveDialogs(dialogs: Map<string, OpenDialog>, now = Date.now()): unknown[] {
  for (const [id, dialog] of dialogs) {
    if (dialog.expiresAt !== null && dialog.expiresAt <= now) dialogs.delete(id);
  }
  return [...dialogs.values()].map((dialog) => dialog.request);
}
