/**
 * Native integration test (plan §10.1.1). Behaviour only — never hardware
 * qualification, never production secrets.
 *
 * Skips unless the native-integration workflow (or a local operator) provides a
 * live fixture service:
 *   PI_POD_TEST_NATIVE_URL=https://127.0.0.1:8433 PI_POD_TEST_NATIVE_TOKEN=… \
 *     node --import tsx --test test/native-integration.test.ts
 *
 * Contract exercised against the fixture:
 *   GET /v1/healthz, GET /v1/capacity (versioned contract), create a tiny
 *   sandbox, exec over the websocket channel, stop, delete, GET /v1/usage.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import { CAPACITY_CONTRACT_VERSION } from "../src/core/providers/sandbox/wire.js";
import { NATIVE_FIXTURE_WORKLOAD_IMAGE } from "./native-fixture-pins.js";

const BASE = (process.env["PI_POD_TEST_NATIVE_URL"] ?? "").replace(/\/$/, "");
const TOKEN = process.env["PI_POD_TEST_NATIVE_TOKEN"] ?? "";
const LIVE = BASE.length > 0 && TOKEN.length > 0;
// Tiny public image pulled by the fixture service itself (runner has egress;
// nothing production is touched). busybox keeps pull + unpack far below the
// standard 20 GiB quota.
const FIXTURE_IMAGE = process.env["PI_POD_TEST_NATIVE_IMAGE"] ?? NATIVE_FIXTURE_WORKLOAD_IMAGE;

function headers(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const hasBody = init?.body !== undefined;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...headers(),
      // Fastify rejects an empty body under a JSON content-type: only claim
      // JSON when a body is actually sent (matters for bodyless DELETE).
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    // keep raw text for assertion messages
  }
  return { status: res.status, body };
}

function asRecord(body: unknown): Record<string, unknown> {
  assert.equal(typeof body, "object", `expected a JSON object, got ${JSON.stringify(body)?.slice(0, 200)}`);
  assert.ok(body !== null);
  return body as Record<string, unknown>;
}

interface ExecControlFrame {
  type?: string;
  exitCode?: number;
  code?: string;
  message?: string;
}

/** Run argv in a live sandbox over the exec websocket; resolves with exit code + stdout. */
function execSandbox(id: string, argv: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const wsBase = BASE.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsBase}/v1/sandboxes/${id}/exec`, { headers: headers() });
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        socket.close();
        fn();
      }
    };
    const timer = setTimeout(() => done(() => reject(new Error("exec timed out after 60s"))), 60_000);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "start", argv, timeoutMs: 30_000 }));
    });
    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // First byte names the stream (wire.ts: 1 = stdout, 2 = stderr).
        if (raw.length > 1 && raw[0] === 1) chunks.push(raw.subarray(1));
        return;
      }
      let frame: ExecControlFrame;
      try {
        frame = JSON.parse(raw.toString("utf8")) as ExecControlFrame;
      } catch {
        clearTimeout(timer);
        done(() => reject(new Error(`malformed exec control frame: ${raw.toString("utf8").slice(0, 200)}`)));
        return;
      }
      if (frame.type === "exit") {
        clearTimeout(timer);
        done(() => resolve({ exitCode: frame.exitCode ?? -1, stdout: Buffer.concat(chunks).toString("utf8") }));
      } else if (frame.type === "error") {
        clearTimeout(timer);
        done(() => reject(new Error(`exec error ${frame.code}: ${frame.message}`)));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      done(() => reject(error));
    });
  });
}

describe("native integration (fixture service)", { skip: !LIVE || undefined }, () => {
  it("serves health and the versioned capacity contract", async () => {
    const health = await api("/v1/healthz");
    assert.equal(health.status, 200);
    assert.equal(asRecord(health.body)["ok"], true);

    const capacity = await api("/v1/capacity");
    assert.equal(capacity.status, 200);
    const contract = asRecord(capacity.body);
    const pretty = JSON.stringify(contract).slice(0, 3000);
    // Pinned-image contract discovery: the first run prints the exact shape so
    // assertions below pin the real wire format instead of a guessed one.
    assert.ok(typeof contract["hostId"] === "string", `capacity has hostId: ${pretty}`);
    assert.ok(typeof contract["bootId"] === "string", `capacity has bootId: ${pretty}`);
    assert.equal(
      contract["contractVersion"],
      CAPACITY_CONTRACT_VERSION,
      `capacity contract is versioned (server/sandbox wire parity): ${pretty}`,
    );
    assert.ok(typeof asRecord(contract["memory"])["budgetBytes"] === "number");
    assert.ok(typeof asRecord(contract["disk"])["capacityBytes"] === "number");
    const sandboxes = asRecord(contract["sandboxes"]);
    for (const key of ["hot", "warm", "stopped", "archived", "error", "booting"]) {
      assert.ok(typeof sandboxes[key] === "number", `capacity.sandboxes.${key} is a number`);
    }
  });

  it("creates a tiny sandbox, execs, stops, deletes, and serves usage", async () => {
    const created = await api("/v1/sandboxes", {
      method: "POST",
      body: JSON.stringify({
        image: FIXTURE_IMAGE,
        workdir: "/",
        // Tiny fixture shape: the runner's tmpfs state dir is small, so never
        // the 10 GiB service default.
        resources: { cpu: 1, memoryGB: 1, diskGB: 2 },
        labels: { "pi-pod-test": "native-integration" },
      }),
    });
    assert.equal(created.status, 200, `create failed: ${JSON.stringify(created.body)?.slice(0, 500)}`);
    const id = String(asRecord(created.body)["id"] ?? "");
    assert.ok(id.length > 0, "create returns a sandbox id");
    try {
      const exec = await execSandbox(id, ["echo", "hello-native"]);
      assert.equal(exec.exitCode, 0);
      assert.match(exec.stdout.trim(), /^hello-native$/);

      const stopped = await api(`/v1/sandboxes/${id}/stop`, { method: "POST", body: "{}" });
      assert.equal(stopped.status, 200, `stop failed: ${JSON.stringify(stopped.body)?.slice(0, 300)}`);
    } finally {
      const deleted = await api(`/v1/sandboxes/${id}`, { method: "DELETE" });
      assert.equal(deleted.status, 200, `delete failed: ${JSON.stringify(deleted.body)?.slice(0, 300)}`);
    }

    const usage = await api("/v1/usage?limit=5");
    assert.equal(usage.status, 200);
    const snapshot = asRecord(usage.body);
    const samples = snapshot["samples"] ?? snapshot["rows"];
    assert.ok(Array.isArray(samples), "usage snapshot carries a samples/rows array");
  });
});
