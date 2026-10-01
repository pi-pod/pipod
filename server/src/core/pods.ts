/**
 * src/pods.ts — logical pod listing/archive/restore, plus shared pod lookup.
 *
 * These are the three things you want once pods outlive the session that made them. Detaching
 * is cheap and nothing on the automatic path deletes anything, so a working week leaves a
 * handful of pods behind — and until now the only way to see them was to ask `pi-pod attach`
 * to fail with an ambiguity error, which is not a listing so much as a diagnostic that happens
 * to contain one.
 *
 * Everything here is scoped to `managed-by=pi-pod` *and* the current host user. That is the
 * same boundary `pi-pod attach` enforces, and it is deliberately not relaxable by id: naming a
 * teammate's pod is reported as not found rather than acted on.
 */
import type { LoadedConfig } from "./config.js";
import { EXIT, PiPodError, errorMessage } from "./errors.js";
import * as path from "node:path";
import {
  LABEL_CREATED,
  LABEL_HOST_USER,
  LABEL_NAME,
  LABEL_PROJECT,
  LABEL_WORKDIR,
  MANAGED_BY_KEY,
  MANAGED_BY_VALUE,
  hostUser,
  hostUserLabel,
  sanitizeLabelValue,
  sessionNameLabel,
} from "./labels.js";
import { color, hint, info, out, plain, withLiveness } from "./log.js";
import { applyHostPodNames, rememberPodName } from "./podnames.js";
import {
  logicalPodState,
  rememberLogicalPodState,
  type LogicalPodState,
} from "./podstate.js";
import { confirm } from "./prompt.js";
import type { Sandbox, SandboxInfo, SandboxProvider } from "./providers/types.js";

export interface PodScope {
  provider: SandboxProvider;
  loaded: LoadedConfig;
  /** Widen past the current project to every pod belonging to this host user. */
  all?: boolean;
  /** Test/embedding seam for machine-local logical metadata. */
  stateHome?: string | null;
}

/** Return only unambiguous workspace metadata; mounting a guessed path can destroy another tree. */
export function exactPodWorkdir(recorded: string | undefined, configured: string): string {
  if (!recorded) {
    throw new PiPodError("pod metadata does not record its workdir", {
      hint: "pi-pod will not guess a mount destination for a legacy pod",
    });
  }
  if (recorded === configured) return configured;
  if (recorded === sanitizeLabelValue(configured)) {
    throw new PiPodError(`pod metadata contains a truncated workdir (${recorded})`, {
      hint: "use the configuration that originally created this pod; pi-pod will not guess between colliding paths",
    });
  }
  return recorded;
}

export function podWorkdirOf(pod: SandboxInfo, loaded: LoadedConfig): string {
  return exactPodWorkdir(pod.labels[LABEL_WORKDIR], loaded.config.workdir);
}

export interface TrackedPodInfo extends SandboxInfo {
  /** User-owned lifecycle state; deliberately independent of the provider state above. */
  logicalState: LogicalPodState;
}

/** Provider inventory enriched with pi-pod's own logical lifecycle state. */
export async function listPods(scope: PodScope): Promise<TrackedPodInfo[]> {
  const user = hostUserLabel();
  const mine = (
    await scope.provider.list({ [MANAGED_BY_KEY]: MANAGED_BY_VALUE, [LABEL_HOST_USER]: user })
  ).filter(
    // Re-checked here rather than trusted from the query: `list()` takes the labels as a
    // request, and a provider that matches them loosely — or not at all — must not be able to
    // widen this listing past the boundary the rest of the file assumes it has.
    (s) =>
      s.labels[MANAGED_BY_KEY] === MANAGED_BY_VALUE &&
      s.labels[LABEL_HOST_USER] === user &&
      s.state !== "gone",
  );

  const project = scope.all ? null : projectOf(scope.loaded);
  const scoped = project === null ? mine : mine.filter((s) => s.labels[LABEL_PROJECT] === sanitizeLabelValue(project));

  // Provider state remains available to attach internally, but never decides the state shown
  // by list. Missing metadata means active: only an explicit archive changes logical state.
  const named = applyHostPodNames(scoped);
  return sortByActivity(
    named.map((pod) => ({
      ...pod,
      logicalState: logicalPodState(scope.provider.name, pod.id, scope.stateHome),
    })),
  );
}

