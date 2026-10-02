import { query } from "../db/index.js";
import { jwksUrl, type ServerEnv } from "../env.js";
import type { AccessTokenClaims } from "./jwt.js";

/**
 * Materialize the minimum FK/display rows implied by a verified token.
 * This is not identity administration and is never consulted for authz.
 */
export async function materializeIdentity(claims: AccessTokenClaims): Promise<void> {
  await query(
    `INSERT INTO users (id, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       email = COALESCE(NULLIF(EXCLUDED.email, ''), users.email),
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       updated_at = now()`,
    [claims.sub, claims.email ?? "", claims.displayName],
  );

  const org = claims.organization;
  if (!org) return;
  await query(
    `INSERT INTO organizations (id, name, alias)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), organizations.name),
       alias = COALESCE(EXCLUDED.alias, organizations.alias),
       updated_at = now()`,
    [org.id, org.name ?? org.alias, org.alias],
  );
}

/**
 * A signed-in user's email. Zitadel's access tokens carry none, so the first time it is asked
 * for, Zitadel's userinfo endpoint answers it — with that user's own token — and it is kept on
 * their row. Null when Zitadel cannot say; never an authentication decision.
 */
export async function userEmail(env: ServerEnv, userId: string, accessToken: string): Promise<string | null> {
  const known = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  if (known.rows[0]?.email) return known.rows[0].email;
  const email = await userinfoEmail(env, accessToken).catch(() => null);
  if (email) await query(`UPDATE users SET email = $2, updated_at = now() WHERE id = $1`, [userId, email]);
  return email;
}

async function userinfoEmail(env: ServerEnv, accessToken: string): Promise<string | null> {
  // Reached by the same route as the signing keys, which may be an internal one; Zitadel then
  // needs the issuer's host to find its instance (see jwt.ts).
  const route = new URL(jwksUrl(env));
  const issuerHost = new URL(env.ZITADEL_ISSUER).host;
  const res = await fetch(new URL("/oidc/v1/userinfo", route.origin), {
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(route.host === issuerHost ? {} : { "x-forwarded-host": issuerHost }),
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { email?: unknown } | null;
  return typeof body?.email === "string" && body.email ? body.email : null;
}
