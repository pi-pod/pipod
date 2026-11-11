/**
 * Limited sign-ins: a machine signed in as a person that can launch from one template and reach
 * only that person's pods from it (`pipod login --device --template <name>`).
 *
 * The account stays the identity provider's. The person confirms on this server's dashboard and
 * hands over the dashboard session they confirmed with; the server keeps that session encrypted
 * and renews it whenever the machine renews its own token. So the sign-in lasts as long as the
 * account's own session would (idle and absolute limits included), ends when the account is
 * removed or deactivated, and never carries a permission the account has lost. The machine gets
 * only tokens this server issues: they mean nothing to the identity provider, and here they mean
 * the limit and nothing more.
 *
 * The limit is a template id, fixed when the person confirms. Routes are closed to a limited
 * sign-in unless they opt in (`allowLimitedSignIn`, enforced in plugin.ts); the routes that do
 * narrow what they reach with `limitReachesPod` and `limitedLaunchTemplateId`.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { audit } from "../audit.js";
import { query, tx } from "../db/index.js";
import type { ServerEnv } from "../env.js";
import { HttpError, conflict, forbidden, notFound } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import { limitedSignInContext } from "../secrets/context.js";
import { decryptSecret, encryptSecret, type KekProvider } from "../secrets/crypto.js";
import { findTemplate, findTemplateByName, visibleTemplateSql, type VisibleTemplate } from "../templates/store.js";
import { renewSession, revokeSession } from "./identity-provider.js";
import { verifyAccessToken } from "./jwt.js";
import { hasPermission, type Permission } from "./rbac.js";

export const LIMITED_ACCESS_PREFIX = "ppsa_";
export const LIMITED_REFRESH_PREFIX = "ppsr_";
/**
 * How long one access token lasts; the machine renews with its refresh token after that, which is
 * when the account is checked again. As long as Zitadel's own access tokens last by default, so a
 * removed account or a lost role reaches a limited sign-in as soon as it reaches a full one.
 */
export const ACCESS_TOKEN_SECONDS = 300;
/** How long a person has to confirm a code, and the machine to collect the sign-in. */
export const REQUEST_SECONDS = 600;
export const POLL_INTERVAL_SECONDS = 5;
/** Renewals this close together share one check with the identity provider. */
const IDENTITY_RECHECK_SECONDS = 60;
/** The permissions a limited sign-in may use, when the account has them. Everything else it does
 *  is reaching its own pods, which ownership and the limit decide, not a permission. */
export const LIMITED_SIGN_IN_PERMISSIONS: readonly Permission[] = ["pods:launch"];
/** Bounds the unauthenticated request table: requests nobody confirms expire in minutes. */
const MAX_PENDING_REQUESTS = 500;

/** What the server knows about the limit of the sign-in a request came from. */
export interface SignInLimit {
  signInId: string;
  templateId: string;
  /** The template's name now; it may have been renamed since the sign-in was confirmed. */
  templateName: string;
  /**
   * Why the sign-in launches nothing, when it does not: the template was deleted, or it was
   * another member's and is no longer shared with the account. Null while it can launch.
   */
  templateUnavailable: "deleted" | "unshared" | null;
}

export interface LimitedPrincipal {
  userId: string;
  email: string;
  orgId: string;
  orgAlias: string | null;
  orgName: string | null;
  /** What this sign-in may use: the account's permissions within LIMITED_SIGN_IN_PERMISSIONS. */
  permissions: string[];
  limit: SignInLimit;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mint(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** Consonants only, so a code never spells a word, and none that read alike. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

function mintUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

/** "bcdf-ghjk", "BCDFGHJK" and "BCDF GHJK" are one code. */
export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z]/g, "");
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function narrowedPermissions(accountPermissions: readonly string[]): string[] {
  return LIMITED_SIGN_IN_PERMISSIONS.filter((permission) => hasPermission(accountPermissions, permission));
}

// --- the limit, as routes apply it ------------------------------------------------------------