/**
 * Most recently used first, with the id as a tiebreak so the order is stable between runs.
 *
 * A pod nothing can date sorts last: guessing a timestamp for it would move it around the list
 * on the strength of a field that does not exist.
 */
export function sortByActivity<T extends SandboxInfo>(pods: T[]): T[] {
  return [...pods].sort((a, b) => {
    const at = activityOf(a);
    const bt = activityOf(b);
    if (at === bt) return a.id.localeCompare(b.id);
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at;
  });
}

/**
 * Unix seconds this pod was last active, best source first.
 *
 * The provider's own `lastActivityAt` is preferred over anything pi-pod could record, because
 * the launcher runs on a client: a host-written timestamp stops advancing the moment a laptop
 * sleeps or a terminal closes, which would make the ordering a statement about the client
 * rather than about the pod. Where the provider does not track activity the fallbacks answer a
 * narrower question — when the pod was *created* — and `formatAge`'s output is honest about
 * being approximate either way.
 */
export function activityOf(pod: SandboxInfo): number | null {
  return lastActivityOf(pod) ?? epochSecondsOf(pod.createdAt) ?? labelSeconds(pod.labels[LABEL_CREATED]);
}

/**
 * The same thing without the fallbacks — activity, or nothing.
 *
 * `pi-pod gc` uses this rather than `activityOf` because the fallbacks are creation times, and
 * "created a long time ago" is not evidence of abandonment: a pod someone has used every day
 * for a month would be the *oldest* thing in the list. For a decision that reclaims a pod, no
 * answer has to stay distinguishable from an old one.
 */
export function lastActivityOf(pod: SandboxInfo): number | null {
  return epochSecondsOf(pod.lastActivityAt);
}

