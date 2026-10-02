import { CancelledError, PiPodError } from "../errors.js";
import {
  capacityReasonHint,
  capacityReasonShort,
  capacityWaitTerminalHint,
} from "./capacity-errors.js";
import { color, debug, info, step, warn } from "../log.js";
import { withWorkstationWait, type WorkstationWaitOptions } from "./workstation.js";
import type { AccountClient, ApiPod, LaunchReport } from "./api.js";
import type { AccountLaunchPlan } from "./launch-types.js";
import { displayRef } from "./ref.js";

export function printLaunchReport(report: LaunchReport, pod: ApiPod): void {
  for (const clamp of report.clamps) {
    warn(`org policy: ${clamp.path} ${JSON.stringify(clamp.from)} → ${JSON.stringify(clamp.to)} (${clamp.reason})`);
  }
  const configProvenance = report.configProvenance ?? pod.resolvedConfig.configProvenance ?? [];
  if (configProvenance.length > 0) {
    info("settings provenance (later layers win):");
    for (const entry of configProvenance) {
      const contested = entry.over.length > 0
        ? color.dim(`  (over ${entry.over.map(displayReportLayer).join(", ")})`)
        : "";
      info(`  ${entry.path} ← ${displayReportLayer(entry.winner)}${contested}`);
    }
  }
  if (report.secretKeys.length > 0) {
    const scopes = report.secretScopes ?? pod.resolvedConfig.secretScopes ?? {};
    const shadows = report.secretShadows ?? pod.resolvedConfig.secretShadows ?? {};
    const labeled = report.secretKeys.map((key) => {
      const scoped = scopes[key] ? `${key}(${scopes[key]})` : key;
      const lost = shadows[key];
      return lost?.length ? `${scoped}[over ${lost.join(",")}]` : scoped;
    });
    info(`secrets traveling: ${labeled.join(", ")}`);
  }
  for (const warning of report.warnings) warn(warning);
  const action = pod.preparationPhase === "preparing-image" ? "preparing its runtime image" : "provisioning";
  info(`pod ${color.bold(displayRef(pod.id, "pod"))} (${pod.provider}) ${action}…`);
}

/**
 * The pod is already provisioning on the server, so a blip on the polling connection says
 * nothing about the launch. Give up on it only once the server has been unreachable long
 * enough to be a real outage, rather than abandoning a healthy pod on one bad response.
 */
function displayReportLayer(layer: string): string {
  if (layer === "org") return "org defaults";
  if (layer === "user") return "user defaults";
  if (layer === "project") return "project preview";
  if (layer === "policy" || layer === "org-policy") return "org policy";
  return layer;
}

export const PROVISION_BLIP_GRACE_MS = 90_000;

/** How long a supporting server may hold one readiness poll open before answering. */
export const READINESS_LONG_POLL_MS = 20_000;

/**
 * Hint for the `capacity_wait_expired` paths. An expired wait never acquired
 * compute, so the row converges to provider_state=gone: hidden from
 * `pipod list` (only includeGone paths such as `gc` see it) and needing no
 * cleanup. The generic `stateReason` throw below keeps its listable-copy hint.
 */
export const CAPACITY_WAIT_EXPIRED_HINT =
  "the pod never acquired compute and is hidden from `pipod list`; retry the launch when capacity frees (`pipod gc` reports hidden rows)";