/** The 403 every refusal of a limited sign-in uses; app.ts audits it. */
export function limitRefusal(limit: SignInLimit, message: string): HttpError {
  return new HttpError(403, `this sign-in is limited to template ${limit.templateName}: ${message}`, {
    code: "limited_sign_in",
    templateId: limit.templateId,
    templateName: limit.templateName,
  });
}

export function isLimitRefusal(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    typeof error.detail === "object" &&
    error.detail !== null &&
    (error.detail as { code?: unknown }).code === "limited_sign_in"
  );
}

/** A limited sign-in reaches its account's own pods launched from its template, and no others. */
export function limitReachesPod(
  limit: SignInLimit,
  userId: string,
  pod: { user_id: string; template_id: string | null },
): boolean {
  return pod.user_id === userId && pod.template_id === limit.templateId;
}

/**
 * The template a launch by a limited sign-in uses: its own, whether the launch names it or not.
 * Naming any other is refused, and a deleted template launches nothing; a new template with the
 * old name is a different template.
 */
export async function limitedLaunchTemplateId(
  auth: { orgId: string; userId: string; limitedTo?: SignInLimit | undefined },
  requested: string | null | undefined,
): Promise<string | null> {
  const limit = auth.limitedTo;
  if (!limit) return requested ?? null;
  if (requested && requested.toLowerCase() !== limit.templateId) {
    throw limitRefusal(limit, `it cannot launch from template ${requested}`);
  }
  if (!(await findTemplate(auth.orgId, limit.templateId, auth.userId))) {
    throw limitRefusal(limit, "that template has been deleted or is no longer yours to use, so it can launch nothing");
  }
  return limit.templateId;
}

// --- authenticating a machine -----------------------------------------------------------------

/** The limited sign-in a live access token belongs to, or null. */
export async function authenticateLimitedToken(token: string): Promise<LimitedPrincipal | null> {
  const rows = await query<{
    sign_in_id: string;
    user_id: string;
    email: string;
    org_id: string;
    org_alias: string | null;
    org_name: string | null;
    permissions: string[];
    template_id: string;
    template_name: string;
    template_unavailable: "deleted" | "unshared" | null;
  }>(
    `SELECT s.id AS sign_in_id, s.user_id, u.email, s.org_id, o.alias AS org_alias, o.name AS org_name,
            s.permissions, s.template_id, t.name AS template_name,
            CASE WHEN t.archived_at IS NOT NULL THEN 'deleted'
                 WHEN NOT (${visibleTemplateSql("t", "s.user_id")}) THEN 'unshared'
            END AS template_unavailable
       FROM limited_sign_in_tokens k
       JOIN limited_sign_ins s ON s.id = k.sign_in_id
       JOIN users u ON u.id = s.user_id
       JOIN organizations o ON o.id = s.org_id
       JOIN pod_templates t ON t.id = s.template_id
      WHERE k.token_hash = $1 AND k.expires_at > now() AND s.revoked_at IS NULL`,
    [digest(token)],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    email: row.email,
    orgId: row.org_id,
    orgAlias: row.org_alias,
    orgName: row.org_name,
    permissions: narrowedPermissions(row.permissions),
    limit: {
      signInId: row.sign_in_id,
      templateId: row.template_id,
      templateName: row.template_name,
      templateUnavailable: row.template_unavailable,
    },
  };
}

