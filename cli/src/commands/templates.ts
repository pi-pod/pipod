/**
 * src/commands/templates.ts — `pipod templates` (§8.5).
 *
 * Templates default to personal (user-scoped): only their owner sees and launches them.
 * `templates share <name> --with <email>` lets one named member launch it too (and
 * `templates unshare` takes that back); `--org` at creation or `templates share <name>` makes
 * one org-wide, which cannot be undone. Org-wide and shared templates sit *below* each
 * member's own settings. They were previously only authorable in the app; this is the
 * same surface from the terminal, addressed by name rather than uuid.
 */
import * as fs from "node:fs";
import type { AccountClient, ApiTemplate, PiSettingsFilesBody } from "../account/api.js";
import { compileBundleSource, flatPiSettings, toOutgoingBundleConfig, type EnvSnapshot } from "../account/bundle-source.js";
import { requireAccountClient } from "../account/client.js";
import { assertOwnTemplate, findTemplate, ownerOf, scopeOf } from "../account/template-ref.js";
import { validateConfig } from "../config.js";
import { PiPodError } from "../errors.js";
import { parseJsonc } from "../jsonc.js";
import { info, out, warn } from "../log.js";
import { isProviderCredentialVar } from "../providers/registry.js";
import { confirm } from "../prompt.js";

export interface TemplatesFlags {
  home?: string | undefined;
  yes?: boolean;
  client?: AccountClient;
}

function requireClient(flags: TemplatesFlags): AccountClient {
  return flags.client ?? requireAccountClient({ home: flags.home });
}

export async function runTemplates(args: string[], flags: TemplatesFlags): Promise<number> {
  const yes = flags.yes || args.includes("-y") || args.includes("--yes");
  const [action = "list", ...rest] = args.filter((a) => a !== "-y" && a !== "--yes");
  const client = requireClient(flags);
  const effective: TemplatesFlags = { ...flags, yes };
  switch (action) {
    case "list":
      return listCmd(client);
    case "show":
      return showCmd(client, rest);
    case "create":
      return createCmd(client, rest, effective);
    case "edit":
      return editCmd(client, rest);
    case "rm":
    case "delete":
      return rmCmd(client, rest, effective);
    case "share":
      return shareCmd(client, rest);
    case "unshare":
      return unshareCmd(client, rest);
    default:
      throw new PiPodError(`unknown \`pipod templates\` action "${action}"`, {
        hint: "actions: list (default), show, create, edit, share, unshare, rm",
      });
  }
}


async function listCmd(client: AccountClient): Promise<number> {
  const { templates } = await client.listTemplates();
  if (templates.length === 0) {
    info("this org has no templates — pods start from the built-in defaults");
    return 0;
  }
  out(`${"NAME".padEnd(24)} ${"SCOPE".padEnd(6)} ${"KEYS".padEnd(5)} ${"SHARING".padEnd(28)} DESCRIPTION`);
  for (const t of templates) {
    const keys = String(Object.keys(t.config ?? {}).length);
    out(`${t.name.padEnd(24)} ${scopeOf(t).padEnd(6)} ${keys.padEnd(5)} ${sharing(t).padEnd(28)} ${t.description ?? ""}`);
  }
  return 0;
}

/** Who else a template reaches, in the list's words: "by <owner>" or "with <members>". */
function sharing(t: ApiTemplate): string {
  if (scopeOf(t) === "shared") return `by ${ownerOf(t)}`;
  if (scopeOf(t) === "org") return "everyone";
  return t.sharedWith?.length ? `with ${t.sharedWith.join(", ")}` : "-";
}

