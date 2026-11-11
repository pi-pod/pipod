import { query } from "../db/index.js";
import type { ServerEnv } from "../env.js";
import { userinfoEmail } from "./identity-provider.js";
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
  // Who may be named in a credential or template share (orgs/members.ts): people seen signed
  // in to this organization. Recorded, never consulted to authorize the signed-in person.
  await query(
    `INSERT INTO organization_members (org_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [org.id, claims.sub],
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