// --- requests: a machine asks, a person decides -----------------------------------------------

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** A machine asks to sign in limited to `templateRef`; a person finishes at `pageBase`. */
export async function startRequest(templateRef: string, pageBase: string): Promise<DeviceAuthorization> {
  await sweep();
  const pending = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM limited_sign_in_requests WHERE state = 'pending' AND expires_at > now()`,
  );
  if ((pending.rows[0]?.n ?? 0) >= MAX_PENDING_REQUESTS) {
    throw new HttpError(503, "too many sign-ins are waiting to be confirmed; try again in a few minutes");
  }
  const deviceCode = randomBytes(32).toString("base64url");
  for (let attempt = 0; ; attempt++) {
    const userCode = mintUserCode();
    try {
      await query(
        `INSERT INTO limited_sign_in_requests (id, device_code_hash, user_code, template_ref, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
        [uuidv7(), digest(deviceCode), userCode, templateRef, REQUEST_SECONDS],
      );
      const page = new URL("/dashboard/#/sign-in", pageBase).toString();
      return {
        device_code: deviceCode,
        user_code: formatUserCode(userCode),
        verification_uri: page,
        verification_uri_complete: `${page}/${formatUserCode(userCode)}`,
        expires_in: REQUEST_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      };
    } catch (error) {
      // A user code collided with a live one: draw another.
      if ((error as { code?: string }).code !== "23505" || attempt >= 4) throw error;
    }
  }
}

/**
 * Forget what nobody will use: requests well past their expiry, and sign-ins a person approved
 * but no machine collected before the request expired — their held session goes with them.
 */
async function sweep(): Promise<void> {
  await query(`DELETE FROM limited_sign_in_requests WHERE expires_at < now() - interval '1 day'`);
  await tx(async (client) => {
    const stale = await client.query<{ id: string }>(
      `UPDATE limited_sign_ins SET revoked_at = now(), revoked_reason = 'not_collected'
        WHERE refresh_token_hash IS NULL AND revoked_at IS NULL
          AND created_at < now() - make_interval(secs => $1)
        RETURNING id`,
      [REQUEST_SECONDS * 2],
    );
    if (stale.rows.length > 0) {
      await client.query(`DELETE FROM limited_sign_in_identities WHERE sign_in_id = ANY($1::uuid[])`, [
        stale.rows.map((row) => row.id),
      ]);
    }
  });
}

interface RequestRow {
  id: string;
  user_code: string;
  template_ref: string;
  state: "pending" | "approved" | "denied" | "redeemed";
  sign_in_id: string | null;
  decided_by: string | null;
  created_at: Date;
  expires_at: Date;
  expired: boolean;
}

const REQUEST_COLUMNS = `id, user_code, template_ref, state, sign_in_id, decided_by, created_at, expires_at,
  (expires_at <= now()) AS expired`;

