/**
 * src/account/template-ref.ts — resolve a template by id or name.
 *
 * Every command that takes a template (launch, `pipod templates`, `pipod secrets`, `pipod jobs
 * push`) resolves it here, so a name means the same template everywhere: an id always works; a
 * name gives your own template first, then the organization's, then one another member shared
 * with you. A shared template never takes a name from one you could already launch, since your
 * pods would run its scripts with your secrets and credentials.
 */
import type { AccountClient, ApiTemplate } from "./api.js";
import { PiPodError } from "../errors.js";

/** Servers that predate scoping omit the field; everything they hold is org-wide. */
export function scopeOf(t: Pick<ApiTemplate, "scope">): "user" | "org" | "shared" {
  return t.scope ?? "org";
}

/** Who a template belongs to, in a few words: "you", "the organization" or its owner's email. */
export function ownerOf(t: Pick<ApiTemplate, "scope" | "sharedBy">): string {
  const scope = scopeOf(t);
  if (scope === "user") return "you";
  if (scope === "org") return "the organization";
  return t.sharedBy ?? "another member";
}

const PRECEDENCE = { user: 0, org: 1, shared: 2 } as const;

/**
 * The template `ref` names among `templates`, or undefined when none does. Several templates
 * shared with you under the same name, with none of your own or the organization's, are
 * ambiguous: that is refused, listing each with its owner and id, because the id is what tells
 * them apart.
 */
export function matchTemplate(templates: readonly ApiTemplate[], ref: string): ApiTemplate | undefined {
  const byId = templates.find((t) => t.id === ref.toLowerCase());
  if (byId) return byId;
  const named = templates
    .filter((t) => t.name.toLowerCase() === ref.toLowerCase())
    .sort((a, b) => PRECEDENCE[scopeOf(a)] - PRECEDENCE[scopeOf(b)]);
  const [first, second] = named;
  if (first && second && scopeOf(first) === "shared") {
    throw new PiPodError(`more than one template named "${ref}" is shared with you`, {
      hint:
        named.map((t) => `${t.name} shared by ${ownerOf(t)}: ${t.id}`).join("\n") +
        "\nname the one you mean by its id",
    });
  }
  return first;
}

/** Templates are addressed by name in the CLI; uuids still work for scripts. */
export async function findTemplate(client: AccountClient, which: string | undefined): Promise<ApiTemplate> {
  if (!which) throw new PiPodError("which template?", { hint: "list them with `pipod templates`" });
  const { templates } = await client.listTemplates();
  const match = matchTemplate(templates, which);
  if (!match) {
    throw new PiPodError(`no template named "${which}" in this org`, {
      hint: templates.length ? `have: ${templates.map((t) => t.name).join(", ")}` : "this org has no templates yet",
    });
  }
  return match;
}

/**
 * Refuse, before asking the server, a change to a template another member shared with you: only
 * they change it, its secrets or who it is shared with. The server refuses it as well.
 */
export function assertOwnTemplate(t: ApiTemplate, what: string): void {
  if (scopeOf(t) !== "shared") return;
  throw new PiPodError(`${t.name} is shared with you by ${ownerOf(t)}; only they can ${what}`, {
    hint: "you can launch it and read it with `pipod templates show`",
  });
}
