import type { KekProvider } from "../../secrets/crypto.js";
import type { ServerEnv } from "../../env.js";
import type { PlacedHost, RequestPlacement, SandboxHostRow, FleetClientDeps } from "../sandboxfleet.js";
import { createStaticHostBackend } from "./static.js";
import { edition } from "../../edition.js";

export type HostPlacementRequest = Omit<RequestPlacement, "placementMode" | "freshnessMs" | "allowLegacyHosts" | "ownerUserId">;
export type HostBackendEnv = Pick<ServerEnv,
  "SANDBOX_HOST_BACKEND" | "SANDBOX_PLACEMENT_MODE" | "CAPACITY_FRESHNESS_SECONDS" |
  "SANDBOX_ALLOW_LEGACY_HOSTS" | "PI_POD_SANDBOX_URL"
>;

/** Host acquisition only; sandbox remains the provider for pod lifecycle operations. */
export interface SandboxHostBackend {
  readonly name: string;
  placeHost(exclude?: ReadonlySet<string>, deps?: FleetClientDeps): Promise<SandboxHostRow | null>;
  placeHostForRequest(args: HostPlacementRequest): Promise<PlacedHost | null>;
  fallbackUrl(): string | undefined;
}

/** Explicit boot configuration, never ambient process env or credential overlays. */
export function getSandboxHostBackend(env: HostBackendEnv, owner?: { userId: string; kek: KekProvider; podId?: string }): SandboxHostBackend {
  if ((env.SANDBOX_HOST_BACKEND ?? "static") === "static") return createStaticHostBackend(env);
  return edition().hostBackend(env as ServerEnv, owner);
}
