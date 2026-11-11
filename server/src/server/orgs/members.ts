/**
 * Members of an organization, as this server knows them: people it has seen sign in to it
 * (`organization_members`, a snapshot taken from verified tokens in auth/snapshots.ts). This is
 * who a person can share a model credential or a template with. It never authorizes the person
 * themselves; their token does that.
 */
import type { Queryable } from "../db/index.js";
import { HttpError, conflict } from "../httperrors.js";

export interface OrganizationMember {
  userId: string;
  email: string;
}

function refusal(status: number, code: string, message: string): HttpError {
  return new HttpError(status, message, { code, message });
}

/**
 * The member of `orgId` with this email. Refused, saying which, when nobody with the email has
 * signed in to this server, or when they have but not to this organization. The server learns
 * its members only from their sign-ins, so a person who has never signed in cannot be named yet.
 */
export async function findMember(db: Queryable, orgId: string, email: string): Promise<OrganizationMember> {
  const rows = await db.query<{ id: string; email: string; member: boolean }>(
    `SELECT u.id, u.email,
            EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = $1 AND m.user_id = u.id) AS member
       FROM users u
      WHERE lower(u.email) = lower($2)`,
    [orgId, email],
  );
  const members = rows.rows.filter((row) => row.member);
  if (members.length > 1) {
    throw conflict("member_ambiguous", {
      code: "member_ambiguous",
      message: `more than one member of this organization uses ${email}`,
    });
  }
  const member = members[0];
  if (member) return { userId: member.id, email: member.email };
  if (rows.rows.length > 0) {
    throw refusal(404, "member_outside_organization", `${email} is not a member of this organization`);
  }
  throw refusal(
    404,
    "member_not_found",
    `nobody with ${email} has signed in to this server (members appear here once they have signed in with \`pipod login\`)`,
  );
}

/**
 * Make sure `userId`, whose verified token names `orgId`, has a membership row: the foreign key a
 * share made by them needs. Their sign-in normally wrote it already.
 */
export async function recordMember(db: Queryable, orgId: string, userId: string): Promise<void> {
  await db.query(`INSERT INTO organization_members (org_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
    orgId,
    userId,
  ]);
}
