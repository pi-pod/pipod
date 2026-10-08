import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import type { Manager } from "../core/manager.js";
import { ServiceError, badRequest } from "../errors.js";
import type { Logger } from "../log.js";
import { ERR_DERIVE_UNAVAILABLE, type DeriveImageRequest, type ResourceSpec } from "../wire.js";
import { packUpperLayer } from "./layer.js";
import {
  OCI_MANIFEST,
  LoopbackRegistryWriter,
  RegistryClient,
  isLoopbackRegistry,
  normalizeReference,
  type NormalizedReference,
  type OciDescriptor,
} from "./registry.js";
import type { ResolvedImage } from "./types.js";

/** Marks the disposable sandboxes derivations run in, so a restart can find and remove them. */
export const IMAGE_BUILD_LABEL = "pi-pod-sandbox/purpose";
const IMAGE_BUILD_VALUE = "image-build";
const SCRIPT_TIMEOUT_MS = 30 * 60_000;
/** Keeps the build sandbox's activity clock current while a quiet download runs. */
const TOUCH_INTERVAL_MS = 30_000;
const OUTPUT_TAIL_BYTES = 4096;
/**
 * Paths crun creates in the root filesystem to bind the runtime's own files over. They exist in
 * every sandbox and in no image; /etc/hosts and /etc/resolv.conf are in the base already.
 */
const RUNTIME_MOUNT_STUBS = [".pps-init"];
/**
 * Runs the script it reads on stdin. A script can outgrow one exec argument (128 KiB on
 * Linux), and a command in it must not read the rest of the script as its own input, so it
 * runs from a temporary file with stdin closed, as a Dockerfile RUN does. The file is removed
 * before the layer is taken.
 */
const SCRIPT_RUNNER = 'script=$(mktemp) && trap \'rm -f "$script"\' EXIT && cat > "$script" && bash "$script" < /dev/null';
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const DOCKER_TO_OCI_LAYER: Record<string, string> = {
  "application/vnd.docker.image.rootfs.diff.tar.gzip": "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.docker.image.rootfs.diff.tar": "application/vnd.oci.image.layer.v1.tar",
};

/** The derivation script itself failed; the end of its output says why. */
export class DeriveScriptFailure extends ServiceError {
  constructor(exitCode: number, readonly outputTail: string) {
    super(`the derivation script exited with code ${exitCode}`, "derive_failed", 422);
  }
}

/** A request that passed validation; deriving it can still fail, but not be refused. */
export interface DerivePlan {
  base: NormalizedReference;
  ref: NormalizedReference;
  script: string;
  resources?: ResourceSpec;
}

/**
 * Check a derive request against what this host can publish, before any work starts. The
 * result must live where the host pulls it from again \u2014 after a restart, a layer repair or a
 * garbage collection \u2014 so it is published next to its base, and only in a loopback registry:
 * one this deployment owns. Anything else is `derive_unavailable`, and the caller prepares
 * the image some other way.
 */
export function planDerive(body: unknown): DerivePlan {
  const request = body as Partial<DeriveImageRequest> | null;
  if (typeof request?.base !== "string" || typeof request.ref !== "string" || typeof request.script !== "string") {
    throw badRequest("base, ref and script are required strings");
  }
  let base: NormalizedReference;
  let ref: NormalizedReference;
  try {
    base = normalizeReference(request.base);
    ref = normalizeReference(request.ref);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }
  if (ref.ref.includes("@")) throw badRequest("ref must be a tag: a derived image has no digest until it is built");
  if (base.registry !== ref.registry || base.repository !== ref.repository || !isLoopbackRegistry(ref.apiHost)) {
    throw new ServiceError(
      `cannot publish ${ref.ref}: derived images are published only beside their base in a loopback registry`,
      ERR_DERIVE_UNAVAILABLE,
      409,
      "prepare this image with the registry's own tooling",
    );
  }
  return { base, ref, script: request.script, ...(request.resources ? { resources: request.resources } : {}) };
}

