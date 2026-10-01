import { RESERVED_ENV_NAMES } from "../../core/labels.js";
import { PROVIDER_CREDENTIAL_VARS } from "../../core/providers/registry.js";
import { getPool, query, type Queryable } from "../db/index.js";
import { badRequest } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import { decryptSecret, encryptSecret, type KekProvider } from "./crypto.js";
import { secretContext } from "./context.js";

export type SecretScope = "org" | "user" | "template";

export interface SecretMeta {
  name: string;
  scopeType: SecretScope;
  scopeId: string;
  keyId: string;
  createdBy: string | null;
  updatedAt: string;
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Documented Phase 1 size bounds (spec §7): names are short identifiers, so 128
 * characters is generous; values hold tokens/keys, so 64 KiB of UTF-8 is ample
 * while bounding per-row database abuse. Enforced here and mirrored in the route
 * schemas so both direct callers and HTTP clients get a 400, never a silent write.
 */
export const SECRET_NAME_MAX_LENGTH = 128;
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;

/**
 * Credential names from retired adapters remain reserved forever. Removing one here would turn
 * a previously server-custodied org/user/template secret into ordinary pod environment on the
 * next launch or resume.
 */
export const RETIRED_PROVIDER_CREDENTIAL_VARS = ["BOAT_API_KEY", "E2B_API_KEY", "DAYTONA_API_KEY"] as const;

const RESERVED_PROVIDER_CREDENTIAL_VARS = new Set<string>([
  ...Object.values(PROVIDER_CREDENTIAL_VARS),
  ...RETIRED_PROVIDER_CREDENTIAL_VARS,
  // Host backend credentials are control-plane-only, not tenant environment.
  "BOAT_WEBHOOK_SECRET", "BOAT_HOSTED_TOKEN", "BOAT_RUNTIME_TOKEN",
]);

/** Provider API keys are server credentials (spec §7): storable, never injected into pods. */
export function isProviderCredential(name: string): boolean {
  return RESERVED_PROVIDER_CREDENTIAL_VARS.has(name);
}

/** Apply credential custody after every environment layer has been merged. */
export function withoutProviderCredentials(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isProviderCredential(name)));
}

export async function putSecret(args: {
  kek: KekProvider;
  orgId: string;
  scopeType: SecretScope;
  scopeId: string;
  name: string;
  value: string;
  createdBy: string;
}, client: Queryable = getPool()): Promise<void> {
  if (!ENV_NAME_RE.test(args.name)) throw badRequest(`"${args.name}" is not a valid env var name`);
  if (args.name.length > SECRET_NAME_MAX_LENGTH) {
    throw badRequest(
      `secret name exceeds the ${SECRET_NAME_MAX_LENGTH}-character limit (${args.name.length} characters)`
    );
  }
  if (Buffer.byteLength(args.value, "utf8") > SECRET_VALUE_MAX_BYTES) {
    throw badRequest(`secret value exceeds the ${SECRET_VALUE_MAX_BYTES}-byte limit`);
  }
  // Provider credentials resolve only from org scope (resolveProviderCredential); a
  // user/template-scoped row would be stored yet never used nor injected, so refuse
  // it at the write choke point rather than leaving a misleading row behind.
  if (args.scopeType !== "org" && isProviderCredential(args.name)) {
    throw badRequest(`"${args.name}" is a provider credential and may only be stored in org scope`);
  }
  if (args.name.startsWith("PI_POD_SERVER_")) {
    throw badRequest(`"${args.name}" is reserved for the pod identity env (spec §8.5)`);
  }
  if ((RESERVED_ENV_NAMES as readonly string[]).includes(args.name) && !isProviderCredential(args.name)) {
    throw badRequest(`"${args.name}" is reserved by pi pod and cannot be set`);
  }
  const { ciphertext, keyId, encryptionVersion } = encryptSecret(
    args.kek, args.value, secretContext(args.orgId, args.scopeType, args.scopeId, args.name),
  );
  await client.query(
    `INSERT INTO secrets (id, org_id, scope_type, scope_id, name, ciphertext, key_id, created_by, encryption_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, scope_type, scope_id, name)
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id,
                   encryption_version = EXCLUDED.encryption_version,
                   created_by = EXCLUDED.created_by, updated_at = now()`,
    [uuidv7(), args.orgId, args.scopeType, args.scopeId, args.name, ciphertext, keyId, args.createdBy, encryptionVersion],
  );
}

export async function deleteSecret(args: {
  orgId: string;
  scopeType: SecretScope;
  scopeId: string;
  name: string;
}, client: Queryable = getPool()): Promise<boolean> {
  const res = await client.query(
    "DELETE FROM secrets WHERE org_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4",
    [args.orgId, args.scopeType, args.scopeId, args.name],
  );
  return (res.rowCount ?? 0) > 0;
}

