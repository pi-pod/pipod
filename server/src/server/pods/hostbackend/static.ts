import {
  capacityFreshnessMs,
  placeSandboxHost,
  placeSandboxHostForRequest,
  sandboxPlacementMode,
} from "../sandboxfleet.js";
import type { HostBackendEnv, SandboxHostBackend } from "./index.js";

/** Preserve the existing registered-host selection and single-host URL fallback. */
export function createStaticHostBackend(env: HostBackendEnv): SandboxHostBackend {
  return {
    name: "static",
    placeHost: (exclude = new Set(), deps = {}) => placeSandboxHost(exclude, sandboxPlacementMode(env), deps),
    placeHostForRequest: (args) => placeSandboxHostForRequest({
      ...args,
      // Personal custody is never a caller override of the static edition.
      ownerUserId: undefined,
      placementMode: sandboxPlacementMode(env),
      freshnessMs: capacityFreshnessMs(env),
      allowLegacyHosts: env.SANDBOX_ALLOW_LEGACY_HOSTS,
    }),
    fallbackUrl: () => env.PI_POD_SANDBOX_URL,
  };
}
