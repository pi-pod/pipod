/**
 * Stale Tailscale resolver repair + lightweight resume hook runner.
 *
 * Incident: a filesystem-only sandbox pause (keepMemory:false) kills every resident process —
 * including tailscaled — but keeps the filesystem, so /etc/resolv.conf
 * still names the MagicDNS resolvers (100.100.100.100, fd7a:115c:a1e0::53) with
 * nothing listening on them. Every DNS lookup then times out and the pod looks
 * network-dead even though the sandbox itself is healthy.
 *
 * Repair policy (narrow, idempotent, fail-closed):
 * - Only Tailscale's exact dual-stack resolvers count (Quad100 + fd7a:115c:a1e0::53
 *   under canonical IPv6 expansion). Any other fd7a:115c:a1e0 address is someone's
 *   custom ULA DNS and is never treated as Tailscale's.
 * - A Tailscale-owned config (Tailscale generated header AND only Tailscale
 *   resolvers) with a dead daemon is restored from the validated pre-tailscale
 *   backup — the `tailscale down` equivalent. Mixed configs (Tailscale + usable
 *   resolvers) are never backup-restored — the backup may predate the custom
 *   DNS — they only get byte-identical stripping of the Tailscale lines.
 * - Symlinked resolv.conf targets are never written through; an indeterminate
 *   daemon probe never authorizes repair; the guarded write re-compares current
 *   content before overwriting. Anything uncertain is a needs-attention outcome,
 *   never a public-DNS overwrite.
 */

import { createHash } from "node:crypto";
import net from "node:net";
import type { Sandbox } from "../../core/providers/types.js";

export const RESOLV_CONF_PATH = "/etc/resolv.conf";
export const TAILSCALE_BACKUP_PATH = "/etc/resolv.pre-tailscale-backup.conf";
/**
 * Durable hook location. Deliberately NOT under /tmp: some sandbox runtimes clear /tmp across
 * a filesystem-only pause (live evidence: a captured fixture had the hook before
 * stop and lost it after resume — DNS/attach recovered but tailscaled never came
 * back). /var/lib survives the pause, so the hook is present when resume needs it.
 */
export const RESUME_HOOK_PATH = "/var/lib/pi-pod/resume.sh";
export const RESUME_HOOK_TIMEOUT_MS = 30_000;
const RESOLVER_RPC_TIMEOUT_MS = 10_000;

/** The exact MagicDNS resolvers Tailscale installs with --accept-dns=true. */
export const TAILSCALE_RESOLVER_IPV4 = "100.100.100.100";
const TAILSCALE_RESOLVER_IPV6_EXPANDED = "fd7a:115c:a1e0:0000:0000:0000:0000:0053";

export type ResolverRepairOutcome =
  /** No Tailscale resolver present — nothing to do (idempotent steady state). */
  | { action: "noop-clean" }
  /** Tailscale resolvers present but tailscaled is alive — MagicDNS is legitimate. */
  | { action: "noop-daemon-live"; resolvers: string[] }
  /** Tailscale-owned config restored from the validated backup. */
  | { action: "repaired-from-backup"; removed: string[]; restored: string[] }
  /** Mixed config: only Tailscale lines stripped, everything else byte-identical. */
  | { action: "repaired-strip"; removed: string[]; kept: string[] }
  /** Left untouched: nothing safe to restore. Never a public-DNS overwrite. */
  | {
      action: "needs-attention";
      reason:
        | "resolv-unreadable"
        | "daemon-indeterminate"
        | "not-tailscale-owned"
        | "no-usable-fallback"
        | "no-backup-no-fallback"
        | "backup-invalid-no-fallback"
        | "symlink-refused"
        | "changed-underfoot"
        | "write-failed"
        | "repair-error";
      detail?: string;
    };

export type ResumeHookOutcome =
  | { action: "skipped-missing" }
  | { action: "ok" }
  | { action: "failed"; exitCode: number; output: string };

/**
 * Canonicalize a nameserver token, or null when it is not a strict IP literal.
 * IPv4 goes through node:net (which rejects leading-zero quads); IPv6 is
 * validated by node:net then expanded to full lowercase form so expanded, casing,
 * and compressed spellings of one address compare equal.
 */
export function normalizeNameserverAddress(raw: string): string | null {
  const token = (raw.trim().split("%")[0] ?? "").trim().toLowerCase();
  if (!token) return null;
  const family = net.isIP(token);
  if (family === 4) return token;
  if (family === 6) return expandIPv6(token);
  return null;
}