async function showCmd(client: AccountClient, args: string[]): Promise<number> {
  const t = await findTemplate(client, args[0]);
  info(`${t.name} (${t.id})`);
  const scope = scopeOf(t);
  if (scope === "shared") {
    info(`scope       shared with you by ${ownerOf(t)} (you can launch it; only they can change it)`);
  } else if (scope === "user") {
    info(`scope       user (${t.sharedWith?.length ? `you, and shared with ${t.sharedWith.join(", ")}` : "only you"})`);
  } else {
    info("scope       org");
  }
  if (t.description) info(`description ${t.description}`);
  if (t.createdFromPod) info(`created by  pod ${t.createdFromPod}`);
  info(`updated     ${t.updatedAt}`);
  out("");
  out(JSON.stringify(t.config ?? {}, null, 2));
  if (t.initScript) {
    out("");
    info("init script:");
    out(t.initScript);
  }
  if (t.bakeScript) {
    out("");
    info("bake script:");
    out(t.bakeScript);
  }
  if (t.agentInstructions) {
    out("");
    info("agent instructions:");
    out(t.agentInstructions);
  }
  if (t.piSettings && Object.keys(t.piSettings).length > 0) {
    info(`Pi settings ${describePiSettings(flatPiSettings(t.piSettings))}`);
  }
  const secrets = await client.listSecrets("template", t.id).catch(() => null);
  if (secrets && secrets.secrets.length > 0) {
    out("");
    info(`template secrets: ${secrets.secrets.map((s) => s.name).join(", ")}`);
  }
  return 0;
}

interface TemplateOpts {
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  initScript?: string;
  bakeScript?: string;
  agentInstructions?: string;
  fromHere?: boolean;
  withSecrets?: boolean;
  org?: boolean;
}

function describePiSettings(settings: PiSettingsFilesBody): string {
  const names = Object.keys(settings);
  const packages = settings.settings?.["packages"];
  const packageCount = Array.isArray(packages) ? packages.length : 0;
  return `${names.join(", ") || "empty"}${packageCount > 0 ? ` (${packageCount} package(s))` : ""}`;
}

export async function writeTemplateSnapshot(write: () => Promise<ApiTemplate>): Promise<ApiTemplate> {
  try {
    return await write();
  } catch (error) {
    if (
      error instanceof PiPodError &&
      error.status === 400 &&
      /(?:unrecognized|unknown|unexpected)[^\n]*piSettings|piSettings[^\n]*(?:unrecognized|unknown|unexpected)/i.test(error.message)
    ) {
      throw new PiPodError("the pi pod server does not support template-owned Pi settings", {
        hint: "deploy the matching pi pod server before pushing Pi files with `pipod push`",
        cause: error,
        status: error.status,
      });
    }
    throw error;
  }
}

/**
 * Config comes from a file rather than flags: it is the same shape as `.pi-pod/config.json`,
 * and validating it here means a bad template is rejected before it becomes everyone's
 * starting point.
 */
function parseOpts(args: string[]): { rest: string[]; opts: TemplateOpts } {
  const opts: TemplateOpts = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => {
      const v = args[++i];
      if (v === undefined) throw new PiPodError(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--name":
        opts.name = next();
        break;
      case "--description":
        opts.description = next();
        break;
      case "--config": {
        const file = next();
        if (!fs.existsSync(file)) throw new PiPodError(`no such config file: ${file}`);
        const parsed = parseJsonc(fs.readFileSync(file, "utf8"), file) as Record<string, unknown>;
        const report = validateConfig(parsed);
        for (const problem of report.errors) throw new PiPodError(`${file}: ${problem}`);
        for (const problem of report.warnings) warn(`${file}: ${problem}`);
        // The bundle boundary drops every local pin, retired key, and UI/preference key.
        opts.config = toOutgoingBundleConfig(parsed);
        break;
      }
      case "--from-here":
        opts.fromHere = true;
        break;
      case "--org":
        opts.org = true;
        break;
      case "--with-secrets":
        opts.withSecrets = true;
        break;
      case "--init-script": {
        const file = next();
        if (!fs.existsSync(file)) throw new PiPodError(`no such init script: ${file}`);
        opts.initScript = fs.readFileSync(file, "utf8");
        break;
      }
      case "--bake-script": {
        const file = next();
        if (!fs.existsSync(file)) throw new PiPodError(`no such bake script: ${file}`);
        opts.bakeScript = fs.readFileSync(file, "utf8");
        break;
      }
      case "--agent-instructions": {
        const file = next();
        if (!fs.existsSync(file)) throw new PiPodError(`no such agent instructions file: ${file}`);
        opts.agentInstructions = fs.readFileSync(file, "utf8");
        break;
      }
      default:
        rest.push(arg);
    }
  }
  return { rest, opts };
}

