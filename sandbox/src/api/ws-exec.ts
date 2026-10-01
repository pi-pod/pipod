import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Writable } from "node:stream";
import type { Manager } from "../core/manager.js";
import type { Logger } from "../log.js";
import { ServiceError } from "../errors.js";
import type { Metrics, WsResult } from "../metrics.js";
import {
  STREAM_STDERR,
  STREAM_STDIN,
  STREAM_STDOUT,
  type ExecClientFrame,
  type ExecServerFrame,
} from "../wire.js";

function sendJson(socket: WebSocket, frame: ExecServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function sendChunk(socket: WebSocket, stream: number, chunk: Buffer): void {
  if (socket.readyState !== socket.OPEN) return;
  const framed = Buffer.allocUnsafe(chunk.length + 1);
  framed[0] = stream;
  chunk.copy(framed, 1);
  socket.send(framed);
}

export function registerExecRoute(
  app: FastifyInstance,
  manager: Manager,
  log: Logger,
  metrics: Metrics,
): void {
  app.get("/v1/sandboxes/:id/exec", { websocket: true }, (socket, req) => {
    const id = (req.params as { id: string }).id;
    let started = false;
    let kill: ((signal?: NodeJS.Signals) => void) | null = null;
    let stdin: Writable | null = null;
    const disconnect=new AbortController();
    const opened = process.hrtime.bigint();
    let result: WsResult = "disconnect";
    metrics.wsOpened("exec");

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (raw.length > 1 && raw[0] === STREAM_STDIN) stdin?.write(raw.subarray(1));
        return;
      }
      let frame: ExecClientFrame;
      try {
        frame = JSON.parse(raw.toString("utf8")) as ExecClientFrame;
      } catch {
        result = "error";
        sendJson(socket, { type: "error", code: "bad_request", message: "malformed control frame" });
        socket.close();
        return;
      }
      if (frame.type === "stdin-eof") {
        stdin?.end();
        return;
      }
      if (frame.type !== "start" || started) return;
      started = true;

      manager
        .execStream(
          id,
          { argv: frame.argv, cwd: frame.cwd, env: frame.env, timeoutMs: frame.timeoutMs,
            signal:disconnect.signal },
          {
            onStdout: (chunk) => sendChunk(socket, STREAM_STDOUT, chunk),
            onStderr: (chunk) => sendChunk(socket, STREAM_STDERR, chunk),
            onStarted: (killer, input) => {
              kill = killer;
              stdin = input;
              sendJson(socket, { type: "started" });
            },
          },
        )
        .then((exitCode) => {
          result = "complete";
          sendJson(socket, { type: "exit", exitCode });
        })
        .catch((err: unknown) => {
          result = "error";
          const code = err instanceof ServiceError ? err.code : "internal";
          sendJson(socket, { type: "error", code, message: String((err as Error)?.message ?? err) });
        })
        .finally(() => socket.close());
    });

    // An exec is tied to its channel: nothing on the service is watching its output once the
    // caller is gone, and a detached exec would be a leak with no handle. PTYs are the
    // opposite case, and are handled that way.
    socket.on("close", () => {
      disconnect.abort();
      metrics.wsClosed("exec", result, Number(process.hrtime.bigint() - opened) / 1e9);
      if (kill) {
        try {
          kill("SIGKILL");
        } catch (err) {
          log.debug({ err, sandbox: id }, "exec kill after disconnect failed");
        }
      }
    });
  });
}