async function requestByUserCode(rawCode: string, client?: PoolClient): Promise<RequestRow> {
  const code = normalizeUserCode(rawCode);
  const sql = `SELECT ${REQUEST_COLUMNS} FROM limited_sign_in_requests WHERE user_code = $1${client ? " FOR UPDATE" : ""}`;
  const rows = client ? await client.query<RequestRow>(sql, [code]) : await query<RequestRow>(sql, [code]);
  const row = rows.rows[0];
  // An expired request that nobody decided is as good as gone; one that was decided stays
  // readable so the page can say what happened.
  if (!row || (row.expired && row.state === "pending")) {
    throw notFound("no sign-in is waiting for this code: it may have expired; run the command on the machine again");
  }
  return row;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The template a request names, as the person deciding it would launch it: by id, or by name with
 * their own first, then the organization's, then one shared with them. A name that only templates
 * shared by different members match is ambiguous: that is the problem, and the id resolves it.
 */
async function templateForPerson(
  orgId: string,
  userId: string,
  ref: string,
): Promise<{ template: VisibleTemplate | null; ambiguity: string | null }> {
  if (UUID.test(ref)) return { template: await findTemplate(orgId, ref.toLowerCase(), userId), ambiguity: null };
  try {
    return { template: await findTemplateByName(orgId, userId, ref), ambiguity: null };
  } catch (error) {
    if (error instanceof HttpError && (error.detail as { code?: string } | undefined)?.code === "template_name_ambiguous") {
      return { template: null, ambiguity: error.message };
    }
    throw error;
  }
}

interface Person {
  userId: string;
  orgId: string;
  permissions: string[];
}

/** Why `person` cannot grant this request, or null when they can. */
function grantProblem(
  person: Person,
  { template, ambiguity }: { template: VisibleTemplate | null; ambiguity: string | null },
  ref: string,
): string | null {
  if (ambiguity) return ambiguity;
  if (!template) return `you have no template named ${JSON.stringify(ref)} in this organization`;
  if (!hasPermission(person.permissions, "pods:launch")) return "your account cannot launch pods (it lacks pods:launch)";
  return null;
}

export interface RequestView {
  userCode: string;
  state: RequestRow["state"];
  requestedAt: string;
  expiresAt: string;
  /** What the machine asked for, verbatim: shown only when it names no template you can use. */
  templateRef: string;
  template: {
    id: string;
    name: string;
    /** `shared`: another member's personal template, shared with this person by `sharedBy`. */
    scope: "user" | "org" | "shared";
    sharedBy: string | null;
    description: string | null;
  } | null;
  /** Why this person cannot confirm it; null when they can. */
  problem: string | null;
  /** Set once decided by someone else: the request is not this person's to see further. */
  decidedByAnother: boolean;
}

/** What the person confirming a code is shown: the template as they would launch it. */
export async function describeRequest(rawCode: string, person: Person): Promise<RequestView> {
  const row = await requestByUserCode(rawCode);
  const decidedByAnother = row.decided_by !== null && row.decided_by !== person.userId;
  const resolved = decidedByAnother
    ? { template: null, ambiguity: null }
    : await templateForPerson(person.orgId, person.userId, row.template_ref);
  const template = resolved.template;
  return {
    userCode: formatUserCode(row.user_code),
    state: row.state,
    requestedAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    templateRef: row.template_ref,
    template: template && {
      id: template.id,
      name: template.name,
      scope: template.access === "own" ? "user" : template.access,
      sharedBy: template.shared_by,
      description: template.description,
    },
    problem: decidedByAnother ? "someone else already decided this sign-in" : grantProblem(person, resolved, row.template_ref),
    decidedByAnother,
  };
}

export async function denyRequest(rawCode: string, person: Person): Promise<void> {
  await tx(async (client) => {
    const row = await requestByUserCode(rawCode, client);
    if (row.state !== "pending") throw conflict("this sign-in was already decided");
    await client.query(
      `UPDATE limited_sign_in_requests SET state = 'denied', decided_by = $2, decided_at = now() WHERE id = $1`,
      [row.id, person.userId],
    );
  });
}

export interface SignInDeps {
  env: ServerEnv;
  kek: KekProvider;
}

/** The public client whose sessions a limited sign-in holds: the dashboard's, where people confirm. */
function heldSessionClient(env: ServerEnv): string {
  if (!env.ZITADEL_DASHBOARD_CLIENT_ID) {
    throw new HttpError(503, "limited sign-ins need the dashboard sign-in: set ZITADEL_DASHBOARD_CLIENT_ID");
  }
  return env.ZITADEL_DASHBOARD_CLIENT_ID;
}

/**
 * The person confirms. `sessionRefreshToken` is the refresh token of the dashboard session they
 * confirmed with; the server renews it once here — which spends the person's copy — and keeps the
 * renewed one as the sign-in's tie to the account.
 */
export async function approveRequest(
  deps: SignInDeps,
  rawCode: string,
  person: Person,
  sessionRefreshToken: string,
): Promise<{ signInId: string; template: { id: string; name: string } }> {
  const clientId = heldSessionClient(deps.env);
  return tx(async (client) => {
    const row = await requestByUserCode(rawCode, client);
    if (row.state !== "pending") throw conflict("this sign-in was already decided");
    if (row.expired) throw notFound("this code expired before it was confirmed; run the command on the machine again");
    const resolved = await templateForPerson(person.orgId, person.userId, row.template_ref);
    const template = resolved.template;
    const problem = grantProblem(person, resolved, row.template_ref);
    if (problem || !template) throw forbidden(problem ?? "this template cannot be granted");

    const renewal = await renewSession(deps.env, clientId, sessionRefreshToken);
    if (renewal.kind === "unavailable") {
      throw new HttpError(503, "the identity provider did not answer; confirm again in a moment");
    }
    if (renewal.kind === "ended") {
      throw new HttpError(401, "this page's sign-in could not be handed to the machine; sign in again and confirm");
    }
    const claims = await verifyAccessToken(deps.env, renewal.accessToken);
    if (claims.sub !== person.userId || claims.organization?.id !== person.orgId) {
      throw forbidden("the session handed over belongs to another account");
    }
    if (!hasPermission(claims.organization.permissions, "pods:launch")) {
      throw forbidden("your account cannot launch pods (it lacks pods:launch)");
    }

    const signInId = uuidv7();
    await client.query(
      `INSERT INTO limited_sign_ins (id, org_id, user_id, template_id, permissions, checked_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [signInId, person.orgId, person.userId, template.id, claims.organization.permissions],
    );
    await storeIdentity(client, deps.kek, signInId, renewal.refreshToken, "insert");
    await client.query(
      `UPDATE limited_sign_in_requests
          SET state = 'approved', sign_in_id = $2, decided_by = $3, decided_at = now()
        WHERE id = $1`,
      [row.id, signInId, person.userId],
    );
    await audit(
      {
        orgId: person.orgId,
        actorId: person.userId,
        action: "sign_in.limited.create",
        targetType: "limited_sign_in",
        targetId: signInId,
        detail: {
          templateId: template.id,
          templateName: template.name,
          ...(template.access === "shared" ? { templateOwner: template.owner_user_id, templateOwnerEmail: template.shared_by } : {}),
          permissions: narrowedPermissions(claims.organization.permissions),
        },
      },
      client,
    );
    return { signInId, template: { id: template.id, name: template.name } };
  });
}

async function storeIdentity(
  client: PoolClient,
  kek: KekProvider,
  signInId: string,
  refreshToken: string,
  mode: "insert" | "update",
): Promise<void> {
  const { ciphertext, keyId, encryptionVersion } = encryptSecret(kek, refreshToken, limitedSignInContext(signInId));
  if (mode === "insert") {
    await client.query(
      `INSERT INTO limited_sign_in_identities (sign_in_id, ciphertext, key_id, encryption_version) VALUES ($1, $2, $3, $4)`,
      [signInId, ciphertext, keyId, encryptionVersion],
    );
  } else {
    await client.query(
      `UPDATE limited_sign_in_identities SET ciphertext = $2, key_id = $3, encryption_version = $4, updated_at = now()
        WHERE sign_in_id = $1`,
      [signInId, ciphertext, keyId, encryptionVersion],
    );
  }
}

async function heldIdentity(client: PoolClient, kek: KekProvider, signInId: string): Promise<string | null> {
  const rows = await client.query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
    `SELECT ciphertext, key_id, encryption_version FROM limited_sign_in_identities WHERE sign_in_id = $1`,
    [signInId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return decryptSecret(kek, row.ciphertext, row.key_id, limitedSignInContext(signInId), Number(row.encryption_version));
}

// --- tokens: the machine collects, renews and ends its sign-in --------------------------------

export interface TokenGrant {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  limited_to: { template_id: string; template_name: string };
}

/** An OAuth error the token endpoint answers with (RFC 6749 §5.2, RFC 8628 §3.5). */
export class GrantError extends Error {
  constructor(
    readonly error: string,
    description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

async function issueAccessToken(client: PoolClient, signInId: string): Promise<string> {
  const token = mint(LIMITED_ACCESS_PREFIX);
  await client.query(`DELETE FROM limited_sign_in_tokens WHERE sign_in_id = $1 AND expires_at <= now()`, [signInId]);
  await client.query(
    `INSERT INTO limited_sign_in_tokens (token_hash, sign_in_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [digest(token), signInId, ACCESS_TOKEN_SECONDS],
  );
  await client.query(`UPDATE limited_sign_ins SET last_used_at = now() WHERE id = $1`, [signInId]);
  return token;
}

async function templateLabel(client: PoolClient, templateId: string): Promise<string> {
  const rows = await client.query<{ name: string }>(`SELECT name FROM pod_templates WHERE id = $1`, [templateId]);
  return rows.rows[0]?.name ?? templateId;
}

/** The device-code grant: once the person approved, the machine collects its sign-in, once. */
export async function collectSignIn(deviceCode: string): Promise<TokenGrant> {
  return tx(async (client) => {
    const rows = await client.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM limited_sign_in_requests WHERE device_code_hash = $1 FOR UPDATE`,
      [digest(deviceCode)],
    );
    const row = rows.rows[0];
    if (!row) throw new GrantError("invalid_grant", "unknown device code");
    if (row.state === "denied") throw new GrantError("access_denied", "the sign-in was declined");
    if (row.state === "redeemed") throw new GrantError("invalid_grant", "this sign-in was already collected");
    if (row.expired) throw new GrantError("expired_token", "the code expired before the sign-in was collected");
    if (row.state === "pending" || !row.sign_in_id) {
      throw new GrantError("authorization_pending", "waiting for the person to confirm the code");
    }
    const refreshToken = mint(LIMITED_REFRESH_PREFIX);
    const claimed = await client.query<{ template_id: string }>(
      `UPDATE limited_sign_ins SET refresh_token_hash = $2
        WHERE id = $1 AND refresh_token_hash IS NULL AND revoked_at IS NULL
        RETURNING template_id`,
      [row.sign_in_id, digest(refreshToken)],
    );
    const signIn = claimed.rows[0];
    if (!signIn) throw new GrantError("invalid_grant", "this sign-in is no longer available");
    await client.query(`UPDATE limited_sign_in_requests SET state = 'redeemed' WHERE id = $1`, [row.id]);
    return {
      access_token: await issueAccessToken(client, row.sign_in_id),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      limited_to: { template_id: signIn.template_id, template_name: await templateLabel(client, signIn.template_id) },
    };
  });
}

/**
 * The refresh grant. Unless it was checked a moment ago, the account's session is renewed with
 * the identity provider first: a session that ended there ends the sign-in, and the account's
 * permissions are taken afresh. The refresh token itself does not rotate.
 */
export async function renewSignIn(deps: SignInDeps, refreshToken: string): Promise<TokenGrant> {
  if (!refreshToken.startsWith(LIMITED_REFRESH_PREFIX)) throw new GrantError("invalid_grant", "not a sign-in refresh token");
  const outcome = await tx(async (client): Promise<TokenGrant | GrantError> => {
    const rows = await client.query<{
      id: string;
      org_id: string;
      user_id: string;
      template_id: string;
      revoked_at: Date | null;
      stale: boolean;
    }>(
      `SELECT id, org_id, user_id, template_id, revoked_at,
              (checked_at < now() - make_interval(secs => $2)) AS stale
         FROM limited_sign_ins WHERE refresh_token_hash = $1 FOR UPDATE`,
      [digest(refreshToken), IDENTITY_RECHECK_SECONDS],
    );
    const signIn = rows.rows[0];
    if (!signIn || signIn.revoked_at) return new GrantError("invalid_grant", "this sign-in has ended");
    if (signIn.stale) {
      const refusal = await recheckAccount(client, deps, signIn);
      if (refusal) return refusal;
    }
    return {
      access_token: await issueAccessToken(client, signIn.id),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      limited_to: { template_id: signIn.template_id, template_name: await templateLabel(client, signIn.template_id) },
    };
  });
  if (outcome instanceof GrantError) throw outcome;
  return outcome;
}

/**
 * Renew the held session and take the account's permissions from it. Returns null when the
 * account checks out, or the error to answer: either the session ended (the sign-in is ended in
 * the same transaction), or the renewed session is kept but its token could not be verified.
 * Throws, leaving everything as it was, when the identity provider gives no answer.
 */
async function recheckAccount(
  client: PoolClient,
  deps: SignInDeps,
  signIn: { id: string; org_id: string; user_id: string },
): Promise<GrantError | null> {
  const clientId = heldSessionClient(deps.env);
  const held = await heldIdentity(client, deps.kek, signIn.id);
  if (!held) {
    await endInTransaction(client, signIn, "identity_missing");
    return new GrantError("invalid_grant", "this sign-in has ended");
  }
  const renewal = await renewSession(deps.env, clientId, held);
  if (renewal.kind === "unavailable") {
    throw new GrantError("temporarily_unavailable", "the identity provider did not answer; retry shortly", 503);
  }
  if (renewal.kind === "ended") {
    await endInTransaction(client, signIn, "account_session_ended", { providerError: renewal.reason });
    return new GrantError("invalid_grant", "the account's session ended at the identity provider; sign in again");
  }
  // The renewed session is the only one now: keep it before anything else can fail.
  await storeIdentity(client, deps.kek, signIn.id, renewal.refreshToken, "update");
  let claims;
  try {
    claims = await verifyAccessToken(deps.env, renewal.accessToken);
  } catch {
    // A token the server cannot verify is a configuration fault here, not the account's: keep
    // the session (renewed and stored above, committed with this answer) and let the machine retry.
    return new GrantError("temporarily_unavailable", "the identity provider's token could not be verified; retry shortly", 503);
  }
  if (claims.sub !== signIn.user_id || claims.organization?.id !== signIn.org_id) {
    await endInTransaction(client, signIn, "account_changed");
    return new GrantError("invalid_grant", "the account behind this sign-in changed; sign in again");
  }
  await client.query(`UPDATE limited_sign_ins SET permissions = $2, checked_at = now() WHERE id = $1`, [
    signIn.id,
    claims.organization.permissions,
  ]);
  return null;
}

async function endInTransaction(
  client: PoolClient,
  signIn: { id: string; org_id: string; user_id: string },
  reason: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `UPDATE limited_sign_ins SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [signIn.id, reason],
  );
  await client.query(`DELETE FROM limited_sign_in_identities WHERE sign_in_id = $1`, [signIn.id]);
  await client.query(`DELETE FROM limited_sign_in_tokens WHERE sign_in_id = $1`, [signIn.id]);
  await audit(
    {
      orgId: signIn.org_id,
      actorId: reason === "signed_out" ? signIn.user_id : null,
      action: "sign_in.limited.end",
      targetType: "limited_sign_in",
      targetId: signIn.id,
      detail: { reason, ...detail },
    },
    client,
  );
}

/**
 * Sign out (RFC 7009 shape): either of the machine's tokens ends the whole sign-in, and the held
 * session is ended at the identity provider too. Unknown tokens are not an error.
 */
export async function endSignIn(deps: SignInDeps, token: string): Promise<void> {
  const held = await tx(async (client) => {
    const rows = await client.query<{ id: string; org_id: string; user_id: string }>(
      `SELECT s.id, s.org_id, s.user_id FROM limited_sign_ins s
        WHERE s.revoked_at IS NULL AND (s.refresh_token_hash = $1
           OR s.id = (SELECT sign_in_id FROM limited_sign_in_tokens WHERE token_hash = $1))
        FOR UPDATE`,
      [digest(token)],
    );
    const signIn = rows.rows[0];
    if (!signIn) return null;
    const identity = await heldIdentity(client, deps.kek, signIn.id).catch(() => null);
    await endInTransaction(client, signIn, "signed_out");
    return identity;
  });
  if (held && deps.env.ZITADEL_DASHBOARD_CLIENT_ID) {
    await revokeSession(deps.env, deps.env.ZITADEL_DASHBOARD_CLIENT_ID, held);
  }
}
