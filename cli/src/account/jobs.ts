/**
 * src/account/jobs.ts — `pipod jobs`, account edition only.
 *
 * Jobs are scheduled prompts the server runs for you: at each cron tick or specified time it
 * launches a pod from the job's template, starts a session with the job's model, and sends the prompt.
 * They live on the server because the schedule needs something always-on to fire it — the
 * laptop CLI manages them but never executes them. Local files in `.pi-pod/jobs/` are the
 * reviewable source; `jobs push` promotes them to the server.
 */
import * as path from "node:path";
import { findTemplate } from "./template-ref.js";
import type { AccountClient, ApiJob, ApiJobTrigger, ApiTemplate } from "./api.js";
import { PiPodError } from "../errors.js";
import {
  loadLocalJob,
  loadLocalJobs,
  projectJobsDirForWrite,
  triggersEqual,
  writeLocalJob,
  type JobTrigger,
  type LocalJobSpec,
} from "../jobfiles.js";
import { color, info, out, warn } from "../log.js";
import { confirm } from "../prompt.js";
import { displayRef, matchesRef } from "./ref.js";

export interface AccountJobFlags {
  quiet: boolean;
  yes: boolean;
  project?: boolean;
  /** Create org jobs or promote matching user jobs during push. */
  org?: boolean;
  home?: string;
  cwd?: string;
}

export async function runAccountJobs(
  client: AccountClient,
  args: string[],
  flags: AccountJobFlags,
): Promise<number> {
  const action = args[0] ?? "list";
  if (flags.org && action !== "push") {
    throw new PiPodError("--org is only supported by `pipod jobs push`");
  }
  switch (action) {
    case "list":
      assertArgCount(args, args.length === 0 ? 0 : 1, "pipod jobs [list]");
      return listJobs(client, flags);
    case "show":
      assertArgCount(args, 2, "pipod jobs show <job>");
      return showJob(client, await selectJob(client, args[1]!, action));
    case "runs":
      assertArgCount(args, 2, "pipod jobs runs <job>");
      return listRuns(client, await selectJob(client, args[1]!, action));
    case "activate":
    case "pause":
    case "resume": {
      assertArgCount(args, 2, `pipod jobs ${action} <job>`);
      const job = await selectJob(client, args[1]!, action);
      const { status } = await client.jobCommand(job.id, action);
      info(`job ${job.name}: ${status}`);
      return 0;
    }
    case "rm": {
      assertArgCount(args, 2, "pipod jobs rm <job>");
      const job = await selectJob(client, args[1]!, action);
      const ok = await confirm(`remove job "${job.name}"? Its schedule stops firing.`, {
        nonInteractiveDefault: false,
        assumeYes: flags.yes,
      });
      if (!ok) return 1;
      await client.deleteJob(job.id);
      info(`job ${job.name} removed`);
      return 0;
    }
    case "push":
      return pushJobs(client, args.slice(1), flags);
    case "pull":
      if (args.length !== 2) throw new PiPodError("usage: pipod jobs pull <job> [--project]");
      return pullJob(client, args[1]!, flags);
    case "diff":
      return diffJobs(client, args.slice(1), flags);
    default:
      throw new PiPodError(`unknown jobs action "${action}"`, {
        hint: "one of: list, show, runs, activate, pause, resume, rm, push, pull, diff — see `pipod jobs --help`",
      });
  }
}

async function listJobs(client: AccountClient, flags: AccountJobFlags): Promise<number> {
  const jobs = await allJobs(client);
  if (flags.quiet) {
    for (const job of jobs) out(job.id);
    return 0;
  }
  if (jobs.length === 0) {
    info("no jobs — add one in .pi-pod/jobs/ and `pipod jobs push`, or ask the agent inside a pod");
    return 0;
  }
  info(`jobs on ${client.serverUrl}:`);
  for (const job of jobs) {
    const next = job.status === "active" && job.nextRunAt ? `next ${ago(job.nextRunAt) || job.nextRunAt}` : "";
    info(
      `  ${color.bold(pad(displayRef(job.id, "job"), 12))}  ${pad(job.name, 24)}  ${pad(job.scope ?? "user", 5)}  ${pad(job.status, 9)}  ${pad(shortSchedule(job.trigger), 24)}  ${next}`,
    );
  }
  return 0;
}