function expandIPv6(address: string): string | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  const groups = [...head, ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  if (halves.length === 2) {
    const missing = 8 - groups.length;
    if (missing < 1) return null;
    return [...head, ...Array<string>(missing).fill("0000"), ...tail]
      .map((group) => group.padStart(4, "0"))
      .join(":");
  }
  if (groups.length !== 8) return null;
  return groups.map((group) => group.padStart(4, "0")).join(":");
}

/** Exact dual-stack match only — never the whole ULA prefix (custom DNS lives there). */
export function isTailscaleResolver(address: string): boolean {
  const normalized = normalizeNameserverAddress(address);
  return normalized === TAILSCALE_RESOLVER_IPV4 || normalized === TAILSCALE_RESOLVER_IPV6_EXPANDED;
}

/** Every `nameserver` token in a resolv.conf text, lowercased and zone-stripped, in order. */
export function parseNameservers(resolvConf: string): string[] {
  const servers: string[] = [];
  for (const line of resolvConf.split("\n")) {
    const match = /^\s*nameserver\s+(\S+)/.exec(line);
    if (match?.[1]) servers.push(match[1].trim().toLowerCase().split("%")[0] ?? "");
  }
  return servers;
}

/** Strict IP literal (v4 or v6) that is not Tailscale's — i.e. DNS worth keeping. */
export function isUsableResolver(token: string): boolean {
  const normalized = normalizeNameserverAddress(token);
  return normalized !== null && !isTailscaleResolver(token);
}

/**
 * A backup is usable only when it restores real DNS: at least one nameserver,
 * every nameserver a strict IP literal, and none of them Tailscale's. Anything
 * else — empty, malformed, garbage, or Tailscale-only — is rejected so a corrupt
 * backup can never become the new resolv.conf.
 */
export function validateBackupNameservers(backupConf: string): { ok: true; servers: string[] } | { ok: false } {
  const servers = parseNameservers(backupConf);
  if (servers.length === 0) return { ok: false };
  if (!servers.every((token) => normalizeNameserverAddress(token) !== null)) return { ok: false };
  if (servers.some(isTailscaleResolver)) return { ok: false };
  return { ok: true, servers };
}

/**
 * Whether this file is Tailscale's own stale output: a Tailscale generated header
 * plus nothing but Tailscale resolvers. Only such files are ever backup-restored,
 * so custom search/options lines and custom resolvers can never be overwritten.
 */
