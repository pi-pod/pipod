/**
 * src/account/pods.ts — pod management, account edition (account-mode-spec §7).
 *
 * Thin clients over the server's REST surface with the local commands' selection rules:
 * listings scope to the current project's pinned template, then its project identity, unless
 * --all; a bare `attach`/`send` means the repo's most recently active pod, and a pod names
 * itself by full id, short ref, legacy prefix, or name. Outside a repository the scope is
 * naturally the whole account.
 */
import * as path from "node:path";
import { CancelledError, EXIT, PiPodError } from "../errors.js";
import { withCapacityHint } from "./capacity-errors.js";
import { color, info, out, warn } from "../log.js";
import { confirm } from "../prompt.js";
import type { AccountClient, ApiPod, ApiTemplate } from "./api.js";
import {
  currentProjectName,
  currentProjectTemplateRef,
  localConfigView,
  resolveTemplate,
  runAccountLaunch,
  splitPiArgs,
  type AccountLaunchFlags,
} from "./launch.js";
import { runAccountSession } from "./session.js";
import { displayRef, isFullUuid, matchesRef } from "./ref.js";
import { withWorkstationWait } from "./workstation.js";
import { billingSummaryLine, type AccountBilling } from "./billing.js";
import { collectSendEntries } from "../send.js";

export interface AccountPodFlags {
  all: boolean;
  quiet: boolean;
  archived: boolean;
  yes: boolean;
  /** `list`/`archive --template <name|id>`: only the pods launched from that template. */
  template?: string | undefined;
  /** `archive --idle <duration>`: only pods whose last activity is older than this. */
  idle?: string | undefined;
  /** `archive --dry-run`: print the pods that would be archived; change nothing. */
  dryRun?: boolean | undefined;
}

const PAGE_LIMIT = 200;

/**
 * Every pod the query matches, not just the newest page. The server answers newest activity
 * first and caps a page at 200, so the pods that fall off a single page are exactly the ones
 * a stale ref or an idle sweep is after. `before` walks back by activity time; a full page
 * whose cursor stops moving ends the walk instead of looping on it.
 */
async function listAllPods(
  client: AccountClient,
  query: { project?: string | undefined; templateId?: string | undefined; includeGone?: boolean | undefined },
): Promise<{ pods: ApiPod[] }> {
  const pods: ApiPod[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await client.listPods({ mine: true, limit: PAGE_LIMIT, before, ...query });
    pods.push(...page.pods);
    if (page.pods.length < PAGE_LIMIT) return { pods };
    const cursor = activityStamp(page.pods.at(-1)!);
    if (cursor === before) return { pods };
    before = cursor;
  }
}

async function podsInScope(
  client: AccountClient,
  flags: { all: boolean; templateId?: string | undefined; includeGone?: boolean | undefined },
  cwd?: string,
): Promise<{ pods: ApiPod[] }> {
  const project = flags.all ? null : currentProjectName(cwd);
  return listAllPods(client, {
    ...(project ? { project } : {}),
    ...(flags.templateId ? { templateId: flags.templateId } : {}),
    ...(flags.includeGone ? { includeGone: true } : {}),
  });
}

/** When the pod last did something; creation stands in until it has. */
function activityStamp(pod: ApiPod): string {
  return pod.lastActivityAt ?? pod.createdAt;
}

const IDLE_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `--idle 4h` → milliseconds. One whole number, one unit; anything else is a usage error. */
export function parseIdleDuration(text: string): number {
  const match = /^(\d+)([mhd])$/i.exec(text);
  const count = match ? Number(match[1]) : 0;
  if (!match || count <= 0) {
    throw new PiPodError(`invalid --idle duration "${text}"`, {
      hint: "use a whole number with one unit: 30m, 4h, 2d",
      exitCode: EXIT.USAGE,
    });
  }
  return count * IDLE_UNIT_MS[match[2]!.toLowerCase()]!;
}

/** A pod with an unreadable timestamp is not provably idle, so a sweep leaves it alone. */
function idleLongerThan(pod: ApiPod, idleMs: number, now: number): boolean {
  const activity = Date.parse(activityStamp(pod));
  return Number.isFinite(activity) && activity < now - idleMs;
}

