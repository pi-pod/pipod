/**
 * dev/main-fake.mts — the server with the fake provider (account-mode-spec §10):
 *   npx tsx dev/main-fake.mts
 * Same env contract as src/server/main.ts; pair with dev/jwks-server.mjs + dev/mint.mjs
 * (or `pi-pod login --token`) for a Zitadel-free local signer loop.
 */
import { registerFakeProvider } from "./fake-provider.mjs";

registerFakeProvider("sandbox");
process.env["PI_POD_SANDBOX_TOKEN"] = process.env["PI_POD_SANDBOX_TOKEN"] || "fake-dev-sandbox-token";
await import("../src/server/main.js");