async function createCmd(client: AccountClient, args: string[], flags: TemplatesFlags): Promise<number> {
  const { rest, opts } = parseOpts(args);
  const name = opts.name ?? rest[0];
  if (!name) {
    throw new PiPodError("usage: pipod templates create <name> [--config <file> | --from-here] [--org] [--description <text>]", {
      hint: "--config takes the same shape as .pi-pod/config.json; --from-here stores only this project's authored config, scripts, and sanitized Pi files; templates are personal unless --org",
    });
  }
  if (opts.fromHere && opts.config) {
    throw new PiPodError("--from-here and --config contradict each other", {
      hint: "--from-here compiles the project source; --config names one explicitly — drop one of the two",
    });
  }
  requireFromHereForSecrets(opts);
  let config = opts.config ?? {};
  let initScript = opts.initScript;
  let bakeScript = opts.bakeScript;
  let env: EnvSnapshot = {};
  let piSettings: PiSettingsFilesBody | undefined;
  if (opts.fromHere) {
    // Fail before reading every source file so a name clash stays cheap and actionable.
    const { templates } = await client.listTemplates();
    const targetScope = opts.org ? "org" : "user";
    const existing = templates.find(
      (t) => t.name.toLowerCase() === name.toLowerCase() && scopeOf(t) === targetScope,
    );
    if (existing) {
      throw new PiPodError(
        targetScope === "org"
          ? `a template named "${existing.name}" already exists in this org`
          : `you already have a template named "${existing.name}"`,
        { hint: `refresh it from this directory instead: pipod push template ${existing.name}` },
      );
    }
    const snapshot = await snapshotFromHere(client, flags);
    config = snapshot.config;
    env = snapshot.env;
    piSettings = snapshot.piSettings;
    if (initScript === undefined) initScript = snapshot.initScript;
    if (bakeScript === undefined) bakeScript = snapshot.bakeScript;
  }
  const create = () => client.createTemplate({
    name,
    config,
    // Omitted for personal templates: the server defaults to user scope, and older
    // servers without scoping would reject the unknown key.
    ...(opts.org ? { scope: "org" as const } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(initScript ? { initScript } : {}),
    ...(bakeScript ? { bakeScript } : {}),
    ...(opts.agentInstructions ? { agentInstructions: opts.agentInstructions } : {}),
    // An explicit refresh is replacement, not merge: an empty project file set clears stale custody.
    ...(opts.fromHere ? { piSettings: piSettings ?? {} } : {}),
  });
  const created = opts.fromHere ? await writeTemplateSnapshot(create) : await create();
  info(`created template ${created.name} (${created.id})`);
  if (scopeOf(created) === "user") {
    info(
      `it is personal — only you see it; share it with one person with \`pipod templates share ${created.name} --with <email>\`, ` +
        `or org-wide with \`pipod templates share ${created.name}\``,
    );
  }
  if (opts.fromHere) {
    info(snapshotSummary(piSettings));
    await syncEnvSecrets(client, created, env, { withSecrets: opts.withSecrets ?? false, reportStale: false });
  }
  await hintMissingCredentials(client);
  return 0;
}

/**
 * Templates never carry model-provider credentials, so a fresh template can still launch
 * pods with nothing to talk to. The nudge is best-effort: never fail a written template over it.
 */
async function hintMissingCredentials(client: AccountClient): Promise<void> {
  let result;
  try {
    result = await client.modelCredentials();
  } catch {
    return;
  }
  if (result.credentials.some((c) => c.state === "ready")) return;
  info("you have no model-provider credential yet — `pipod credentials connect` sets them up");
}

function requireFromHereForSecrets(opts: TemplateOpts): void {
  if (opts.withSecrets && !opts.fromHere) {
    throw new PiPodError("--with-secrets only makes sense with --from-here", {
      hint: "it uploads env values from the compiled project source; without --from-here there is nothing to upload",
    });
  }
}

function snapshotSummary(piSettings: PiSettingsFilesBody | undefined): string {
  return (
    "the snapshot stores this project's authored config, scripts, and sanitized Pi files verbatim " +
    `(${describePiSettings(piSettings ?? {})})`
  );
}

/** Compile only the project-authored source layer; persistent layers are never pre-merged. */
async function snapshotFromHere(
  _client: AccountClient,
  flags: TemplatesFlags,
): Promise<{
  config: Record<string, unknown>;
  env: EnvSnapshot;
  piSettings: PiSettingsFilesBody;
  initScript: string;
  bakeScript: string;
}> {
  const source = await compileBundleSource({ source: "project", home: flags.home });
  for (const warning of source.warnings) warn(warning);
  return {
    config: source.config,
    env: source.env,
    piSettings: source.piFiles,
    initScript: source.initScript,
    bakeScript: source.bakeScript,
  };
}

/** Whose pods a template's secrets reach. */
function reach(template: { scope?: "user" | "org" | "shared"; sharedWith?: string[] }): string {
  if (scopeOf(template) === "org") return "every org member's pod launched from it";
  if (template.sharedWith?.length) return `every pod you or ${template.sharedWith.join(", ")} launch from it`;
  return "every pod you launch from it";
}

/**
 * Uploading project env values is a new act, not a detail of compiling the source, so it
 * needs its own signal: --with-secrets, or a yes at this prompt. -y is
 * deliberately not honored here — it confirms the action the user asked for, not this one.
 */
export async function syncEnvSecrets(
  client: AccountClient,
  template: { id: string; name: string; scope?: "user" | "org" | "shared"; sharedWith?: string[] },
  env: EnvSnapshot,
  opts: { withSecrets: boolean; reportStale: boolean },
): Promise<void> {
  const names = Object.keys(env).filter((n) => {
    if (isProviderCredentialVar(n)) {
      warn(`${n} is a provider credential and never travels in a template — the org key upload owns those`);
      return false;
    }
    return true;
  });
  if (names.length === 0) return;
  const labeled = names.map((n) => `${n} [${env[n]!.source}]`).join(", ");
  const consented =
    opts.withSecrets ||
    (await confirm(
      `upload ${names.length} env value(s) as secrets on template ${template.name} ` +
        `(${labeled})? they reach ${reach(template)}`,
      { nonInteractiveDefault: false },
    ));
  if (!consented) {
    warn(
      `the push did not store these project env values in template custody: ${names.join(", ")} — ` +
        `they remain local source only; use --with-secrets or \`pipod secrets set template/${template.name} <NAME>\` to apply them`,
    );
    return;
  }
  const uploaded: string[] = [];
  for (const name of names) {
    try {
      await client.putSecret("template", template.id, name, env[name]!.value);
      uploaded.push(name);
    } catch (e) {
      const remaining = names.filter((n) => !uploaded.includes(n));
      throw new PiPodError(
        `uploaded ${uploaded.length} of ${names.length} template secrets; ${remaining.join(", ")} did not make it: ` +
          (e instanceof Error ? e.message : String(e)),
        { hint: `the template itself is fine — finish with pipod push template ${template.name} --with-secrets` },
      );
    }
  }
  info(
    `uploaded ${uploaded.length} template secret(s): ${uploaded.join(", ")} — ` +
      `values are encrypted server-side; the names show${scopeOf(template) === "user" ? "" : " org-wide"} in templates show`,
  );
  if (opts.reportStale) {
    const listed = await client.listSecrets("template", template.id).catch(() => null);
    const stale = listed ? listed.secrets.map((s) => s.name).filter((n) => !(n in env)) : [];
    if (stale.length > 0) {
      warn(
        `template secrets no longer in your local env files: ${stale.join(", ")} — ` +
          `remove each with \`pipod secrets rm template/${template.name} <NAME>\` if nothing needs them`,
      );
    }
  }
}

async function editCmd(client: AccountClient, args: string[]): Promise<number> {
  const { rest, opts } = parseOpts(args);
  // Whole-bundle replacement from the project source is `pipod push`, not an edit.
  if (opts.fromHere || opts.withSecrets) {
    const flag = opts.fromHere ? "--from-here" : "--with-secrets";
    throw new PiPodError(`${flag} is not an edit option; run \`pipod push template <name>\``, {
      hint: "push replaces the whole bundle with this project's source, after a diff preview",
    });
  }
  if (opts.org) {
    throw new PiPodError("--org is not an edit option; make a template org-wide with `pipod templates share <name>`", {
      hint: "templates are personal unless created with --org or shared",
    });
  }
  const t = await findTemplate(client, rest[0]);
  assertOwnTemplate(t, "change it");
  if (
    opts.name === undefined &&
    opts.description === undefined &&
    !opts.config &&
    opts.initScript === undefined &&
    opts.bakeScript === undefined &&
    opts.agentInstructions === undefined
  ) {
    throw new PiPodError("nothing to change", {
      hint: "pass --name, --description, --config <file>, --init-script <file>, --bake-script <file> or --agent-instructions <file>",
    });
  }
  const updated = await client.updateTemplate(t.id, {
    // Compare-and-swap against the version just read, like user/org settings writes;
    // servers without template versions get the plain replace they always did.
    ...(t.version !== undefined ? { expectedVersion: t.version } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.initScript !== undefined ? { initScript: opts.initScript } : {}),
    ...(opts.bakeScript !== undefined ? { bakeScript: opts.bakeScript } : {}),
    ...(opts.agentInstructions !== undefined ? { agentInstructions: opts.agentInstructions } : {}),
  });
  info(`updated template ${updated.name}`);
  await hintMissingCredentials(client);
  return 0;
}

/**
 * `share <name|id> --with <email>` lets one member launch the template; `share <name|id>` alone
 * hands it to the whole org, which cannot be undone. The two differ by one option, so anything
 * that is not exactly one of them is refused before the server is asked: `--with` without a
 * usable email, a second `--with`, a stray word (an email without `--with`), any other option.
 */
function parseShareArgs(
  action: "share" | "unshare",
  args: readonly string[],
): { ref: string; with: string | undefined } {
  const usage = `usage: pipod templates ${action} <name|id> ${action === "share" ? "[--with <email>]" : "--with <email>"}`;
  let ref: string | undefined;
  let member: string | undefined;
  let withSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--with" || arg.startsWith("--with=")) {
      if (withSeen) {
        throw new PiPodError("--with names one person; nothing was shared — share with each person separately", { hint: usage });
      }
      withSeen = true;
      const value = arg === "--with" ? args[++i] : arg.slice("--with=".length);
      if (value === undefined || value.startsWith("-")) {
        throw new PiPodError("--with needs the email of the person to share with; nothing was shared", { hint: usage });
      }
      member = value.trim();
      if (!EMAIL.test(member)) {
        throw new PiPodError(
          member ? `--with ${JSON.stringify(member)} is not an email address; nothing was shared` : "--with is empty; nothing was shared",
          { hint: usage },
        );
      }
    } else if (arg.startsWith("-")) {
      throw new PiPodError(`unknown option ${arg} for \`pipod templates ${action}\`; nothing was shared`, { hint: usage });
    } else if (ref === undefined) {
      ref = arg;
    } else {
      throw new PiPodError(`unexpected argument ${JSON.stringify(arg)}; nothing was shared`, {
        hint: arg.includes("@") ? `to share with one person: pipod templates ${action} ${ref} --with ${arg}` : usage,
      });
    }
  }
  if (!ref) throw new PiPodError("which template?", { hint: usage });
  if (action === "unshare" && !withSeen) {
    throw new PiPodError("unshare needs --with <email>: it stops sharing with one person", {
      hint: `${usage}\nan org-wide template cannot be made personal again`,
    });
  }
  return { ref, with: member };
}

