/**
 * Credential sharing: the owner of a model credential lets named members of the same
 * organization use it. A share is one fact — (owner, provider, member) — and this module is
 * the only place that decides which credential serves a person for a provider:
 *
 *   1. their own credential, if they have one, whatever its state;
 *   2. otherwise the credential shared with them;
 *   3. otherwise none.
 *
 * That rule is the whole switch: connecting your own moves you to it, removing it falls back
 * to the share. Own wins even when it needs reconnecting, because falling through would
 * silently change whose account pays. A member holds at most one shared credential per
 * provider (the table's primary key), so "which shared credential" has one answer.
 *
 * Custody does not change. The owner's row is refreshed and leased exactly as it is for the
 * owner's own pods (lease.ts); the member's pods receive the same sanitized lease. Nothing in
 * this module reads or returns credential values.
 *
 * Membership comes from `organization_members`, the snapshot of people seen signing in to an
 * organization (auth/snapshots.ts). Removing a membership row, or the credential, deletes its
 * shares through the foreign keys in migration 007.
 */
import type pg from "pg";
import { query, tx, type Queryable } from "../db/index.js";
import { HttpError, badRequest, conflict } from "../httperrors.js";
import { classifyCredentialMeta } from "./login.js";
import {
  credentialMetaColumns,
  credentialMetaFromRow,
  type CredentialMeta,
  type ModelCredentialMetaRow,
} from "./store.js";
import type { CredentialListing, CredentialSubject, ListedCredential } from "./types.js";

/** A credential row that can serve a subject, and whose it is. */
export interface ServingCredential {
  meta: CredentialMeta;
  /** The row's owner: the subject themselves, or whoever shared it with them. */
  owner: CredentialSubject;
  /** The owner's email when the row is someone else's; absent for the subject's own. */
  sharedBy?: string;
}

type CandidateRow = ModelCredentialMetaRow & { owner_email: string };

/**
 * Rows that can serve member `$2` in organization `$1`: their own, and those shared with them.
 * Ordered so that, per provider, the member's own row comes first.
 */
const CANDIDATES = `
  SELECT ${credentialMetaColumns("c")}, u.email AS owner_email
    FROM model_credentials c
    JOIN users u ON u.id = c.user_id
   WHERE c.org_id = $1
     AND (c.user_id = $2 OR EXISTS (
           SELECT 1 FROM model_credential_shares s
            WHERE s.org_id = c.org_id AND s.provider_id = c.provider_id
              AND s.owner_user_id = c.user_id AND s.member_user_id = $2))`;

function servingFrom(subject: CredentialSubject, row: CandidateRow): ServingCredential {
  const meta = credentialMetaFromRow(row);
  if (row.user_id === subject.userId) return { meta, owner: subject };
  return { meta, owner: { orgId: subject.orgId, userId: row.user_id }, sharedBy: row.owner_email };
}

/** The credential that serves `subject` for `providerId`, or null when none does. */
export async function servingCredential(
  subject: CredentialSubject,
  providerId: string,
): Promise<ServingCredential | null> {
  const rows = await query<CandidateRow>(
    `${CANDIDATES} AND c.provider_id = $3 ORDER BY (c.user_id = $2) DESC LIMIT 1`,
    [subject.orgId, subject.userId, providerId],
  );
  const row = rows.rows[0];
  return row ? servingFrom(subject, row) : null;
}

/**
 * Every credential that serves `subject`, one per provider, plus the shares their own
 * credentials override (listed so a person can see what they would fall back to).
 */
export async function servingCredentials(
  subject: CredentialSubject,
): Promise<{ serving: ServingCredential[]; overridden: ServingCredential[] }> {
  const rows = await query<CandidateRow>(`${CANDIDATES} ORDER BY c.provider_id, (c.user_id = $2) DESC`, [
    subject.orgId,
    subject.userId,
  ]);
  const serving: ServingCredential[] = [];
  const overridden: ServingCredential[] = [];
  for (const row of rows.rows) {
    const candidate = servingFrom(subject, row);
    const served = serving.at(-1)?.meta.providerId === candidate.meta.providerId;
    (served ? overridden : serving).push(candidate);
  }
  return { serving, overridden };
}

/** A serving credential's metadata, with the owner's email when it is shared. */
export type ServingCredentialMeta = CredentialMeta & { sharedBy?: string };

/** Metadata of every credential that serves `subject`, one per provider (launch planning). */
export async function servingCredentialMetas(subject: CredentialSubject): Promise<ServingCredentialMeta[]> {
  const { serving } = await servingCredentials(subject);
  return serving.map(({ meta, sharedBy }) => (sharedBy ? { ...meta, sharedBy } : meta));
}

/** What `GET /model-credentials` lists for `subject`; metadata only. */
export async function listCredentials(subject: CredentialSubject): Promise<CredentialListing> {
  const [{ serving, overridden }, given] = await Promise.all([servingCredentials(subject), sharesGivenBy(subject)]);
  const listed = (credential: ServingCredential): ListedCredential => {
    const status = classifyCredentialMeta(credential.meta);
    if (credential.sharedBy) return { ...status, source: "shared", sharedBy: credential.sharedBy };
    const sharedWith = given.get(credential.meta.providerId);
    return { ...status, source: "own", ...(sharedWith ? { sharedWith } : {}) };
  };
  return { credentials: serving.map(listed), overriddenShares: overridden.map(listed) };
}