/** Poll provider-agnostic readiness while narrating init progress. */
export async function watchProvisioning(
  client: AccountClient,
  podId: string,
  timing: {
    pollMs?: number;
    retryMs?: number;
    blipGraceMs?: number;
    waitMs?: number;
    timeoutMs?: number;
    cancelled?: () => boolean;
  } = {},
): Promise<ApiPod> {
  const pollMs = timing.pollMs ?? 1000;
  const retryMs = timing.retryMs ?? 2000;
  const blipGraceMs = timing.blipGraceMs ?? PROVISION_BLIP_GRACE_MS;
  let reportedWaiting = false;
  const reported = new Set<string>();
  // Last announced capacity-wait reason: re-announce only when the reason changes, so a
  // 60-second wait narrates once instead of once per poll. Progress re-renders at most
  // every 5s (the server's bounded wait with validated reason/numbers/deadlineAt)
  // so a 60s wait is visibly alive, not stalled output.
  let announcedWaitReason: string | null = null;
  let lastWaitLogAt = 0;
  let lastWaitAttempts = -1;
  const deadline = Date.now() + 30 * 60 * 1000;
  let blipSince: number | null = null;
  let reportedBlip = false;
  for (;;) {
    if (timing.cancelled?.()) throw new CancelledError("interrupted");
    let pod: ApiPod;
    const polledAt = Date.now();
    try {
      // A supporting server holds the request until the pod changes (long poll), so
      // progress lands the moment it happens instead of on the next tick.
      pod = await client.getPod(podId, {
        waitMs: timing.waitMs ?? READINESS_LONG_POLL_MS,
        ...(timing.timeoutMs !== undefined ? { timeoutMs: timing.timeoutMs } : {}),
      });
      if (timing.cancelled?.()) throw new CancelledError("interrupted");
      if (blipSince !== null) {
        if (reportedBlip) step("launch", "server is back");
        blipSince = null;
        reportedBlip = false;
      }
    } catch (e) {
      if (timing.cancelled?.()) throw new CancelledError("interrupted");
      const transient = e instanceof PiPodError && e.transient;
      if (!transient) throw e;
      const now = Date.now();
      blipSince ??= now;
      if (now - blipSince > blipGraceMs) {
        const ref = displayRef(podId, "pod");
        throw new PiPodError(
          `lost contact with the server while pod ${ref} was still provisioning`,
          {
            hint: `provisioning continues on the server — reattach with \`pipod attach ${ref}\``,
            transient: true,
            cause: e,
          },
        );
      }
      if (!reportedBlip) {
        reportedBlip = true;
        warn(`lost contact with the server — the pod keeps provisioning; still watching (${e.message})`);
      }
      await new Promise((r) => setTimeout(r, retryMs));
      continue;
    }
    const phase = pod.preparationPhase;
    if (phase === "preparing-image" && !reported.has(phase)) {
      reported.add(phase);
      reportedWaiting = true;
      const ref = pod.resolvedConfig.image ?? "the updated runtime";
      step("image", `preparing ${ref} (first launch after this runtime update; usually a few minutes)`);
    } else if (phase === "provisioning-sandbox" && !reported.has(phase)) {
      reported.add(phase);
      reportedWaiting = true;
      step("launch", "runtime image is ready; preparing the sandbox");
    } else if (!phase && !pod.ready && !reportedWaiting) {
      // Backward compatibility with servers that predate preparationPhase.
      reportedWaiting = true;
      step("launch", "sandbox is getting ready");
    }
    for (const s of pod.resolvedConfig.initSteps ?? []) {
      const key = `${s.scope}:${s.status}`;
      if (s.status !== "pending" && !reported.has(key)) {
        reported.add(key);
        step("init", `${s.scope} init script: ${s.status}`);
      }
    }
    if (pod.ready) return pod;
    // Bounded capacity wait (capacity contract §1): the request is
    // valid and entitled, holding one concurrency slot but no host reservation.
    // Older servers omit the field — that reads exactly like no wait and flows
    // through today's path. New servers send preparationPhase `waiting-for-capacity`
    // with validated reason|required|available|unit|deadlineAt|waitedSeconds plus
    // terminal stateReasonCode `capacity_wait_expired`.
    const wait = pod.capacityWait ?? null;
    const waitingPhase = phase === "waiting-for-capacity";
    if (wait !== null && wait.state === "waiting") {
      const key = wait.reason ?? "capacity";
      const now = Date.now();
      if (announcedWaitReason !== key) {
        announcedWaitReason = key;
        lastWaitLogAt = now;
        lastWaitAttempts = wait.attempts;
        reportedWaiting = true;
        // Contract copy: [launch] waiting for fleet
        // capacity: <reason> (needs X, free Y) — up to Ns, with a
        // countdown. The trailing `waiting for capacity` keeps the legacy
        // copy greppable (older tooling/tests match it exactly once per reason).
        step("launch", `waiting for fleet capacity: ${describeCapacityWaitLine(wait)} (waiting for capacity)`);
      } else if (
        now - lastWaitLogAt >= 5000 &&
        wait.attempts >= lastWaitAttempts + 5
      ) {
        lastWaitLogAt = now;
        lastWaitAttempts = wait.attempts;
        step("launch", `still waiting for fleet capacity: ${describeCapacityWaitLine(wait)} (waiting for capacity)`);
      } else if (now - lastWaitLogAt >= 5000 && wait.attempts === lastWaitAttempts) {
        // Heartbeat countdown even when attempts stall (long-poll holds): at most every 5s.
        lastWaitLogAt = now;
        step("launch", `still waiting for fleet capacity: ${describeCapacityWaitLine(wait)} (waiting for capacity)`);
      }
    } else if (waitingPhase && wait === null) {
      // New phase without a wait view (should not happen; server always sends
      // both) — render the phase label additively, never as raw provider text.
      const now = Date.now();
      if (announcedWaitReason !== "fleet_capacity") {
        announcedWaitReason = "fleet_capacity";
        lastWaitLogAt = now;
        reportedWaiting = true;
        step("launch", "waiting for fleet capacity: fleet_capacity — up to 60s (~60s left) (waiting for capacity)");
      } else if (now - lastWaitLogAt >= 5000) {
        lastWaitLogAt = now;
        step("launch", "still waiting for fleet capacity: fleet_capacity — up to 60s (~60s left) (waiting for capacity)");
      }
    } else if (wait !== null && wait.state === "admitted" && announcedWaitReason !== null) {
      announcedWaitReason = null;
      step("capacity", "capacity found — provisioning continues");
    } else if (wait !== null && (wait.state === "expired" || wait.state === "cancelled")) {
      // Terminal wait states are FINAL for this operation: never transient (no blip
      // retry), never a duplicate launch — a new launch may be tried by hand. A wake
      // ends on an existing workspace, so its copy must never say "launch again".
      // Typed expiry (server stateReasonCode) reads as retry-later copy.
      if (wait.state === "expired" && (pod as ApiPod).stateReasonCode === "capacity_wait_expired") {
        throw new PiPodError(describeLaunchFailure(pod), {
          hint: CAPACITY_WAIT_EXPIRED_HINT,
          transient: false,
        });
      }
      const wake = wait.kind === "wake";
      const operation = wake ? "wake" : "launch";
      throw new PiPodError(
        wait.state === "expired"
          ? `${operation} failed: capacity wait expired (${capacityReasonShort(wait.reason)} pressure)`
          : `${operation} failed: capacity wait was cancelled`,
        {
          hint: capacityWaitTerminalHint(wait.state, wait.reason, wait.kind),
          transient: false,
        },
      );
    }
    // A refused reuse ends this watch — the pod went back to stopped and the caller owes a
    // fresh launch; waiting longer would time out on a pod that will never become ready.
    if (pod.resolvedConfig.reuseRefused) return pod;
    if ((pod as ApiPod).stateReasonCode === "capacity_wait_expired") {
      throw new PiPodError(describeLaunchFailure(pod), {
        hint: CAPACITY_WAIT_EXPIRED_HINT,
      });
    }
    if (pod.stateReason) {
      throw new PiPodError(`launch failed: ${pod.stateReason}`, { hint: await launchFailureHint(client, pod) });
    }
    if (Date.now() > deadline) throw new PiPodError("launch timed out after 30 minutes");
    // Pace only what the server answered immediately — an older server that ignores the
    // long poll, or a change that returned at once. A held request needs no extra sleep.
    const elapsed = Date.now() - polledAt;
    if (elapsed < pollMs) await new Promise((r) => setTimeout(r, pollMs - elapsed));
  }
}