/** Enough to tell an email from a typo or a template name; the server checks it again. */
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]+$/;

async function shareCmd(client: AccountClient, args: string[]): Promise<number> {
  const parsed = parseShareArgs("share", args);
  const t = await findTemplate(client, parsed.ref);
  assertOwnTemplate(t, "share it");
  if (parsed.with !== undefined) return shareWithMember(client, t, parsed.with);
  if (scopeOf(t) === "org") {
    info(`${t.name} is already org-wide`);
    return 0;
  }
  const updated = await shareWithOrg(client, t);
  info(`shared ${updated.name} with the org — every member can now see and launch from it`);
  return 0;
}

/** One-way: org templates cannot go private again, so the request says it means the whole org. */
async function shareWithOrg(client: AccountClient, t: ApiTemplate): Promise<ApiTemplate> {
  try {
    return await client.updateTemplate(t.id, { scope: "org", orgWide: true });
  } catch (error) {
    // A server from before named shares rejects the confirmation field it does not know. It has
    // no other kind of share, so the plain request means exactly what was asked for.
    if (error instanceof PiPodError && error.status === 400 && /validation failed/i.test(error.message)) {
      return client.updateTemplate(t.id, { scope: "org" });
    }
    throw error;
  }
}

async function shareWithMember(client: AccountClient, t: ApiTemplate, email: string): Promise<number> {
  if (scopeOf(t) === "org") {
    info(`${t.name} is org-wide: every member, ${email} included, can already launch it`);
    return 0;
  }
  const shared = await withShareRoute(() => client.shareTemplate(t.id, email));
  if (!shared.created) {
    info(`${shared.name} is already shared with ${shared.sharedWith}`);
    return 0;
  }
  info(
    `shared ${shared.name} with ${shared.sharedWith} — they can launch from it and read it (secret names, never values); ` +
      "only you can change it, its secrets or who it is shared with",
  );
  info(`take it back with \`pipod templates unshare ${shared.name} --with ${shared.sharedWith}\``);
  return 0;
}