/** Member emails each of `owner`'s credentials is shared with, by provider id. */
async function sharesGivenBy(owner: CredentialSubject): Promise<Map<string, string[]>> {
  const rows = await query<{ provider_id: string; email: string }>(
    `SELECT s.provider_id, u.email
       FROM model_credential_shares s
       JOIN users u ON u.id = s.member_user_id
      WHERE s.org_id = $1 AND s.owner_user_id = $2
      ORDER BY s.provider_id, u.email`,
    [owner.orgId, owner.userId],
  );
  const given = new Map<string, string[]>();
  for (const row of rows.rows) given.set(row.provider_id, [...(given.get(row.provider_id) ?? []), row.email]);
  return given;
}

export interface OrganizationMember {
  userId: string;
  email: string;
}

/**
 * The member of `orgId` with this email. Not found means nobody with it has signed in to the
 * organization yet; the server learns its members only from their sign-ins.
 */
async function findMember(db: Queryable, orgId: string, email: string): Promise<OrganizationMember> {
  const rows = await db.query<{ id: string; email: string }>(
    `SELECT u.id, u.email
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND lower(u.email) = lower($2)`,
    [orgId, email],
  );
  if (rows.rows.length === 0) {
    throw new HttpError(404, "member_not_found", {
      code: "member_not_found",
      message: `${email} is not a member of this organization (members appear here once they have signed in with \`pipod login\`)`,
    });
  }
  if (rows.rows.length > 1) {
    throw conflict("member_ambiguous", {
      code: "member_ambiguous",
      message: `more than one member of this organization uses ${email}`,
    });
  }
  return { userId: rows.rows[0]!.id, email: rows.rows[0]!.email };
}

function credentialNotOwned(providerId: string): HttpError {
  return new HttpError(404, "credential_not_found", {
    code: "credential_not_found",
    message: `you have no saved ${providerId} credential of your own to share`,
    provider: providerId,
  });
}

const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Share `owner`'s credential for `providerId` with the member who has `email`. Idempotent for
 * the same owner. Refused with 409 `credential_already_shared`, naming the sharer, when someone
 * else already shares this provider with that member.
 */
export async function shareCredential(
  owner: CredentialSubject,
  providerId: string,
  email: string,
): Promise<{ member: OrganizationMember; created: boolean }> {
  try {
    return await tx(async (c) => {
      const own = await c.query(
        `SELECT 1 FROM model_credentials WHERE org_id = $1 AND user_id = $2 AND provider_id = $3`,
        [owner.orgId, owner.userId, providerId],
      );
      if ((own.rowCount ?? 0) === 0) throw credentialNotOwned(providerId);
      const member = await findMember(c, owner.orgId, email);
      if (member.userId === owner.userId) {
        throw badRequest("cannot_share_with_self", {
          code: "cannot_share_with_self",
          message: "a credential is already yours; share it with someone else",
        });
      }
      // The caller's verified token names this organization; its snapshot row normally exists.
      await c.query(
        `INSERT INTO organization_members (org_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [owner.orgId, owner.userId],
      );
      const inserted = await c.query(
        `INSERT INTO model_credential_shares (org_id, provider_id, member_user_id, owner_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, provider_id, member_user_id) DO NOTHING`,
        [owner.orgId, providerId, member.userId, owner.userId],
      );
      if ((inserted.rowCount ?? 0) > 0) return { member, created: true };
      const existing = await c.query<{ owner_user_id: string; email: string }>(
        `SELECT s.owner_user_id, u.email
           FROM model_credential_shares s
           JOIN users u ON u.id = s.owner_user_id
          WHERE s.org_id = $1 AND s.provider_id = $2 AND s.member_user_id = $3`,
        [owner.orgId, providerId, member.userId],
      );
      const holder = existing.rows[0];
      if (holder?.owner_user_id === owner.userId) return { member, created: false };
      throw conflict("credential_already_shared", {
        code: "credential_already_shared",
        message: holder
          ? `${member.email} already has a ${providerId} credential shared by ${holder.email}; only one person can share a provider with them`
          : `${member.email}'s ${providerId} share changed while sharing; try again`,
        provider: providerId,
        ...(holder ? { sharedBy: holder.email } : {}),
      });
    });
  } catch (error) {
    // The credential was removed between the check and the insert.
    const violation = error as pg.DatabaseError;
    if (violation.code === FOREIGN_KEY_VIOLATION && violation.constraint === "model_credential_shares_credential_fkey") {
      throw credentialNotOwned(providerId);
    }
    throw error;
  }
}

/**
 * Stop sharing `owner`'s credential for `providerId` with the member who has `email`. True when
 * a share was removed; a share that is already gone is not an error. The member's pods drop the
 * credential at their next lease poll.
 */
export async function unshareCredential(
  owner: CredentialSubject,
  providerId: string,
  email: string,
): Promise<{ removed: boolean; memberUserId?: string }> {
  const rows = await query<{ member_user_id: string }>(
    `DELETE FROM model_credential_shares s
      USING users u
      WHERE s.org_id = $1 AND s.owner_user_id = $2 AND s.provider_id = $3
        AND u.id = s.member_user_id AND lower(u.email) = lower($4)
      RETURNING s.member_user_id`,
    [owner.orgId, owner.userId, providerId, email],
  );
  const memberUserId = rows.rows[0]?.member_user_id;
  return memberUserId ? { removed: true, memberUserId } : { removed: false };
}
