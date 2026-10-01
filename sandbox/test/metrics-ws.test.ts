import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { registerExecRoute } from "../src/api/ws-exec.js";
import { registerPtyRoute } from "../src/api/ws-pty.js";
import type { Manager } from "../src/core/manager.js";
import { createLogger } from "../src/log.js";
import { Metrics } from "../src/metrics.js";

describe("websocket route metrics", () => {
  it("records exec disconnect without sandbox ids", async (t) => {
    const metrics = new Metrics();
    const manager = {
      execStream: async (
        _id: string,
        _spec: unknown,
        hooks: { onStarted?: (kill: () => void, stdin: Writable) => void },
      ) => {
        await new Promise<void>((resolve) => {
          hooks.onStarted?.(() => resolve(), new Writable({ write: (_c, _e, cb) => cb() }));
        });
        return 0;
      },
    } as unknown as Manager;

    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerExecRoute(app, manager, createLogger("silent"), metrics);
    await app.listen({ host: "127.0.0.1", port: 0 });
    t.after(() => app.close());
    const port = (app.server.address() as AddressInfo).port;

    const idle = new WebSocket(`ws://127.0.0.1:${port}/v1/sandboxes/sb-execid000000000001/exec`);
    await new Promise<void>((resolve, reject) => {
      idle.once("open", resolve);
      idle.once("error", reject);
    });
    idle.close();
    await new Promise<void>((resolve) => idle.once("close", () => resolve()));

    const text = await metrics.scrape();
    assert.match(text, /pps_ws_connections_total\{kind="exec",result="disconnect"\} 1/);
    assert.doesNotMatch(text, /sb-execid000000000001/);
  });

  it("records a pty client disconnect", async (t) => {
    const metrics = new Metrics();
    const manager = {
      openPty: async () => {
        throw new Error("unused");
      },
      attachPty: async () => null,
      notePtyActivity: () => undefined,
    } as unknown as Manager;

    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerPtyRoute(app, manager, createLogger("silent"), metrics);
    await app.listen({ host: "127.0.0.1", port: 0 });
    t.after(() => app.close());
    const port = (app.server.address() as AddressInfo).port;

    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/sandboxes/sb-ptyid0000000000001/pty`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));

    const text = await metrics.scrape();
    assert.match(text, /pps_ws_connections_total\{kind="pty",result="disconnect"\} 1/);
    assert.doesNotMatch(text, /sb-ptyid0000000000001/);
  });
});