/**
 * Builds images as base + one layer: what a script leaves behind in a disposable sandbox,
 * published to the base's loopback registry and then pulled like any other image. This is how
 * a self-hosted deployment, which has no image builder, gets the package and bake variants
 * the server launches from, so that only the first launch of a recipe pays for running them.
 *
 * The script gets what an image build gets: root in /root, no secrets, no workspace, and open
 * egress to public addresses (sandboxes never reach private ones).
 */
export class ImageDeriver {
  readonly #inFlight = new Map<string, Promise<ResolvedImage>>();

  constructor(
    private readonly manager: Manager,
    private readonly spoolDir: string,
    private readonly log: Logger,
  ) {}

  /** A call for a `ref` already being derived joins that derivation (without its log). */
  derive(plan: DerivePlan, onLog: (line: string) => void = () => {}): Promise<ResolvedImage> {
    const key = plan.ref.ref;
    const current = this.#inFlight.get(key);
    if (current) {
      onLog(`joining the derivation of ${key} already in progress`);
      return current;
    }
    const task = this.#derive(plan, onLog).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, task);
    return task;
  }

  async #derive(plan: DerivePlan, onLog: (line: string) => void): Promise<ResolvedImage> {
    const images = this.manager.imagesRef;
    const present = await images.resolve(plan.ref.ref);
    if (present) return present;
    const writer = new LoopbackRegistryWriter(plan.ref);
    if (await writer.hasManifest(plan.ref.reference)) {
      onLog(`${plan.ref.ref} is already published; pulling it`);
      return await images.pull(plan.ref.ref);
    }

    // Build on the exact manifest the published config will name as its base, even if the
    // base tag moves meanwhile.
    const base = (await images.resolve(plan.base.ref)) ?? (await images.pull(plan.base.ref));
    const pinnedBase = normalizeReference(`${plan.base.registry}/${plan.base.repository}@${base.manifestDigest}`);
    const registry = new RegistryClient().request();
    const baseManifest = await registry.fetchManifest(pinnedBase);
    const baseConfig = await readVerifiedBlob(await registry.fetchBlob(pinnedBase, baseManifest.manifest.config.digest),
      baseManifest.manifest.config.digest);

