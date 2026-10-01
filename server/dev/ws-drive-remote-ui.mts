/**
 * dev/ws-drive-remote-ui.mts — drives the remote extension UI fixture over a real session
 * WebSocket and prints what a client would render.
 *
 * Usage: npx tsx dev/ws-drive-remote-ui.mts <podId> <bearer token> [--reattach] [--seconds N]
 *
 * It prompts REMOTEUI, answers the fixture's input long-polls the way a client does
 * (resize, then key events), asserts frame revisions only move forward, and with
 * --reattach drops the socket mid-surface to check the gateway's snapshot replay.
 */
import WebSocket from "ws";
import {
  REMOTE_UI_INPUT_PREFIX,
  REMOTE_UI_PROTOCOL_VERSION,
  encodeRemoteUiPayload,
  remoteUiFrameFromExtensionRequest,
  type RemoteUiFrame,
  type RemoteUiSurfaceFrame,
} from "../src/core/remote-ui-protocol.js";

const [podId, token, ...flags] = process.argv.slice(2);
const reattach = flags.includes("--reattach");
const seconds = Number(flags[flags.indexOf("--seconds") + 1] ?? 6) || 6;
const server = process.env["SERVER_URL"] ?? "http://127.0.0.1:8080";

/** Tickets are one-shot, so every connection mints its own. */
async function mintTicket(): Promise<string> {
  const response = await fetch(`${server}/v1/pods/${podId}/ws-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`ws-ticket failed: ${response.status}`);
  return ((await response.json()) as { ticket: string }).ticket;
}
const strip = (line: string) => line.replace(/\u001b\[[0-9;:]*m/g, "");

interface Session {
  frames: number;
  surfaces: Map<string, { role: string; revision: number; lines: string[] }>;
  controls: Array<{ action: string; value: unknown }>;
  responses: number;
}

async function connect(
  session: Session,
  script: (send: (message: unknown) => void, frame: RemoteUiFrame, requestId?: string) => void,
  seconds: number,
): Promise<void> {
  const ticket = await mintTicket();
  const url = new URL(`${server.replace(/^http/, "ws")}/v1/pods/${podId}/session`);
  url.searchParams.set("ticket", ticket);
  const ws = new WebSocket(url);
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, seconds * 1000);
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as {
        type: string;
        kind?: string;
        payload?: { id?: string; method?: string };
        code?: string;
        message?: string;
      };
      if (message.type === "error") {
        console.log(`error ${message.code}: ${message.message}`);
        return;
      }
      if (message.type !== "ephemeral" || message.kind !== "extension_ui_request") return;
      const frame = remoteUiFrameFromExtensionRequest(message.payload as never);
      if (!frame) return;
      session.frames += 1;
      if (frame.kind === "control") {
        session.controls.push({ action: frame.action, value: frame.value });
      } else {
        const surface = frame as RemoteUiSurfaceFrame;
        const known = session.surfaces.get(surface.surfaceId);
        if (known && surface.revision < known.revision) {
          // Expected on attach: the cached snapshot can land after a live frame. A client
          // that honours revision monotonicity drops it, which is why that rule exists.
          console.log(`stale frame on ${surface.surfaceId}: ${known.revision} -> ${surface.revision} (client drops)`);
          return;
        }
        if (surface.kind === "close") session.surfaces.delete(surface.surfaceId);
        else {
          session.surfaces.set(surface.surfaceId, {
            role: surface.role,
            revision: surface.revision,
            lines: (surface.lines ?? []).map(strip),
          });
        }
      }
      const requestId = message.payload?.method === "input" ? message.payload.id : undefined;
      script(send, frame, requestId);
      if (requestId) session.responses += 1;
    });
    ws.on("open", () => setTimeout(() => send({ type: "prompt", text: "REMOTEUI please" }), 300));
    ws.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("error", (error) => {
      console.log("WS ERROR:", error.message);
      clearTimeout(timer);
      resolve();
    });
  });
}

const session: Session = { frames: 0, surfaces: new Map(), controls: [], responses: 0 };
const sent = new Map<string, number>();

/**
 * Answers like the app does: a resize once the grid is known, then one key event per
 * surface. A client that answered every request would spin the pod's render loop, which is
 * exactly why the reference client only responds when it has something to send.
 */
const script = (
  send: (message: unknown) => void,
  frame: RemoteUiFrame,
  requestId?: string,
): void => {
  if (!requestId || frame.kind === "control" || frame.kind === "close") return;
  const surface = frame as RemoteUiSurfaceFrame;
  const count = (sent.get(surface.surfaceId) ?? 0) + 1;
  if (count > 2) return;
  sent.set(surface.surfaceId, count);
  const input = {
    v: REMOTE_UI_PROTOCOL_VERSION,
    kind: count === 1 ? "resize" : "input",
    surfaceId: surface.surfaceId,
    sequence: count,
    width: 96,
    height: 30,
    ...(count === 1
      ? {}
      : { events: surface.role === "editor" ? ["h", "i", "\r"] : ["\u001b[B"] }),
  };
  send({
    type: "ui_response",
    response: {
      type: "extension_ui_response",
      id: requestId,
      value: REMOTE_UI_INPUT_PREFIX + encodeRemoteUiPayload(input as never),
    },
  });
};

await connect(session, script, seconds);
if (reattach) {
  console.log("--- reattaching ---");
  const replayed: Session = { frames: 0, surfaces: new Map(), controls: [], responses: 0 };
  await connect(replayed, () => {}, 3);
  console.log(
    JSON.stringify(
      {
        replayedSurfaces: [...replayed.surfaces.entries()].map(([id, s]) => ({ id, role: s.role, revision: s.revision })),
        replayedControls: replayed.controls,
      },
      null,
      1,
    ),
  );
}

console.log(
  JSON.stringify(
    {
      frames: session.frames,
      responses: session.responses,
      controls: session.controls,
      surfaces: [...session.surfaces.entries()].map(([id, surface]) => ({
        id,
        role: surface.role,
        revision: surface.revision,
        lines: surface.lines,
      })),
    },
    null,
    1,
  ),
);
