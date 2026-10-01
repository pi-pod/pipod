import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Manager } from "../core/manager.js";
import type { PtySession } from "../core/pty.js";
import type { Logger } from "../log.js";
import { ServiceError } from "../errors.js";
import type { Metrics, WsResult } from "../metrics.js";
import { ERR_NO_SESSION, type PtyClientFrame, type PtyServerFrame } from "../wire.js";

function sendJson(socket: WebSocket, frame: PtyServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

export function registerPtyRoute(
  app: FastifyInstance,
  manager: Manager,
  log: Logger,
  metrics: Metrics,
): void {
  app.get("/v1/sandboxes/:id/pty", { websocket: true }, (socket, req) => {
    const id = (req.params as { id: string }).id;
    let session: PtySession | null = null;
    const opened = process.hrtime.bigint();
    let result: WsResult = "disconnect";
    metrics.wsOpened("pty");
    // Throttled: a keystroke must not cost a database write, but a person typing must keep
    // the sandbox out of the warm tier.
    let lastActivity = 0;
    const noteActivity = (): void => {
      const now = Date.now();
      if (now - lastActivity < 1_000) return;
      lastActivity = now;
      if (session) manager.notePtyActivity(session.sandboxId);
    };

    const bind = (s: PtySession, reattached: boolean): void => {
      session = s;
      sendJson(socket, { type: "ready", sessionId: s.id, reattached });
      s.attach(
        (data) => {
          if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
        },
        (exitCode) => {
          result = "complete";
          sendJson(socket, { type: "exit", exitCode });
          socket.close();
        },
      );
    };

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        noteActivity();
        session?.write(raw);
        return;
      }
      let frame: PtyClientFrame;
      try {
        frame = JSON.parse(raw.toString("utf8")) as PtyClientFrame;
      } catch {
        result = "error";
        sendJson(socket, { type: "error", code: "bad_request", message: "malformed control frame" });
        socket.close();
        return;
      }

      switch (frame.type) {
        case "open":
          if (session) return;
          void manager
            .openPty(id, {
              argv: frame.argv,
              cols: frame.cols,
              rows: frame.rows,
              cwd: frame.cwd,
              env: frame.env,
            })
            .then((s) => bind(s, false))
            .catch((err: unknown) => {
              result = "error";
              const code = err instanceof ServiceError ? err.code : "internal";
              sendJson(socket, { type: "error", code, message: String((err as Error)?.message ?? err) });
              socket.close();
            });
          return;
        case "attach":
          if (session) return;
          void manager
            .attachPty(frame.sessionId)
            .then((s) => {
              if (!s) {
                // The launcher that owned this session is gone and so is the session; core's
                // documented fallback is to start a fresh pi in the same workspace.
                result = "error";
                sendJson(socket, {
                  type: "error",
                  code: ERR_NO_SESSION,
                  message: `pty session ${frame.sessionId} no longer exists`,
                });
                socket.close();
                return;
              }
              s.resize(frame.cols, frame.rows);
              bind(s, true);
            })
            .catch((err: unknown) => {
              result = "error";
              const code = err instanceof ServiceError ? err.code : "internal";
              sendJson(socket, { type: "error", code, message: String((err as Error)?.message ?? err) });
              socket.close();
            });
          return;
        case "resize":
          noteActivity();
          session?.resize(frame.cols, frame.rows);
          return;
        case "detach":
          session?.detach();
          session = null;
          socket.close();
          return;
        case "kill":
          session?.kill();
          return;
      }
    });

    // Disconnect detaches; it never kills. A closed laptop must not end the pi running in
    // the sandbox — that is the whole point of the service holding the PTY (§3).
    socket.on("close", () => {
      metrics.wsClosed("pty", result, Number(process.hrtime.bigint() - opened) / 1e9);
      if (session) {
        session.detach();
        log.debug({ sandbox: id, session: session.id }, "pty client detached");
      }
    });
  });
}
