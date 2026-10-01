/**
 * src/teardown.ts — §9. Every teardown path ends with the pod stopped (unless `--keep`).
 *
 * Stopped, not deleted. The pod keeps its disk, so the clone and any uncommitted work are
 * still there; from there the provider archives it once it has been quiet for
 * `archiveAfterDays`, and `pi-pod attach` restores it from either state. Nothing on this path
 * destroys anything — that takes a human naming a pod to `pi-pod gc --delete`.
 *
 * The single most important property here is idempotence: the lifecycle registers teardown
 * in a `finally`, signal handlers may fire during it, and a crash mid-teardown must not
 * stop twice or skip the orphan notice. `Teardown.run()` is therefore run-once and
 * returns the same promise to every later caller.
 */
import { color, error, info, plain, warn } from "./log.js";
import { confirm } from "./prompt.js";
import { LABEL_HOST_USER, MANAGED_BY_KEY, MANAGED_BY_VALUE, hostUser } from "./labels.js";
import { lastActivityOf } from "./pods.js";
import type { Sandbox, SandboxInfo, SandboxProvider } from "./providers/types.js";
import { forgetPodEnvSources } from "./podenv.js";

export interface TeardownOptions {
  sandbox: Sandbox;
  /** Whether pi exiting should stop the pod (`!--keep`). */
  autoStop: boolean;
  /** Grace period before giving up on a stop. */
  stopTimeoutSeconds: number;
  /** Clone root inside the pod, for the unpushed-work check. */
  cloneDir?: string | undefined;
  branch?: string | undefined;
  /** Skip the unpushed-work check (e.g. teardown before the clone existed). */
  checkUnpushed: boolean;
}

export interface TeardownResult {
  stopped: boolean;
  /** True when the pod's disk was also moved to cold storage (§9). Implies `stopped`. */
  archived?: boolean;
  /** Set when the stop was attempted and failed — the pod is then still billing. */
  orphanId?: string;
}

/** How a pod is reclaimed. Neither destroys anything; `pi-pod attach` comes back from both. */
export type ReclaimAction = "stop" | "archive";

export class Teardown {
  private readonly opts: TeardownOptions;
  private promise: Promise<TeardownResult> | null = null;

  constructor(opts: TeardownOptions) {
    this.opts = opts;
  }

  /**
   * Enabled once a clone exists. Before that there is nothing to warn about, and asking the
   * user to confirm the destruction of an empty pod is noise.
   */
  enableUnpushedCheck(cloneDir: string, branch: string): void {
    this.opts.cloneDir = cloneDir;
    this.opts.branch = branch;
    this.opts.checkUnpushed = true;
  }

  /** True once teardown has started, so callers can avoid redundant work. */
  get started(): boolean {
    return this.promise !== null;
  }

  /** Run-once: later callers get the first run's result. */
  run(): Promise<TeardownResult> {
    if (!this.promise) this.promise = this.execute();
    return this.promise;
  }

  /**
   * Reclaim the pod because the user asked for it, not because policy did (§8).
   *
   * `autoStop` and `--keep` answer one question — what should happen *when pi exits* — and
   * the detach chords are the user answering a different one, out loud, for this session. So this
   * path deliberately ignores them: a keystroke that says "stop this pod" must not turn into a
   * no-op because a flag on the command line was about something else. It is still the same
   * run-once slot as `run()`, so the lifecycle's `finally` cannot stop the pod a second time.
   */
  reclaim(action: ReclaimAction, reason: string): Promise<TeardownResult> {
    if (this.promise) return this.promise;
    this.promise = this.execute({ action, reason });
    return this.promise;
  }

  /**
   * Settle teardown without issuing another provider mutation — detach, hang-up, or a lost
   * transport (§8). The provider may already have stopped the sandbox independently, so the
   * final message and result are reconciled against its current state before claiming it is up.
   *
   * This has to be a *decision*, not a skipped call: the lifecycle registers `run()` in a
   * `finally`, so anything that merely returns early still ends up stopping the pod on
   * the way out. Claiming the run-once slot is what prevents a second provider mutation.
   */
  keep(reason: string): Promise<TeardownResult> {
    if (this.promise) return this.promise;
    this.promise = this.settleKeep(reason);
    return this.promise;
  }