export function isTailscaleOwnedConfig(resolvConf: string): boolean {
  const servers = parseNameservers(resolvConf);
  if (servers.length === 0 || !servers.every(isTailscaleResolver)) return false;
  return resolvConf.split("\n").some((line) => /^\s*[#;].*tailscale/i.test(line));
}

/** Current resolv.conf minus Tailscale nameserver lines; every other byte kept. */
export function stripTailscaleNameservers(resolvConf: string): string {
  return resolvConf
    .split("\n")
    .filter((line) => {
      const match = /^\s*nameserver\s+(\S+)/.exec(line);
      return !(match?.[1] && isTailscaleResolver(match[1]));
    })
    .join("\n");
}

async function readRemoteFile(
  sandbox: Sandbox,
  path: string,
): Promise<{ ok: true; content: string } | { ok: false }> {
  try {
    const result = await sandbox.exec(["cat", path], { timeoutMs: RESOLVER_RPC_TIMEOUT_MS });
    if (result.exitCode !== 0) return { ok: false };
    return { ok: true, content: result.output ?? "" };
  } catch {
    return { ok: false };
  }
}

export type DaemonState = "live" | "gone" | "indeterminate";

/**
 * The tailscaled liveness probe. Only argv[0]'s basename is ever inspected — the
 * full cmdline (which may carry secrets in args) is never printed, only matched
 * locally in the pipeline. `procGlob` exists so tests can exec this exact script
 * against a fake /proc tree; production always passes the default.
 */
export function tailscaledProbeScript(procGlob = "/proc/[0-9]*/cmdline"): string {
  return (
    `: pi-pod-tailscaled-probe; checked=0; live=0; ` +
    `for proc in ${procGlob}; do ` +
    // A glob miss (or non-file) is no evidence at all — never a "gone" vote.
    `[ -f "$proc" ] || continue; ` +
    // One open, one read off the same fd: no TOCTOU between proving readability
    // and reading. Unopenable entries are skipped without a vote (fail-closed
    // below); anything opened is observable evidence, whether its first field is
    // full, partial (a process exiting mid-read — conservatively still a vote),
    // or empty (zombie/kernel thread — a known non-match, never "unknown").
    `first=""; ` +
    `if exec 3< "$proc" 2>/dev/null; then ` +
    `IFS= read -r -d '' first <&3 2>/dev/null || true; exec 3<&-; ` +
    `checked=$((checked + 1)); ` +
    `[ "\${first##*/}" = tailscaled ] && live=1; fi; done; ` +
    `[ "$checked" -gt 0 ] || exit 2; ` +
    `[ "$live" = 1 ] && exit 0; exit 1`
  );
}

/**
 * Whether a tailscaled process is alive, via /proc rather than pgrep/ps so the
 * answer does not depend on which utilities the image installed. Matches argv[0]
 * basename exactly — the same ownership discipline as the supervisor pid check.
 * Fail-closed: zero observable processes (hidden/unreadable /proc, or any exec
 * failure) is indeterminate, which never authorizes repair.
 */
export async function tailscaledState(sandbox: Sandbox): Promise<DaemonState> {
  try {
    const result = await sandbox.exec(["bash", "-lc", tailscaledProbeScript()], {
      timeoutMs: RESOLVER_RPC_TIMEOUT_MS,
    });
    if (result.exitCode === 0) return "live";
    if (result.exitCode === 1) return "gone";
    return "indeterminate";
  } catch {
    return "indeterminate";
  }
}

type GuardedWriteResult = "ok" | "symlink-refused" | "changed-underfoot" | "write-failed";

/**
 * Overwrite resolv.conf in one guarded exec: refuse symlinked targets, re-compare
 * the live content hash against what repair decided on, decode into a mktemp file
 * (never a fixed /tmp path — no symlink/race window), then cat over the target.
 */
async function writeResolvConfGuarded(
  sandbox: Sandbox,
  expectedCurrent: string,
  newContent: string,
): Promise<GuardedWriteResult> {
  const expectedHash = createHash("sha256").update(expectedCurrent, "utf8").digest("hex");
  const encoded = Buffer.from(newContent, "utf8").toString("base64");
  const script =
    `if test -L ${RESOLV_CONF_PATH}; then exit 4; fi; ` +
    // sha256sum missing (or the file vanishing) yields an empty hash, which can
    // never equal the expected one — fail closed, never write on uncertainty.
    `cur=$(sha256sum ${RESOLV_CONF_PATH} 2>/dev/null | awk '{print $1}'); ` +
    `[ "$cur" = '${expectedHash}' ] || exit 5; ` +
    `tmp=$(mktemp /tmp/pi-pod-resolv.XXXXXX) || exit 1; ` +
    `printf '%s' '${encoded}' | base64 -d > "$tmp" && ` +
    `cat "$tmp" > ${RESOLV_CONF_PATH}; rc=$?; rm -f "$tmp"; exit "$rc"`;
  try {
    const result = await sandbox.exec(["bash", "-lc", script], {
      timeoutMs: RESOLVER_RPC_TIMEOUT_MS,
    });
    if (result.exitCode === 0) return "ok";
    if (result.exitCode === 4) return "symlink-refused";
    if (result.exitCode === 5) return "changed-underfoot";
    return "write-failed";
  } catch {
    return "write-failed";
  }
}

function writeFailureOutcome(result: GuardedWriteResult): ResolverRepairOutcome {
  if (result === "symlink-refused") {
    return {
      action: "needs-attention",
      reason: "symlink-refused",
      detail: `${RESOLV_CONF_PATH} is a symlink; leaving its target to the authoritative owner`,
    };
  }
  if (result === "changed-underfoot") {
    return {
      action: "needs-attention",
      reason: "changed-underfoot",
      detail: `${RESOLV_CONF_PATH} changed since it was read; refusing to overwrite`,
    };
  }
  return { action: "needs-attention", reason: "write-failed" };
}

/**
 * Migrate a stale Tailscale resolver before transport startup/resume. Narrow
 * (only Tailscale-caused staleness, owned-config restore or byte-identical
 * strip), idempotent (a clean file is a noop), safe on every snapshot with or
 * without the resume hook — and total: it never throws, so callers log the
 * outcome and continue to diagnostics.
 */
export async function repairStaleTailscaleResolver(
  sandbox: Sandbox,
): Promise<ResolverRepairOutcome> {
  try {
    const current = await readRemoteFile(sandbox, RESOLV_CONF_PATH);
    if (!current.ok) return { action: "needs-attention", reason: "resolv-unreadable" };
    const servers = parseNameservers(current.content);
    if (!servers.some(isTailscaleResolver)) return { action: "noop-clean" };
    const daemon = await tailscaledState(sandbox);
    if (daemon === "live") {
      return { action: "noop-daemon-live", resolvers: servers };
    }
    if (daemon === "indeterminate") {
      return {
        action: "needs-attention",
        reason: "daemon-indeterminate",
        detail: "could not prove tailscaled is gone; refusing repair",
      };
    }

    // Mixed configs keep their custom DNS byte-identical: only Tailscale lines go.
    // The backup is never consulted here — it may predate the custom configuration.
    // Stripping requires at least one usable fallback: Tailscale-plus-garbage would
    // otherwise decay to a garbage-only file that then reads as noop-clean.
    if (!servers.every(isTailscaleResolver)) {
      const usable = servers.filter(isUsableResolver);
      if (usable.length === 0) {
        return {
          action: "needs-attention",
          reason: "no-usable-fallback",
          detail: "Tailscale resolvers mixed only with unusable entries; refusing to strip down to garbage",
        };
      }
      const stale = servers.filter(isTailscaleResolver);
      const stripped = stripTailscaleNameservers(current.content);
      const written = await writeResolvConfGuarded(sandbox, current.content, stripped);
      if (written === "ok") return { action: "repaired-strip", removed: stale, kept: usable };
      return writeFailureOutcome(written);
    }

    // Tailscale-only resolvers: restore the backup, but only when the file is
    // provably Tailscale's own output — otherwise hands off.
    if (!isTailscaleOwnedConfig(current.content)) {
      return {
        action: "needs-attention",
        reason: "not-tailscale-owned",
        detail: "Tailscale-only resolvers without a Tailscale generated header; refusing restore",
      };
    }
    const stale = servers.filter(isTailscaleResolver);
    const backup = await readRemoteFile(sandbox, TAILSCALE_BACKUP_PATH);
    if (!backup.ok) {
      return {
        action: "needs-attention",
        reason: "no-backup-no-fallback",
        detail: "only Tailscale resolvers present with no backup; refusing a public-DNS overwrite",
      };
    }
    const validated = validateBackupNameservers(backup.content);
    if (!validated.ok) {
      return {
        action: "needs-attention",
        reason: "backup-invalid-no-fallback",
        detail: `backup at ${TAILSCALE_BACKUP_PATH} is unusable and no non-Tailscale nameserver survives`,
      };
    }
    const content = backup.content.endsWith("\n") ? backup.content : `${backup.content}\n`;
    const written = await writeResolvConfGuarded(sandbox, current.content, content);
    if (written === "ok") {
      return { action: "repaired-from-backup", removed: stale, restored: validated.servers };
    }
    return writeFailureOutcome(written);
  } catch (error) {
    return {
      action: "needs-attention",
      reason: "repair-error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function describeResolverRepair(outcome: ResolverRepairOutcome): string {
  switch (outcome.action) {
    case "noop-clean":
      return "resolver clean (no Tailscale nameserver)";
    case "noop-daemon-live":
      return `resolver left alone (tailscaled live; ${outcome.resolvers.join(",")})`;
    case "repaired-from-backup":
      return `stale Tailscale resolver repaired from backup (removed ${outcome.removed.join(",")}; restored ${outcome.restored.join(",")})`;
    case "repaired-strip":
      return `stale Tailscale resolver stripped (removed ${outcome.removed.join(",")}; kept ${outcome.kept.join(",")})`;
    case "needs-attention":
      return `resolver needs attention (${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""})`;
  }
}

/**
 * Whether the resume hook should run: cold runtime startup only (no live
 * supervisor and no connected transport). A connected/hot attach skips it
 * entirely — zero added latency and no repeated side effects.
 */
export function shouldRunResumeHook(args: {
  channelConnected: boolean;
  supervisorRunning: boolean;
}): boolean {
  return !args.channelConnected && !args.supervisorRunning;
}

/**
 * Run the lightweight resume hook installed by init.sh: optional in-memory-only
 * process setup lost across a filesystem-only pause (dummy device, tailscaled,
 * ssh snippets). One exec, bounded, minimal env, no secrets. A missing hook is
 * a clean noop so snapshots predating the hook work unchanged; a failing hook
 * is reported, never thrown — full init must not rerun here.
 */
export async function runResumeHook(
  sandbox: Sandbox,
  args: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<ResumeHookOutcome> {
  const script =
    `[ -s ${RESUME_HOOK_PATH} ] || exit 3; ` +
    `bash ${RESUME_HOOK_PATH} 2>&1 | head -c 4000; rc=\${PIPESTATUS[0]}; exit "$rc"`;
  try {
    const result = await sandbox.exec(["bash", "-lc", script], {
      env: args.env,
      timeoutMs: args.timeoutMs ?? RESUME_HOOK_TIMEOUT_MS,
    });
    if (result.exitCode === 3) return { action: "skipped-missing" };
    if (result.exitCode === 0) return { action: "ok" };
    return {
      action: "failed",
      exitCode: result.exitCode,
      output: (result.output ?? "").trim().slice(-1000),
    };
  } catch (error) {
    return {
      action: "failed",
      exitCode: -1,
      output: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    };
  }
}
