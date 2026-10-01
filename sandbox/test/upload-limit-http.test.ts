import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { buildServer } from "../src/api/server.js";
import type { ObjectStore } from "../src/archive/types.js";
import { loadConfig } from "../src/config.js";
import type { Manager } from "../src/core/manager.js";
import { createLogger } from "../src/log.js";

const TOKEN = "upload-limit-test-token-long-enough";
const LIMIT = 1024;

const NO_STORE: ObjectStore = {
  kind: "none",
  put: async () => ({ key: "", size: 0 }),
  get: async () => undefined,
  head: async () => null,
  list: async () => [],
  delete: async () => undefined,
};

test("PUT /files enforces the streaming upload limit with explicit statuses", async (t) => {
  const cfg = loadConfig({
    PI_POD_SANDBOX_TOKEN: TOKEN,
    PI_POD_SANDBOX_STATE_DIR: "/tmp/pi-pod-sandbox-upload-test",
    PI_POD_SANDBOX_MAX_UPLOAD_BYTES: String(LIMIT),
    LOG_LEVEL: "fatal",
  });
  const received: { id: string; path: string; bytes: number }[] = [];
  const calls: string[] = [];
  const manager = {
    async uploadFile(id: string, destPath: string, _mode: number, body: Readable): Promise<void> {
      calls.push(destPath);
      let bytes = 0;
      for await (const chunk of body) bytes += (chunk as Buffer).length;
      received.push({ id, path: destPath, bytes });
    },
  } as unknown as Manager;
  const app = await buildServer({
    cfg,
    manager,
    objects: NO_STORE,
    log: createLogger("fatal"),
    version: "upload-limit-test",
    runtimeName: "test",
  });
  t.after(async () => app.close());
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const put = (body: Buffer | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${baseUrl}/v1/sandboxes/sb-01234567/files?path=${encodeURIComponent("/workspace/seed.bin")}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream", ...headers },
      body,
      // Chunked streaming must not send a content-length; the server counts while reading.
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);

  const small = await put(randomBytes(512));
  assert.equal(small.status, 204);
  assert.equal(received.at(-1)?.bytes, 512);

  const exact = await put(randomBytes(LIMIT));
  assert.equal(exact.status, 204);
  assert.equal(received.at(-1)?.bytes, LIMIT);

  // Buffer bodies carry a content-length, so this is rejected before the sandbox is touched.
  const before = calls.length;
  const over = await put(randomBytes(LIMIT + 1));
  assert.equal(over.status, 413);
  assert.equal((await over.json() as { error: { code: string } }).error.code, "payload_too_large");
  assert.equal(calls.length, before);

  // Chunked bodies have no declared length; the guard aborts mid-stream.
  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(768));
      controller.enqueue(new Uint8Array(768));
      controller.close();
    },
  });
  const streamed = await put(chunked);
  assert.equal(streamed.status, 413);
  const streamedBody = (await streamed.json()) as { error: { code: string; message: string } };
  assert.equal(streamedBody.error.code, "payload_too_large");
  assert.match(streamedBody.error.message, /1 KiB/);
});
