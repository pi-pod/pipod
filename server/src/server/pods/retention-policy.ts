/**
 * Canonical retention policy (plan §3.1): 15 min idle, 60 min stopped archive.
 *
 * The deployment maximum (POD_SANDBOX_MAX_ARCHIVE_AFTER_MINUTES, default 60) scopes to
 * platform-funded native sandboxes only: provider `sandbox` launched under the platform
 * credential. BYOK (`org-secret` custody) and non-sandbox providers keep their documented
 * behavior — the deployment never rewrites an external service's timer.
 *
 * The launch report (resolved_config) is immutable; the mutable effective retention lives
 * in `pod_retention` (one row per pod, versioned by revision). Readers prefer the table
 * and fall back to the launch report for legacy rows. Reapplying policy never resets the
 * stopped clock — only a real new stop does.
 */
import type { Queryable } from "../db/index.js";
import { query } from "../db/index.js";
import type { Clamp } from "../settings/merge.js";
import type { PodRow } from "./types.js";

export const PLATFORM_ARCHIVE_DEFAULT_MINUTES = 60;
export const PLATFORM_ARCHIVE_MAX_DEFAULT = 60;

/** Deployment max from env (default 60). Always finite: zero/unlimited cannot bypass it. */
export function platformArchiveMaxMinutes(env: { POD_SANDBOX_MAX_ARCHIVE_AFTER_MINUTES?: unknown }): number {
  const raw = env.POD_SANDBOX_MAX_ARCHIVE_AFTER_MINUTES;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  return PLATFORM_ARCHIVE_MAX_DEFAULT;
}

/** True only for platform-funded native sandboxes: the deployment max applies. */
export function isPlatformFundedSandbox(args: {
  providerName: string;
  credentialSource: "org-secret" | "platform" | null;
}): boolean {
  return args.providerName === "sandbox" && args.credentialSource === "platform";
}

export interface EffectiveRetention {
  /** What the provider timer and the server reaper must both enforce. */
  effectiveArchiveAfterMinutes: number;
  /** Whether the deployment max participated (platform-funded only). */
  scoped: boolean;
  /** Bounded, actionable clamp entries for the launch report (never silent). */
  clamps: Clamp[];
  warnings: string[];
  provenance: string;
}

/**
 * Resolve the effective archive delay. Pure for tests. Rules in order:
 * 1. Non-platform (BYOK or other provider): deployment max does not apply. Zero stays
 *    zero (provider semantics); org max still narrows.
 * 2. Platform: zero/unlimited clamps to the deployment max (finite SaaS ceiling).
 * 3. The stricter of (requested, org max, deployment max) wins; every clamp is reported.
 */
export function resolveEffectiveRetention(args: {
  requestedMinutes: number;
  /** Verified personal host identity, never an edition flag or request setting. */
  ownedBoatHost?: boolean;
  orgMaxMinutes?: number | undefined;
  deploymentMaxMinutes?: number | undefined;
  providerName: string;
  credentialSource: "org-secret" | "platform" | null;
}): EffectiveRetention {
  const clamps: Clamp[] = [];
  const warnings: string[] = [];
  if (args.ownedBoatHost) return {
    effectiveArchiveAfterMinutes: 0, scoped: false, clamps, warnings,
    provenance: "owned-boat-local-disk-retained",
  };
  const scoped = isPlatformFundedSandbox({
    providerName: args.providerName,
    credentialSource: args.credentialSource,
  });
  const deploymentMax = args.deploymentMaxMinutes ?? PLATFORM_ARCHIVE_MAX_DEFAULT;
  let effective = args.requestedMinutes;

  if (!scoped) {
    if (args.orgMaxMinutes !== undefined && effective > args.orgMaxMinutes) {
      clamps.push({
        path: "archiveAfterMinutes",
        from: effective,
        to: args.orgMaxMinutes,
        reason: "org policy maxArchiveAfterMinutes",
      });
      effective = args.orgMaxMinutes;
    }
    return {
      effectiveArchiveAfterMinutes: effective,
      scoped: false,
      clamps,
      warnings,
      provenance: "launch+org-policy",
    };
  }

  // Platform: zero/unlimited never bypasses the finite maximum.
  if (!Number.isFinite(effective) || effective <= 0) {
    clamps.push({
      path: "archiveAfterMinutes",
      from: args.requestedMinutes,
      to: deploymentMax,
      reason: "deployment POD_SANDBOX_MAX_ARCHIVE_AFTER_MINUTES (unlimited not permitted on platform fleet)",
    });
    warnings.push(
      `archiveAfterMinutes ${args.requestedMinutes} is not permitted on the platform fleet; using ${deploymentMax}`,
    );
    effective = deploymentMax;
  }
  if (args.orgMaxMinutes !== undefined && effective > args.orgMaxMinutes) {
    clamps.push({
      path: "archiveAfterMinutes",
      from: effective,
      to: args.orgMaxMinutes,
      reason: "org policy maxArchiveAfterMinutes (stricter than deployment maximum)",
    });
    effective = args.orgMaxMinutes;
  }
  if (effective > deploymentMax) {
    clamps.push({
      path: "archiveAfterMinutes",
      from: effective,
      to: deploymentMax,
      reason: "deployment POD_SANDBOX_MAX_ARCHIVE_AFTER_MINUTES",
    });
    warnings.push(
      `archiveAfterMinutes clamped to the platform maximum of ${deploymentMax} minutes`,
    );
    effective = deploymentMax;
  }
  return {
    effectiveArchiveAfterMinutes: effective,
    scoped: true,
    clamps,
    warnings,
    provenance: "launch+org-policy+deployment-max",
  };
}

