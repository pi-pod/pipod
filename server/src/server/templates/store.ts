/**
 * Templates and who reaches them. A template is one of three things to a person:
 *
 *   - `own`: their personal template. Only they see it, launch it and change it, and it sits
 *     above their user settings layer.
 *   - `org`: an organization-wide template. Every member launches it; it sits below their user
 *     layer, as defaults.
 *   - `shared`: another member's personal template that its owner shared with them by name
 *     (`template_shares`). To them it behaves as an organization-wide template does — they launch
 *     it and read it (secret names, never values), and it sits below their user layer — but only
 *     its owner changes it, its secrets or who it is shared with.
 *
 * Every query that decides whether a person can see or launch a template uses
 * {@link visibleTemplateSql}; every write goes through {@link lockTemplateForChange}.
 */
import type { Queryable } from "../db/index.js";
import { validateConfig } from "../../core/config.js";
import { mergeConfigLayers } from "../../core/userconfig.js";
import { query } from "../db/index.js";
import { badRequest, HttpError, notFound } from "../httperrors.js";
import { assertNoRetiredConfigKeys } from "../settings/merge.js";
import { flattenTemplatePiSettings, type PiSettingsFiles } from "../settings/pi-settings.js";

/** Launches without a templateId use the built-in default (spec §1): no init script,
 * default egress, no extra secrets. The name is reserved so a DB row can never shadow it. */
export const DEFAULT_TEMPLATE_NAME = "default";

