import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { RemoteRpcClient } from "../src/core/client/rpc.js";
import { FRAME_PROTO_VERSION } from "../src/core/client/frames.js";
import {
  PodTransportRegistry,
  WsPodChannel,
} from "../src/server/gateway/pod-transport.js";

const servers: Array<{ http: Server; wss: WebSocketServer }> = [];
afterEach(async () => {
  for (const { http, wss } of servers.splice(0)) {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

async function socketPair(): Promise<{ server: WebSocket; client: WebSocket }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  servers.push({ http, wss });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const accepted = new Promise<WebSocket>((resolve) => wss.once("connection", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return { server: await accepted, client };
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once("message", (raw) => resolve(raw.toString())));
}

describe("WsPodChannel", () => {
  it("carries one frame per message and drives RemoteRpcClient hello", async () => {
    const sockets = await socketPair();
    const channel = new WsPodChannel(sockets.server, "pod-a");
    const rpc = new RemoteRpcClient({ channel });

    const outbound = nextMessage(sockets.client);
    const helloPromise = rpc.ensureHello(1_000);
    assert.equal(await outbound, 'S {"cmd":"hello"}');
    sockets.client.send(
      `S ${JSON.stringify({
        event: "hello",
        proto: FRAME_PROTO_VERSION,
        piVersion: "0.84.0",
        shimVersion: "11",
        extensionVersion: 1,
        piRunning: true,
        eventSeq: 0,
      })}`,
    );
    const hello = await helloPromise;
    assert.equal(hello.proto, FRAME_PROTO_VERSION);
    assert.equal(hello.piRunning, true);
    rpc.retireChannel();
  });

  it("answers shim liveness pings with a transport-level pong", async () => {
    const sockets = await socketPair();
    const channel = new WsPodChannel(sockets.server, "pod-a");
    const delivered: string[] = [];
    channel.onData((data) => delivered.push(Buffer.from(data).toString()));
    const pong = nextMessage(sockets.client);
    sockets.client.send('S {"event":"ping"}');
    assert.equal(await pong, 'S {"cmd":"pong"}');
    // The ping still reaches the session reader that tracks channel liveness.
    assert.deepEqual(delivered, ['S {"event":"ping"}\n']);

    // Non-ping control frames and events are not answered.
    const next = nextMessage(sockets.client);
    sockets.client.send('S {"event":"pi_exit","code":0}');
    sockets.client.send('E cGluZw==');
    channel.write(new TextEncoder().encode('S {"cmd":"hello"}\n'));
    assert.equal(await next, 'S {"cmd":"hello"}');
  });

  it("rejects messages containing carrier newlines", async () => {
    const sockets = await socketPair();
    const channel = new WsPodChannel(sockets.server, "pod-a");
    channel.onData(() => assert.fail("malformed data must not be delivered"));
    const closed = new Promise<number>((resolve) => sockets.client.once("close", resolve));
    sockets.client.send("S {}\nE bad");
    assert.equal(await closed, 4400);
  });
});

describe("PodTransportRegistry", () => {
  it("wakes attach waiters and supersedes the previous writer", async () => {
    const registry = new PodTransportRegistry();
    const firstSockets = await socketPair();
    const first = new WsPodChannel(firstSockets.server, "pod-a");
    const waiting = registry.waitFor("pod-a", 1_000);
    registry.bind(first);
    assert.equal(await waiting, first);

    const superseded = new Promise<number>((resolve) => firstSockets.client.once("close", resolve));
    const secondSockets = await socketPair();
    const second = new WsPodChannel(secondSockets.server, "pod-a");
    assert.equal(registry.bind(second), first);
    assert.equal(await superseded, 4408);
    assert.equal(registry.connected("pod-a"), second);
    registry.shutdown();
  });

  it("bounds the wait for a missing supervisor", async () => {
    const registry = new PodTransportRegistry();
    await assert.rejects(registry.waitFor("missing", 10), /did not connect/);
  });
});
