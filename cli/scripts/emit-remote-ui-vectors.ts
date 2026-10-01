/**
 * Emits the cross-language golden vectors for the remote extension UI wire format.
 *
 * The TypeScript codec is the reference implementation, so these vectors are generated
 * from it and checked in twice: `test/fixtures/remote-ui-vectors.json` here and the
 * identical copy in pi-pod-flutter, whose Dart codec asserts it decodes and re-encodes
 * them. Regenerate with
 * `node --import tsx scripts/emit-remote-ui-vectors.ts` and copy the result to the app.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  REMOTE_UI_INPUT_PREFIX,
  REMOTE_UI_NOTIFICATION_PREFIX,
  REMOTE_UI_PROTOCOL_VERSION,
  encodeRemoteUiPayload,
  type RemoteUiFrame,
  type RemoteUiInput,
} from "../src/remote-ui-protocol.js";

interface FrameVector {
  name: string;
  request: { type: "extension_ui_request"; id: string; method: string; title?: string; message?: string };
  frame: RemoteUiFrame;
}

interface InputVector {
  name: string;
  input: RemoteUiInput;
  encoded: string;
  response: { type: "extension_ui_response"; id: string; value: string };
}

function frameVector(name: string, frame: RemoteUiFrame, method: "input" | "notify", id: string): FrameVector {
  const encoded = encodeRemoteUiPayload(frame);
  return {
    name,
    request: {
      type: "extension_ui_request",
      id,
      method,
      ...(method === "input"
        ? { title: REMOTE_UI_INPUT_PREFIX + encoded }
        : { message: REMOTE_UI_NOTIFICATION_PREFIX + encoded }),
    },
    frame,
  };
}

function inputVector(name: string, input: RemoteUiInput, id: string): InputVector {
  const encoded = encodeRemoteUiPayload(input);
  return {
    name,
    input,
    encoded,
    response: { type: "extension_ui_response", id, value: REMOTE_UI_INPUT_PREFIX + encoded },
  };
}

export function buildVectors() {
  const v = REMOTE_UI_PROTOCOL_VERSION;
  const frames: FrameVector[] = [
    frameVector(
      "custom overlay open with styled lines",
      {
        v,
        kind: "open",
        surfaceId: "surface-abc-1",
        revision: 1,
        role: "custom",
        contextRevision: 3,
        lines: ["\u001b[1;38;5;213mPick a branch\u001b[0m", "  main", "  \u001b[7mfeature/remote-ui\u001b[0m", "  résumé — ✓ 中文"],
        overlay: true,
        overlayOptions: {
          width: "60%",
          minWidth: 40,
          maxHeight: "50%",
          anchor: "center",
          offsetX: 2,
          offsetY: -1,
          margin: { top: 1, right: 2, bottom: 1, left: 2 },
          nonCapturing: true,
        },
        focused: false,
      },
      "input",
      "req-open-1",
    ),
    frameVector(
      "widget repaint below the editor",
      { v, kind: "frame", surfaceId: "surface-abc-2", revision: 42, role: "widget", widgetKey: "todo", placement: "belowEditor", lines: ["3 tasks left"] },
      "notify",
      "req-widget-1",
    ),
    frameVector(
      "editor frame carrying text and a submit",
      {
        v,
        kind: "frame",
        surfaceId: "surface-abc-3",
        revision: 7,
        role: "editor",
        lines: ["> ship it"],
        editorText: "ship it",
        editorSubmit: "ship it",
        editorSubmitId: 4,
      },
      "input",
      "req-editor-1",
    ),
    frameVector("header band", { v, kind: "open", surfaceId: "surface-abc-4", revision: 0, role: "header", lines: ["pi-pod · main"] }, "notify", "req-header-1"),
    frameVector("footer band", { v, kind: "frame", surfaceId: "surface-abc-5", revision: 2, role: "footer", lines: ["", "ready"] }, "notify", "req-footer-1"),
    frameVector(
      "surface close after a render failure",
      { v, kind: "close", surfaceId: "surface-abc-6", revision: 9, role: "custom", error: "extension threw" },
      "notify",
      "req-close-1",
    ),
    frameVector("control: working message", { v, kind: "control", action: "setWorkingMessage", value: "compiling…", contextRevision: 3 }, "notify", "req-ctl-1"),
    frameVector("control: working visible", { v, kind: "control", action: "setWorkingVisible", value: true }, "notify", "req-ctl-2"),
    frameVector("control: working indicator object", { v, kind: "control", action: "setWorkingIndicator", value: { frames: ["|", "/"], intervalMs: 80 } }, "notify", "req-ctl-3"),
    frameVector("control: hidden thinking label", { v, kind: "control", action: "setHiddenThinkingLabel", value: "reasoning" }, "notify", "req-ctl-4"),
    frameVector("control: tools expanded", { v, kind: "control", action: "setToolsExpanded", value: false }, "notify", "req-ctl-5"),
  ];

  const inputs: InputVector[] = [
    inputVector("batched key events", { v, kind: "input", surfaceId: "surface-abc-1", sequence: 1, width: 80, height: 24, events: ["\u001b[A", "\u001b[B", "\r"] }, "req-open-1"),
    inputVector("single datum", { v, kind: "input", surfaceId: "surface-abc-1", sequence: 2, width: 120, height: 40, data: "q" }, "req-open-2"),
    inputVector("resize", { v, kind: "resize", surfaceId: "surface-abc-2", sequence: 3, width: 1000, height: 1 }, "req-widget-1"),
    inputVector("absolute editor text", { v, kind: "setText", surfaceId: "surface-abc-3", sequence: 4, width: 80, height: 24, data: "ship it — résumé ✓" }, "req-editor-1"),
    inputVector("close", { v, kind: "close", surfaceId: "surface-abc-6", sequence: 5, width: 80, height: 24 }, "req-close-1"),
  ];

  const invalidFrames = [
    { name: "unknown notification prefix", request: { type: "extension_ui_request", id: "x", method: "notify", message: "pi-pod-internal/other:AAAA" } },
    { name: "notify prefix on an input request", request: { type: "extension_ui_request", id: "x", method: "input", title: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "frame", surfaceId: "s", revision: 1, role: "custom" }) } },
    { name: "non-canonical base64url", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + "eyJhIjoxfQ==" } },
    { name: "alphabet violation", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + "not base64!" } },
    { name: "empty payload", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX } },
    { name: "wrong protocol version", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v: 2, kind: "frame", surfaceId: "s", revision: 1, role: "custom" } as never) } },
    { name: "unknown role", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "frame", surfaceId: "s", revision: 1, role: "sidebar" } as never) } },
    { name: "unknown kind", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "paint", surfaceId: "s", revision: 1, role: "custom" } as never) } },
    { name: "empty surface id", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "frame", surfaceId: "", revision: 1, role: "custom" } as never) } },
    { name: "negative revision", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "frame", surfaceId: "s", revision: -1, role: "custom" } as never) } },
    { name: "fractional revision", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "frame", surfaceId: "s", revision: 1.5, role: "custom" } as never) } },
    { name: "zero context revision", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "frame", surfaceId: "s", revision: 1, role: "custom", contextRevision: 0 } as never) } },
    { name: "non-string line", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "frame", surfaceId: "s", revision: 1, role: "custom", lines: [7] } as never) } },
    { name: "unknown control action", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "control", action: "setEverything" } as never) } },
    { name: "input payload where a frame belongs", request: { type: "extension_ui_request", id: "x", method: "notify", message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload({ v, kind: "resize", surfaceId: "s", sequence: 1, width: 10, height: 10 }) } },
  ];

  const invalidInputs = [
    { name: "width below range", encoded: encodeRemoteUiPayload({ v, kind: "input", surfaceId: "s", sequence: 1, width: 0, height: 24 } as never) },
    { name: "width above range", encoded: encodeRemoteUiPayload({ v, kind: "input", surfaceId: "s", sequence: 1, width: 1001, height: 24 } as never) },
    { name: "negative sequence", encoded: encodeRemoteUiPayload({ v, kind: "input", surfaceId: "s", sequence: -1, width: 80, height: 24 } as never) },
    { name: "too many events", encoded: encodeRemoteUiPayload({ v, kind: "input", surfaceId: "s", sequence: 1, width: 80, height: 24, events: Array.from({ length: 65 }, () => "a") } as never) },
    { name: "unknown input kind", encoded: encodeRemoteUiPayload({ v, kind: "scroll", surfaceId: "s", sequence: 1, width: 80, height: 24 } as never) },
  ];

  return {
    version: REMOTE_UI_PROTOCOL_VERSION,
    note: "Generated by pi-pod scripts/emit-remote-ui-vectors.ts. Mirrored in pi-pod-flutter/test/fixtures/remote_ui/vectors.json.",
    notificationPrefix: REMOTE_UI_NOTIFICATION_PREFIX,
    inputPrefix: REMOTE_UI_INPUT_PREFIX,
    frames,
    inputs,
    invalidFrames,
    invalidInputs,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? new URL("../test/fixtures/remote-ui-vectors.json", import.meta.url).pathname;
  writeFileSync(target, `${JSON.stringify(buildVectors(), null, 2)}\n`);
  process.stdout.write(`wrote ${target}\n`);
}
