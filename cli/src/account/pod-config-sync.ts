/**
 * src/account/pod-config-sync.ts — the pod-derived TUI config sync pipeline.
 *
 * One serialized, generation-aware pipeline for every sync trigger: attach, reconnect,
 * `/pod switch`, and manual `/pod sync`. Outcomes are values, never exceptions — reconnect
 * runs inside `onRecovered`, where a throw reads as a failed recovery. A switch that cannot
 * produce the target pod's manifest rewrites the derived dir to host-only settings, so pod
 * A's settings are never left active against pod B.
 */
import type { ShimHello } from "../client/protocol.js";
import type { DerivedPodConfig } from "../client/runtime/pod-derived-config.js";
import { manifestCacheDir, readManifestCache, writeManifestCache } from "../client/runtime/pod-derived-config.js";
import {
  validatePodTuiManifest,
  type PodExtensionIdentity,
  type PodTuiManifest,
} from "../client/runtime/pod-manifest.js";
import { debug } from "../log.js";
import type { TuiManifestFrame } from "./gateway-rpc.js";

/** First shim generation that answers `tui_manifest`; older pods skip the request entirely. */
export const MIN_MANIFEST_SHIM_VERSION = 13;

export type PodConfigSyncReason = "attach" | "reconnect" | "switch" | "manual";

export type PodConfigSyncOutcome =
  | {
      kind: "applied";
      podId: string;
      digest: string;
      /** False when the digest matches what this session last applied. */
      changed: boolean;
      /** The pod's disk drifted from what pi loaded at boot. */
      drift: boolean;
      themeCount: number;
      /** On-disk extension identities, for the attested-set diff (agent-era installs). */
      extensions: PodExtensionIdentity[];
      diagnostics: string[];
    }
  | { kind: "unsupported"; reason: string }
  | { kind: "invalid" }
  | { kind: "failed"; message: string }
  | { kind: "stale" };

export interface PodConfigSyncRpc {
  readonly podId: string;
  readonly helloInfo: ShimHello | null;
  getTuiManifest(knownDigest?: string): Promise<TuiManifestFrame>;
}

export interface PodConfigSyncDeps {
  rpc: PodConfigSyncRpc;
  derived: DerivedPodConfig;
  cacheRoot: string | null;
  serverHost: string;
}

export interface PodConfigSync {
  sync(reason: PodConfigSyncReason): Promise<PodConfigSyncOutcome>;
  /** Bound after the runtime exists: applies a refreshed derived dir (settings reload). */
  setOnAfterApply(callback: (() => Promise<void>) | null): void;
}

export function manifestCapable(hello: ShimHello | null): boolean {
  const version = Number.parseInt(hello?.shimVersion ?? "", 10);
  return Number.isFinite(version) && version >= MIN_MANIFEST_SHIM_VERSION;
}

export function createPodConfigSync(deps: PodConfigSyncDeps): PodConfigSync {
  let tail: Promise<unknown> = Promise.resolve();
  let onAfterApply: (() => Promise<void>) | null = null;
  const appliedDigests = new Map<string, string>();

  const fallBackToHost = async (): Promise<void> => {
    try {
      deps.derived.refresh(null);
      await onAfterApply?.();
    } catch (error) {
      debug(`pod config host fallback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const run = async (reason: PodConfigSyncReason): Promise<PodConfigSyncOutcome> => {
    const podId = deps.rpc.podId;
    if (!manifestCapable(deps.rpc.helloInfo)) {
      // A switch to a pre-manifest pod must not keep the previous pod's settings active.
      if (reason === "switch") await fallBackToHost();
      const shimVersion = deps.rpc.helloInfo?.shimVersion ?? "unknown";
      return { kind: "unsupported", reason: `the pod runs shim ${shimVersion}, which predates pod-derived settings` };
    }
    const cacheDir = deps.cacheRoot ? manifestCacheDir(deps.cacheRoot, deps.serverHost, podId) : null;
    const cached = cacheDir ? readManifestCache(cacheDir) : null;
    try {
      let frame = await deps.rpc.getTuiManifest(cached?.digest);
      if (deps.rpc.podId !== podId) return { kind: "stale" };
      if (frame.unsupported) {
        if (reason === "switch") await fallBackToHost();
        return { kind: "unsupported", reason: "the server predates pod-derived settings" };
      }
      let manifest: PodTuiManifest | null = null;
      if (frame.unchanged === true) {
        manifest = cached;
        if (manifest === null) {
          // The unchanged short-circuit answered a digest whose cache entry is gone; re-ask.
          frame = await deps.rpc.getTuiManifest();
          if (deps.rpc.podId !== podId) return { kind: "stale" };
          if (frame.unsupported || frame.unchanged === true) {
            if (reason === "switch") await fallBackToHost();
            return { kind: "failed", message: "the pod answered without a manifest" };
          }
        }
      }
      manifest ??= validatePodTuiManifest(frame);
      if (manifest === null) {
        await fallBackToHost();
        return { kind: "invalid" };
      }
      if (cacheDir) {
        try {
          writeManifestCache(cacheDir, manifest);
        } catch (error) {
          debug(`pod manifest cache write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      deps.derived.refresh(manifest);
      const changed = appliedDigests.get(podId) !== manifest.digest;
      appliedDigests.set(podId, manifest.digest);
      await onAfterApply?.();
      if (deps.rpc.podId !== podId) return { kind: "stale" };
      return {
        kind: "applied",
        podId,
        digest: manifest.digest,
        changed,
        drift: manifest.bootDigest !== null && manifest.bootDigest !== manifest.digest,
        themeCount: manifest.themes.length,
        extensions: manifest.extensions,
        diagnostics: manifest.diagnostics,
      };
    } catch (error) {
      if (reason === "switch") await fallBackToHost();
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    sync: (reason) => {
      const result = tail.then(
        () => run(reason),
        () => run(reason),
      );
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    setOnAfterApply: (callback) => {
      onAfterApply = callback;
    },
  };
}

/** The user-facing line for a non-applied outcome; null when nothing is worth saying. */
export function podConfigSyncNotice(outcome: PodConfigSyncOutcome): { message: string; type: "info" | "warning" } | null {
  switch (outcome.kind) {
    case "applied":
      return outcome.drift
        ? {
            message:
              "pod config changed on disk after pi started — the agent's process may run older config until it restarts",
            type: "warning",
          }
        : null;
    case "unsupported":
      return { message: `pod-derived settings unavailable (${outcome.reason}); using host settings`, type: "info" };
    case "invalid":
      return { message: "the pod's settings manifest failed validation; using host settings", type: "warning" };
    case "failed":
      return { message: `pod settings sync failed: ${outcome.message}; using host settings`, type: "warning" };
    case "stale":
      return null;
  }
}
