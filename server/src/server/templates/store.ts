import { validateConfig } from "../../core/config.js";
import { mergeConfigLayers } from "../../core/userconfig.js";
import { query } from "../db/index.js";
import { badRequest, notFound } from "../httperrors.js";
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

/** A template is visible to `userId` when it is org-wide or their own (spec §6). */
export async function getTemplate(orgId: string, id: string, userId: string): Promise<TemplateRow> {
  const row = await findTemplate(orgId, id, userId);
  if (!row) throw notFound("template not found");
  return row;
}

/** Like getTemplate, but null when the template is not visible or has been deleted. */
export async function findTemplate(orgId: string, id: string, userId: string): Promise<TemplateRow | null> {
  const rows = await query<TemplateRow>(
    `SELECT * FROM pod_templates
     WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
       AND (owner_user_id IS NULL OR owner_user_id = $3)`,
    [id, orgId, userId],
  );
  const row = rows.rows[0];
  return row ? { ...row, pi_settings: flattenTemplatePiSettings(row.pi_settings) } : null;
}
