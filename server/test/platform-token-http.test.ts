import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import http from "node:http";
import { platformSandboxClient } from "../src/server/pods/operations.js";
import { PROVIDER_META } from "../src/core/providers/meta.js";

const VAR = PROVIDER_META.sandbox.credentialEnv;
const BOOT_TOKEN = "boot-snapshot-token0123456789";
const OVERLAY_TOKEN = "byo-overlay-token0123456789evil";

let savedAmbient: string | undefined;
beforeEach(() => {
  savedAmbient = process.env[VAR];
});
afterEach(() => {
  if (savedAmbient === undefined) delete process.env[VAR];
  else process.env[VAR] = savedAmbient;
});

describe("platformSandboxClient under overlay (HTTP adversarial)", () => {
  async function withBearerHost(
    work: (url: string, seen: string[]) => Promise<void>,
  ): Promise<void> {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(String(req.headers["authorization"] ?? ""));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      await work(`http://127.0.0.1:${address.port}`, seen);
    } finally {
      server.close();
    }
  }

  it("uses the explicit boot token while ambient is overlaid", async () => {
    await withBearerHost(async (url, seen) => {
      const client = platformSandboxClient(url, BOOT_TOKEN);
      assert.ok(client);
      process.env[VAR] = OVERLAY_TOKEN;
      try {
        await client.json("GET", "/v1/authz");
      } finally {
        delete process.env[VAR];
      }
      assert.deepEqual(seen, [`Bearer ${BOOT_TOKEN}`]);
    });
  });

  it("explicit null token yields no client even with an overlay present", async () => {
    await withBearerHost(async (url, seen) => {
      process.env[VAR] = OVERLAY_TOKEN;
      try {
        assert.equal(platformSandboxClient(url, null), null);
      } finally {
        delete process.env[VAR];
      }
      assert.deepEqual(seen, [], "no request may fly unauthenticated");
    });
  });

  it("returns null when no token is configured (fleet ops skip, never unauthenticated)", async () => {
    // Hermetic: the full-suite runner exports a token into ambient.
    delete process.env[VAR];
    assert.equal(platformSandboxClient("http://127.0.0.1:9", null), null);
  });
});
