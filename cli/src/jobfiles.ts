/**
 * src/jobfiles.ts — local job specs in `~/.pi-pod/jobs/` and the project's `.pi-pod/jobs/`.
 *
 * Files hold the declarative spec only (trigger, template, model, prompt). Status,
 * next_run_at, and run history stay on the server — the server is the only thing that
 * fires schedules. Project files win on a name collision; push prints which layer
 * supplied each job.
 */
import { CronExpressionParser } from "cron-parser";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR, findConfigPath } from "./config.js";
import { PiPodError } from "./errors.js";
import { parseJsonc } from "./jsonc.js";
import { userConfigDir } from "./userconfig.js";

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_AT_TIMES = 100;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_NAME_LENGTH = 100;
export const JOBS_SUBDIR = "jobs";

export type JobLayer = "user" | "project";

export interface CronJobTrigger {
  type: "cron";
  cron: string;
}

export interface AtJobTrigger {
  type: "at";
  times: string[];
}

export type JobTrigger = CronJobTrigger | AtJobTrigger;

export interface LocalJobSpec {
  name: string;
  description?: string;
  trigger: JobTrigger;
  template?: string;
  model: string;
  prompt: string;
  sourcePath: string;
  promptPath?: string;
  layer: JobLayer;
  mtimeMs: number;
}

export interface JobsDirOptions {
  cwd?: string;
  home?: string;
}

export interface ResolvedJobsDirs {
  userDir: string | null;
  projectDir: string | null;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  return a === b || realpathOr(a) === realpathOr(b);
}

function fail(source: string, field: string, message: string): never {
  throw new PiPodError(`${source}: ${field}: ${message}`);
}

export function userJobsDir(home?: string): string | null {
  const root = userConfigDir(home);
  return root ? path.join(root, JOBS_SUBDIR) : null;
}

