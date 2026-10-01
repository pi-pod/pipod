// Mints a dev access token the server accepts via ZITADEL_JWKS_URL.
// Usage: node mint.mjs [sub] [orgId] [orgDomain] [permission...]
// With no permission args, mints the full server permission set (local-dev convenience).
import { SignJWT, importJWK } from "jose";
import { loadOrCreateKeys } from "./jwks-server.mjs";

const PERMISSIONS = [
  "pods:launch",
  "pods:manage_any",
  "templates:write",
  "jobs:write",
  "secrets:org:write",
  "secrets:own:write",
  "settings:own:write",
  "policy:write",
  "org:manage",
  "audit:read",
];

const DEV_SUB = "018f0000-0000-7000-8000-000000000001";
const DEV_ORG = "018f0000-0000-7000-8000-000000000010";

const [, , sub = DEV_SUB, orgId = DEV_ORG, domainOrPerm, ...rest] = process.argv;
const knownPerm = new Set(PERMISSIONS);
const domainIsPerm = typeof domainOrPerm === "string" && knownPerm.has(domainOrPerm);
const orgDomain = domainIsPerm || domainOrPerm === undefined ? "dev" : domainOrPerm;
const permArgs = domainIsPerm ? [domainOrPerm, ...rest] : rest;
const permissions = permArgs.length > 0 ? permArgs.filter((p) => p !== "--none") : ["owner", ...PERMISSIONS];
const issuer = process.env.ZITADEL_ISSUER ?? "http://127.0.0.1:9999";
const audience = process.env.ZITADEL_API_AUDIENCE ?? "pipod-api";

const roleClaim = Object.fromEntries(permissions.map((role) => [role, { [orgId]: orgDomain }]));

const { privateJwk } = await loadOrCreateKeys();
const key = await importJWK(privateJwk, "RS256");
const token = await new SignJWT({
  sid: "sess_dev_1",
  email: "dev@example.com",
  name: "Dev User",
  "urn:zitadel:iam:user:resourceowner:id": orgId,
  "urn:zitadel:iam:user:resourceowner:name": "Dev Org",
  "urn:zitadel:iam:user:resourceowner:primary_domain": orgDomain,
  "urn:zitadel:iam:org:project:roles": roleClaim,
  [`urn:zitadel:iam:org:project:${audience}:roles`]: roleClaim,
})
  .setProtectedHeader({ alg: "RS256", kid: "dev-key-1" })
  .setSubject(sub)
  .setIssuer(issuer)
  .setAudience(audience)
  .setIssuedAt()
  .setExpirationTime("8h")
  .sign(key);
console.log(token);