async function showJob(client: AccountClient, job: ApiJob): Promise<number> {
  info(`${color.bold(job.name)} (${job.id})`);
  if (job.description) info(`  ${job.description}`);
  // Old servers may still return "draft"; render it as-is and let `activate` handle it.
  info(`  scope:     ${job.scope ?? "user"}`);
  info(`  status:    ${job.status}`);
  if (job.trigger.type === "cron") {
    info(`  schedule:  cron "${job.trigger.cron}" (UTC)`);
  } else {
    info(`  schedule:  ${job.trigger.times.length === 1 ? "once" : `${job.trigger.times.length} times`} (absolute times)`);
    for (const time of job.trigger.times) info(`               ${time}`);
  }
  info(`  template:  ${job.templateId ? await templateName(client, job.templateId) : "default"}`);
  info(`  model:     ${job.model}`);
  info(`  next run:  ${job.nextRunAt ?? "—"}`);
  info(`  last run:  ${job.lastRunAt ?? "never"}`);
  info(`  prompt:`);
  for (const line of job.prompt.split("\n")) info(`    ${line}`);
  return 0;
}

async function listRuns(client: AccountClient, job: ApiJob): Promise<number> {
  const { runs } = await client.jobRuns(job.id);
  if (runs.length === 0) {
    info(`no runs yet for ${job.name}`);
    return 0;
  }
  info(`runs of ${job.name}:`);
  for (const run of runs) {
    const pod = run.podId ? `pod ${displayRef(run.podId, "pod")}` : "";
    const error = run.error ? ` — ${run.error}` : "";
    info(`  ${pad(ago(run.startedAt) || run.startedAt, 12)}  ${pad(run.status, 10)}  ${pod}${error}`);
  }
  return 0;
}

interface JobPlan {
  local: LocalJobSpec;
  server: ApiJob | undefined;
  templateId: string | null;
  templateLabel: string;
  changes: FieldChange[];
  staleServer: boolean;
  desiredScope: "user" | "org";
}

interface FieldChange {
  field: string;
  summary: string;
  patch?: Record<string, unknown>;
}

async function selectLocals(names: string[], flags: AccountJobFlags): Promise<LocalJobSpec[]> {
  const opts = { cwd: flags.cwd, home: flags.home };
  if (names.length === 0) return loadLocalJobs(opts);
  return names.map((name) => loadLocalJob(name, opts));
}

async function planJobs(client: AccountClient, locals: LocalJobSpec[], promoteToOrg: boolean): Promise<JobPlan[]> {
  const serverJobs = await allJobs(client);
  const byName = new Map(serverJobs.map((job) => [job.name, job]));
  const templates = await client.listTemplates().catch(() => ({ templates: [] as ApiTemplate[] }));
  const plans: JobPlan[] = [];
  for (const local of locals) {
    const templateId = local.template ? (await findTemplate(client, local.template)).id : null;
    const server = byName.get(local.name);
    const templateLabel = templateDisplay(templateId, templates.templates);
    const desiredScope: "user" | "org" = promoteToOrg ? "org" : (server?.scope ?? "user");
    const changes = server
      ? diffFields(local, server, templateId, templates.templates, desiredScope)
      : [{ field: "(new)", summary: `create as ${desiredScope}-scoped on the server`, patch: undefined }];
    const staleServer = Boolean(
      server && local.mtimeMs > 0 && Date.parse(server.updatedAt) > local.mtimeMs,
    );
    plans.push({ local, server, templateId, templateLabel, changes, staleServer, desiredScope });
  }
  return plans;
}

function templateDisplay(id: string | null, templates: ApiTemplate[]): string {
  if (!id) return "default";
  return templates.find((t) => t.id === id)?.name ?? id;
}

function diffFields(
  local: LocalJobSpec,
  server: ApiJob,
  templateId: string | null,
  templates: ApiTemplate[],
  desiredScope: "user" | "org",
): FieldChange[] {
  const changes: FieldChange[] = [];
  if ((server.scope ?? "user") !== desiredScope) {
    changes.push({
      field: "scope",
      summary: `${server.scope ?? "user"} → ${desiredScope} (one-way promotion; the user layer will no longer apply)`,
      patch: { scope: desiredScope },
    });
  }
  const localDescription = local.description ?? null;
  if ((localDescription ?? "") !== (server.description ?? "")) {
    changes.push({
      field: "description",
      summary: `${fmt(server.description)} → ${fmt(localDescription)}`,
      patch: { description: local.description ?? "" },
    });
  }
  if (!triggersEqual(local.trigger, server.trigger)) {
    changes.push({
      field: "trigger",
      summary: `${shortSchedule(server.trigger)} → ${shortSchedule(local.trigger)}`,
      patch: { trigger: local.trigger },
    });
  }
  if ((server.templateId ?? null) !== templateId) {
    changes.push({
      field: "template",
      summary: `${templateDisplay(server.templateId, templates)} → ${templateDisplay(templateId, templates)}`,
      patch: { templateId },
    });
  }
  if (local.model !== server.model) {
    changes.push({
      field: "model",
      summary: `${server.model} → ${local.model}`,
      patch: { model: local.model },
    });
  }
  if (local.prompt !== server.prompt) {
    changes.push({
      field: "prompt",
      summary: unifiedTextDiff(server.prompt, local.prompt),
      patch: { prompt: local.prompt },
    });
  }
  return changes;
}