  private async settleKeep(reason: string): Promise<TeardownResult> {
    const { sandbox } = this.opts;
    const stateTimeoutMs = Math.min(5_000, Math.max(1, this.opts.stopTimeoutSeconds * 1_000));
    const state = await withTimeout(sandbox.state(), stateTimeoutMs, "pod state check").catch(() => null);
    if (state === "stopped" || state === "archived") {
      info(`${reason} — pod ${color.bold(sandbox.id)} is ${state}; its disk and clone are preserved`);
      info(`resume with: pi-pod attach ${sandbox.id}`);
      return { stopped: true, ...(state === "archived" ? { archived: true } : {}) };
    }
    if (state === "started") {
      info(`${reason} — pod ${color.bold(sandbox.id)} is still running`);
    } else if (state === "starting") {
      info(`${reason} — pod ${color.bold(sandbox.id)} is starting`);
    } else {
      info(`${reason} — pod ${color.bold(sandbox.id)} state could not be confirmed${state ? ` (provider reports ${state})` : ""}`);
    }
    return { stopped: false };
  }

  /**
   * @param request Set when the user asked for this directly (see {@link reclaim}); absent means
   *                the policy path, where `--keep` still gets to hold the pod.
   */
  private async execute(request?: { action: ReclaimAction; reason: string }): Promise<TeardownResult> {
    const { sandbox } = this.opts;

    if (this.opts.checkUnpushed && this.opts.cloneDir && this.opts.branch) {
      await warnAboutUnpushedWork(sandbox, this.opts.cloneDir, this.opts.branch);
    }

    if (!request && !this.opts.autoStop) {
      info(`${color.yellow("--keep")}: pod ${color.bold(sandbox.id)} was left running`);
      info(`archive it later with: pi-pod archive ${sandbox.id}`);
      return { stopped: false };
    }

    const action: ReclaimAction = request?.action ?? "stop";
    // Archiving stops the pod first and then moves its disk, so it needs the stop budget plus
    // the copy — a timeout tuned for a stop would abort it halfway every time.
    const timeoutMs = this.opts.stopTimeoutSeconds * 1000 * (action === "archive" ? 2 : 1);
    if (request) info(`${request.reason} — applying automatic retention policy`);

    try {
      await withTimeout(
        action === "archive" ? sandbox.archive(timeoutMs) : sandbox.stop(timeoutMs),
        timeoutMs,
        `pod ${action}`,
      );
      if (action === "archive") await confirmArchiveDisposition(sandbox, Math.min(timeoutMs, 5_000));
      info(`pod ${sandbox.id} is ready to leave ${color.dim("(logical state remains active)")}`);
      return { stopped: true, ...(action === "archive" ? { archived: true } : {}) };
    } catch (e) {
      // This is a cost problem rather than a data one; keep provider details out of lifecycle UX.
      error(`automatic retention policy failed for pod ${color.bold(sandbox.id)}: ${e instanceof Error ? e.message : String(e)}`);
      error("the pod remains available; automatic policy can retry, or `pi-pod gc --delete` removes it permanently");
      return { stopped: false, orphanId: sandbox.id };
    }
  }
}

