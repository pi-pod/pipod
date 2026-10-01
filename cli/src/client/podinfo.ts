/**
 * src/client/podinfo.ts — the lines `/pod status` shows (§5.4).
 *
 * Client-side facts from the provider control plane and the session plan — the counterpart
 * of the pod-side `/pod:info`, which tells the *agent* the same story from inside.
 */

export interface PodStatusFacts {
  podId: string;
  provider: string;
  /** Internal provider state; rendered only as provider-agnostic readiness. */
  state: string;
  project: string;
  image: string;
  egress: string;
  /** Effective values, after provider capability clamping (§3.2). */
  idleTimeoutMinutes: number;
  archiveAfterMinutes: number | null;
  /** When present, status renders this instead of inferring from archiveAfterMinutes. */
  archiveTransition?:
    | { kind: "same-as-stop"; expiryDays: null }
    | { kind: "after-stop"; maxDelayDays: number };
  createdAtMs?: number | undefined;
}

export function buildPodStatusLines(facts: PodStatusFacts): string[] {
  const lines = [
    "pi pod session",
    `  pod id     ${facts.podId}`,
    `  provider   ${facts.provider}`,
    `  readiness  ${facts.state === "started" ? "ready" : ["provisioning", "starting"].includes(facts.state) ? "initializing" : "unavailable"}`,
    `  project    ${facts.project}`,
    `  image      ${facts.image}`,
    `  egress     ${facts.egress}`,
  ];

  lines.push(
    facts.idleTimeoutMinutes === 0
      ? "  retention  provider auto-stop off; `pipod gc` is the fallback"
      : `  retention  provider auto-stop after ${facts.idleTimeoutMinutes} min without activity`,
  );
  const sameAsStop = facts.archiveTransition?.kind === "same-as-stop" || facts.archiveAfterMinutes === null;
  const storageWindow =
    sameAsStop || facts.archiveAfterMinutes === null
      ? null
      : facts.archiveAfterMinutes < 24 * 60
        ? `${facts.archiveAfterMinutes} min`
        : `${facts.archiveAfterMinutes / (24 * 60)} day(s)`;
  lines.push(
    sameAsStop
      ? "  storage    stop is already at-rest; no provider expiry is documented"
      : `  storage    may compact after ${storageWindow}; access restores automatically`,
  );
  lines.push("  archive    logical /pod archive is separate from provider storage compaction");

  if (facts.createdAtMs !== undefined) {
    lines.push(`  uptime     ${formatUptime(Date.now() - facts.createdAtMs)}`);
  }
  return lines;
}

function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m`;
  const days = Math.floor(hours / 24);
  if (days < 1) return `${hours}h ${minutes % 60}m`;
  return `${days}d ${hours % 24}h`;
}
