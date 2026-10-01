/**
 * Operator tool for the sandbox fleet: `npm run fleet -- <command>`.
 *
 * Fleet membership is deployment wiring, not tenant data, so it is changed the way migrations
 * are — on the host, against the database, by whoever already administers the deployment —
 * rather than through an authenticated API this server does not otherwise need.
 *
 * PRODUCTION ENTRYPOINT: `node dist/fleet.js <command>`, built from sandboxfleet-cli.ts.
 * Never `node dist/main.js fleet …` — that boots a second server process and dies on
 * EADDRINUSE instead of running the command. An edition adds its own commands by
 * calling `runFleetCli` from its entrypoint.
 */
import { closePool, initPool } from "../db/index.js";
import { HttpError } from "../httperrors.js";
import {
  addSandboxHost,
  archivePodsOnHost,
  describePlacementMode,
  drainSandboxHost,
  getSandboxHost,
  listSandboxHosts,
  podsOnHost,
  preloadImageOnFleet,
  probeSandboxHosts,
  rehomeSandboxHost,
  reconcileDeadSandboxHost,
  removeSandboxHost,
  sandboxPlacementMode,
  setSandboxHostStatus,
  type PodOnHost,
  type SandboxHostRow,
} from "./sandboxfleet.js";
import { platformArchiveMaxMinutes } from "./retention-policy.js";
import {
  applyRetentionPlan,
  planRetention,
  retentionStatus,
  type Custody,
} from "./retention-reconciler.js";
import { PROVIDER_META } from "../../core/providers/meta.js";
import { checkProviderCredential } from "../secrets/store.js";
import { operatorKek } from "../secrets/operator-kek.js";
import { runLaunchGateCommand } from "./launch-gate-cli.js";

/**
 * Retention commands deliberately avoid loadEnv(): the fleet CLI must work with only
 * DATABASE_URL (+ optional operator env), not a full server environment. Deployment
 * policy, the platform token snapshot, and the KEK are each read ONCE here and passed
 * down — the reconciler itself never touches process.env mid-run.
 */
function retentionDeploymentMax(): number {
  const raw = process.env["POD_SANDBOX_MAX_ARCHIVE_AFTER_MINUTES"];
  const coerced = raw === undefined || raw.trim() === "" ? undefined : Number(raw);
  return platformArchiveMaxMinutes({ POD_SANDBOX_MAX_ARCHIVE_AFTER_MINUTES: coerced });
}

/**
 * Per-org custody resolver for legacy rows without a launch record. KEK comes from the
 * operator environment (same contract as secrets-maintenance); when it is absent every
 * legacy row resolves `unknown` and apply backfills the record only — provider
 * convergence stays fail-closed. Results are cached per org for the command's lifetime.
 */
function buildCustodyResolver(): (orgId: string) => Promise<Custody> {
  const cache = new Map<string, Custody>();
  const kek = operatorKek();
  if (!kek) {
    console.error("warning: SECRETS_KEK is not set; legacy custody resolves as unknown (record-only mode)");
  }
  return async (orgId: string): Promise<Custody> => {
    const cached = cache.get(orgId);
    if (cached !== undefined) return cached;
    let custody: Custody = "unknown";
    if (kek) {
      try {
        const found = await checkProviderCredential({
          kek,
          orgId,
          provider: "sandbox",
          platformEnv: { PI_POD_SANDBOX_TOKEN: process.env["PI_POD_SANDBOX_TOKEN"] },
        });
        custody = found?.source === "org-secret" ? "org-secret" : found ? "platform" : "unknown";
      } catch {
        custody = "unknown";
      }
    }
    cache.set(orgId, custody);
    return custody;
  };
}

/** Startup snapshot of the platform token: read once, never from process.env mid-run. */
function fleetDeps() {
  const kek = operatorKek();
  return { platformToken: platformTokenSnapshot(), ...(kek ? { kek } : {}) };
}

function platformTokenSnapshot(): string | null {
  const token = process.env[PROVIDER_META.sandbox.credentialEnv];
  return typeof token === "string" && token.length > 0 ? token : null;
}

const GB = 1024 ** 3;