function epochSecondsOf(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function labelSeconds(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : null;
}

export interface ListCommandOptions extends PodScope {
  /** `--quiet`: ids only, one per line, for piping into the other commands. */
  quiet?: boolean;
  /** `--archived`: include pods the user explicitly archived. */
  archived?: boolean;
  /** Test seam. */
  now?: number;
}

/** `pi-pod list` renders the logical state, never the provider's execution/storage state. */
export async function runList(opts: ListCommandOptions): Promise<number> {
  const found = await listPods(opts);
  const pods = opts.archived === true ? found : found.filter((p) => p.logicalState !== "archived");
  const hidden = found.length - pods.length;

  if (pods.length === 0) {
    // Nothing found is not a failure — `pi-pod list` on a repo you have not launched yet is a
    // perfectly ordinary thing to run. Under --quiet it is also not a *sentence*: the output
    // is being read by something that wants ids or nothing.
    if (!opts.quiet) {
      if (hidden > 0) {
        // Distinct from having no pods at all, because the next move is different: there is
        // something to come back to, and one flag away from being on screen.
        info(opts.all ? "every pod you have is archived" : "every pod for this repo is archived");
        hint(`\`pi-pod list --archived\` shows ${hidden === 1 ? "it" : "them"}`);
      } else {
        info(opts.all ? "no pods for this user" : "no pods for this repo");
        hint(opts.all ? "start one with `pi-pod`" : "`pi-pod list --all` covers every repo");
      }
    }
    return EXIT.OK;
  }

  if (opts.quiet) {
    for (const pod of pods) out(pod.id);
    return EXIT.OK;
  }

  const now = opts.now ?? Date.now();
  const rows = pods.map((pod) => ({
    id: pod.id,
    name: pod.labels[LABEL_NAME] ?? "",
    state: pod.logicalState,
    project: pod.labels[LABEL_PROJECT] ?? "?",
    active: formatAge(activityOf(pod), now),
  }));

  const w = (pick: (r: (typeof rows)[number]) => string, header: string) =>
    Math.max(header.length, ...rows.map((r) => pick(r).length));
  const idW = w((r) => r.id, "POD");
  const stateW = w((r) => r.state, "STATE");
  const projectW = opts.all ? w((r) => r.project, "PROJECT") : 0;
  // Only once something has a name: a column of blanks is worse than no column, and a user
  // who never renames anything should not pay table width for a feature they do not use.
  const named = rows.some((r) => r.name !== "");
  const nameW = named ? w((r) => r.name, "NAME") : 0;

  // The table is this command's *product*, so it goes to stdout where `pi-pod list > pods.txt`
  // can catch it — unlike the launcher's diagnostics, which stay on stderr. Colour follows
  // stdout's own terminal rather than the global setting for the same reason: escape codes are
  // decoration for a human, and would be noise in the file.
  const styled = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const bold = (s: string) => (styled ? color.bold(s) : s);
  const dim = (s: string) => (styled ? color.dim(s) : s);

  plain("");
  out(
    dim(
      `  ${"POD".padEnd(idW)}  ` +
        (named ? `${"NAME".padEnd(nameW)}  ` : "") +
        `${"STATE".padEnd(stateW)}  ` +
        (opts.all ? `${"PROJECT".padEnd(projectW)}  ` : "") +
        "LAST ACTIVE",
    ),
  );
  for (const r of rows) {
    out(
      `  ${bold(r.id.padEnd(idW))}  ` +
        (named ? `${r.name.padEnd(nameW)}  ` : "") +
        `${r.state.padEnd(stateW)}  ` +
        (opts.all ? `${r.project.padEnd(projectW)}  ` : "") +
        dim(r.active),
    );
  }
  plain("");
  // Said rather than left to be noticed: a count the user cannot see is the one way this
  // filter could cost them a pod they were looking for.
  if (hidden > 0) {
    hint(`${hidden} archived pod${hidden === 1 ? "" : "s"} not shown — \`pi-pod list --archived\` includes them`);
  }
  hint(`attach with: pi-pod attach ${pods[0]!.id}`);
  return EXIT.OK;
}

/**
 * "3m ago" — coarse on purpose. The question this column answers is which of these pods is the
 * one you were just working in, and a precise timestamp makes that harder to see, not easier.
 */
export function formatAge(seconds: number | null, nowMs: number): string {
  if (seconds === null) return "unknown";
  const elapsed = Math.max(0, Math.floor(nowMs / 1000) - seconds);
  if (elapsed < 60) return "just now";
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Resolve a pod to act on: the explicit id or name, or this repo's own when there is exactly one.
 *
 * Ambiguity is never resolved by guessing. A lifecycle command must never act on a guessed pod.
 */
export async function selectPod(
  scope: PodScope,
  /** A pod id, or a session name mirrored onto `pi-pod/name` (§5.4). */
  podId: string | undefined,
  action: string,
): Promise<TrackedPodInfo> {
  const user = hostUser();
  const mine = await listPods({ ...scope, all: true });

  if (podId !== undefined) {
    const byId = mine.find((s) => s.id === podId);
    if (byId) return byId;

    // Names are a mirror of what the session called itself, so they are neither unique nor
    // guaranteed to exist. Falling back to them only after an id miss keeps an id argument
    // meaning exactly one thing.
    const byName = mine.filter((s) => s.labels[LABEL_NAME] === sanitizeLabelValue(podId));
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      plain("");
      info(`${byName.length} pods named ${podId}:`);
      for (const s of byName) {
        plain(`    ${color.bold(s.id)}  ${s.labels[LABEL_PROJECT] ?? "?"}  (${s.logicalState})`);
      }
      plain("");
      throw new PiPodError(`more than one pod named ${podId} to ${action}`, {
        hint: `pass the id: pi-pod ${action} <pod-id>`,
      });
    }

    // Provider ids are long and unmemorable, so a unique prefix is accepted the way short
    // git hashes are — and only a unique one: acting on a guessed pod is worse than asking.
    const byPrefix = podId.length >= 4 ? mine.filter((s) => s.id.startsWith(podId)) : [];
    if (byPrefix.length === 1) return byPrefix[0]!;
    if (byPrefix.length > 1) {
      plain("");
      info(`${byPrefix.length} pods start with ${podId}:`);
      for (const s of byPrefix) {
        plain(`    ${color.bold(s.id)}  ${s.labels[LABEL_PROJECT] ?? "?"}  (${s.logicalState})`);
      }
      plain("");
      throw new PiPodError(`more than one pod matches the prefix ${podId} to ${action}`, {
        hint: `pass the full id: pi-pod ${action} <pod-id>`,
      });
    }

    throw new PiPodError(`${podId} is not a pi-pod pod belonging to ${user}`, {
      hint:
        "run `pi-pod list` to see the pods you can act on — by id, unique id prefix, or the name in the NAME column.\n" +
        "Pods created by other users, or outside pi-pod, are deliberately not reachable.",
    });
  }

  const project = projectOf(scope.loaded);
  const forThisProject = project === null ? mine : mine.filter((s) => s.labels[LABEL_PROJECT] === sanitizeLabelValue(project));

  if (forThisProject.length === 1) return forThisProject[0]!;

  if (forThisProject.length === 0) {
    throw new PiPodError(project ? `no pod for ${project}` : "no pod for this project", {
      hint: "start one with `pi-pod`",
    });
  }

  plain("");
  info(`${forThisProject.length} pods for this project:`);
  for (const s of forThisProject) {
    plain(`    ${color.bold(s.id)}  ${s.labels[LABEL_PROJECT] ?? "?"}  (${s.logicalState})`);
  }
  plain("");
  throw new PiPodError(`more than one pod to ${action}`, {
    hint: `pass the id: pi-pod ${action} <pod-id>`,
  });
}

export interface RenameCommandOptions extends PodScope {
  /** Pod id or current name; omitted means this repo's own, when there is exactly one. */
  podId?: string | undefined;
  name: string;
}

/**
 * `pi-pod rename <pod> <name>` — name a pod from outside any session (§9).
 *
 * This writes the *label*, which is the mirror rather than the source of truth: a pi session
 * resumed on this pod carries its own `session_info` name, and the next time that session
 * renames itself the label goes back to following it. For a live session, `/name` inside it is
 * the thing that renames both.
 */
export async function runRename(opts: RenameCommandOptions): Promise<number> {
  const name = opts.name.trim();
  if (name === "") {
    throw new PiPodError("a pod name cannot be empty", {
      hint: "pi-pod rename <pod> <name>",
      exitCode: EXIT.USAGE,
    });
  }

  const target = await selectPod(opts, opts.podId, "rename");
  const sandbox = await opts.provider.get(target.id, {
    ...(target.labels[LABEL_WORKDIR] ? { workdir: podWorkdirOf(target, opts.loaded) } : {}),
  });
  if (!sandbox) {
    throw new PiPodError(`pod ${target.id} no longer exists`, {
      hint: "it was deleted with `pi-pod gc --delete`",
    });
  }

  await sandbox.setLabels(sessionNameLabel(name));
  const stored = sanitizeLabelValue(name);
  // Durable on the host even when the provider drops mutable labels for stopped pods (§5.4).
  rememberPodName(target.id, stored);
  info(`pod ${color.bold(target.id)} is now ${color.bold(stored)}`);
  // Said only when it happened: the sanitizer is invisible until it changes something, and a
  // user who then types the name they asked for would get a not-found they cannot explain.
  if (stored !== name) hint(`the name was adjusted to fit a pod label: ${stored}`);
  hint(`attach with: pi-pod attach ${stored}`);
  return EXIT.OK;
}

/** Resolve every target before changing metadata, so a typo leaves the whole request untouched. */
async function resolveTargets(scope: PodScope, ids: string[], action: string): Promise<TrackedPodInfo[]> {
  if (ids.length === 0) return [await selectPod(scope, undefined, action)];
  return Promise.all(ids.map((id) => selectPod(scope, id, action)));
}

type PodAction = "archive" | "restore";

async function actionTargets(opts: PodActionOptions, action: PodAction): Promise<TrackedPodInfo[] | null> {
  if (opts.all !== true) return resolveTargets(opts, opts.ids, action);
  if (opts.ids.length > 0) {
    throw new PiPodError(`--all ${action}s every pod, so it cannot be combined with pod ids`, {
      hint: `drop --all to ${action} just the pods you named`,
    });
  }

  const mine = await listPods({ ...opts, all: true });
  const desired: LogicalPodState = action === "archive" ? "archived" : "active";
  const targets = mine.filter((pod) => pod.logicalState !== desired);
  if (targets.length === 0) {
    info(mine.length === 0 ? "no pods for this user" : `every pod is already ${desired}`);
    return [];
  }

  plain("");
  info(`${targets.length} pod(s) to ${action}, across every project:`);
  for (const pod of targets) {
    plain(`    ${color.bold(pod.id)}  ${pod.labels[LABEL_PROJECT] ?? "?"}  (${pod.logicalState})`);
  }
  plain("");
  const proceed = await confirm(`${action === "archive" ? "Archive" : "Restore"} all ${targets.length} of them?`, {
    nonInteractiveDefault: true,
    assumeYes: opts.yes === true,
  });
  return proceed ? targets : null;
}

/** Bring an active logical pod back to provider-agnostic readiness when needed. */
export async function ensurePodStarted(
  sandbox: Sandbox,
  target: SandboxInfo,
  startTimeoutMs: number,
  provider?: Pick<SandboxProvider, "capabilities">,
): Promise<void> {
  const state = await sandbox.state();
  if (state === "gone") {
    throw new PiPodError(`pod ${target.id} has been destroyed`);
  }
  if (state === "error") {
    throw new PiPodError(`pod ${target.id} is unavailable`, {
      hint: `reclaim it with \`pi-pod gc ${target.id} --delete\` and launch a fresh one`,
    });
  }
  if (state === "started") return;

  info(`pod ${color.bold(target.id)} is not ready yet — preparing it`);
  info(
    color.dim(
      provider?.capabilities.workdirSurvivesStop === false
        ? "this provider cannot preserve the workdir across stop/start; refusing reconstruction is safer than hiding data loss"
        : "the clone and any uncommitted work remain intact; this may take a few minutes",
    ),
  );
  await withLiveness(
    "preparing the pod",
    () => sandbox.start(startTimeoutMs),
    { expectation: "often under a minute, but sometimes a few minutes" },
  );
}

export interface PodActionOptions extends PodScope {
  /** Pod ids; empty means this repo's pod, when there is exactly one. */
  ids: string[];
  all?: boolean;
  yes?: boolean;
}

/** Archive only changes pi-pod's durable logical state; provider automation remains untouched. */
export async function runArchive(opts: PodActionOptions): Promise<number> {
  return runLogicalAction(opts, "archive");
}

/** Restore makes a logically archived pod visible/attachable again without starting it. */
export async function runRestore(opts: PodActionOptions): Promise<number> {
  return runLogicalAction(opts, "restore");
}

async function runLogicalAction(opts: PodActionOptions, action: PodAction): Promise<number> {
  const targets = await actionTargets(opts, action);
  if (targets === null) {
    info(`nothing ${action === "archive" ? "archived" : "restored"}`);
    return EXIT.OK;
  }
  const state: LogicalPodState = action === "archive" ? "archived" : "active";
  let failures = 0;
  for (const target of targets) {
    if (target.logicalState === state) {
      info(`pod ${color.bold(target.id)} is already ${state}`);
      continue;
    }
    try {
      rememberLogicalPodState(opts.provider.name, target.id, state, opts.stateHome);
      info(
        action === "archive"
          ? `pod ${color.bold(target.id)} archived ${color.dim("(logical state only; automatic sandbox retention is unchanged)")}`
          : `pod ${color.bold(target.id)} restored ${color.dim("(attach starts the sandbox when needed)")}`,
      );
    } catch (e) {
      info(`could not ${action} ${target.id}: ${errorMessage(e)}`);
      failures += 1;
    }
  }
  return failures > 0 ? EXIT.FAILURE : EXIT.OK;
}

/** Archived is a user disposition; restore it before commands that enter or mutate its files. */
export function requireActivePod(target: TrackedPodInfo, action: string): void {
  if (target.logicalState !== "archived") return;
  throw new PiPodError(`pod ${target.id} is archived`, {
    hint: `run \`pi-pod restore ${target.id}\` before ${action}`,
  });
}

/**
 * The project this directory belongs to, or null when there is no project contract here.
 *
 * Null widens the listing to every pod rather than showing none: a directory without a
 * `.pi-pod/` is a reason to stop filtering, not a reason to claim the user has no pods.
 */
function projectOf(loaded: LoadedConfig): string | null {
  if (loaded.configPath === null) return null;
  return loaded.config.name ?? path.basename(loaded.projectRoot);
}