    await mkdir(this.spoolDir, { recursive: true });
    const layerFile = path.join(this.spoolDir, `derive-${createHash("sha256").update(plan.ref.ref).digest("hex").slice(0, 16)}-${Date.now()}.tar.zst`);
    try {
      onLog(`running the derivation script for ${plan.ref.ref} on ${plan.base.ref}`);
      const layer = await this.#runInBuildSandbox(pinnedBase.ref, plan, layerFile, onLog);
      onLog(`publishing a ${layer.size}-byte layer as ${plan.ref.ref}`);
      const config = derivedConfig(baseConfig, layer.diffId);
      const configDigest = `sha256:${createHash("sha256").update(config).digest("hex")}`;
      const manifest = Buffer.from(JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: OCI_CONFIG, digest: configDigest, size: config.byteLength },
        layers: [
          ...baseManifest.manifest.layers.map(ociLayerDescriptor),
          { mediaType: layer.mediaType, digest: layer.digest, size: layer.size },
        ],
      }));
      await writer.putBlob(layer.digest, await openAsBlob(layerFile));
      await writer.putBlob(configDigest, new Blob([config]));
      await writer.putManifest(plan.ref.reference, manifest, OCI_MANIFEST);
    } finally {
      await rm(layerFile, { force: true });
    }
    const image = await images.pull(plan.ref.ref);
    this.log.info({ image: image.ref, digest: image.manifestDigest }, "derived image published");
    return image;
  }

  async #runInBuildSandbox(
    image: string,
    plan: DerivePlan,
    layerFile: string,
    onLog: (line: string) => void,
  ): Promise<Awaited<ReturnType<typeof packUpperLayer>>> {
    const sandbox = await this.manager.create({
      image,
      workdir: "/workspace",
      ...(plan.resources ? { resources: plan.resources } : {}),
      labels: { [IMAGE_BUILD_LABEL]: IMAGE_BUILD_VALUE },
      archiveAfterMinutes: 0,
      idleTimeoutMinutes: 0,
      egress: { mode: "open" },
    });
    const touch = setInterval(() => {
      void this.manager.touch(sandbox.id).catch(() => undefined);
    }, TOUCH_INTERVAL_MS);
    touch.unref();
    try {
      let tail = Buffer.alloc(0);
      let partial = "";
      const output = (chunk: Buffer): void => {
        tail = Buffer.concat([tail, chunk]).subarray(-OUTPUT_TAIL_BYTES);
        const lines = (partial + chunk.toString("utf8")).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) onLog(line);
      };
      const exitCode = await this.manager.execStream(
        sandbox.id,
        { argv: ["bash", "-c", SCRIPT_RUNNER], cwd: "/root", timeoutMs: SCRIPT_TIMEOUT_MS },
        { onStdout: output, onStderr: output, onStarted: (_kill, stdin) => stdin.end(plan.script) },
      );
      if (partial) onLog(partial);
      if (exitCode !== 0) throw new DeriveScriptFailure(exitCode, tail.toString("utf8"));
      clearInterval(touch);
      await this.manager.stop(sandbox.id);
      return await this.manager.withStoppedUpper(sandbox.id, (upper) =>
        packUpperLayer(upper, layerFile, RUNTIME_MOUNT_STUBS));
    } finally {
      clearInterval(touch);
      await this.manager.delete(sandbox.id).catch((err: unknown) =>
        this.log.warn({ err, sandbox: sandbox.id }, "could not delete an image build sandbox; a restart removes it"));
    }
  }
}

/**
 * Delete the build sandboxes a previous run left behind. Their script died with that run, so
 * they hold admitted capacity and disk for nothing. Call once, after the manager has started.
 */
export async function removeAbandonedImageBuilds(manager: Manager, log: Logger): Promise<void> {
  for (const sandbox of manager.list({ [IMAGE_BUILD_LABEL]: IMAGE_BUILD_VALUE })) {
    try {
      await manager.delete(sandbox.id);
      log.info({ sandbox: sandbox.id }, "removed an abandoned image build sandbox");
    } catch (err) {
      log.warn({ err, sandbox: sandbox.id }, "could not remove an abandoned image build sandbox");
    }
  }
}

async function readVerifiedBlob(response: Response, digest: string): Promise<Buffer> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, hex] = digest.split(":", 2) as [string, string];
  if (createHash(algorithm).update(bytes).digest("hex") !== hex.toLowerCase()) {
    throw new Error(`blob digest verification failed for ${digest}`);
  }
  return bytes;
}

/** The base's image config with one more layer: same runtime settings, one more diff_id. */
function derivedConfig(baseConfig: Buffer, diffId: string): Buffer {
  const config = JSON.parse(baseConfig.toString("utf8")) as {
    created?: string;
    rootfs?: { type?: string; diff_ids?: string[] };
    history?: Array<Record<string, unknown>>;
  };
  const created = new Date().toISOString();
  config.created = created;
  config.rootfs = { type: "layers", diff_ids: [...(config.rootfs?.diff_ids ?? []), diffId] };
  config.history = [...(config.history ?? []), { created, created_by: "pi pod image derivation", comment: "packages and bake script" }];
  return Buffer.from(JSON.stringify(config));
}

/** Base layers are named in an OCI manifest, so Docker's media types take their OCI spelling. */
function ociLayerDescriptor(descriptor: OciDescriptor): OciDescriptor {
  return {
    ...descriptor,
    mediaType: DOCKER_TO_OCI_LAYER[descriptor.mediaType] ?? descriptor.mediaType,
  };
}