const USAGE_COMMANDS = `usage: fleet <command>

  launch-gate status      show global admission mode and unresolved attempt counts
  launch-gate hold [--expect-epoch N] --actor ID --reason CODE
                          close launch admission; observation-only recovery remains active
  launch-gate open [--expect-epoch N] --actor ID --reason CODE --source-sha SHA
                          open only with the required recovery protocol and accounted legacy rows
  list                    every registered host with live health, headroom, and fairness (managed/gate)
  doctor                  per-host admission health; exit 1 when any host needs attention
  add <id> <url>          register a host and start placing pods on it
  drain <id>              stop placing new pods; existing pods stay put
  activate <id>           place pods on this host again
  pods <id>               the pods whose frozen launch config names this host
  archive <id>            archive every live pod on the host (interrupts running work)
  rehome <id>             move the host's archived pods onto the rest of the fleet
  remove <id>             forget a host; refused while pods still point at it
  preload <image-ref>     pull an image into every host's content store
  retention plan        dry-run inventory of platform retention vs provider timers
  retention apply --yes converge desired state + provider timers (operator approval)
  retention status      convergence counts, pending/failed rows, overdue wave size
  reconcile-gone [--dry-run|--yes]
                      converge failed-launch rows stuck at active+gone (never
                      acquired compute) to archived. Prints every gone row;
                      refuses any row naming a provider sandbox (a workspace
                      may exist). --yes applies, otherwise dry-runs.
  reconcile-dead-host <host-id> [--dry-run]
                      inventory permanently deleted host (including gone rows)
  reconcile-dead-host <host-id> --yes --expected-url <url>
                      --host-deleted-confirmed --quiescence-confirmed
                      --accept-workspace-loss --reason <operator/incident evidence>
                      abandon recovery and converge archived/gone atomically;
                      host must be draining and ALL writers stopped
  reconcile-archived <pod-id> <host-id>
                      converge one error pod to archived after host confirmation
  rehome-guarded <host-id> --yes --quiescence-confirmed [--min-quiet-secs N]
                      manifest-handshake moves: source hold (revision CAS) +
                      verified object + exact adoption + CAS repoint; source hold
                      kept after commit, never deleted. Hosts without the rev5
                      fence API are refused (deploy the fence before retiring).
  hold-release              DISABLED (server manual release cannot prove non-adoption;
                      retry the move or use retire-source; break-glass is host-side)
  retire-source <source-host-id> <pod-id>
                      atomic held-source retire after a committed repoint whose
                      cleanup stayed pending (proof re-derived live; shared object
                      retained; refusals keep the hold natively)
`;

const USAGE_TRAILER = `A newly added host has an empty image cache, so preload the current pi-pod-base tag before
pods are placed on it. GHCR_USERNAME and GHCR_TOKEN supply registry auth for a private tag;
they are used for that pull only and never stored on the host. Production rollout runs this
inside a healthy pi-pod-server after deploy, against every registered host; with none
registered, PI_POD_SANDBOX_URL is preloaded instead.

Removing a machine is: drain, wait (or archive), rehome, remove, then delete the VM.`;

let USAGE = `${USAGE_COMMANDS}\n${USAGE_TRAILER}`;

