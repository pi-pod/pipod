import { query } from "../db/index.js";
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
