import { strict as assert } from "node:assert";
import * as http from "node:http";
import { describe, it } from "node:test";
import { AccountClient } from "../../src/account/api.js";
import { runBillingCommand } from "../../src/account/billing-cli.js";
import { parseArgs } from "../../src/cli.js";
import type { AccountAuth } from "../../src/account/store.js";
import { PiPodError } from "../../src/errors.js";

const authFor = (serverUrl: string): AccountAuth => ({
  serverUrl,
  accessToken: "tok",
  user: { id: "u1", email: "dev@example.com" },
  orgId: "org-1",
});

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (client: AccountClient) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await run(new AccountClient(authFor(`http://127.0.0.1:${port}`)));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("pipod billing", () => {
  it("posts checkout with explicit paid intent", async () => {
    let seen = "";
    await withServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        seen = Buffer.concat(chunks).toString();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_x", trial: false }));
      });
    }, async (client) => {
      const code = await runBillingCommand(client, ["checkout", "--plan", "standard"]);
      assert.equal(code, 0);
      assert.match(seen, /"trial":false/);
      assert.match(seen, /"plan":"standard"/);
    });
  });

  it("refuses a non-https checkout URL", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: "http://evil.example/pay", trial: true }));
    }, async (client) => {
      await assert.rejects(
        () => runBillingCommand(client, ["checkout"]),
        (e: unknown) => e instanceof PiPodError && /usable checkout URL/.test(e.message),
      );
    });
  });
});