async function confirmArchiveDisposition(sandbox: Sandbox, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await sandbox.state().catch(() => null);
    if (state === "archived") return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  warn(`pod ${sandbox.id} accepted the archive request; provider listings may take a moment to reflect it`);
  return false;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * §9: on the way out, tell the user what they are leaving behind in the sandbox.
 *
 * This used to gate deletion behind a confirmation, because the answer decided whether work
 * survived. Teardown only stops the pod now, so the work always survives and there is
 * nothing to confirm — asking anyway would train people to hit `y` at a prompt that once
 * meant something. What remains is the part that was always useful: saying where the work is
 * and how to get back to it.
 *
 * Deliberately best-effort — a pod that is already unreachable should still be stopped,
 * not block teardown behind a failing exec.
 */
export async function warnAboutUnpushedWork(
  sandbox: Sandbox,
  cloneDir: string,
  branch: string,
): Promise<void> {
  let dirtyCount = 0;
  let unpushed: string[] = [];

  try {
    const status = await sandbox.exec(["git", "status", "--porcelain"], { cwd: cloneDir, timeoutMs: 30_000 });
    dirtyCount = (status.output ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "").length;

    const log = await sandbox.exec(
      ["git", "log", "--oneline", "--no-decorate", `origin/${branch}..HEAD`],
      { cwd: cloneDir, timeoutMs: 30_000 },
    );
    if (log.exitCode === 0) {
      unpushed = (log.output ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
    }
  } catch {
    // The pod may already be gone; nothing to report.
    return;
  }

  if (dirtyCount === 0 && unpushed.length === 0) return;

  const parts: string[] = [];
  if (unpushed.length > 0) parts.push(`${unpushed.length} unpushed commit(s)`);
  if (dirtyCount > 0) parts.push(`${dirtyCount} modified file(s)`);

  plain("");
  warn(`${color.bold(parts.join(" and "))} stay in the pod`);
  for (const line of unpushed.slice(0, 10)) plain(`    ${line}`);
  if (unpushed.length > 10) plain(`    … and ${unpushed.length - 10} more`);
  // Neither stopping nor archiving touches the filesystem, so this is genuinely informational
  // whichever way the session is ending.
  info(`reclaiming the pod does not discard them — \`pi-pod attach ${sandbox.id}\` to push`);
  plain("");
}

// ---------------------------------------------------------------------------
// Garbage collection (§9)
// ---------------------------------------------------------------------------

export interface GcOptions {
  provider: SandboxProvider;
  /** `--all` widens from the current host-user to the whole org. */
  all: boolean;
  /** `--yes` skips prompts. */
  yes: boolean;
  /**
   * `--delete`: destroy the pods instead of marking their logical lifecycle archived.
   *
   * The only irreversible thing pi-pod does; it discards uncommitted work with no way back.
   */
  destroy?: boolean;
  /**
   * Explicit pod ids. Naming one is the request itself, so how long it has been idle is not
   * consulted — `--keep` exists precisely to hold a pod past a window that has not arrived yet,
   * and without this there is no pi-pod command that can then reclaim it. Ownership is still
   * enforced: an id outside the caller's `managed-by=pi-pod` scope is reported, not touched.
   *
   * This is also the whole of gc on a provider that cannot report activity: naming an id is a
   * human's judgment, which needs no clock behind it.
   */
  ids?: string[];
  /**
   * How long a pod may go without the *provider* seeing activity before a bare `pi-pod gc`
   * counts it abandoned. Ignored when ids are named.
   */
  orphanTtlMinutes?: number;
  /** Grace period for each stop/archive. */
  timeoutSeconds?: number;
  /**
   * Config's archive window, in minutes, already clamped to what the provider honors.
   *
   * gc realigns the caller's own pods to it as it goes (§9). Omit to skip that pass —
   * callers without a resolved config have no business rewriting retention.
   */
  archiveAfterMinutes?: number;
  /** User-triggered gc archives logical metadata through this hook, never provider storage. */
  archiveLogical?: (pod: SandboxInfo) => void | Promise<void>;
  /** Test seam. */
  now?: number;
}

export interface GcResult {
  candidates: SandboxInfo[];
  /** Ids successfully reclaimed — archived, or deleted under `--delete`. */
  reclaimed: string[];
  /** What was done to them, so callers can report it without re-deriving the flag. */
  action: "archive" | "delete";
  failed: Array<{ id: string; error: string }>;
  skipped: SandboxInfo[];
  /** Requested ids that matched no pi-pod pod in scope. */
  unknown: string[];
  /**
   * Set when the timed sweep could not run because the provider does not report activity —
   * as distinct from running and finding nothing, which is `candidates: []`.
   */
  sweepUnavailable?: boolean;
  /** Pods whose server-side retention was stale and has been brought in line. */
  realigned: string[];
}

/**
 * Selects owned pods by provider activity, then marks them logically archived through the
 * caller's metadata hook. Provider stop/archive remains exclusively automatic policy; gc never
 * turns a provider storage transition into a user command. `--delete` is the explicit,
 * irreversible exception.
 */
export async function collectGarbage(opts: GcOptions): Promise<GcResult> {
  const now = opts.now ?? Date.now();
  const user = hostUser();

  const selector: Record<string, string> = { [MANAGED_BY_KEY]: MANAGED_BY_VALUE };
  if (!opts.all) selector[LABEL_HOST_USER] = user;

  const all = await opts.provider.list(selector);

  // Defense in depth: some providers match labels loosely, so re-filter locally rather than
  // trusting the query to have excluded a teammate's sandbox.
  const mine = all.filter(
    (s) =>
      s.labels[MANAGED_BY_KEY] === MANAGED_BY_VALUE &&
      (opts.all || s.labels[LABEL_HOST_USER] === user),
  );

  const wanted = opts.ids ?? [];
  const byId = wanted.length > 0;

  // A provider that cannot say when a pod was last used cannot be swept on a timer, and the
  // launcher must not fill the gap from its own memory: it runs on a client that sleeps and
  // disconnects, so a host-kept timestamp would make reclamation depend on whether a laptop
  // happened to be awake. Naming ids still works — that is a person deciding, not a clock.
  const canSweep = opts.provider.capabilities.reportsLastActivity;
  const abandoned = (s: SandboxInfo) => isAbandoned(s, now, opts.orphanTtlMinutes);

  const candidates = byId
    ? mine.filter((s) => wanted.includes(s.id))
    : canSweep
      ? mine.filter(abandoned)
      : [];
  // Provider-archived pods may still be logically active, so they remain eligible for gc's
  // explicit logical archive intent. Gone pods are omitted from actionable candidates.
  const skipped =
    byId || !canSweep ? [] : mine.filter((s) => s.state !== "archived" && s.state !== "gone" && !abandoned(s));
  const unknown = wanted.filter((id) => !mine.some((s) => s.id === id));

  const realigned = await realignRetention(opts, mine, user);

  const destroy = opts.destroy === true;
  const action = destroy ? "delete" : "archive";
  const result: GcResult = {
    candidates,
    reclaimed: [],
    action,
    failed: [],
    skipped,
    unknown,
    realigned,
    ...(byId || canSweep ? {} : { sweepUnavailable: true }),
  };
  if (candidates.length === 0) return result;

  plain("");
  info(`${candidates.length} ${byId ? "pod(s)" : "expired pod(s)"} to ${action}:`);
  for (const s of candidates) {
    plain(`    ${s.id}  ${s.labels["pi-pod/repo"] ?? "?"}  (${s.labels[LABEL_HOST_USER] ?? "?"})`);
  }
  if (destroy) {
    // The one place in pi-pod where saying yes loses work. Say so at the prompt, not in the
    // docs — `--delete` is easy to reach for by analogy with every other gc.
    warn("--delete DESTROYS these pods and any uncommitted work in them; archiving is reversible");
  }
  plain("");

  const scope = opts.all ? " across the whole org" : "";
  const proceed = await confirm(
    destroy ? `Permanently delete these pods${scope}?` : `Archive these pods${scope}?`,
    { nonInteractiveDefault: false, assumeYes: opts.yes },
  );
  if (!proceed) {
    info(`nothing ${destroy ? "deleted" : "archived"}`);
    return result;
  }

  for (const info_ of candidates) {
    try {
      if (destroy) await deleteById(opts.provider, info_.id);
      else if (opts.archiveLogical) await opts.archiveLogical(info_);
      else throw new Error("logical archive handler is unavailable");
      result.reclaimed.push(info_.id);
    } catch (e) {
      result.failed.push({ id: info_.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * Bring the caller's own pods' retention in line with config, and report which needed it.
 *
 * Retention is fixed at `create()`, so this is the only thing that ever reaches a pod made
 * under an older config — including one still carrying a server-side *delete* timer from
 * before §9 switched to archival. gc is where it belongs: it is already the command that
 * enumerates your pods, and turning off a delete timer is the least destructive thing it
 * could possibly do.
 *
 * Scoped to the caller's own pods even under `--all`. Listing a teammate's pod is
 * reasonable; rewriting its settings from your config is not.
 *
 * Entirely best-effort: gc's job is reclaiming pods, and a provider that will not talk
 * about retention must not stop it from doing that.
 */
async function realignRetention(
  opts: GcOptions,
  mine: SandboxInfo[],
  user: string,
): Promise<string[]> {
  if (opts.archiveAfterMinutes === undefined) return [];

  const changed: string[] = [];
  for (const info_ of mine) {
    if (info_.labels[LABEL_HOST_USER] !== user) continue;
    try {
      const sandbox = await opts.provider.get(info_.id);
      if (!sandbox) continue;
      if (await sandbox.applyRetention({ archiveAfterMinutes: opts.archiveAfterMinutes })) {
        changed.push(info_.id);
      }
    } catch {
      /* a pod we cannot re-settle is not a reason to abandon the sweep */
    }
  }
  return changed;
}

/**
 * Is this an unreclaimed pod on which the provider has seen no activity for the orphan window?
 *
 * Archived pods are deliberately terminal for this decision: their activity timestamp remains
 * old after archival, but gc has already done exactly what the warning asks the user to do.
 * Treating that timestamp alone as abandonment makes every archived pod an orphan forever.
 *
 * Also `false` whenever there is no activity timestamp to judge by. That is the safe direction:
 * an unanswerable question must not archive a pod, and the fallbacks `pi-pod list` uses for
 * *display* are creation times, which say nothing about whether anyone still wants it.
 */
export function isAbandoned(pod: SandboxInfo, nowMs: number, orphanTtlMinutes?: number): boolean {
  if (pod.state === "archived" || pod.state === "gone") return false;
  if (orphanTtlMinutes === undefined || orphanTtlMinutes <= 0) return false;
  const seconds = lastActivityOf(pod);
  if (seconds === null) return false;
  return nowMs - seconds * 1000 >= orphanTtlMinutes * 60 * 1000;
}


async function deleteById(provider: SandboxProvider, id: string): Promise<void> {
  if (typeof provider.deleteById !== "function") {
    throw new Error(`provider "${provider.name}" does not support deleting a pod by id`);
  }
  await provider.deleteById(id);
  forgetPodEnvSources(provider.name, id);
}

/**
 * Surfaced on the next run: "1 orphaned pod found, run pi-pod gc" (§9). Best-effort and
 * silent on failure — a broken orphan check must never block a session from starting.
 *
 * Silent too on a provider that cannot report activity: there is nothing to check, and a
 * warning that appeared on every launch because the question is unanswerable would be noise
 * with no action behind it.
 */
export async function reportOrphans(provider: SandboxProvider, orphanTtlMinutes: number): Promise<void> {
  if (!provider.capabilities.reportsLastActivity) return;
  try {
    const pods = await provider.list({
      [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
      [LABEL_HOST_USER]: hostUser(),
    });
    const now = Date.now();
    const expired = pods.filter((s) => isAbandoned(s, now, orphanTtlMinutes));
    if (expired.length > 0) {
      warn(`${expired.length} orphaned pod(s) found — run \`pi-pod gc\` to archive them`);
    }
  } catch {
    /* never block a session on the orphan check */
  }
}