/**
 * What to do about a failed launch. A full host is the common case on a self-hosted server:
 * every running pod holds its whole memory ceiling until it stops, so name the caller's own.
 */
async function launchFailureHint(client: AccountClient, failed: ApiPod): Promise<string> {
  if (!/admission_denied\b.*\bat capacity\b/.test(failed.stateReason ?? "")) {
    return "`pipod list` shows the pod; delete it with `pipod gc --delete` once diagnosed";
  }
  const { pods } = await client.listPods({ mine: true }).catch(() => ({ pods: [] as ApiPod[] }));
  const running = pods.filter(
    (p) => p.id !== failed.id && p.state === "active" && p.ready && p.sandboxState !== "stopped" && p.sandboxState !== "archived",
  );
  if (running.length === 0) return "the server is full with other people's pods; try again when one stops";
  const names = running.map((p) => `${displayRef(p.id, "pod")} (${p.name})`).join(", ");
  return `the server is full; stop a pod you are not using — ${names} — with \`pipod stop <pod>\`, then launch again`;
}

/** Translate compatibility errors for request features that require a matching server. */
async function launchWithCompatibilityErrors(
  client: AccountClient,
  body: Parameters<AccountClient["launch"]>[0],
): Promise<{ pod: ApiPod; report: LaunchReport }> {
  try {
    return await client.launch(body);
  } catch (error) {
    if (
      body.workspaceSeed &&
      error instanceof PiPodError &&
      error.status === 400 &&
      /(?:unrecognized|unknown|unexpected)[^\n]*workspaceSeed|workspaceSeed[^\n]*(?:unrecognized|unknown|unexpected)/i.test(error.message)
    ) {
      // The seed gate is an optimization, not a requirement: a server that predates it starts
      // Pi immediately and the seed lands afterwards, exactly as configured projects always did.
      debug("the server predates the workspace seed gate — launching without it");
      const { workspaceSeed: _gate, ...ungated } = body;
      return await client.launch(ungated);
    }
    if (
      body.placement &&
      error instanceof PiPodError &&
      error.status === 400 &&
      /(?:unrecognized|unknown|unexpected)[^\n]*placement|placement[^\n]*(?:unrecognized|unknown|unexpected)/i.test(error.message)
    ) {
      throw new PiPodError("the pi pod server does not support co-located pods", {
        hint: "deploy the matching pi pod server before using `--on`",
        cause: error,
        status: error.status,
      });
    }
    if (
      body.forkFrom &&
      error instanceof PiPodError &&
      error.status === 400 &&
      /(?:unrecognized|unknown|unexpected)[^\n]*forkFrom|forkFrom[^\n]*(?:unrecognized|unknown|unexpected)/i.test(error.message)
    ) {
      throw new PiPodError("the pi pod server does not support forking a session into a new pod", {
        hint: "deploy the matching pi pod server before using `pipod fork`",
        cause: error,
        status: error.status,
      });
    }
    throw error;
  }
}

