import { bundledPiVersion } from "../../core/client/piversion.js";
import { DEFAULT_CONFIG } from "../../core/config.js";
import { launcherVersion, packageRoot, resolveImageRecipe } from "../../core/image.js";
import { PROVIDER_CREDENTIAL_VARS } from "../../core/providers/registry.js";
import {
  supportsImageBuild,
  supportsImageMirror,
  type SandboxProvider,
} from "../../core/providers/types.js";
import { ensureHostedImage } from "../pods/images.js";
import { query } from "../db/index.js";
import { hostCanDial, providerForHost, type HostIdentity } from "../pods/hostidentity.js";
import { sandboxPlacementMode } from "../pods/sandboxfleet.js";
import { withPlatformProviderCredential } from "../pods/providercred.js";
import type { WorkerDeps } from "./index.js";

/** Prepare the one package-free, bake-free managed recipe used as every fallback floor. */
export async function prewarmProviderImage(args: {
  providerName: string;
  provider: SandboxProvider;
  credentialScope: string;
  log: WorkerDeps["log"];
  ensureImage?: typeof ensureHostedImage;
}): Promise<void> {
  if (!supportsImageBuild(args.provider) && !supportsImageMirror(args.provider)) {
    args.log.info(
      `image prewarm: skipping ${args.providerName}; provider can neither build nor mirror managed images`,
    );
    return;
  }
  const recipe = resolveImageRecipe({
    configuredRef: "",
    imagePinned: false,
    launcherVersion: launcherVersion(),
    piVersion: bundledPiVersion(),
    assetRoot: packageRoot(),
    provider: args.provider,
    resources: DEFAULT_CONFIG.resources,
    packages: [],
  });
  if (!recipe.managed) throw new Error("default image recipe unexpectedly resolved as custom");
  if (await args.provider.resolveImage(recipe.ref)) {
    args.log.info(`image prewarm: ${args.providerName} ${recipe.ref} is ready`);
    return;
  }
  args.log.info(`image prewarm: preparing ${args.providerName} ${recipe.ref}`);
  await (args.ensureImage ?? ensureHostedImage)({
    credentialScope: args.credentialScope,
    provider: args.provider,
    recipe,
    resources: DEFAULT_CONFIG.resources,
    assetRoot: packageRoot(),
  });
  args.log.info(`image prewarm: ${args.providerName} ${recipe.ref} is ready`);
}

/**
 * Best-effort rollout warmup for platform-owned provider accounts. BYO organizations use the
 * same canonical recipe and prepare automatically on first launch under their own credential.
 */
export async function runImagePrewarm(deps: WorkerDeps): Promise<void> {
  const placementMode = sandboxPlacementMode(deps.env as unknown as Record<string, unknown>);
  for (const [providerName, envVar] of Object.entries(PROVIDER_CREDENTIAL_VARS)) {
    const credential = deps.env[envVar as keyof typeof deps.env];
    if (typeof credential !== "string" || credential.length === 0) continue;
    // Fleet mode never warms the control-plane fallback URL: fleet hosts are warmed by
    // `fleet preload` across the registered fleet instead (plan §4.1).
    if (providerName === "sandbox" && placementMode === "fleet") {
      deps.log.info("image prewarm: skipping sandbox fallback URL in fleet mode; use `fleet preload`");
      continue;
    }
    try {
      if (providerName === "sandbox") {
        const host = (await query<HostIdentity>("SELECT * FROM sandbox_hosts WHERE url = $1 OR hosted_url = $1", [deps.env.PI_POD_SANDBOX_URL])).rows[0];
        if (host) {
          if (!hostCanDial(host)) continue;
          const routed = providerForHost(host, deps.kek, {}, credential);
          await prewarmProviderImage({ providerName, ...routed, log: deps.log });
          continue;
        }
      }
      await withPlatformProviderCredential({
        provider: providerName,
        credential,
        ...(providerName === "sandbox"
          ? { providerConfig: { url: deps.env.PI_POD_SANDBOX_URL } }
          : {}),
        fn: (provider, credentialScope) =>
          prewarmProviderImage({
            providerName,
            provider,
            credentialScope,
            log: deps.log,
          }),
      });
    } catch (error) {
      deps.log.warn(
        `image prewarm: ${providerName} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