async function unshareCmd(client: AccountClient, args: string[]): Promise<number> {
  const parsed = parseShareArgs("unshare", args);
  const t = await findTemplate(client, parsed.ref);
  assertOwnTemplate(t, "change who it is shared with");
  if (scopeOf(t) === "org") {
    throw new PiPodError(`${t.name} is org-wide, and an org-wide template cannot be made personal again`);
  }
  const email = parsed.with!;
  const result = await withShareRoute(() => client.unshareTemplate(t.id, email));
  info(
    result.removed
      ? `stopped sharing ${result.name} with ${email}: they cannot launch from it any more, and nor can their pods' forks, child pods, co-located pods or jobs`
      : `${result.name} was not shared with ${email}`,
  );
  const paused = result.jobsPaused ?? 0;
  if (paused > 0) {
    const jobs = paused === 1 ? "their scheduled job" : `their ${paused} scheduled jobs`;
    info(`paused ${jobs} from ${result.name}: ${paused === 1 ? "it" : "they"} cannot run without the template`);
  }
  const { total, running } = result.pods;
  if (total > 0) {
    info(
      `${email} still has ${total} pod${total === 1 ? "" : "s"} from ${result.name} (${running} running). ` +
        "They stay theirs and keep the template's secrets they were launched with; " +
        `ending that access means stopping ${total === 1 ? "it" : "them"} and rotating ${result.name}'s secrets`,
    );
  } else {
    info(`${email} has no pods from ${result.name}`);
  }
  return 0;
}

/** A server from before named shares has no share route at all. */
async function withShareRoute<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PiPodError && error.status === 404 && /^Route /.test(error.message)) {
      throw new PiPodError("this pi pod server cannot share a template with one person", {
        hint: "it needs a newer pi pod server; nothing was shared",
        cause: error,
      });
    }
    throw error;
  }
}

async function rmCmd(client: AccountClient, args: string[], flags: TemplatesFlags): Promise<number> {
  const t = await findTemplate(client, args[0]);
  assertOwnTemplate(t, "delete it");
  const shares = t.sharedWith?.length ? ` (it is shared with ${t.sharedWith.join(", ")}; they lose it too)` : "";
  const ok = await confirm(
    scopeOf(t) === "user" ? `delete your template ${t.name}${shares}?` : `delete template ${t.name} for the whole org?`,
    {
      nonInteractiveDefault: false,
      assumeYes: flags.yes === true,
    },
  );
  if (!ok) {
    info("left it alone");
    return 1;
  }
  await client.deleteTemplate(t.id);
  info(`deleted template ${t.name}`);
  return 0;
}