/**
 * A launch that dies on the wire leaves two possibilities — the request never arrived, or it
 * arrived and the answer was lost on the way back — and only the first may be retried blindly.
 * The server goes away for a few seconds on every deploy, which is too little to throw away a
 * launch over and more than enough to lose a reply, so neither giving up nor relaunching is
 * right on its own.
 *
 * The pod list settles it. Ids taken before the attempt turn "did my launch land?" into a
 * question the server can answer once it is back: a pod that was not there before is the lost
 * launch, adopted as if its reply had arrived, and only its absence sends a second request.
 * The cost is one extra call per launch, paid against the alternative of a duplicate pod that
 * bills until someone notices it.
 */
export const LAUNCH_BLIP_GRACE_MS = 90_000;

export async function launchRidingOutBlips(
  client: AccountClient,
  plan: AccountLaunchPlan,
  body: Parameters<AccountClient["launch"]>[0],
  timing: {
    retryMs?: number;
    blipGraceMs?: number;
    cancelled?: () => boolean;
    /** Test seam for the workstation wait; production uses its own measured bounds. */
    workstation?: WorkstationWaitOptions;
  } = {},
): Promise<{ pod: ApiPod; report: LaunchReport }> {
  const retryMs = timing.retryMs ?? 2000;
  const blipGraceMs = timing.blipGraceMs ?? LAUNCH_BLIP_GRACE_MS;
  const before = await podsForThisLaunch(client, plan, body.project?.name ?? null);
  const knownIds = before ? new Set(before.map((pod) => pod.id)) : null;
  let blipSince: number | null = null;
  let announced = false;
  for (;;) {
    if (timing.cancelled?.()) throw new CancelledError("interrupted");
    try {
      // A personal workstation that is asleep or coming up refuses the launch with a typed
      // 503 before any pod row exists, so asking again is free and creates nothing twice.
      // It has to be handled here rather than below: the refusal is a 503, which the blip
      // path would read as a lost connection and narrate as "lost contact with the server"
      // for ninety seconds before failing a launch that was only ever waiting on a machine.
      return await withWorkstationWait(
        client,
        () => launchWithCompatibilityErrors(client, body),
        {
          ...(timing.cancelled ? { cancelled: timing.cancelled } : {}),
          ...timing.workstation,
          // A lost launch reply is not a typed 503. Do not issue the POST again from here.
          replayTransport: false,
        },
      );
    } catch (error) {
      // Without a before-picture there is no way to tell a lost launch from one that never
      // happened, and guessing wrong costs a pod — so one bad connection stays fatal.
      if (!(error instanceof PiPodError) || !error.transient || !knownIds) throw error;
      blipSince ??= Date.now();
      const deadline = blipSince + blipGraceMs;
      if (!announced) {
        announced = true;
        warn(`lost contact with the server while launching — asking whether the pod was created (${error.message})`);
      }
      let landed: ApiPod[] | null = null;
      while (!landed) {
        // `>=`, not `>`: the deadline is the instant the window closes, and a zero window has
        // to mean zero retries. With `>` a whole pass could run inside one millisecond tick
        // and buy itself a retry the grace period never granted.
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        landed = await podsForThisLaunch(client, plan, body.project?.name ?? null);
      }
      const fresh = landed.filter((pod) => !knownIds.has(pod.id));
      if (fresh.length === 1) {
        const pod = fresh[0]!;
        step("launch", `the launch landed before the connection dropped — continuing with pod ${color.bold(displayRef(pod.id, "pod"))}`);
        // The launch-time warnings went down with the reply; the pod carries the rest.
        return { pod, report: { clamps: pod.resolvedConfig.clamps, secretKeys: pod.resolvedConfig.secretKeys, warnings: [] } };
      }
      if (fresh.length > 1) {
        throw new PiPodError("the server gained more than one pod for this project while the launch was in flight", {
          hint: `pick one with \`pipod attach\` rather than launch again: ${fresh.map((pod) => displayRef(pod.id, "pod")).join(", ")}`,
          cause: error,
        });
      }
      if (timing.cancelled?.()) throw new CancelledError("interrupted");
      // An empty list is not proof the original POST cannot still commit. Do not issue another.
      throw new PiPodError("the launch request did not return, and the server does not show a pod from it", {
        hint: "the request may still be committing; do not launch again until you confirm no pod was created",
        code: "launch_unresolved",
        transient: false,
        cause: error,
      });
    }
  }
}