/** Existing project `.pi-pod/jobs/` walking up from cwd, or null when there is none. */
export function findProjectJobsDir(cwd: string, home?: string): string | null {
  const userDir = userConfigDir(home);
  const homeDir = userDir ? path.dirname(userDir) : null;
  let dir = path.resolve(cwd);
  for (;;) {
    const configDir = path.join(dir, CONFIG_DIR);
    const jobsDir = path.join(configDir, JOBS_SUBDIR);
    const isUser = userDir !== null && samePath(configDir, userDir);
    if (!isUser && fs.existsSync(jobsDir) && fs.statSync(jobsDir).isDirectory()) {
      return jobsDir;
    }
    if (homeDir !== null && samePath(dir, homeDir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where `jobs pull --project` writes. Prefers an existing jobs dir, then the project
 * `.pi-pod/` that owns config.json, then `cwd/.pi-pod/jobs`.
 */
export function projectJobsDirForWrite(cwd: string, home?: string): string {
  const existing = findProjectJobsDir(cwd, home);
  if (existing) return existing;
  const configPath = findConfigPath(cwd, { home });
  if (configPath) return path.join(path.dirname(configPath), JOBS_SUBDIR);
  return path.join(path.resolve(cwd), CONFIG_DIR, JOBS_SUBDIR);
}

export function resolveJobsDirs(opts: JobsDirOptions = {}): ResolvedJobsDirs {
  const cwd = opts.cwd ?? process.cwd();
  const userDir = userJobsDir(opts.home);
  return {
    userDir: userDir && fs.existsSync(userDir) && fs.statSync(userDir).isDirectory() ? userDir : null,
    projectDir: findProjectJobsDir(cwd, opts.home),
  };
}

export function parseModelRef(model: string, source = "job", field = "model"): { provider: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    fail(source, field, `invalid model "${model}" — use "provider/model-id", e.g. "anthropic/claude-opus-4-7"`);
  }
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

export function normalizeJobTrigger(
  trigger: { type: string; cron?: string; times?: string[] },
  source = "job",
  field = "trigger",
): JobTrigger {
  if (trigger.type === "cron") {
    if (!trigger.cron) fail(source, field, "a cron trigger needs a cron expression");
    const cron = trigger.cron.trim();
    const fields = cron.split(/\s+/);
    if (fields.length !== 5) {
      fail(
        source,
        `${field}.cron`,
        `invalid cron expression "${trigger.cron}" — use exactly 5 fields: minute hour day-of-month month day-of-week`,
      );
    }
    let expr: ReturnType<typeof CronExpressionParser.parse>;
    try {
      expr = CronExpressionParser.parse(cron, { tz: "UTC" });
    } catch (e) {
      fail(
        source,
        `${field}.cron`,
        `invalid cron expression "${trigger.cron}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const minutes = [...expr.fields.minute.values];
    const hours = [...expr.fields.hour.values];
    const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute)).sort((a, b) => a - b);
    const intradayTooClose = times.slice(0, -1).some((time, index) => times[index + 1]! - time < MIN_INTERVAL_MINUTES);
    const midnightGap = times[0]! + 24 * 60 - times.at(-1)!;
    const tooClose =
      intradayTooClose || (midnightGap < MIN_INTERVAL_MINUTES && calendarCanMatchConsecutiveDays(fields.slice(2)));
    if (tooClose) {
      fail(
        source,
        `${field}.cron`,
        `cron "${trigger.cron}" fires more often than every ${MIN_INTERVAL_MINUTES} minutes — each run launches a pod, so schedule accordingly`,
      );
    }
    return { type: "cron", cron };
  }

  if (trigger.type !== "at") {
    fail(source, field, `unsupported trigger type "${trigger.type}" — use "cron" or "at"`);
  }
  if (!trigger.times || trigger.times.length === 0) {
    fail(source, `${field}.times`, "an at trigger needs at least one timestamp");
  }
  if (trigger.times.length > MAX_AT_TIMES) {
    fail(source, `${field}.times`, `an at trigger supports at most ${MAX_AT_TIMES} timestamps`);
  }

  const times = trigger.times.map((timestamp, index) =>
    normalizeTimestamp(timestamp, source, `${field}.times[${index}]`),
  );
  times.sort();
  for (let index = 1; index < times.length; index += 1) {
    const previous = Date.parse(times[index - 1]!);
    const current = Date.parse(times[index]!);
    if (current === previous) {
      fail(source, `${field}.times`, `at trigger contains duplicate timestamp "${times[index]}"`);
    }
    if (current - previous < MIN_INTERVAL_MINUTES * 60_000) {
      fail(
        source,
        `${field}.times`,
        `at trigger timestamps must be at least ${MIN_INTERVAL_MINUTES} minutes apart — each run launches a pod`,
      );
    }
  }
  return { type: "at", times };
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeTimestamp(timestamp: string, source: string, field: string): string {
  const match = ISO_INSTANT.exec(timestamp);
  const parsed = Date.parse(timestamp);
  if (!match || !Number.isFinite(parsed)) {
    fail(source, field, `invalid at timestamp "${timestamp}" — use ISO 8601 with an explicit timezone`);
  }
  const [, year, month, day, hour, minute, second] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    fail(source, field, `invalid at timestamp "${timestamp}"`);
  }
  const calendarDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
    fail(source, field, `invalid at timestamp "${timestamp}"`);
  }
  return new Date(parsed).toISOString();
}

function calendarCanMatchConsecutiveDays(dateFields: string[]): boolean {
  const start = new Date("2000-01-01T00:00:00Z");
  const end = new Date("2400-01-01T00:00:00Z");
  const days = CronExpressionParser.parse(`0 12 ${dateFields.join(" ")}`, {
    tz: "UTC",
    currentDate: start,
    endDate: end,
  });
  let previous: number | null = null;
  for (;;) {
    try {
      const current = days.next().getTime();
      if (previous !== null && current - previous === 24 * 60 * 60_000) return true;
      previous = current;
    } catch {
      return false;
    }
  }
}

const ALLOWED_KEYS = new Set(["description", "trigger", "template", "model", "prompt", "promptFile"]);

function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, "(root)", "job file must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function readString(raw: Record<string, unknown>, key: string, source: string): string | undefined {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (typeof value !== "string") fail(source, key, "must be a string");
  return value;
}

export function parseJobFile(text: string, sourcePath: string, layer: JobLayer): LocalJobSpec {
  const source = sourcePath;
  const name = path.basename(sourcePath, ".json");
  if (!name || name.length > MAX_NAME_LENGTH) {
    fail(source, "name", `job name (filename stem) must be 1–${MAX_NAME_LENGTH} characters`);
  }

  const raw = asRecord(parseJsonc(text, sourcePath), source);
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) fail(source, key, `unknown field — expected one of ${[...ALLOWED_KEYS].join(", ")}`);
  }

  const description = readString(raw, "description", source);
  const template = readString(raw, "template", source);
  const model = readString(raw, "model", source);
  if (!model || !model.trim()) fail(source, "model", "required");
  parseModelRef(model, source, "model");

  if (!raw.trigger || typeof raw.trigger !== "object" || Array.isArray(raw.trigger)) {
    fail(source, "trigger", "required object with type \"cron\" or \"at\"");
  }
  const triggerRaw = raw.trigger as { type?: unknown; cron?: unknown; times?: unknown };
  if (typeof triggerRaw.type !== "string") fail(source, "trigger.type", "required");
  const trigger = normalizeJobTrigger(
    {
      type: triggerRaw.type,
      cron: typeof triggerRaw.cron === "string" ? triggerRaw.cron : undefined,
      times: Array.isArray(triggerRaw.times) ? triggerRaw.times.map((time) => String(time)) : undefined,
    },
    source,
    "trigger",
  );

  const prompt = readString(raw, "prompt", source);
  const promptFile = readString(raw, "promptFile", source);
  if (prompt !== undefined && promptFile !== undefined) {
    fail(source, "prompt", "prompt and promptFile are mutually exclusive");
  }
  if (prompt === undefined && promptFile === undefined) {
    fail(source, "prompt", "set prompt or promptFile");
  }

  let resolvedPrompt = prompt ?? "";
  let promptPath: string | undefined;
  if (promptFile !== undefined) {
    if (!promptFile.trim()) fail(source, "promptFile", "must not be empty");
    // A job file arrives with a checkout and its prompt is uploaded: it may name only a file
    // beside it, never one elsewhere on this machine.
    if (promptFile !== path.basename(promptFile) || promptFile === "." || promptFile === "..") {
      fail(source, "promptFile", "must be a file name in the same directory as the job file");
    }
    promptPath = path.join(path.dirname(sourcePath), promptFile);
    if (!fs.existsSync(promptPath)) fail(source, "promptFile", `file not found: ${promptPath}`);
    if (!fs.lstatSync(promptPath).isFile()) fail(source, "promptFile", "must be a regular file, not a symlink");
    resolvedPrompt = fs.readFileSync(promptPath, "utf8");
  }
  if (!resolvedPrompt.trim()) fail(source, promptFile !== undefined ? "promptFile" : "prompt", "prompt must not be empty");
  if (Buffer.byteLength(resolvedPrompt, "utf8") > MAX_PROMPT_BYTES) {
    fail(
      source,
      promptFile !== undefined ? "promptFile" : "prompt",
      `prompt must be at most ${MAX_PROMPT_BYTES} bytes`,
    );
  }

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(sourcePath).mtimeMs;
  } catch {
    // Parse-only callers (tests with no file) leave mtime at 0.
  }

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    trigger,
    ...(template !== undefined && template.trim() ? { template: template.trim() } : {}),
    model: model.trim(),
    prompt: resolvedPrompt,
    sourcePath,
    ...(promptPath ? { promptPath } : {}),
    layer,
    mtimeMs,
  };
}

function listJsonFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function loadDir(dir: string, layer: JobLayer): LocalJobSpec[] {
  return listJsonFiles(dir).map((file) => parseJobFile(fs.readFileSync(file, "utf8"), file, layer));
}

/**
 * User jobs first, then project jobs overwrite by name. The returned list is sorted by name.
 */
export function loadLocalJobs(opts: JobsDirOptions = {}): LocalJobSpec[] {
  const dirs = resolveJobsDirs(opts);
  const byName = new Map<string, LocalJobSpec>();
  if (dirs.userDir) {
    for (const job of loadDir(dirs.userDir, "user")) byName.set(job.name, job);
  }
  if (dirs.projectDir) {
    for (const job of loadDir(dirs.projectDir, "project")) byName.set(job.name, job);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadLocalJob(name: string, opts: JobsDirOptions = {}): LocalJobSpec {
  const jobs = loadLocalJobs(opts);
  const match = jobs.find((job) => job.name === name);
  if (!match) {
    throw new PiPodError(`no local job file named "${name}"`, {
      hint: jobs.length ? `have: ${jobs.map((job) => job.name).join(", ")}` : "no files in ~/.pi-pod/jobs/ or .pi-pod/jobs/",
    });
  }
  return match;
}

export function promptFileName(name: string): string {
  return `${name}.prompt.md`;
}

export function jobFileName(name: string): string {
  return `${name}.json`;
}

export interface WrittenJobFiles {
  jsonPath: string;
  promptPath: string;
}

export function serializeJobFile(spec: {
  name: string;
  description?: string | null;
  trigger: JobTrigger;
  template?: string | null;
  model: string;
}): string {
  const body: Record<string, unknown> = {};
  if (spec.description) body.description = spec.description;
  body.trigger = spec.trigger;
  if (spec.template) body.template = spec.template;
  body.model = spec.model;
  body.promptFile = promptFileName(spec.name);
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function writeLocalJob(
  spec: {
    name: string;
    description?: string | null;
    trigger: JobTrigger;
    template?: string | null;
    model: string;
    prompt: string;
  },
  opts: JobsDirOptions & { project?: boolean; overwrite?: boolean } = {},
): WrittenJobFiles {
  // The name comes from the server, where any member can name a shared job: it must stay
  // a plain file name inside the jobs directory.
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(spec.name) || spec.name.includes("..")) {
    throw new PiPodError(`job name "${spec.name}" cannot be a local file name`, {
      hint: "rename the job on the server (letters, digits, '.', '_', '-', spaces), then pull again",
    });
  }
  const cwd = opts.cwd ?? process.cwd();
  const dir = opts.project ? projectJobsDirForWrite(cwd, opts.home) : (userJobsDir(opts.home) ?? path.join(path.resolve(cwd), CONFIG_DIR, JOBS_SUBDIR));
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, jobFileName(spec.name));
  const promptPath = path.join(dir, promptFileName(spec.name));
  const nextJson = serializeJobFile(spec);
  for (const [file, next] of [[jsonPath, nextJson], [promptPath, spec.prompt]] as const) {
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!existing) continue;
    if (!existing.isFile()) {
      throw new PiPodError(`refusing to write ${file} — it is not a regular file`, {
        hint: "remove it (a symlink is never followed), then pull again",
      });
    }
    if (!opts.overwrite && fs.readFileSync(file, "utf8") !== next) {
      throw new PiPodError(`refusing to overwrite ${file} — it differs from the server copy`, {
        hint: "pass -y to overwrite, or `pipod jobs diff` to see the drift",
      });
    }
  }
  fs.writeFileSync(jsonPath, nextJson);
  fs.writeFileSync(promptPath, spec.prompt);
  return { jsonPath, promptPath };
}

export function triggersEqual(a: JobTrigger, b: JobTrigger): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "cron" && b.type === "cron") return a.cron === b.cron;
  if (a.type === "at" && b.type === "at") return a.times.length === b.times.length && a.times.every((time, i) => time === b.times[i]);
  return false;
 }