// ---------------------------------------------------------------------------
// Versioned effective-retention record (pod_retention)
// ---------------------------------------------------------------------------

/** Which custody funded the pod: the deployment max applies to platform only. */
export type CredentialSource = "platform" | "org-secret";

export interface RetentionRecord {
  pod_id: string;
  desired_archive_after_minutes: number;
  revision: number;
  previous_archive_after_minutes: number | null;
  status: string;
  provider_archive_after_minutes: number | null;
  /** NULL = unknown (legacy rows written before this column existed). */
  credential_source: CredentialSource | null;
  updated_at: string;
}

/** Create the launch record in the SAME transaction as the pod insert (atomic). */
export async function createRetentionRecord(
  client: Queryable,
  args: { podId: string; desiredMinutes: number; credentialSource: CredentialSource | null },
): Promise<void> {
  await client.query(
    `INSERT INTO pod_retention (pod_id, desired_archive_after_minutes, revision, status, credential_source)
     VALUES ($1, $2, 1, 'pending', $3)`,
    [args.podId, args.desiredMinutes, args.credentialSource],
  );
}

/** Latest desired state, or null for legacy rows without a record yet. */
export async function readRetentionRecord(
  podId: string,
  client: Queryable = { query: (text: string, params?: unknown[]) => query(text, params ?? []) } as Queryable,
): Promise<RetentionRecord | null> {
  const rows = await client.query<RetentionRecord>(
    `SELECT pod_id, desired_archive_after_minutes, revision, previous_archive_after_minutes,
            status, provider_archive_after_minutes, credential_source, updated_at
       FROM pod_retention WHERE pod_id = $1`,
    [podId],
  );
  return (rows.rows[0] as RetentionRecord | undefined) ?? null;
}

/**
 * Effective delay for timers: the versioned record wins; legacy rows fall back to the
 * frozen launch report (config.archiveAfterMinutes, then legacy days). Both the server
 * reaper and provider retention updates must use this one value.
 */
export function effectiveDelayForPod(
  pod: Pick<PodRow, "resolved_config">,
  record: RetentionRecord | null,
): number {
  if (record) return record.desired_archive_after_minutes;
  const retention = (pod.resolved_config as unknown as {
    retention?: { effectiveArchiveAfterMinutes?: number | null };
  })?.retention;
  if (typeof retention?.effectiveArchiveAfterMinutes === "number") {
    return retention.effectiveArchiveAfterMinutes;
  }
  const config = (pod.resolved_config as unknown as {
    config?: { archiveAfterMinutes?: number; archiveAfterDays?: number };
  })?.config;
  if (typeof config?.archiveAfterMinutes === "number") return config.archiveAfterMinutes;
  if (typeof config?.archiveAfterDays === "number") return config.archiveAfterDays * 24 * 60;
  return PLATFORM_ARCHIVE_DEFAULT_MINUTES;
}
