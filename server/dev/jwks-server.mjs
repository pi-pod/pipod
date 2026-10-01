// Dev JWKS server + token minter for tests without a live Zitadel.
// Serves a local JWKS at http://127.0.0.1:9999/jwks; mint.mjs signs RS256 tokens
// that the server's jwtVerify path (ZITADEL_JWKS_URL override) accepts.
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createServer } from "node:http";
import * as fs from "node:fs";

const KEY_FILE = new URL("./dev-key.json", import.meta.url).pathname;

export async function loadOrCreateKeys() {
  if (fs.existsSync(KEY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    return { publicJwk: saved.publicJwk, privateJwk: saved.privateJwk };
  }
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  publicJwk.kid = "dev-key-1";
  publicJwk.alg = "RS256";
  privateJwk.kid = "dev-key-1";
  privateJwk.alg = "RS256";
  fs.writeFileSync(KEY_FILE, JSON.stringify({ publicJwk, privateJwk }));
  return { publicJwk, privateJwk };
}

if (process.argv[1] && process.argv[1].endsWith("jwks-server.mjs")) {
  const { publicJwk } = await loadOrCreateKeys();
  createServer((req, res) => {
    if (req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else {
      res.writeHead(404).end();
    }
  }).listen(9999, "127.0.0.1", () => console.log("dev JWKS on http://127.0.0.1:9999/jwks"));
}
