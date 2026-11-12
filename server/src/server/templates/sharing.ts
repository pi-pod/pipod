/**
 * Sharing a personal template with named members of its organization. A share is one fact,
 * (template, member), and only the template's owner makes or ends it. What a share lets the
 * member do is decided where templates are read and launched (store.ts); this module only
 * records the facts.
 *
 * Ending a share stops everything new: the member's launches, and their pods' forks, child pods,
 * co-located pods and job runs, all resolve the template through store.ts and stop seeing it.
 * The member's scheduled jobs from it are paused (pauseMemberJobs). Pods the member already
 * launched keep the template's secrets they were launched with (pods/launchenv.ts), so the answer
 * counts them: ending their access means stopping them and rotating the template's secrets.
 */
import { tx } from "../db/index.js";
import { HttpError, badRequest } from "../httperrors.js";
import { findMember, recordMember, type OrganizationMember } from "../orgs/members.js";
import { lockTemplateForChange, type VisibleTemplate } from "./store.js";

export interface TemplateOwner {
  orgId: string;
  userId: string;
}

/** The owner's personal template, locked for a change to who it is shared with. */
async function ownTemplate(
  client: Parameters<typeof lockTemplateForChange>[0],
  owner: TemplateOwner,
  templateId: string,
  what: string,
): Promise<VisibleTemplate> {
  const template = await lockTemplateForChange(client, { ...owner, templateId, what });
  if (template.access === "org") {
    throw new HttpError(409, `${template.name} is organization-wide: every member can already launch it`, {
      code: "template_org_wide",
      message: `${template.name} is organization-wide: every member can already launch it`,
    });
  }
  return template;
}

/** Share `owner`'s personal template with the member who has `email`. Idempotent. */
export async function shareTemplate(
  owner: TemplateOwner,
  templateId: string,
  email: string,
): Promise<{ template: VisibleTemplate; member: OrganizationMember; created: boolean }> {
  return tx(async (client) => {
    const template = await ownTemplate(client, owner, templateId, "share it");
    const member = await findMember(client, owner.orgId, email);
    if (member.userId === owner.userId) {
      throw badRequest(`${member.email} is you: ${template.name} is already yours`, {
        code: "cannot_share_with_self",
        message: `${member.email} is you: ${template.name} is already yours`,
      });
    }
    await recordMember(client, owner.orgId, owner.userId);
    const inserted = await client.query(
      `INSERT INTO template_shares (template_id, member_user_id, org_id, owner_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (template_id, member_user_id) DO NOTHING`,
      [template.id, member.userId, owner.orgId, owner.userId],
    );
    return { template, member, created: (inserted.rowCount ?? 0) > 0 };
  });
}

/** What ending a share left behind: the member's pods from the template that still exist. */
export interface RemainingPods {
  /** Pods not deleted: running, stopped or archived (an archived pod can be restored). */
  total: number;
  running: number;
}

/**
 * Stop sharing `owner`'s template with the member who has `email`. A share that is already gone
 * is not an error. Counts the member's pods from the template that still exist either way, so a
 * repeated unshare still says what is left.
 */
export async function unshareTemplate(
  owner: TemplateOwner,
  templateId: string,
  email: string,
): Promise<{
  template: VisibleTemplate;
  removed: boolean;
  memberUserId: string | null;
  pods: RemainingPods;
  jobsPaused: number;
}> {
  return tx(async (client) => {
    const template = await ownTemplate(client, owner, templateId, "change who it is shared with");
    const deleted = await client.query<{ member_user_id: string }>(
      `DELETE FROM template_shares s
        USING users u
        WHERE s.template_id = $1 AND u.id = s.member_user_id AND lower(u.email) = lower($2)
        RETURNING s.member_user_id`,
      [template.id, email],
    );
    let memberUserId = deleted.rows[0]?.member_user_id ?? null;
    if (!memberUserId) {
      const known = await client.query<{ id: string }>(
        `SELECT u.id FROM users u JOIN organization_members m ON m.user_id = u.id AND m.org_id = $1
          WHERE lower(u.email) = lower($2)`,
        [owner.orgId, email],
      );
      memberUserId = known.rows.length === 1 ? known.rows[0]!.id : null;
    }
    const pods = memberUserId ? await remainingPods(client, template.id, memberUserId) : { total: 0, running: 0 };
    const jobsPaused = memberUserId ? await pauseMemberJobs(client, template, memberUserId) : 0;
    return { template, removed: deleted.rows.length > 0, memberUserId, pods, jobsPaused };
  });
}

/**
 * Pause the scheduled jobs that people other than its owner run from a personal template, or
 * only `memberUserId`'s. Once their share has ended (unshared, or the template deleted) such a
 * job can never launch again, so every run would fail; and an active job on a template is what
 * keeps a template from being deleted, which must stay its owner's to decide. Resuming a paused
 * job asks for a template its owner can launch from (jobs/routes.ts), so it stays paused until
 * the template is shared with them again or they pick another. The template row is locked by
 * the caller, and job writes lock it too, so no job can slip in between.
 */
export async function pauseMemberJobs(
  client: Parameters<typeof lockTemplateForChange>[0],
  template: { id: string; owner_user_id: string | null },
  memberUserId?: string,
): Promise<number> {
  if (template.owner_user_id === null) return 0;
  const paused = await client.query(
    `UPDATE jobs SET status = 'paused', next_run_at = NULL, updated_at = now()
      WHERE template_id = $1 AND status = 'active' AND archived_at IS NULL
        AND user_id <> $2 AND ($3::text IS NULL OR user_id = $3)
      RETURNING id`,
    [template.id, template.owner_user_id, memberUserId ?? null],
  );
  return paused.rowCount ?? 0;
}

async function remainingPods(
  client: Parameters<typeof lockTemplateForChange>[0],
  templateId: string,
  userId: string,
): Promise<RemainingPods> {
  const rows = await client.query<{ total: number; running: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state = 'active' AND provider_state = 'started')::int AS running
       FROM pods
      WHERE template_id = $1 AND user_id = $2 AND provider_state <> 'gone'`,
    [templateId, userId],
  );
  return rows.rows[0] ?? { total: 0, running: 0 };
}