export interface TemplateRow {
  id: string;
  org_id: string;
  /** NULL = org-wide; otherwise only this user sees and launches the template. */
  owner_user_id: string | null;
  name: string;
  description: string | null;
  init_script: string | null;
  bake_script: string | null;
  /** Shown to the agent in every pod launched from the template (see pods/template-brief.ts). */
  agent_instructions: string | null;
  config: Record<string, unknown>;
  pi_settings: PiSettingsFiles;
  created_by: string | null;
  created_from_pod: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

/** Templates are validated at write time (spec §6): a template that cannot launch is
 * rejected when authored, not discovered at launch. Retired bundle keys are rejected with
 * the removal spelled out before the merged probe runs. */
export function assertValidTemplateConfig(config: Record<string, unknown>): void {
  assertNoRetiredConfigKeys(config);
  const probe = validateConfig(mergeConfigLayers({}, config));
  if (probe.errors.length > 0) {
    throw badRequest(
      "invalid template config",
      probe.errors.map((e, i) => `${probe.errorPaths[i]}: ${e}`),
    );
  }
}

/** Ownership moves one way: an owner may hand their personal template to the org, but an
 * org template cannot be pulled private out from under the members relying on it.
 * Returns whether this request shares the template with the org. */
export function assertScopeChange(
  existing: Pick<TemplateRow, "owner_user_id">,
  requested: "user" | "org" | undefined,
): boolean {
  if (requested === "user" && existing.owner_user_id === null) {
    throw badRequest("an org template cannot be made personal", "create your own copy instead");
  }
  return requested === "org" && existing.owner_user_id !== null;
}

/** How a person reaches a template; see the module comment. */
export type TemplateAccess = "own" | "org" | "shared";

/** A template as one person sees it. */
export interface VisibleTemplate extends TemplateRow {
  access: TemplateAccess;
  /** The owner's email when the template is shared with this person; null otherwise. */
  shared_by: string | null;
}

/**
 * The SQL condition "template `alias` is live and person `userParam` can see and launch it":
 * organization-wide, their own, or shared with them. The one definition of visibility; every
 * read of a template on a person's behalf filters with it.
 */
export function visibleTemplateSql(alias: string, userParam: string): string {
  return `${alias}.archived_at IS NULL AND (
    ${alias}.owner_user_id IS NULL OR ${alias}.owner_user_id = ${userParam}
    OR EXISTS (SELECT 1 FROM template_shares ts
                WHERE ts.template_id = ${alias}.id AND ts.member_user_id = ${userParam}))`;
}

/** Columns that turn a visible `pod_templates` row into a {@link VisibleTemplate} (join `template_owner`). */
function accessColumns(alias: string, userParam: string): string {
  return `CASE WHEN ${alias}.owner_user_id IS NULL THEN 'org'
               WHEN ${alias}.owner_user_id = ${userParam} THEN 'own'
               ELSE 'shared' END AS access,
          CASE WHEN ${alias}.owner_user_id <> ${userParam} THEN template_owner.email END AS shared_by`;
}

function visibleFromRow(row: VisibleTemplate): VisibleTemplate {
  return { ...row, pi_settings: flattenTemplatePiSettings(row.pi_settings) };
}

/**
 * Where a template sits in its launcher's settings chain: their own above their user layer;
 * an organization-wide or shared one below it, as defaults the person's own settings override.
 */
export function templateSettingsScope(template: Pick<VisibleTemplate, "access">): "user" | "org" {
  return template.access === "own" ? "user" : "org";
}

/**
 * What a launch's audit entry adds about its template: the owner, when the launcher used a
 * template another member shared with them (the entry's actor is the launcher).
 */
export function sharedTemplateAudit(
  template: Pick<VisibleTemplate, "access" | "owner_user_id" | "shared_by"> | null,
): { templateOwner?: string; templateOwnerEmail?: string } {
  if (template?.access !== "shared" || !template.owner_user_id) return {};
  return { templateOwner: template.owner_user_id, ...(template.shared_by ? { templateOwnerEmail: template.shared_by } : {}) };
}

/** A template `userId` can see and launch: org-wide, their own or shared with them. */
export async function getTemplate(orgId: string, id: string, userId: string): Promise<VisibleTemplate> {
  const row = await findTemplate(orgId, id, userId);
  if (!row) throw notFound("template not found");
  return row;
}

/** Like getTemplate, but null when the template is not visible or has been deleted. */
export async function findTemplate(orgId: string, id: string, userId: string): Promise<VisibleTemplate | null> {
  const rows = await query<VisibleTemplate>(
    `SELECT t.*, ${accessColumns("t", "$3")}
       FROM pod_templates t LEFT JOIN users template_owner ON template_owner.id = t.owner_user_id
      WHERE t.id = $1 AND t.org_id = $2 AND ${visibleTemplateSql("t", "$3")}`,
    [id, orgId, userId],
  );
  const row = rows.rows[0];
  return row ? visibleFromRow(row) : null;
}

/** Every template `userId` can see, newest first; `templateId` narrows it to one. */
export async function listVisibleTemplates(args: {
  orgId: string;
  userId: string;
  limit: number;
  before?: string | null;
  templateId?: string | null;
}): Promise<VisibleTemplate[]> {
  // The page is the newest `limit` templates; within it, the person's own and the organization's
  // come before those shared with them. A client that resolves a name by taking the first match
  // after its own (pipod 0.1.28 and older) then never prefers a shared template to an
  // organization-wide one of the same name.
  const rows = await query<VisibleTemplate>(
    `SELECT * FROM (
       SELECT t.*, ${accessColumns("t", "$2")}
         FROM pod_templates t LEFT JOIN users template_owner ON template_owner.id = t.owner_user_id
        WHERE t.org_id = $1 AND ${visibleTemplateSql("t", "$2")}
          AND ($3::timestamptz IS NULL OR t.created_at < $3)
          AND ($5::uuid IS NULL OR t.id = $5)
        ORDER BY t.created_at DESC LIMIT $4
     ) page
     ORDER BY (access = 'shared'), created_at DESC`,
    [args.orgId, args.userId, args.before ?? null, args.limit, args.templateId ?? null],
  );
  return rows.rows.map(visibleFromRow);
}

/** Who each of `templateIds` is shared with (member emails), for its owner's view. */
export async function sharedWith(templateIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (templateIds.length === 0) return out;
  const rows = await query<{ template_id: string; email: string }>(
    `SELECT s.template_id, u.email
       FROM template_shares s JOIN users u ON u.id = s.member_user_id
      WHERE s.template_id = ANY($1::uuid[])
      ORDER BY s.template_id, lower(u.email)`,
    [templateIds],
  );
  for (const row of rows.rows) out.set(row.template_id, [...(out.get(row.template_id) ?? []), row.email]);
  return out;
}

/** The refusal for anyone but its owner changing a template shared with them. */
export function notTheOwner(template: Pick<VisibleTemplate, "name" | "shared_by">, what = "change it"): HttpError {
  const owner = template.shared_by ?? "its owner";
  return new HttpError(403, `${template.name} is shared with you by ${owner}; only ${owner} can ${what}`, {
    code: "template_shared",
    message: `${template.name} is shared with you by ${owner}; only ${owner} can ${what}`,
    sharedBy: template.shared_by,
  });
}

/**
 * Lock a template for a write on `userId`'s behalf: visible to them, and not merely shared with
 * them. A shared template answers 403 naming its owner; one they cannot see answers 404. Callers
 * still apply their own rules for organization-wide templates and pod tokens.
 */
export async function lockTemplateForChange(
  client: Queryable,
  args: { orgId: string; templateId: string; userId: string; what?: string },
): Promise<VisibleTemplate> {
  const rows = await client.query<VisibleTemplate>(
    `SELECT t.*, ${accessColumns("t", "$3")}
       FROM pod_templates t LEFT JOIN users template_owner ON template_owner.id = t.owner_user_id
      WHERE t.id = $1 AND t.org_id = $2 AND ${visibleTemplateSql("t", "$3")}
        FOR UPDATE OF t`,
    [args.templateId, args.orgId, args.userId],
  );
  const row = rows.rows[0];
  if (!row) throw notFound("template not found");
  if (row.access === "shared") throw notTheOwner(row, args.what);
  return visibleFromRow(row);
}

/**
 * A template by name for `userId`, the way a launch resolves one: their own first, then the
 * organization's, then one shared with them. A shared template never takes a name from one they
 * could already launch; when only shared templates match and there are several, the name is
 * ambiguous and the answer says so, listing each with its owner and id.
 */
export async function findTemplateByName(
  orgId: string,
  userId: string,
  name: string,
): Promise<VisibleTemplate | null> {
  const rows = await query<VisibleTemplate>(
    `SELECT t.*, ${accessColumns("t", "$2")}
       FROM pod_templates t LEFT JOIN users template_owner ON template_owner.id = t.owner_user_id
      WHERE t.org_id = $1 AND ${visibleTemplateSql("t", "$2")} AND lower(t.name) = lower($3)
      ORDER BY CASE WHEN t.owner_user_id = $2 THEN 0 WHEN t.owner_user_id IS NULL THEN 1 ELSE 2 END,
               t.created_at`,
    [orgId, userId, name],
  );
  const [first, ...rest] = rows.rows;
  if (!first) return null;
  if (first.access === "shared" && rest.length > 0) {
    throw ambiguousSharedName(name, rows.rows);
  }
  return visibleFromRow(first);
}

export function ambiguousSharedName(
  name: string,
  matches: ReadonlyArray<Pick<VisibleTemplate, "id" | "shared_by">>,
): HttpError {
  const listed = matches.map((t) => `${name} shared by ${t.shared_by ?? "another member"} (${t.id})`).join("; ");
  const message = `more than one template named ${JSON.stringify(name)} is shared with you: ${listed}; use the id of the one you mean`;
  return new HttpError(409, message, {
    code: "template_name_ambiguous",
    message,
    matches: matches.map((t) => ({ id: t.id, sharedBy: t.shared_by })),
  });
}

/** Shares a template has, as they are deleted with it (rule: deleting a template ends its shares). */
export async function endTemplateShares(client: Queryable, templateId: string): Promise<number> {
  const removed = await client.query(`DELETE FROM template_shares WHERE template_id = $1`, [templateId]);
  return removed.rowCount ?? 0;
}
