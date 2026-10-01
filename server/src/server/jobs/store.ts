import { CronExpressionParser } from "cron-parser";
import { query } from "../db/index.js";
import { badRequest, notFound } from "../httperrors.js";

/** Floor between occurrences: every tick launches a whole pod, so a per-minute cron is a
 * cost incident, not a schedule. */
export const MIN_INTERVAL_MINUTES = 5;

export interface CronJobTrigger {
  type: "cron";
  /** Standard 5-field cron expression, evaluated in UTC. */
  cron: string;
}

export interface AtJobTrigger {
  type: "at";
  /** Sorted, unique ISO instants. Offsets are normalized to UTC before storage. */
  times: string[];
}

export type JobTrigger = CronJobTrigger | AtJobTrigger;
export type JobStatus = "active" | "paused" | "completed";
export type JobScope = "org" | "user";
export const MAX_AT_TIMES = 100;

export interface JobRow {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  description: string | null;
  status: JobStatus;
  scope: JobScope;
  trigger: JobTrigger;
  template_id: string | null;
  model: string;
  prompt: string;
  created_from_pod: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRunRow {
  id: string;
  job_id: string;
  org_id: string;
  pod_id: string | null;
  scheduled_at: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** Validate and canonicalize a trigger before it crosses the storage boundary. Keeping
 * normalization here means routes, workers, and future callers share exactly one schedule contract. */
export function normalizeJobTrigger(trigger: {
  type: string;
  cron?: string;
  times?: string[];
}): JobTrigger {
  if (trigger.type === "cron") {
    if (!trigger.cron) throw badRequest("a cron trigger needs a cron expression");
    const cron = trigger.cron.trim();
    const fields = cron.split(/\s+/);
    if (fields.length !== 5) {
      throw badRequest(`invalid cron expression "${trigger.cron}" — use exactly 5 fields: minute hour day-of-month month day-of-week`);
    }
    let expr: ReturnType<typeof CronExpressionParser.parse>;
    try {
      expr = CronExpressionParser.parse(cron, { tz: "UTC" });
    } catch (e) {
      throw badRequest(`invalid cron expression "${trigger.cron}": ${e instanceof Error ? e.message : String(e)}`);
    }

    // Prove the floor from the complete minute/hour field sets, rather than sampling a few
    // occurrences (a comma list can hide a one-minute gap after arbitrary safe gaps). Within
    // a day every candidate is exact; the midnight wrap matters only when the calendar fields
    // can match consecutive dates.
    const minutes = [...expr.fields.minute.values];
    const hours = [...expr.fields.hour.values];
    const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute)).sort((a, b) => a - b);
    const intradayTooClose = times.slice(0, -1).some((time, index) => times[index + 1]! - time < MIN_INTERVAL_MINUTES);
    const midnightGap = times[0]! + 24 * 60 - times.at(-1)!;
    const tooClose =
      intradayTooClose ||
      (midnightGap < MIN_INTERVAL_MINUTES && calendarCanMatchConsecutiveDays(fields.slice(2)));
    if (tooClose) {
      throw badRequest(
        `cron "${trigger.cron}" fires more often than every ${MIN_INTERVAL_MINUTES} minutes — each run launches a pod, so schedule accordingly`,
      );
    }
    return { type: "cron", cron };
  }

  if (trigger.type !== "at") {
    throw badRequest(`unsupported trigger type "${trigger.type}" — use "cron" or "at"`);
  }
  if (!trigger.times || trigger.times.length === 0) {
    throw badRequest("an at trigger needs at least one timestamp");
  }
  if (trigger.times.length > MAX_AT_TIMES) {
    throw badRequest(`an at trigger supports at most ${MAX_AT_TIMES} timestamps`);
  }

  const times = trigger.times.map(normalizeTimestamp).sort();
  for (let index = 1; index < times.length; index += 1) {
    const previous = Date.parse(times[index - 1]!);
    const current = Date.parse(times[index]!);
    if (current === previous) throw badRequest(`at trigger contains duplicate timestamp "${times[index]}"`);
    if (current - previous < MIN_INTERVAL_MINUTES * 60_000) {
      throw badRequest(
        `at trigger timestamps must be at least ${MIN_INTERVAL_MINUTES} minutes apart — each run launches a pod`,
      );
    }
  }
  return { type: "at", times };
}

/** Assertion-shaped compatibility helper for callers that only need validation. */
export function assertValidTrigger(trigger: {
  type: string;
  cron?: string;
  times?: string[];
}): asserts trigger is JobTrigger {
  normalizeJobTrigger(trigger);
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeTimestamp(timestamp: string): string {
  const match = ISO_INSTANT.exec(timestamp);
  const parsed = Date.parse(timestamp);
  if (!match || !Number.isFinite(parsed)) {
    throw badRequest(`invalid at timestamp "${timestamp}" — use ISO 8601 with an explicit timezone`);
  }
  const [, year, month, day, hour, minute, second] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    throw badRequest(`invalid at timestamp "${timestamp}"`);
  }
  const calendarDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
    throw badRequest(`invalid at timestamp "${timestamp}"`);
  }
  return new Date(parsed).toISOString();
}

/** Cron's DOM/DOW semantics are subtle; let cron-parser enumerate matching *dates*. A
 * 400-year Gregorian cycle is exhaustive, while sparse annual schedules cost only ~400
 * iterations and daily schedules return after the second occurrence. */
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

/** "provider/model-id", split at the first slash (model ids may contain slashes). */
export function parseModelRef(model: string): { provider: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw badRequest(`invalid model "${model}" — use "provider/model-id", e.g. "anthropic/claude-opus-4-7"`);
  }
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** Return the first occurrence strictly after `from`, or null when a finite schedule is exhausted. */
export function nextOccurrenceAt(trigger: JobTrigger, from: Date = new Date()): Date | null {
  if (trigger.type === "cron") {
    return CronExpressionParser.parse(trigger.cron, { tz: "UTC", currentDate: from }).next().toDate();
  }
  const next = trigger.times.find((time) => Date.parse(time) > from.getTime());
  return next ? new Date(next) : null;
}

/** Ownership moves one way: a personal job can be handed to the organization, but an
 * organization job cannot be made personal after other members may have started relying on it.
 * Returns whether this request promotes the job. */
export function assertJobScopeChange(
  existing: Pick<JobRow, "scope">,
  requested: JobScope | undefined,
): boolean {
  if (requested === "user" && existing.scope === "org") {
    throw badRequest("an org job cannot be made personal", "create your own copy instead");
  }
  return requested === "org" && existing.scope === "user";
}

/** Reject an invalid shared definition while the author can still fix it, rather than when
 * the scheduler fires. */
export function assertJobTemplateScope(jobScope: JobScope, templateScope: JobScope): void {
  if (jobScope === "org" && templateScope === "user") {
    throw badRequest(
      "an org-scoped job cannot reference a user-scoped template — promote the template to org scope or choose an org-scoped template",
      "promote the template to org scope or choose an org-scoped template",
    );
  }
}

/** The scheduler uses this exact decision at launch time: shared jobs skip the owner's bundle. */
export function jobIncludesUserBundle(job: Pick<JobRow, "scope">): boolean {
  return job.scope === "user";
}

/** Organization jobs are visible to every member; personal jobs only to their owner. */
export async function getJob(orgId: string, userId: string, id: string): Promise<JobRow> {
  const rows = await query<JobRow>(
    `SELECT * FROM jobs
     WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
       AND (scope = 'org' OR user_id = $3)`,
    [id, orgId, userId],
  );
  const row = rows.rows[0];
  if (!row) throw notFound("job not found");
  return row;
}