/** Oldest activity first; missing activity falls back to creation time. */
export function sortPodsByActivity(pods: ApiPod[]): ApiPod[] {
  const activityTime = (pod: ApiPod): number => {
    const parsed = Date.parse(activityStamp(pod));
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  return [...pods].sort((a, b) => activityTime(a) - activityTime(b));
}

/**
 * Listing order with nesting: roots and siblings are oldest-activity-first, and every pod
 * follows the pod it belongs to. The grouping edge prefers the machine (hostPodId) over the
 * launcher (parentPodId): co-located pods sit under the pod whose machine they share, which
 * is also the group's only real-provider member. A pod whose group anchor is not in the
 * listing (a project-scoped `ls`, or an older server) is shown as a root rather than hidden.
 */
export function orderPodsAsTree(pods: ApiPod[]): Array<{ pod: ApiPod; depth: number }> {
  const sorted = sortPodsByActivity(pods);
  const present = new Set(sorted.map((pod) => pod.id));
  const childrenOf = new Map<string, ApiPod[]>();
  const roots: ApiPod[] = [];
  for (const pod of sorted) {
    const anchorId = pod.hostPodId ?? pod.parentPodId ?? null;
    const anchor = anchorId && present.has(anchorId) ? anchorId : null;
    if (anchor === null) roots.push(pod);
    else childrenOf.set(anchor, [...(childrenOf.get(anchor) ?? []), pod]);
  }
  const ordered: Array<{ pod: ApiPod; depth: number }> = [];
  const visit = (pod: ApiPod, depth: number): void => {
    ordered.push({ pod, depth });
    for (const child of childrenOf.get(pod.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return ordered;
}

/** List output is command data, not a diagnostic, so pipelines receive it on stdout. */
function listOut(msg: string): void {
  out(`${color.cyan("pi pod")} ${msg}`);
}

export async function runAccountList(
  client: AccountClient,
  flags: AccountPodFlags,
  podRef?: string,
): Promise<number> {
  if (podRef) return runAccountGroupList(client, flags, podRef);
  // A project template pin is the default list scope. `--all` deliberately suppresses that
  // implicit filter, while an explicit `--template` remains authoritative alongside --all.
  const templateRef = flags.template ?? (flags.all ? null : currentProjectTemplateRef());
  const template = templateRef ? await resolveTemplate(client, templateRef) : null;
  // The plan line is SaaS-only and never worth a round trip of its own: ask for the
  // workstation block beside the pods, and let a server that has no such thing answer nothing.
  // A template belongs to the account, not to a repo, so naming one asks about the account:
  // the project the terminal happens to be sitting in does not narrow the answer further.
  const [scoped, billing] = await Promise.all([
    podsInScope(client, {
      all: flags.all || template !== null,
      ...(template ? { templateId: template.id } : {}),
    }),
    flags.quiet ? Promise.resolve(null) : client.accountBilling(),
  ]);
  // `/v1/me` is the only route that carries the block; absence hides the footer silently.
  let pods = scoped.pods;
  // A server that predates the filter ignores the query and answers with everything, which
  // would read as "every pod uses this template". The pods say who launched them; believe them.
  if (template) pods = pods.filter((pod) => pod.templateId === template.id);
  if (!flags.archived) pods = pods.filter((p) => p.state !== "archived");
  pods = sortPodsByActivity(pods);
  if (flags.quiet) {
    for (const pod of pods) out(pod.id);
    return 0;
  }
  if (pods.length === 0) {
    listOut(emptyListMessage(flags.all, template));
    renderBillingLine(billing);
    return 0;
  }
  listOut(template ? `pods from template ${template.name} on ${client.serverUrl}:` : `pods on ${client.serverUrl}:`);
  renderPodLines(pods);
  renderBillingLine(billing);
  return 0;
}

/**
 * The account's plan, active hours and spend cap — or nothing at all.
 *
 * This is the edition boundary in one function. The SaaS server meters a personal workstation
 * per user and reports it; the self-hosted server runs on hardware its operator already pays
 * for and reports none of it. Absence therefore prints nothing: no zeroes, no "unknown", no
 * empty heading. A self-hosted operator must never be shown a spend cap they do not have.
 */
function renderBillingLine(billing: AccountBilling | null): void {
  const line = billingSummaryLine(billing);
  if (line !== null) listOut(`  ${color.dim(line)}`);
}

/** `pipod list <pod>`: one machine's group — the pod and everything co-located on it. */
async function runAccountGroupList(
  client: AccountClient,
  flags: AccountPodFlags,
  podRef: string,
): Promise<number> {
  const named = await selectAccountPod(client, podRef, "list");
  const anchorId = named.hostPodId ?? named.id;
  const pods = (await listAllPods(client, {})).pods;
  const group = pods.filter(
    (pod) => (pod.id === anchorId || pod.hostPodId === anchorId) && (flags.archived || pod.state !== "archived"),
  );
  if (flags.quiet) {
    for (const pod of sortPodsByActivity(group)) out(pod.id);
    return 0;
  }
  const anchor = pods.find((pod) => pod.id === anchorId);
  listOut(`pods on ${anchor ? anchor.name : displayRef(anchorId, "pod")}'s machine:`);
  renderPodLines(group);
  return 0;
}

function renderPodLines(pods: ApiPod[]): void {
  for (const { pod, depth } of orderPodsAsTree(pods)) {
    const when = pod.lastActivityAt ?? pod.createdAt;
    const status = podStatusLabel(pod);
    // The storage label already says Stopped/Archived for asleep sandboxes; repeating the
    // `asleep` connection beside it adds noise, so it is shown only for other states.
    const storageAsleep = podStorageKind(pod) === "stopped-retained" || podStorageKind(pod) === "provider-archived";
    const connection = pod.connection && pod.connection !== "connected" && !(storageAsleep && pod.connection === "asleep")
      ? ` ${pod.connection}`
      : "";
    const indent = depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
    // The session name is the pod's mutable identity (rename and Pi's session naming update
    // it). Keep the immutable project visible when it adds context, but never substitute it
    // for the name: that made renamed pods look as though the rename had not happened.
    const label = pod.project && pod.project !== pod.name ? `${pod.name} (${pod.project})` : pod.name;
    // Where the pod lives: the provider for machine-backed pods, `on <host>` for co-located
    // ones — so the real-provider member of a group is visible as the machine's owner.
    const location = pod.location ?? pod.provider;
    listOut(`  ${color.bold(pad(displayRef(pod.id, "pod"), 12))}  ${pad(indent + label, 34)}  ${pad(status + connection, 38)}  ${pad(location, 14)}  ${ago(when)}`);
  }
}

/**
 * Storage-aware status vocabulary (cost-control plan §3.4). The logical state keeps its
 * hide semantics — `state=archived` stays hidden from active listings — while the label
 * names the physical truth the server reports in `sandboxState`:
 *
 * - `Stopped …`: active row, stopped sandbox. `attach` restarts it in seconds.
 * - `Archived — restores on next use`: provider-archived sandbox under an active row.
 *   Restore downloads and unpacks it (seconds-to-minutes depending on workspace size).
 * - `Archived — hidden …`: a logically archived row (`list --archived` shows it). The
 *   suffix names the sandbox layer when the server reports it.
 *
 * Single-provider build: the `sandbox` fleet holds a documented full local-disk
 * reservation per stopped workspace, so stopped rows always say "local disk retained".
 * A cold-storage claim needs sandbox-confirmed archive (`sandboxState=archived`);
 * a bare logically-hidden row claims nothing about storage.
 *
 * `sandboxState` is optional: older servers omit it and fall back to the logical state.
 */
export type PodStorageKind =
  | "running"
  | "starting"
  | "failed"
  | "stopped-retained"
  | "provider-archived"
  | "archived-hidden"
  | "archived-hidden-retained"
  | "archived-hidden-cold";

export function podStorageKind(pod: ApiPod): PodStorageKind {
  if (pod.preparationPhase === "failed") return "failed";
  if (pod.initializing) return "starting";
  const sandbox = pod.sandboxState ?? null;
  if (pod.state === "archived") {
    if (sandbox === "stopped") return "archived-hidden-retained";
    if (sandbox === "archived") return "archived-hidden-cold";
    return "archived-hidden";
  }
  if (sandbox === "stopped") return "stopped-retained";
  if (sandbox === "archived") return "provider-archived";
  return "running";
}

export function podStatusLabel(pod: ApiPod): string {
  if (pod.preparationPhase === "failed") return "failed";
  if (pod.preparationPhase === "waiting-for-capacity") return "waiting for capacity";
  if (pod.initializing) return pod.preparationPhase ?? "preparing";
  switch (podStorageKind(pod)) {
    case "stopped-retained":
      return "Stopped — local disk retained";
    case "provider-archived":
      return "Archived — restores on next use";
    case "archived-hidden-retained":
      return "Archived — hidden · disk retained";
    case "archived-hidden-cold":
      return "Archived — hidden · cold storage";
    case "archived-hidden":
      return "archived";
    case "failed":
      return "failed";
    case "starting":
      return pod.preparationPhase ?? "preparing";
    case "running":
      return pod.state;
  }
}

/** Wake/restore cost hint for the pod's current storage state, or null when generic. */
export function podRestoreHint(pod: ApiPod): string | null {
  switch (podStorageKind(pod)) {
    case "stopped-retained":
      return "attach restarts it in seconds";
    case "provider-archived":
    case "archived-hidden-retained":
    case "archived-hidden-cold":
    case "archived-hidden":
      return "restore downloads it on next use (seconds-to-minutes depending on workspace size)";
    default:
      return null;
  }
}

/**
 * An empty listing names the scope that came up empty, so the next move is obvious. A named
 * template is that scope on its own — offering "--all for every project" there would promise
 * pods that widening cannot find, since nothing was narrowed by project to begin with.
 */
function emptyListMessage(all: boolean, template: ApiTemplate | null): string {
  if (template) return `no pods from template ${template.name}`;
  return !all && currentProjectName() !== null
    ? "no pods for this project (use --all for every project)"
    : "no pods";
}

/** Full id, short ref, legacy prefix, or name — or this scope's only pod when omitted. */
export async function selectAccountPod(
  client: AccountClient,
  podRef: string | undefined,
  action: string,
  cwd?: string,
): Promise<ApiPod> {
  if (podRef) {
    // A full id needs no listing: the server answers by id no matter how many pods have been
    // active more recently, so an old pod stays reachable by the ref `list` once printed.
    if (isFullUuid(podRef)) return client.getPod(podRef.toLowerCase());
    const pods = (await listAllPods(client, {})).pods;

    const named = pods.filter((pod) => pod.name === podRef);
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw ambiguousPodRef(podRef, named);

    const matches = pods.filter((pod) => matchesRef(pod.id, podRef));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw ambiguousPodRef(podRef, matches);
    throw new PiPodError(`no pod matches "${podRef}"`, { hint: "see `pipod list --all`" });
  }
  const pods = (await podsInScope(client, { all: false }, cwd)).pods;
  if (pods.length === 0) {
    throw new PiPodError(`no pod ${currentProjectName(cwd) ? "for this project " : ""}to ${action}`, {
      hint: "launch one with `pipod`, or name a pod ref from `pipod list --all`",
    });
  }
  if (pods.length > 1) {
    throw new PiPodError(`${currentProjectName(cwd) ? "this project" : "this account"} has ${pods.length} pods; name the one to ${action}`, {
      hint: `choose a ref from:\n${podChoiceLines(pods)}`,
    });
  }
  return pods[0]!;
}

function ambiguousPodRef(ref: string, pods: ApiPod[]): PiPodError {
  return new PiPodError(`"${ref}" matches ${pods.length} pods`, {
    hint: `use a longer ref:\n${podChoiceLines(pods)}`,
  });
}

function podChoiceLines(pods: ApiPod[]): string {
  const refs = pods.map((pod) => displayRef(pod.id, "pod"));
  const counts = new Map<string, number>();
  for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  return pods
    .map((pod, index) => {
      const ref = refs[index]!;
      const unambiguousRef = counts.get(ref)! > 1 ? pod.id : ref;
      return `  ${unambiguousRef}  ${pod.name}  (${pod.state})`;
    })
    .join("\n");
}

export async function runAccountPodAction(
  client: AccountClient,
  args: string[],
  flags: AccountPodFlags,
  action: "archive" | "restore",
): Promise<number> {
  // The parser fills these flags for restore too; only archive sweeps and dry-runs, so restore
  // reads none of them and keeps `--all` as its single bulk selector.
  const idleMs = action === "archive" && flags.idle !== undefined ? parseIdleDuration(flags.idle) : null;
  const dryRun = action === "archive" && flags.dryRun === true;
  const filtered = action === "archive" && (flags.template !== undefined || idleMs !== null);
  if (flags.all && args.length > 0) {
    throw new PiPodError(`--all ${action}s every pod, so it cannot be combined with pod ids`, {
      hint: `drop --all to ${action} just the pods you named`,
    });
  }
  if (filtered && args.length > 0) {
    throw new PiPodError("--template and --idle choose the pods to archive, so they cannot be combined with pod ids", {
      hint: "drop the pod ids to archive whatever matches, or drop the filters to archive just the pods you named",
      exitCode: EXIT.USAGE,
    });
  }
  const targets: ApiPod[] = [];
  if (flags.all || filtered) {
    const { pods, empty } = action === "archive"
      ? await archiveSweep(client, flags, idleMs)
      : await restoreSweep(client);
    if (pods.length === 0) {
      empty();
      return 0;
    }
    targets.push(...pods);
    if (!dryRun) {
      const ok = await confirm(`${action} ${targets.length} pod(s)?`, {
        nonInteractiveDefault: true,
        assumeYes: flags.yes,
      });
      if (!ok) return 1;
    }
  } else if (args.length > 0) {
    const resolved = await Promise.all(args.map((ref) => selectAccountPod(client, ref, action)));
    const seen = new Set<string>();
    for (const pod of resolved) {
      if (!seen.has(pod.id)) targets.push(pod);
      seen.add(pod.id);
    }
  } else {
    targets.push(await selectAccountPod(client, undefined, action));
  }
  if (dryRun) {
    renderPodLines(targets);
    listOut(`would archive ${targets.length} pod(s)`);
    return 0;
  }
  for (const pod of targets) {
    let result: { state: string; cascaded?: string[] };
    try {
      result = await client.podCommand(pod.id, action);
    } catch (error) {
      throw withCapacityHint(error);
    }
    const { state, cascaded } = result;
    const group =
      cascaded && cascaded.length > 0
        ? ` (and ${cascaded.length} co-located pod${cascaded.length === 1 ? "" : "s"})`
        : "";
    if (action === "archive") {
      info(
        `pod ${displayRef(pod.id, "pod")}: logically archived${group} — hidden from active lists ` +
          "(`pipod list --archived` shows it); files are retained and cold archive follows after " +
          "60 stopped minutes; `pipod restore` returns it (stopped restarts in seconds on a running workstation; archived restores in seconds-to-minutes depending on size)",
      );
    } else {
      const restoreHint =
        pod.sandboxState === "archived"
          ? " — attach starts its sandbox when needed (archived restores in seconds-to-minutes depending on size)"
          : " — attach starts its sandbox when needed (stopped restarts in seconds on a running workstation; a sleeping workstation takes several minutes to start)";
      info(`pod ${displayRef(pod.id, "pod")}: ${state}${group}${restoreHint}`);
    }
  }
  return 0;
}

/**
 * `archive --all/--template/--idle`: the pods a sweep would archive, oldest activity first so
 * a dry-run reads like `list`. The scope is list's own rule — explicit template, else the
 * project's pin, else the project, with `--all` widening to the account — rather than a
 * second policy that could drift from what `list` just showed. Already-archived pods are
 * never targets, so an empty answer names the filter that came up empty.
 */
async function archiveSweep(
  client: AccountClient,
  flags: AccountPodFlags,
  idleMs: number | null,
): Promise<{ pods: ApiPod[]; empty: () => void }> {
  const templateRef = flags.template ?? (flags.all ? null : currentProjectTemplateRef());
  const template = templateRef ? await resolveTemplate(client, templateRef) : null;
  let pods = (await podsInScope(client, {
    all: flags.all || template !== null,
    ...(template ? { templateId: template.id } : {}),
  })).pods;
  if (template) pods = pods.filter((pod) => pod.templateId === template.id);
  pods = pods.filter((pod) => pod.state !== "archived");
  const now = Date.now();
  if (idleMs !== null) pods = pods.filter((pod) => idleLongerThan(pod, idleMs, now));
  const scope = template
    ? ` from template ${template.name}`
    : !flags.all && currentProjectName() !== null
      ? " for this project"
      : "";
  const empty = (): void => {
    if (idleMs !== null) listOut(`no pods${scope} idle longer than ${flags.idle}`);
    else if (template) listOut(`no pods${scope}`);
    else info("every pod is already archived");
  };
  return { pods: sortPodsByActivity(pods), empty };
}

/** `restore --all`: every archived pod on the account. */
async function restoreSweep(client: AccountClient): Promise<{ pods: ApiPod[]; empty: () => void }> {
  const scope = (await podsInScope(client, { all: true })).pods;
  return {
    pods: scope.filter((pod) => pod.state !== "active"),
    empty: () => info("every pod is already active"),
  };
}

/** `pipod stop`: release compute now; the filesystem survives and attach restarts the pod. */
export async function runAccountStop(
  client: AccountClient,
  args: string[],
  flags: AccountPodFlags,
): Promise<number> {
  const targets: ApiPod[] = [];
  if (args.length > 0) {
    const resolved = await Promise.all(args.map((ref) => selectAccountPod(client, ref, "stop")));
    const seen = new Set<string>();
    for (const pod of resolved) {
      if (!seen.has(pod.id)) targets.push(pod);
      seen.add(pod.id);
    }
  } else {
    targets.push(await selectAccountPod(client, undefined, "stop"));
  }
  for (const pod of targets) {
    if (pod.state !== "active") {
      info(`pod ${displayRef(pod.id, "pod")} is archived — nothing to stop`);
      continue;
    }
    let state: string;
    try {
      ({ state } = await client.podCommand(pod.id, "stop"));
    } catch (error) {
      throw withCapacityHint(error);
    }
    info(`pod ${displayRef(pod.id, "pod")}: ${state} — Stopped, local disk retained; \`pipod attach ${displayRef(pod.id, "pod")}\` restarts it in seconds; cold archive follows after 60 stopped minutes`);
  }
  return 0;
}

export async function runAccountFork(
  client: AccountClient,
  args: string[],
  flags: AccountLaunchFlags & { session?: string },
  piArgs: string[],
): Promise<number> {
  if (args.length !== 1) {
    throw new PiPodError("usage: pipod fork <pod> [launch options]", { exitCode: EXIT.USAGE });
  }
  const source = await selectAccountPod(client, args[0], "fork");
  return runAccountLaunch({
    client,
    flags: {
      ...flags,
      reuse: false,
      forkFrom: {
        podId: source.id,
        ...(flags.session ? { sessionPath: flags.session } : {}),
      },
    },
    piArgs,
  });
}

export async function runAccountRename(client: AccountClient, args: string[]): Promise<number> {
  if (args.length !== 2) {
    throw new PiPodError("usage: pipod rename <pod> <new-name>");
  }
  const pod = await selectAccountPod(client, args[0], "rename");
  await client.renamePod(pod.id, args[1]!);
  info(`pod ${displayRef(pod.id, "pod")} renamed to ${args[1]}`);
  return 0;
}

/** The server's worker owns retention (§7); gc surfaces state and offers the delete half. */
export async function runAccountGc(
  client: AccountClient,
  flags: AccountPodFlags & { destroy: boolean },
): Promise<number> {
  // includeGone: failed launches that never acquired compute converge to
  // archived+gone, which default listings omit — gc must still offer them.
  const pods = (await podsInScope(client, { all: true, includeGone: true })).pods;
  const archived = pods.filter((p) => p.state === "archived");
  const unavailable = pods.filter(
    (p) => p.state === "active" && !p.ready && !p.initializing && p.stateReason !== null,
  );
  info("the server applies automatic inactivity (15 min idle stop) and storage policy (60 min archive) on its own schedule");
  if (archived.length === 0 && unavailable.length === 0) {
    info("nothing archived or unavailable to clean up");
    return 0;
  }
  if (!flags.destroy) {
    for (const pod of [...archived, ...unavailable]) {
      info(`  ${displayRef(pod.id, "pod")}  ${pad(pod.project ?? pod.name, 30)}  ${pod.state}`);
    }
    info("pass --delete to remove them");
    return 0;
  }
  const targets = [...archived, ...unavailable];
  const ok = await confirm(`delete ${targets.length} pod(s) permanently?`, {
    nonInteractiveDefault: false,
    assumeYes: flags.yes,
  });
  if (!ok) return 1;
  // Deepest first, so reclaiming a whole tree never trips the server's refusal to orphan a
  // pod's live children on the pods it is about to delete anyway.
  const deepestFirst = [...targets].sort((a, b) => (b.lineageDepth ?? 0) - (a.lineageDepth ?? 0));
  for (const pod of deepestFirst) {
    try {
      await client.deletePod(pod.id);
    } catch (e) {
      // A live child outside this cleanup is somebody's running work: keep it, do not cascade.
      if (e instanceof PiPodError && e.status === 409) {
        warn(`kept pod ${displayRef(pod.id, "pod")}: pods it launched are still running`);
        continue;
      }
      throw e;
    }
    info(`deleted pod ${displayRef(pod.id, "pod")}`);
  }
  return 0;
}

export interface AccountAttachFlags {
  yes?: boolean;
}

export async function runAccountAttach(
  client: AccountClient,
  args: string[],
  piArgs: string[],
  flags: AccountAttachFlags,
): Promise<number> {
  const { prompt, extraArgs, tuiMode } = splitPiArgs(piArgs);
  if (extraArgs.length > 0) {
    throw new PiPodError(`pi flags are not configurable per-attach in account mode: ${extraArgs.join(" ")}`, {
      hint: "the session is shared across surfaces; set Pi options in config (`pi` key)",
    });
  }
  const pod = await selectAccountPod(client, args[0], "attach");
  if (pod.state === "archived") {
    const ok = await confirm(`pod ${displayRef(pod.id, "pod")} is archived — restore and attach?`, {
      nonInteractiveDefault: true,
      assumeYes: flags.yes,
    });
    if (!ok) throw new CancelledError("attach cancelled");
    try {
      // A restore needs the workstation the workspace lives on, so it is a wake in disguise.
      await withWorkstationWait(client, () => client.podCommand(pod.id, "restore"));
    } catch (error) {
      throw withCapacityHint(error);
    }
  }
  const result = await runAccountSession({
    client,
    pod,
    loadContext: async () => {
      const { config, projectRoot } = await localConfigView(client, process.cwd(), {
        templateId: pod.templateId ?? null,
      });
      return { config, hostCwd: projectRoot ?? process.cwd() };
    },
    startupPrompt: prompt,
    ...(tuiMode ? { tuiMode } : {}),
  });
  return result.exitCode;
}


export async function runAccountSend(
  client: AccountClient,
  args: string[],
  flags: { yes?: boolean } = {},
) : Promise<number> {
  const [podRef, sourcePath] = args.length >= 2 ? [args[0], args[1]!] : [undefined, args[0]];
  if (!sourcePath) {
    throw new PiPodError("usage: pipod send [pod] <path>");
  }
  const source = path.resolve(sourcePath);
  const sourceName = path.basename(source);
  if (sourceName === "") {
    throw new PiPodError(`cannot send the filesystem root ${source}`, {
      hint: "name a file or directory inside it instead",
    });
  }

  const pod = await selectAccountPod(client, podRef, "send");
  if (pod.state === "archived") {
    const ok = await confirm(`pod ${displayRef(pod.id, "pod")} is archived — restore and send?`, {
      nonInteractiveDefault: false,
      assumeYes: flags.yes,
    });
    if (!ok) throw new CancelledError("send cancelled");
    try {
      await withWorkstationWait(client, () => client.podCommand(pod.id, "restore"));
    } catch (error) {
      throw withCapacityHint(error);
    }
  }

  const { entries } = collectSendEntries(source, { relBase: sourceName, label: sourcePath });

  info(`sending ${entries.length} entr${entries.length === 1 ? "y" : "ies"} → pod ${displayRef(pod.id, "pod")}`);
  try {
    // A send is what wakes a sleeping personal workstation; the refusal arrives before any
    // byte is written, so the same request is safe to make again once the machine is up.
    await withWorkstationWait(client, () =>
      client.request(`/pods/${pod.id}/files`, { method: "POST", body: { entries } }),
    );
  } catch (e) {
    if (e instanceof PiPodError && e.status === 403 && /pod token|send files/i.test(e.message)) {
      throw new PiPodError(
        "this server rejects pod-token file send; seed files in the project launch overlay or use a user-authenticated host",
        { status: 403, cause: e },
      );
    }
    throw e;
  }
  info("sent");
  return 0;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