/** This launch's identity among the caller's pods, or null when the server cannot say. */
async function podsForThisLaunch(client: AccountClient, plan: AccountLaunchPlan, project: string | null): Promise<ApiPod[] | null> {
  try {
    const { pods } = await client.listPods({
      mine: true,
      state: "active",
    });
    return pods.filter((pod) => pod.templateId === (plan.templateId ?? null) && pod.project === project);
  } catch (e) {
    debug(`could not list this project's pods: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * §6.5: pick this project's most recently active stopped pod and ask the server to
 * relaunch onto its warm disk. Any refusal — no candidate, an older server without the
 * endpoint, an ineligible pod (409) — answers null and the caller launches fresh.
 */
export async function tryAccountReuse(
  client: AccountClient,
  plan: AccountLaunchPlan,
  body: Parameters<AccountClient["launch"]>[0],
  timing: { workstation?: WorkstationWaitOptions } = {},
): Promise<{ pod: ApiPod; report: LaunchReport } | null> {
  let candidate: ApiPod | undefined;
  try {
    const { pods } = await client.listPods({
      mine: true,
      state: "active",
    });
    // This project's own stopped pod: another project's disk holds another project's work.
    candidate = pods.find(
      (p) =>
        p.templateId === (plan.templateId ?? null) &&
        p.project === (plan.projectName ?? null) &&
        !p.ready &&
        !p.initializing &&
        p.stateReason === null,
    );
  } catch (e) {
    debug(`could not list pods for reuse: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (!candidate) {
    debug("no stopped pod to reuse for this project — launching fresh");
    return null;
  }
  step("reuse", `relaunching onto stopped pod ${color.bold(displayRef(candidate.id, "pod"))}'s warm disk`);
  try {
    // A warm disk keeps its workspace; a reuse never seeds, so it never arms the seed gate.
    const { workspaceSeed: _gate, placement: _placement, forkFrom: _fork, ...reuseBody } = body;
    // Waiting for the workstation here rather than falling through: the warm disk is the
    // whole point of a reuse, and "not reusable" would be a false verdict on a pod whose
    // machine simply had not finished starting.
    return await withWorkstationWait(client, () => client.reusePod(candidate!.id, reuseBody), {
      ...timing.workstation,
      replayTransport: false,
    });
  } catch (error) {
    // Only a definitive "this pod cannot be reused" answer may fall through to a fresh launch.
    // A lost reply, a start-guard, or a cancel must not be rewritten into another mutation.
    if (error instanceof PiPodError && (error.status === 404 || error.status === 409)) {
      const reason = error.message.replace(/^the pi pod server refused \S+ \S+: /, "");
      info(`pod ${displayRef(candidate.id, "pod")} not reusable (${reason}); launching a fresh pod`);
      return null;
    }
    throw error;
  }
}

/** One progress line for a queued launch/wake: reason plus time left on the final deadline. */
export function capacityWaitProgress(wait: {
  reason: string | null;
  deadlineInMs: number;
  attempts: number;
  detail?: { retryable?: boolean } | null;
}): string {
  const what = capacityReasonShort(wait.reason);
  const secondsLeft = Math.max(0, Math.ceil(wait.deadlineInMs / 1000));
  const tries = wait.attempts > 0 ? ` (attempt ${wait.attempts + 1})` : "";
  const reasonCopy = wait.reason !== null ? capacityReasonHint(wait.reason) : null;
  const why = reasonCopy !== null && reasonCopy !== "" ? ` — ${reasonCopy}` : "";
  return `no room for ${what} yet; retrying until the deadline (~${secondsLeft}s left)${tries}${why}`;
}

/** Human amounts for the wait view's validated numbers (bytes → GiB, else raw with unit). */
export function describeCapacityAmounts(wait: {
  required?: number;
  available?: number;
  unit?: string | null;
}): string {
  if (wait.required === undefined || wait.available === undefined) return "";
  const format = (value: number): string =>
    wait.unit === "bytes" && value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(1)} GiB`
      : `${value}${wait.unit ? ` ${wait.unit}` : ""}`;
  return ` (needs ${format(wait.required)}, free ${format(wait.available)})`;
}

/**
 * One-line wait copy from the server's validated wait view:
 * `<reason> (needs X, free Y) — up to Ns (~Ns left)`.
 * Never renders raw provider text — reason is the validated enum, numbers are
 * finite non-negative validated fields. Older servers omit the amount fields and
 * render as `<reason> — up to Ns (~Ns left)`.
 */
export function describeCapacityWaitLine(wait: {
  reason: string | null;
  deadlineInMs: number;
  required?: number;
  available?: number;
  unit?: string | null;
  deadlineAt?: string | null;
}): string {
  let remaining = Math.max(0, Math.ceil(wait.deadlineInMs / 1000));
  if (!Number.isFinite(remaining) && typeof wait.deadlineAt === "string") {
    const parsed = Date.parse(wait.deadlineAt);
    if (Number.isFinite(parsed)) remaining = Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
  }
  if (!Number.isFinite(remaining)) remaining = 60;
  const reason = wait.reason ?? "fleet_capacity";
  return `${reason}${describeCapacityAmounts(wait)} — up to ${remaining}s (~${remaining}s left)`;
}

/**
 * Typed capacity expiry (server stateReasonCode `capacity_wait_expired`):
 * `launch failed: the fleet is still at capacity (waited Ns for <reason>); retry shortly`.
 * Falls back to the opaque stateReason when the code or wait view is absent
 * (older servers render exactly as before).
 */
export function describeLaunchFailure(pod: ApiPod): string {
  if ((pod as ApiPod).stateReasonCode === "capacity_wait_expired") {
    const wait = pod.capacityWait as unknown as
      | { reason?: string | null; waitedSeconds?: number | null } | null | undefined;
    const reason = (wait?.reason ?? "fleet_capacity") as string;
    const waited =
      typeof wait?.waitedSeconds === "number" && Number.isFinite(wait.waitedSeconds)
        ? ` (waited ${Math.max(0, Math.round(wait.waitedSeconds))}s for ${reason})`
        : ` (${reason})`;
    return `launch failed: the fleet is still at capacity${waited}; retry shortly`;
  }
  return `launch failed: ${pod.stateReason}`;
}

/** One line naming total launch wall time and the server's per-phase provisioning cost. */
export function podReadySummary(pod: ApiPod, totalMs: number): string {
  const total = `pod ready in ${(totalMs / 1000).toFixed(1)}s`;
  const timings = pod.resolvedConfig.timings;
  if (!timings) return total;
  const order = ["create", "start", "prep", "clone", "materialize", "init"];
  const parts = order
    .filter((name) => (timings[name] ?? 0) >= 100)
    .map((name) => `${name} ${((timings[name] ?? 0) / 1000).toFixed(1)}s`);
  return parts.length > 0 ? `${total} (${parts.join(" · ")})` : total;
}
