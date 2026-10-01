/**
 * src/account/template-ref.ts — resolve a template by id or name.
 *
 * Shared by `pipod templates` and `pipod jobs push`, so name lookup is the same
 * everywhere: id match first, then case-insensitive name, user scope winning.
 */
import type { AccountClient, ApiTemplate } from "./api.js";
import { PiPodError } from "../errors.js";

/** Servers that predate scoping omit the field; everything they hold is org-wide. */
export function scopeOf(t: Pick<ApiTemplate, "scope">): "user" | "org" {
  return t.scope ?? "org";
}

/** Templates are addressed by name in the CLI; uuids still work for scripts. */
export async function findTemplate(client: AccountClient, which: string | undefined): Promise<ApiTemplate> {
  if (!which) throw new PiPodError("which template?", { hint: "list them with `pipod templates`" });
  const { templates } = await client.listTemplates();
  // Your personal template may share a name with an org one; yours wins, like at launch.
  const named = templates.filter((t) => t.name.toLowerCase() === which.toLowerCase());
  const match =
    templates.find((t) => t.id === which) ??
    named.find((t) => scopeOf(t) === "user") ??
    named[0];
  if (!match) {
    throw new PiPodError(`no template named "${which}" in this org`, {
      hint: templates.length ? `have: ${templates.map((t) => t.name).join(", ")}` : "this org has no templates yet",
    });
  }
  return match;
}