/** List returns names and metadata only — values are write-only (spec §7). */
export async function listSecrets(args: {
  orgId: string;
  scopeType: SecretScope;
  scopeId: string;
}): Promise<SecretMeta[]> {
  const rows = await query<{
    name: string;
    key_id: string;
    created_by: string | null;
    updated_at: string;
  }>(
    `SELECT name, key_id, created_by, updated_at FROM secrets
     WHERE org_id = $1 AND scope_type = $2 AND scope_id = $3 ORDER BY name`,
    [args.orgId, args.scopeType, args.scopeId],
  );
  return rows.rows.map((r) => ({
    name: r.name,
    scopeType: args.scopeType,
    scopeId: args.scopeId,
    keyId: r.key_id,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
  }));
}

async function readScope(
  kek: KekProvider,
  orgId: string,
  scopeType: SecretScope,
  scopeId: string,
): Promise<Record<string, string>> {
  const rows = await query<{ name: string; ciphertext: Buffer; key_id: string; encryption_version: number }>(
    "SELECT name, ciphertext, key_id, encryption_version FROM secrets WHERE org_id = $1 AND scope_type = $2 AND scope_id = $3",
    [orgId, scopeType, scopeId],
  );
  const out: Record<string, string> = {};
  for (const row of rows.rows) {
    out[row.name] = decryptSecret(kek, row.ciphertext, row.key_id,
      secretContext(orgId, scopeType, scopeId, row.name), row.encryption_version);
  }
  return out;
}

export interface ResolvedSecrets {
  /** Injected pod env. Never logged. */
  env: Record<string, string>;
  /** Preflight names every key that travels (spec §7); values never leave the server. */
  keys: string[];
  /** Which scope supplied each key after precedence (org < user < template, spec §7). */
  origins: Record<string, SecretScope>;
}

/**
 * Org secrets → user secrets → template secrets, merged per key, later wins (spec §7) —
 * the CLI's user-env-under-repo-env rule with an org layer beneath; the template scope
 * replaces the repo scope. Provider credentials are stripped: pods never see provider keys.
 */
export async function resolveSecrets(args: {
  kek: KekProvider;
  orgId: string;
  userId: string;
  /** Organization-scoped scheduled jobs omit user-bundle secrets. Defaults to true. */
  includeUserLayer?: boolean;
  /** Null for the built-in default template, which carries no extra secrets. */
  templateId: string | null;
}): Promise<ResolvedSecrets> {
  // These scopes are independent rows. Reading them concurrently removes two database
  // round-trips from every launch and every cold gateway attach.
  const [org, user, template] = await Promise.all([
    readScope(args.kek, args.orgId, "org", args.orgId),
    args.includeUserLayer === false
      ? Promise.resolve({} as Record<string, string>)
      : readScope(args.kek, args.orgId, "user", args.userId),
    args.templateId
      ? readScope(args.kek, args.orgId, "template", args.templateId)
      : Promise.resolve({} as Record<string, string>),
  ]);
  const merged: Record<string, string> = { ...org, ...user, ...template };
  const env = withoutProviderCredentials(merged);
  const origins: Record<string, SecretScope> = {};
  for (const name of Object.keys(env)) {
    origins[name] = name in template ? "template" : name in user ? "user" : "org";
  }
  return { env, keys: Object.keys(env).sort(), origins };
}

/** Org-scoped provider credential (BYO), falling back to the platform account key. */
export async function resolveProviderCredential(args: {
  kek: KekProvider;
  orgId: string;
  provider: string;
  platformEnv: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const envVar = PROVIDER_CREDENTIAL_VARS[args.provider];
  if (!envVar) return null;
  const org = await readScope(args.kek, args.orgId, "org", args.orgId);
  return org[envVar] ?? args.platformEnv[envVar] ?? null;
}

/**
 * Which custody would supply a provider credential, without touching the value: the answer
 * launches fail on and the resolve endpoint reports, so a missing key is a preflight error
 * with a named fix instead of an async provisioning failure.
 */
export async function checkProviderCredential(args: {
  kek: KekProvider;
  orgId: string;
  provider: string;
  platformEnv: NodeJS.ProcessEnv;
}): Promise<{ envVar: string; source: "org-secret" | "platform" } | null> {
  const envVar = PROVIDER_CREDENTIAL_VARS[args.provider];
  if (!envVar) return null;
  const org = await readScope(args.kek, args.orgId, "org", args.orgId);
  if (org[envVar] != null) return { envVar, source: "org-secret" };
  if (args.platformEnv[envVar] != null) return { envVar, source: "platform" };
  return null;
}
