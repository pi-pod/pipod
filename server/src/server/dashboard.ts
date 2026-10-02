/**
 * The web dashboard: the static page in `dashboard/` at the package root (beside `migrations/`).
 * It signs in to Zitadel in the browser and edits settings and templates through /v1 with the
 * resulting access token, as the CLI does, so it holds no privilege the API does not check.
 * This module only serves its files, under headers that keep the page from running or loading
 * anything it did not ship.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerEnv } from "./env.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** The page's own routes, all answered with index.html; the page reads its state from the URL. */
const PAGES = new Set(["", "callback"]);

interface Asset {
  body: Buffer;
  type: string;
}

/** Every servable file, read once at boot: a request can only name one of these. */
function loadAssets(dir: string): Map<string, Asset> | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const assets = new Map<string, Asset>();
  for (const name of names) {
    const type = CONTENT_TYPES[path.extname(name)];
    const file = path.join(dir, name);
    if (type && fs.statSync(file).isFile()) assets.set(name, { body: fs.readFileSync(file), type });
  }
  return assets;
}

/**
 * The page talks to this server and to the identity provider, nothing else. Sign-in codes
 * arrive in the callback URL, so no Referer may carry them away.
 */
function securityHeaders(env: ServerEnv): Record<string, string> {
  const issuer = new URL(env.ZITADEL_ISSUER).origin;
  return {
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self'",
      `connect-src 'self' ${issuer}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  };
}

export function registerDashboard(
  app: FastifyInstance,
  env: ServerEnv,
  dir = path.join(process.cwd(), "dashboard"),
): void {
  const assets = loadAssets(dir);
  const index = assets?.get("index.html");
  if (!assets || !index) {
    app.log.warn(`dashboard: ${dir}/index.html is missing; /dashboard is not served`);
    return;
  }
  const headers = securityHeaders(env);
  const send = (reply: FastifyReply, asset: Asset) => reply.headers(headers).type(asset.type).send(asset.body);
  const toDashboard = (_req: unknown, reply: FastifyReply) => reply.redirect("/dashboard/");

  app.get("/", { schema: { hide: true } }, toDashboard);
  app.get("/dashboard", { schema: { hide: true } }, toDashboard);
  app.get("/dashboard/*", { schema: { hide: true } }, async (req, reply) => {
    const name = (req.params as { "*": string })["*"];
    const asset = PAGES.has(name) ? index : assets.get(name);
    if (!asset) return reply.code(404).send({ error: "not found", detail: null });
    return send(reply, asset);
  });
}
