/**
 * Versioned wire format for extension-owned TUI components that execute in the pod and
 * render inside the client's real InteractiveMode. The extension itself never crosses the
 * trust boundary: only rendered lines, layout metadata, and terminal input do.
 */

import { decodeWireJson, encodeWireJson, isPlainObject } from "./wire-codec.js";

export const REMOTE_UI_PROTOCOL_VERSION = 1 as const;
export const REMOTE_UI_INSTALL_SYMBOL = "pi-pod.remote-ui-v1.install";
export const REMOTE_UI_NOTIFICATION_PREFIX = "pi-pod-internal/remote-ui-v1:";
export const REMOTE_UI_INPUT_PREFIX = "pi-pod-internal/remote-ui-input-v1:";
export const REMOTE_UI_MAX_ENCODED_BYTES = 2 * 1024 * 1024;
export const REMOTE_UI_MAX_SURFACES = 32;
export const REMOTE_UI_MAX_LINES = 2_000;
export const REMOTE_UI_MAX_LINE_LENGTH = 32_768;

export type RemoteUiRole = "custom" | "widget" | "header" | "footer" | "editor";

export interface RemoteUiOverlayOptions {
  width?: number | `${number}%`;
  minWidth?: number;
  maxHeight?: number | `${number}%`;
  anchor?: string;
  offsetX?: number;
  offsetY?: number;
  row?: number | `${number}%`;
  col?: number | `${number}%`;
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
  nonCapturing?: boolean;
}

export interface RemoteUiSurfaceFrame {
  v: typeof REMOTE_UI_PROTOCOL_VERSION;
  kind: "open" | "frame" | "close";
  surfaceId: string;
  revision: number;
  role: RemoteUiRole;
  contextRevision?: number;
  lines?: string[];
  widgetKey?: string;
  placement?: "aboveEditor" | "belowEditor";
  overlay?: boolean;
  overlayOptions?: RemoteUiOverlayOptions;
  /** Mirrored overlay-handle focus: the pod extension called handle.focus()/unfocus(). */
  focused?: boolean;
  editorText?: string;
  editorSubmit?: string;
  editorSubmitId?: number;
  error?: string;
}

export interface RemoteUiControlFrame {
  v: typeof REMOTE_UI_PROTOCOL_VERSION;
  kind: "control";
  contextRevision?: number;
  action:
    | "setWorkingMessage"
    | "setWorkingVisible"
    | "setWorkingIndicator"
    | "setHiddenThinkingLabel"
    | "setToolsExpanded";
  value?: unknown;
}

export type RemoteUiFrame = RemoteUiSurfaceFrame | RemoteUiControlFrame;

export interface RemoteUiInput {
  v: typeof REMOTE_UI_PROTOCOL_VERSION;
  kind: "input" | "resize" | "setText" | "close";
  surfaceId: string;
  sequence: number;
  width: number;
  height: number;
  data?: string;
  events?: string[];
}

export function encodeRemoteUiPayload(value: RemoteUiFrame | RemoteUiInput): string {
  return encodeWireJson(value);
}

export function decodeRemoteUiPayload(encoded: string): RemoteUiFrame | RemoteUiInput | null {
  const decoded = decodeWireJson(encoded, REMOTE_UI_MAX_ENCODED_BYTES);
  if (!decoded.ok) return null;
  if (!isRemoteUiFrame(decoded.value) && !isRemoteUiInput(decoded.value)) return null;
  return decoded.value as RemoteUiFrame | RemoteUiInput;
}

export function remoteUiFrameFromExtensionRequest(request: {
  method?: string;
  title?: string;
  message?: string;
}): RemoteUiFrame | null {
  const encoded =
    request.method === "input" && request.title?.startsWith(REMOTE_UI_INPUT_PREFIX)
      ? request.title.slice(REMOTE_UI_INPUT_PREFIX.length)
      : request.method === "notify" && request.message?.startsWith(REMOTE_UI_NOTIFICATION_PREFIX)
        ? request.message.slice(REMOTE_UI_NOTIFICATION_PREFIX.length)
        : null;
  if (encoded === null) return null;
  const decoded = decodeRemoteUiPayload(encoded);
  if (!decoded || !isRemoteUiFrame(decoded)) return null;
  return decoded as RemoteUiFrame;
}

export function remoteUiInputFromResponse(response: { value?: unknown }): RemoteUiInput | null {
  if (typeof response.value !== "string" || !response.value.startsWith(REMOTE_UI_INPUT_PREFIX)) return null;
  const decoded = decodeRemoteUiPayload(response.value.slice(REMOTE_UI_INPUT_PREFIX.length));
  if (!decoded || !isRemoteUiInput(decoded)) return null;
  return decoded as RemoteUiInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

const REMOTE_UI_ROLES = new Set<RemoteUiRole>(["custom", "widget", "header", "footer", "editor"]);
const REMOTE_UI_CONTROL_ACTIONS = new Set<RemoteUiControlFrame["action"]>([
  "setWorkingMessage",
  "setWorkingVisible",
  "setWorkingIndicator",
  "setHiddenThinkingLabel",
  "setToolsExpanded",
]);

function isRemoteUiFrame(value: unknown): value is RemoteUiFrame {
  if (!isRecord(value) || value.v !== REMOTE_UI_PROTOCOL_VERSION) return false;
  if (value.kind === "control") {
    if (value.contextRevision !== undefined && (!Number.isInteger(value.contextRevision) || (value.contextRevision as number) < 1)) return false;
    return typeof value.action === "string" &&
      REMOTE_UI_CONTROL_ACTIONS.has(value.action as RemoteUiControlFrame["action"]);
  }
  if (value.kind !== "open" && value.kind !== "frame" && value.kind !== "close") return false;
  if (typeof value.surfaceId !== "string" || value.surfaceId.length === 0 || value.surfaceId.length > 256) return false;
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) return false;
  if (typeof value.role !== "string" || !REMOTE_UI_ROLES.has(value.role as RemoteUiRole)) return false;
  if (value.contextRevision !== undefined && (!Number.isInteger(value.contextRevision) || (value.contextRevision as number) < 1)) return false;
  if (value.focused !== undefined && typeof value.focused !== "boolean") return false;
  if (value.lines !== undefined) {
    if (!Array.isArray(value.lines) || value.lines.length > REMOTE_UI_MAX_LINES) return false;
    if (!value.lines.every((line) => typeof line === "string" && line.length <= REMOTE_UI_MAX_LINE_LENGTH)) return false;
  }
  return true;
}

function isRemoteUiInput(value: unknown): value is RemoteUiInput {
  if (!isRecord(value) || value.v !== REMOTE_UI_PROTOCOL_VERSION) return false;
  if (value.kind !== "input" && value.kind !== "resize" && value.kind !== "setText" && value.kind !== "close") return false;
  if (typeof value.surfaceId !== "string" || value.surfaceId.length === 0 || value.surfaceId.length > 256) return false;
  if (!Number.isInteger(value.sequence) || (value.sequence as number) < 0) return false;
  if (!Number.isInteger(value.width) || (value.width as number) < 1 || (value.width as number) > 1000) return false;
  if (!Number.isInteger(value.height) || (value.height as number) < 1 || (value.height as number) > 1000) return false;
  if (value.data !== undefined && (typeof value.data !== "string" || value.data.length > REMOTE_UI_MAX_LINE_LENGTH)) return false;
  if (value.events !== undefined) {
    if (!Array.isArray(value.events) || value.events.length > 64) return false;
    if (!value.events.every((event) => typeof event === "string" && event.length <= REMOTE_UI_MAX_LINE_LENGTH)) return false;
  }
  return true;
}