/** The usage text, including any edition commands, for an edition command's own errors. */
export function fleetUsage(): string {
  return USAGE;
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function requireArg(value: string | undefined, name: string): string {
  return value ?? fail(`missing <${name}>\n\n${USAGE}`);
}
export function flag(rest: string[], name: string): string {
  const i = rest.indexOf(`--${name}`);
  if (i < 0 || rest[i + 1] === undefined || rest[i + 1]!.startsWith("--")) fail(`missing --${name}`);
  return rest[i + 1]!;
}
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer`);
  return n;
}

/** One-line host identity for operator output. Box lifecycle state and ownership
 * ride along so a stopped-but-healthy personal host reads as asleep-at-a-glance
 * (never mistaken for a broken static host), without suppressing any fault line. */
function describeHost(host: SandboxHostRow): string {
  const box = host.box_state != null ? ` box=${host.box_state}` : "";
  const owner = host.owner_user_id != null ? " owned" : "";
  // Owned Box rows carry url NULL with the dial endpoint in hosted_url;
  // printing raw null sends the operator chasing a missing URL.
  return `${host.id.padEnd(20)} ${host.status.padEnd(9)} ${host.hosted_url ?? host.url}${box}${owner}`;
}

/**
 * One-line fairness summary for operator visibility (W12): managed hosts
 * gate grantless tenants (`fairness_degraded`) until the allocator issues
 * a grant, so an operator must see managed/gate at a glance. The gate flag
 * rides the capacity report when the host is new enough to send it;
 * absence is unknown (check the host's PI_POD_SANDBOX_GRANT_GATE_ADMISSION
 * env), never off.
 */
export function describeFairness(fairness: {
  mode: "local-weights" | "grants" | "degraded";
  managed: boolean;
  gateAdmissions?: boolean;
  activeGrants: number;
  expiredGrants: number;
  degradedTenants: number;
} | null): string {
  if (!fairness) return "fairness: unknown (no capacity report)";
  const gate =
    fairness.gateAdmissions === true ? "on" : fairness.gateAdmissions === false ? "off" : "unknown";
  return (
    `fairness: mode=${fairness.mode} managed=${fairness.managed ? "yes" : "no"} gate=${gate} ` +
    `active=${fairness.activeGrants} expired=${fairness.expiredGrants} degradedTenants=${fairness.degradedTenants}`
  );
}

async function list(): Promise<void> {
  const mode = sandboxPlacementMode();
  console.log(`placement: ${describePlacementMode(mode)}`);
  const hosts = await listSandboxHosts();
  if (hosts.length === 0) {
    console.log(
      mode === "fleet"
        ? "no sandbox hosts registered; fleet mode fails closed — launches are refused until a worker is registered"
        : "no sandbox hosts registered; launches use PI_POD_SANDBOX_URL as a single-host deployment",
    );
    return;
  }
  const probed = await probeSandboxHosts(hosts, fleetDeps());
  for (const entry of probed) {
    const counts = entry.health?.sandboxes;
    const headroom = entry.reportsCapacity
      ? `free ${(entry.freeMemoryBytes / GB).toFixed(1)}GB ram, ${entry.freeCpu.toFixed(2)} cpu, ` +
        `${(entry.freeDiskBytes / GB).toFixed(1)}GB disk`
      : "headroom unknown (host predates fleet capacity reporting)";
    const detail = entry.reachable
      ? `hot=${counts?.hot ?? 0} warm=${counts?.warm ?? 0} stopped=${counts?.stopped ?? 0} ` +
        `archived=${counts?.archived ?? 0} | ${headroom}`
      : entry.host.box_state != null && entry.host.box_state !== "running" ? `sleeping (${entry.host.box_state}) — probe skipped` : "UNREACHABLE";
    console.log(`${describeHost(entry.host)}\n  ${detail}`);
    if (entry.reachable) console.log(`  ${describeFairness(entry.capacity?.fairness ?? null)}`);
  }
}

/**
 * `fleet doctor`: per-host admission health with operator action attached.
 * Read-only (healthz probes only). Exit 1 when any host needs attention:
 * unreachable, unreadable/misidentified capacity, fairness-degraded
 * tenants, owner-migration debt, or floor memory admission. Managed hosts
 * with the admission gate off are flagged (that is the documented
 * post-outage rollback state — restorable, but deliberate).
 */
async function doctor(): Promise<void> {
  const hosts = await listSandboxHosts();
  if (hosts.length === 0) {
    console.log("no sandbox hosts registered");
    process.exitCode = 1;
    return;
  }
  const probed = await probeSandboxHosts(hosts, fleetDeps());
  let problems = 0;
  for (const entry of probed) {
    if (entry.host.box_state != null && entry.host.box_state !== "running") {
      console.log(`${describeHost(entry.host)}\n  sleeping (${entry.host.box_state}) — probe skipped`);
      continue;
    }
    const notes: string[] = [];
    if (!entry.reachable) {
      notes.push("UNREACHABLE — check the host process and network");
    } else {
      if (entry.capacityStatus !== "ok") {
        notes.push(
          entry.capacityStatus === "absent"
            ? "no capacity contract (legacy host: placement compat only)"
            : `capacity ${entry.capacityStatus} — fix host config/version before trusting placement`,
        );
      }
      const fairness = entry.capacity?.fairness;
      if (fairness) {
        if (fairness.managed && fairness.mode === "degraded") {
          notes.push(
            `${fairness.degradedTenants} tenant(s) on bounded fallback — new launches for grantless tenants wait (fairness_degraded) until the allocator recovers`,
          );
        }
        if (fairness.managed && fairness.gateAdmissions === false) {
          notes.push(
            "admission gate is OFF (PI_POD_SANDBOX_GRANT_GATE_ADMISSION=0): grantless tenants are admitted without grants — the documented rollback state, re-enable the gate once the allocator is healthy",
          );
        }
      }
      const tenancy = entry.capacity?.tenancy;
      if (tenancy) {
        const debt =
          tenancy.unownedLive + tenancy.unownedInitializable + (tenancy.unownedUncertain ?? 0);
        if (debt > 0) notes.push(`${debt} unowned sandbox(es) pending owner init (allocator skips this host)`);
      }
      if (entry.capacity && entry.capacity.capabilities.memoryAdmission !== "ceiling") {
        notes.push("floor memory admission — cannot uphold ceiling placement (allocator skips this host)");
      }
    }
    console.log(describeHost(entry.host));
    if (entry.reachable) console.log(`  ${describeFairness(entry.capacity?.fairness ?? null)}`);
    if (notes.length === 0) {
      console.log("  ok");
    } else {
      problems += 1;
      for (const note of notes) console.log(`  PROBLEM: ${note}`);
    }
  }
  console.log(problems === 0 ? `\n${probed.length} host(s) healthy` : `\n${problems}/${probed.length} host(s) need attention`);
  if (problems > 0) process.exitCode = 1;
}

async function pods(id: string): Promise<void> {
  const host = await getSandboxHost(id);
  if (!host) fail(`no sandbox host "${id}"`);
  const rows = await podsOnHost(host);
  if (rows.length === 0) {
    console.log(`no pods point at ${id}`);
    return;
  }
  for (const pod of rows) {
    console.log(`${pod.id}  ${pod.provider_state.padEnd(14)} ${pod.name}`);
  }
  const movable = rows.filter((pod) => pod.provider_state === "archived").length;
  console.log(`\n${rows.length} pod(s); ${movable} archived and movable to another host`);
}

async function run(argv: string[], extension?: FleetCliExtension): Promise<void> {
  const [command, ...rest] = argv;
  // Single startup snapshot for the whole run: fleet host calls below take
  // it explicitly and never re-read ambient process.env mid-run.
  const hostDeps = fleetDeps();
  const bootToken = hostDeps.platformToken;
  switch (command) {
    case "launch-gate":
      return await runLaunchGateCommand(rest, extension?.launchGateStatus);
    case "list":
      return await list();
    case "doctor":
      return await doctor();
    case "add": {
      const host = await addSandboxHost(
        requireArg(rest[0], "id"),
        requireArg(rest[1], "url"),
      );
      console.log(`registered ${describeHost(host)}`);
      return;
    }
    case "drain": {
      const host = await drainSandboxHost(requireArg(rest[0], "id"));
      console.log(
        `${host.id} is draining; its pods keep running and it takes no new ones.\n` +
          `Watch \`fleet pods ${host.id}\` empty, or force it with \`fleet archive ${host.id}\`.`,
      );
      return;
    }
    case "activate": {
      const host = await setSandboxHostStatus(requireArg(rest[0], "id"), "active");
      console.log(`${host.id} is taking pods again`);
      return;
    }
    case "pods":
      return await pods(requireArg(rest[0], "id"));
    case "archive": {
      const id = requireArg(rest[0], "id");
      const host = await getSandboxHost(id);
      if (!host) fail(`no sandbox host "${id}"`);
      const result = await archivePodsOnHost(host, bootToken, (message) => console.log(message), hostDeps.kek);
      console.log(`archived ${result.archived.length} pod(s)`);
      for (const failure of result.failed) console.error(`  ${failure.pod}: ${failure.reason}`);
      if (result.failed.length > 0) process.exitCode = 1;
      return;
    }
    case "rehome": {
      console.error(
        "warning: fleet rehome is superseded by quiescence-gated rehome-guarded " +
          "(adoption proof + stability + CAS, no source cleanup); " +
          "the legacy path stays only until capacity+infra coordinate its retirement",
      );
      const result = await rehomeSandboxHost(
        requireArg(rest[0], "id"),
        (message) => console.log(message),
      );
      console.log(`moved ${result.moved.length} pod(s)`);
      for (const skip of result.skipped) console.error(`  skipped ${skip.pod}: ${skip.reason}`);
      if (result.skipped.length > 0) process.exitCode = 1;
      return;
    }
    case "remove": {
      const id = requireArg(rest[0], "id");
      await removeSandboxHost(id);
      console.log(`removed ${id}; the machine can now be destroyed`);
      return;
    }
    case "preload": {
      const username = process.env["GHCR_USERNAME"];
      const password = process.env["GHCR_TOKEN"];
      const result = await preloadImageOnFleet(
        requireArg(rest[0], "image-ref"),
        username && password ? { username, password } : null,
        bootToken,
        (message) => console.log(message),
        sandboxPlacementMode(),
        hostDeps.kek,
      );
      console.log(`preloaded on ${result.preloaded.length} host(s)`);
      for (const failure of result.failed) console.error(`  ${failure.host}: ${failure.reason}`);
      if (result.failed.length > 0) process.exitCode = 1;
      return;
    }
    case "retention": {
      const sub = rest[0];
      const deploymentMax = retentionDeploymentMax();
      if (sub === "plan") {
        const plan = await planRetention({
          ...hostDeps,
          deploymentMaxMinutes: deploymentMax,
          platformToken: bootToken,
          resolveCustody: buildCustodyResolver(),
        });
        console.log(`migration ${plan.migrationId} generated ${plan.generatedAt}`);
        console.log(`deployment max ${plan.deploymentMaxMinutes}min; ${plan.entries.length} pod(s), ${plan.overdueCount} overdue stopped`);
        for (const e of plan.entries) {
          console.log(
            `${e.podId} org=${e.orgId} logical=${e.logicalState} provider=${e.providerState} ` +
              `req=${e.requestedMinutes} orgMax=${e.orgMaxMinutes ?? "-"} effective=${e.effectiveMinutes} ` +
              `custody=${e.custody} scoped=${e.scoped} ` +
              `provider=${e.providerMinutes ?? "?"} stoppedAt=${e.stoppedAt} due=${e.dueAt ?? "-"} ` +
              `action=${e.action} rev=${e.recordRevision ?? "-"} ${e.detail}`,
          );
        }
        return;
      }
      if (sub === "status") {
        const status = await retentionStatus();
        console.log(
          `migration ${status.migrationId}: ${status.totalPods} pod(s), ` +
            `${status.withRecord} with record (${status.applied} applied, ${status.pending} pending, ` +
            `${status.failed} failed, ${status.skipped} skipped, ${status.unscopedRecords} unscoped), ` +
            `${status.overdueStopped} overdue stopped`,
        );
        for (const f of status.failures) console.error(`  failed ${f.podId}: ${f.lastError ?? "unknown"} (${f.updatedAt})`);
        if (status.failed > 0) process.exitCode = 1;
        return;
      }
      if (sub === "apply") {
        if (!rest.includes("--yes")) {
          fail("retention apply requires explicit operator approval: re-run with --yes");
        }
        const plan = await planRetention({
          ...hostDeps,
          deploymentMaxMinutes: deploymentMax,
          platformToken: bootToken,
          resolveCustody: buildCustodyResolver(),
        });
        const applied = await applyRetentionPlan(plan, {
          ...hostDeps,
          approved: true,
          actorId: null,
          deploymentMaxMinutes: deploymentMax,
          platformToken: bootToken,
          resolveCustody: buildCustodyResolver(),
        });
        console.log(
          `migration ${applied.migrationId}: ${applied.recordsWritten} record(s) written, ` +
            `${applied.providerUpdated} provider timer(s) updated, ${applied.alreadyConverged} already converged, ` +
            `${applied.skippedUnscoped} unscoped skipped, ${applied.resolutionsChanged} re-resolved, ` +
            `${applied.overdueCount} overdue stopped (the archive sweep releases them sequentially)`,
        );
        for (const f of applied.failed) console.error(`  failed ${f.podId}: ${f.reason}`);
        if (applied.failed.length > 0) process.exitCode = 1;
        return;
      }
      fail(USAGE);
    }
    case "reconcile-gone": {
      const { reconcileGoneRows } = await import("./gone-reconciler.js");
      const apply = rest.includes("--yes");
      const result = await reconcileGoneRows({
        dryRun: !apply,
        actorId: null,
        log: { info: (m) => console.log(m), warn: (m) => console.error(m) },
      });
      console.log(
        `${apply ? "applied" : "dry-run"}: ${result.plans.length} gone row(s) — ` +
          `${result.archived.length} archived, ${result.refused.length} refused, ` +
          `${result.skipped.length} skipped, ${result.failed.length} failed`,
      );
      for (const plan of result.plans) {
        const r = plan.row;
        console.log(
          `${plan.decision.padEnd(7)} ${r.id} provider=${r.provider} state=${r.state} ` +
            `created=${typeof r.created_at === "string" ? r.created_at : new Date(r.created_at).toISOString()} ` +
            `reason=${(r.state_reason ?? "-").slice(0, 120)} :: ${plan.detail}`,
        );
      }
      for (const f of result.failed) console.error(`  failed ${f.podId}: ${f.reason}`);
      if (!apply && !rest.includes("--dry-run")) {
        console.log("dry-run only: re-run with --yes to converge the archivable rows");
      }
      if (apply && (result.refused.length > 0 || result.failed.length > 0)) process.exitCode = 1;
      return;
    }
    case "reconcile-dead-host": {
      const id = requireArg(rest[0], "host-id");
      const flags = new Set<string>();
      const values = new Map<string, string>();
      for (let i = 1; i < rest.length; i += 1) {
        const arg = rest[i]!;
        if (["--yes", "--dry-run", "--host-deleted-confirmed", "--quiescence-confirmed", "--accept-workspace-loss"].includes(arg)) {
          if (flags.has(arg)) fail(`duplicate option ${arg}`);
          flags.add(arg);
        } else if (arg === "--expected-url" || arg === "--reason") {
          const value = rest[++i];
          if (!value || value.startsWith("--") || values.has(arg)) fail(`missing or duplicate value for ${arg}`);
          values.set(arg, value);
        } else {
          fail(`unknown reconcile-dead-host option ${arg}`);
        }
      }
      if (flags.has("--yes") && flags.has("--dry-run")) fail("--yes and --dry-run are mutually exclusive");
      const result = await reconcileDeadSandboxHost(id, {
        dryRun: !flags.has("--yes"),
        expectedUrl: values.get("--expected-url"), reason: values.get("--reason"),
        hostDeletedConfirmed: flags.has("--host-deleted-confirmed"),
        quiescenceConfirmed: flags.has("--quiescence-confirmed"),
        acceptWorkspaceLoss: flags.has("--accept-workspace-loss"),
      });
      console.log(`${result.dryRun ? "dry-run" : "applied"} ${result.hostId} ${result.url}`);
      for (const pod of result.pods) {
        console.log(`${pod.action} ${pod.id} ${pod.state}/${pod.providerState} -> archived/gone`);
      }
      console.log(`${result.pods.filter((pod) => pod.action === "converge").length} to converge; ${result.pods.filter((pod) => pod.action === "unchanged").length} already terminal; ${result.pods.filter((pod) => pod.action === "refuse").length} refused`);
      if (result.pods.some((pod) => pod.action === "refuse")) process.exitCode = 1;
      return;
    }
    case "reconcile-archived": {
      const { reconcileProviderArchived } = await import("./sandbox-retirement.js");
      const { getSandboxHost: getHost } = await import("./sandboxfleet.js");
      const podId = requireArg(rest[0], "pod-id");
      const host = await getHost(requireArg(rest[1], "host-id"));
      if (!host) fail(`no sandbox host "${rest[1]}"`);
      const rows = await (
        await import("../db/index.js")
      ).query<PodOnHost>(
        `SELECT p.id, p.org_id, p.user_id, p.sandbox_host_id, p.name, p.state, p.provider_state, p.provider_sandbox_id, p.resolved_config
           FROM pods p WHERE p.id = $1 AND p.provider = 'sandbox'`,
        [podId],
      );
      const pod = rows.rows[0];
      if (!pod) fail(`no sandbox pod "${podId}"`);
      const { readReconcileExpected } = await import("./sandbox-retirement.js");
      const expected = await readReconcileExpected(podId);
      if (!expected) fail(`pod "${podId}" names no source sandbox to converge`);
      const result = await reconcileProviderArchived(hostDeps, {
        host: host!,
        pod,
        actorId: null,
        expected: expected!,
      });
      console.log(`${result.converged ? "converged" : "skipped"} ${result.podId}: ${result.detail}`);
      if (!result.converged) process.exitCode = 1;
      return;
    }
    case "rehome-guarded": {
      const { guardedRehome } = await import("./sandbox-retirement.js");
      if (!rest.includes("--yes")) {
        fail("rehome-guarded requires explicit operator approval: re-run with --yes (attested maintenance window, quiesced source)");
      }
      if (!rest.includes("--quiescence-confirmed")) {
        fail(
          "rehome-guarded additionally requires --quiescence-confirmed: same-object proof " +
            "needs the native manifest handshake, so only an operator-attested quiescent " +
            "window (no live work, shared archive store confirmed) may move workspaces",
        );
      }
      const quietArg = rest.find((a) => a.startsWith("--min-quiet-secs="));
      const minQuietSecs = quietArg ? Number(quietArg.split("=")[1]) : undefined;
      const result = await guardedRehome(
        hostDeps,
        requireArg(rest[0], "host-id"),
        {
          approved: true,
          quiescenceAttested: true,
          ...(minQuietSecs === undefined ? {} : { minQuietSecs }),
          actorId: null,
          onProgress: (m) => console.log(m),
        },
      );
      console.log(`moved ${result.moved.length} pod(s)`);
      for (const skip of result.skipped) console.error(`  skipped ${skip.pod}: ${skip.reason}`);
      if (result.skipped.length > 0) process.exitCode = 1;
      return;
    }
    case "retire-source": {
      const { retireSourceRow } = await import("./sandbox-retirement.js");
      const { getSandboxHost: getHost } = await import("./sandboxfleet.js");
      const host = await getHost(requireArg(rest[0], "source-host-id"));
      if (!host) fail(`no sandbox host "${rest[0]}"`);
      const podRows = await (
        await import("../db/index.js")
      ).query<{ id: string }>(`SELECT id FROM pods WHERE id = $1`, [requireArg(rest[1], "pod-id")]);
      if ((podRows.rowCount ?? 0) !== 1) fail(`no pod "${rest[1]}"`);
      const result = await retireSourceRow(
        hostDeps,
        { source: host!, podId: requireArg(rest[1], "pod-id"), holder: `rehome:${requireArg(rest[1], "pod-id")}` },
      );
      console.log(`${result.retired ? "retired" : "not retired"}: ${result.detail}`);
      if (!result.retired) process.exitCode = 1;
      return;
    }
    case "hold-release": {
      console.error(
        "hold-release is disabled on the server: every proof protocol audited had holes " +
          "that could unfence an adopted source (two writers). Safe next steps: retry the " +
          "guarded move (same holder replays idempotently while held), or run retire-source " +
          "once the target provably holds the exact object. Host-side break-glass is a " +
          "native-operator action, never a guarded server command.",
      );
      process.exitCode = 1;
      return;
    }
    default: {
      const extra = command === undefined ? undefined : extension?.commands[command];
      if (!extra) fail(USAGE);
      await extra(rest);
    }
  }
}

/** Operator commands an edition adds to the fleet CLI. */
export interface FleetCliExtension {
  /** Usage lines for `commands`, in the format of the built-in list. */
  usage: string;
  commands: Record<string, (rest: string[]) => Promise<void>>;
  /** Extra `name=value` fields for `launch-gate status`, printed before the core counts. */
  launchGateStatus?: () => Promise<string[]>;
}

/** Runs one fleet command against DATABASE_URL, then closes the pool. */
export async function runFleetCli(argv: string[], extension?: FleetCliExtension): Promise<void> {
  if (extension) USAGE = `${USAGE_COMMANDS}${extension.usage}\n${USAGE_TRAILER}`;
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) fail("DATABASE_URL is required");
  initPool(databaseUrl);
  try {
    await run(argv, extension);
  } catch (error) {
    if (error instanceof HttpError) fail(error.message);
    throw error;
  } finally {
    await closePool();
  }
}