function fmt(value: string | null | undefined): string {
  return value ? JSON.stringify(value) : "(none)";
}

function printPlan(plan: JobPlan): void {
  const layer = plan.local.layer === "project" ? "project .pi-pod/jobs/" : "~/.pi-pod/jobs/";
  const dest = plan.server ? `server ${displayRef(plan.server.id, "job")} (${plan.server.status})` : "new on the server";
  info(`${color.bold(plan.local.name)}  ${color.dim(`${layer} → ${dest}`)}`);
  // A run moves the server's timestamp too; it matters only when the specs differ.
  if (plan.staleServer && plan.server && plan.changes.length > 0) {
    warn(
      `server copy of "${plan.local.name}" was updated more recently than the local file (server ${plan.server.updatedAt})`,
    );
  }
  if (plan.changes.length === 0) {
    info("  in sync");
    return;
  }
  for (const change of plan.changes) {
    if (change.field === "prompt") {
      info("  prompt:");
      for (const line of change.summary.split("\n")) info(`    ${line}`);
    } else {
      info(`  ${change.field}: ${change.summary}`);
    }
  }
}

function printUnmanaged(serverJobs: ApiJob[], locals: LocalJobSpec[]): void {
  const localNames = new Set(locals.map((job) => job.name));
  const unmanaged = serverJobs.filter((job) => !localNames.has(job.name));
  if (unmanaged.length === 0) return;
  info("server-only (unmanaged) — `jobs pull` to adopt, `jobs rm` to archive:");
  for (const job of unmanaged) {
    info(`  ${job.name}  ${job.scope ?? "user"}  ${job.status}  ${shortSchedule(job.trigger)}`);
  }
}

async function pushJobs(client: AccountClient, names: string[], flags: AccountJobFlags): Promise<number> {
  const locals = await selectLocals(names, flags);
  if (locals.length === 0) {
    info("no local job files — nothing to push");
    printUnmanaged(await allJobs(client), locals);
    return 0;
  }
  const plans = await planJobs(client, locals, flags.org === true);
  for (const plan of plans) printPlan(plan);
  printUnmanaged(await allJobs(client), names.length === 0 ? locals : await loadLocalJobs({ cwd: flags.cwd, home: flags.home }));

  const dirty = plans.filter((plan) => plan.changes.length > 0);
  if (dirty.length === 0) {
    info("everything named is in sync");
    return 0;
  }
  const ok = await confirm(`push ${dirty.length} job(s)? New jobs become active immediately.`, {
    nonInteractiveDefault: false,
    assumeYes: flags.yes,
  });
  if (!ok) return 1;

  for (const plan of dirty) {
    if (!plan.server) {
      const created = await client.createJob({
        name: plan.local.name,
        ...(plan.local.description !== undefined ? { description: plan.local.description } : {}),
        trigger: plan.local.trigger,
        templateId: plan.templateId,
        model: plan.local.model,
        prompt: plan.local.prompt,
        ...(plan.desiredScope === "org" ? { scope: "org" as const } : {}),
      });
      info(
        `created ${created.name} (${created.status})  next run ${created.nextRunAt ?? "—"}`,
      );
      continue;
    }
    const patch: Record<string, unknown> = {};
    for (const change of plan.changes) Object.assign(patch, change.patch ?? {});
    const updated = await client.patchJob(plan.server.id, patch);
    if (updated.status === "paused") {
      info(`updated ${updated.name} — still paused (status is not changed by push)`);
    } else {
      info(`updated ${updated.name} (${updated.status})`);
    }
  }
  return 0;
}

async function diffJobs(client: AccountClient, names: string[], flags: AccountJobFlags): Promise<number> {
  const locals = await selectLocals(names, flags);
  if (locals.length === 0) {
    info("no local job files");
    printUnmanaged(await allJobs(client), locals);
    return 0;
  }
  const plans = await planJobs(client, locals, false);
  let drifted = false;
  for (const plan of plans) {
    printPlan(plan);
    if (plan.changes.length > 0) drifted = true;
  }
  printUnmanaged(
    await allJobs(client),
    names.length === 0 ? locals : await loadLocalJobs({ cwd: flags.cwd, home: flags.home }),
  );
  return drifted ? 1 : 0;
}

/** A template's name, or its id when it cannot be found (deleted, or not visible to you). */
async function templateName(client: AccountClient, id: string): Promise<string> {
  try {
    return (await findTemplate(client, id)).name;
  } catch {
    return id;
  }
}

async function pullJob(client: AccountClient, ref: string, flags: AccountJobFlags): Promise<number> {
  const job = await selectJob(client, ref, "pull");
  const template = job.templateId ? await templateName(client, job.templateId) : null;
  const written = writeLocalJob(
    {
      name: job.name,
      description: job.description,
      trigger: job.trigger,
      template,
      model: job.model,
      prompt: job.prompt,
    },
    {
      cwd: flags.cwd,
      home: flags.home,
      project: flags.project,
      overwrite: flags.yes,
    },
  );
  const dest = flags.project ? projectJobsDirForWrite(flags.cwd ?? process.cwd(), flags.home) : path.dirname(written.jsonPath);
  info(`wrote ${path.relative(dest, written.jsonPath) || written.jsonPath} and ${path.basename(written.promptPath)}`);
  return 0;
}

/** Full id, short ref, legacy prefix, or name. Exact UUIDs avoid a paginated list. */
async function selectJob(client: AccountClient, ref: string, _action: string): Promise<ApiJob> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
    return client.getJob(ref.toLowerCase());
  }
  const jobs = await allJobs(client);
  const named = jobs.filter((job) => job.name === ref);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw ambiguousJobRef(ref, named);

  const matches = jobs.filter((job) => matchesRef(job.id, ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw ambiguousJobRef(ref, matches);
  throw new PiPodError(`no job matches "${ref}"`, { hint: "see `pipod jobs`" });
}

function ambiguousJobRef(ref: string, jobs: ApiJob[]): PiPodError {
  const refs = jobs.map((job) => displayRef(job.id, "job"));
  const counts = new Map<string, number>();
  for (const display of refs) counts.set(display, (counts.get(display) ?? 0) + 1);
  const choices = jobs
    .map((job, index) => {
      const display = refs[index]!;
      const unambiguousRef = counts.get(display)! > 1 ? job.id : display;
      return `  ${unambiguousRef}  ${job.name}  (${job.status})`;
    })
    .join("\n");
  return new PiPodError(`"${ref}" matches ${jobs.length} jobs`, {
    hint: `use a longer ref:\n${choices}`,
  });
}

async function allJobs(client: AccountClient): Promise<ApiJob[]> {
  const jobs: ApiJob[] = [];
  let before: string | undefined;
  let beforeId: string | undefined;
  for (;;) {
    const page = await client.listJobs({ limit: 200, before, beforeId });
    jobs.push(...page.jobs);
    if (page.jobs.length < 200) return jobs;
    const last = page.jobs.at(-1);
    if (!last || (last.createdAt === before && last.id === beforeId)) return jobs;
    before = last.createdAt;
    beforeId = last.id;
  }
}

function assertArgCount(args: string[], expected: number, usage: string): void {
  if (args.length !== expected) throw new PiPodError(`usage: ${usage}`);
}

function shortSchedule(trigger: ApiJobTrigger | JobTrigger): string {
  if (trigger.type === "cron") return trigger.cron;
  return trigger.times.length === 1 ? `once ${trigger.times[0]}` : `${trigger.times.length} scheduled times`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Relative time in either direction: "3h ago" for the past, "in 3h" for the future. */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  const spell = (n: number) => {
    if (n < 1) return "now";
    if (n < 60) return `${n}m`;
    const hours = Math.floor(n / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };
  const word = spell(minutes);
  if (word === "now") return ms >= 0 ? "just now" : "now";
  return ms >= 0 ? `${word} ago` : `in ${word}`;
}

/** Compact unified text diff for prompts. Identical strings return an empty string. */
export function unifiedTextDiff(from: string, to: string): string {
  const a = from.split("\n");
  const b = to.split("\n");
  const lcs = longestCommonSubsequence(a, b);
  const lines: string[] = ["--- server", "+++ local"];
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length || j < b.length) {
    if (k < lcs.length && i < a.length && a[i] === lcs[k]) {
      if (j < b.length && b[j] === lcs[k]) {
        lines.push(` ${a[i]}`);
        i += 1;
        j += 1;
        k += 1;
      } else {
        lines.push(`+${b[j] ?? ""}`);
        j += 1;
      }
    } else if (k < lcs.length && j < b.length && b[j] === lcs[k]) {
      lines.push(`-${a[i] ?? ""}`);
      i += 1;
    } else if (i < a.length && (j >= b.length || a[i] !== b[j])) {
      lines.push(`-${a[i]}`);
      i += 1;
    } else if (j < b.length) {
      lines.push(`+${b[j]}`);
      j += 1;
    }
  }
  return lines.join("\n");
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const out: string[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push(a[i - 1]!);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return out.reverse();
}
