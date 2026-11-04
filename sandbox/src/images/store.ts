import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { assertLayerNotMounted, fileDigest, layerTreeDigest, layerTreeFingerprint, verifyDiffDigest } from "./integrity.js";
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ImagePullOptions, ImageRuntimeConfig, ImageStore, ResolvedImage } from "./types.js";
import {
  normalizeReference,
  RegistryClient,
  type NormalizedReference,
  type OciDescriptor,
  type RegistryRequest,
  type HostRegistryAuth,
  type RegistryAuth,
} from "./registry.js";

interface StoredImage extends ResolvedImage {
  blobDigests?: string[];
  layerSources?: Array<{ diffDigest: string; descriptor: OciDescriptor }>;
  /**
   * Per lower, the content digest that verified it and the tree fingerprint at that moment.
   * Persisted so a restart can trust an unchanged tree with a metadata walk instead of
   * re-hashing the blob, re-extracting the layer and hashing both trees again — which is what
   * made a restart take minutes (measured: 361.7 s of a 362.4 s boot). Contents are still
   * compared by {@link scrub}, which runs every IMAGE_SCRUB_INTERVAL_MS.
   */
  layerVerifications?: Record<string, { content: string; fingerprint: string }>;
  /** Retain historical manifests for local pods without adding implicit aliases to /images. */
  cacheOnly?: boolean;
}

interface ImageConfigDocument {
  config?: {
    Env?: unknown;
    Entrypoint?: unknown;
    Cmd?: unknown;
    WorkingDir?: unknown;
    User?: unknown;
  };
  rootfs?: {
    diff_ids?: unknown;
  };
}

const DIGEST_PATTERN = /^([A-Za-z0-9_+.-]+):([0-9a-fA-F]+)$/;

function parseDigest(digest: string): { algorithm: string; hex: string } {
  const match = DIGEST_PATTERN.exec(digest);
  if (!match) throw new Error(`invalid OCI digest: ${digest}`);
  return { algorithm: match[1]!.toLowerCase(), hex: match[2]!.toLowerCase() };
}

async function isDirectory(location: string): Promise<boolean> {
  try {
    return (await stat(location)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isFile(location: string): Promise<boolean> {
  try {
    return (await stat(location)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const reason = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
        reject(new Error(`${command} failed (${reason})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      }
    });
  });
}

function compressionArguments(mediaType: string): string[] {
  if (mediaType.includes("zstd")) return ["--zstd"];
  if (mediaType.includes("gzip") || mediaType.endsWith(".tar.gzip")) return ["--gzip"];
  if (mediaType.includes("layer.v1.tar") || mediaType.includes("rootfs.diff.tar")) return [];
  throw new Error(`unsupported image layer media type: ${mediaType || "unknown"}`);
}

async function convertWhiteouts(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".wh..wh..opq") {
      await rm(path.join(directory, entry.name), { force: true, recursive: true });
      await run("setfattr", ["-n", "trusted.overlay.opaque", "-v", "y", directory]);
    } else if (entry.name.startsWith(".wh.")) {
      const marker = path.join(directory, entry.name);
      const target = path.join(directory, entry.name.slice(4));
      await rm(target, { force: true, recursive: true });
      await rm(marker, { force: true, recursive: true });
      await run("mknod", [target, "c", "0", "0"]);
    }
  }

  const remaining = await readdir(directory, { withFileTypes: true });
  for (const entry of remaining) {
    if (entry.isDirectory()) await convertWhiteouts(path.join(directory, entry.name));
  }
}

export async function extractLayerBlob(blobPath: string, mediaType: string, targetDirectory: string): Promise<void> {
  if (await isDirectory(targetDirectory)) return;
  await mkdir(path.dirname(targetDirectory), { recursive: true });
  const temporaryDirectory = `${targetDirectory}.tmp-${randomUUID()}`;
  await mkdir(temporaryDirectory, { recursive: false });

  try {
    await run("tar", [
      "--extract",
      "--file",
      blobPath,
      "--directory",
      temporaryDirectory,
      "--numeric-owner",
      "--xattrs",
      "--xattrs-include=*",
      "-p",
      ...compressionArguments(mediaType),
    ]);
    await convertWhiteouts(temporaryDirectory);
    try {
      await rename(temporaryDirectory, targetDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
        throw error;
      }
      if (!(await isDirectory(targetDirectory))) throw error;
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function runtimeConfig(document: ImageConfigDocument): ImageRuntimeConfig {
  const source = document.config ?? {};
  const result: ImageRuntimeConfig = {
    env: stringArray(source.Env),
    entrypoint: stringArray(source.Entrypoint),
    cmd: stringArray(source.Cmd),
  };
  if (typeof source.WorkingDir === "string" && source.WorkingDir) result.workingDir = source.WorkingDir;
  if (typeof source.User === "string" && source.User) result.user = source.User;
  return result;
}

function publicImage(record: StoredImage): ResolvedImage {
  return {
    ref: record.ref,
    manifestDigest: record.manifestDigest,
    layers: [...record.layers],
    config: {
      env: [...record.config.env],
      entrypoint: [...record.config.entrypoint],
      cmd: [...record.config.cmd],
      ...(record.config.workingDir !== undefined ? { workingDir: record.config.workingDir } : {}),
      ...(record.config.user !== undefined ? { user: record.config.user } : {}),
    },
    pulledAt: record.pulledAt,
  };
}

export function omitEmptyDiffLayers(diffIds: string[], emptyDigests: ReadonlySet<string>): string[] {
  const meaningful = diffIds.filter((digest) => !emptyDigests.has(digest));
  // OverlayFS still needs one lowerdir for a scratch-like image whose every layer is empty.
  return meaningful.length > 0 ? meaningful : diffIds.slice(0, 1);
}

export class OciImageStore implements ImageStore {
  readonly #stateDir: string;
  readonly #blobsDir: string;
  readonly #layersDir: string;
  readonly #refsDir: string;
  readonly #registry: RegistryClient;
  readonly #log: (message: string) => void;
  readonly #blobTasks = new Map<string, Promise<string>>();
  readonly #layerTasks = new Map<string, Promise<number>>();
  readonly #maxImageBytes: number;
  /**
   * Lowers whose contents were verified since boot: the content digest that verified them and
   * the tree's fingerprint at that moment. A resolve compares the fingerprint, which reads no
   * file contents; {@link scrub} compares the contents.
   */
  readonly #verifiedLayers = new Map<string, { content: string; fingerprint: string }>();
  readonly #layerChecks = new Map<string, Promise<boolean>>();

  constructor(options: {
    stateDir: string;
    auth?: HostRegistryAuth;
    log?: (message: string) => void;
    /** Largest image a pull may store, compressed or extracted. */
    maxImageBytes?: number;
  }) {
    this.#maxImageBytes = options.maxImageBytes ?? Number.POSITIVE_INFINITY;
    this.#stateDir = path.resolve(options.stateDir);
    this.#blobsDir = path.join(this.#stateDir, "images", "blobs");
    this.#layersDir = path.join(this.#stateDir, "layers");
    this.#refsDir = path.join(this.#stateDir, "images", "refs");
    this.#log = options.log ?? (() => undefined);
    this.#registry = new RegistryClient({ auth: options.auth, log: this.#log });
  }

  layerDir(digest: string): string {
    const { algorithm, hex } = parseDigest(digest);
    return path.join(this.#layersDir, `${algorithm}-${hex}`);
  }

  /**
   * Must finish before runtime reconciliation or any listener is started. Failure is fatal.
   *
   * Verifies exactly the lowers a sandbox that can resume would mount. Every stored image ref
   * used to be re-verified here — blob hashed, layer re-extracted, both trees hashed — which
   * cost 361.7 s of a 362.4 s restart for layers nothing was about to mount, while adopting the
   * whole retained state afterwards took 663 ms. An unverified ref is not a correctness risk:
   * `resolve` refuses it (its lower is not in {@link #verifiedLayers}) so the next pull repairs
   * it, and {@link scrub} re-hashes verified contents every IMAGE_SCRUB_INTERVAL_MS.
   *
   * An unchanged tree is trusted from the record's persisted fingerprint: metadata only, no
   * file contents read, the same model `resolve` already relies on within a boot.
   */
  async validateAndRepair(required: Array<{ image: string; imageDigest: string; layers: string[] }> = []): Promise<void> {
    this.#verifiedLayers.clear();
    const layersByRef = new Map<string, string[]>();
    let reused = 0;
    let reverified = 0;
    for (const row of required) {
      const reference = normalizeReference(row.image);
      let layers = layersByRef.get(reference.ref);
      if (layers === undefined) {
        layers = await this.#verifyLowers(reference, row.imageDigest, (how) => {
          if (how === "persisted") reused += 1;
          else reverified += 1;
        });
        layersByRef.set(reference.ref, layers);
      }
      // The row pins the manifest it was created from; a layer list that disagrees with the
      // verified image is not something to admit a lowerdir for.
      if (JSON.stringify(row.layers) !== JSON.stringify(layers)) {
        throw new Error(`sandbox image layer selection mismatch: ${row.imageDigest}`);
      }
    }
    if (required.length > 0) {
      this.#log(`verified ${layersByRef.size} image(s) for resume: ${reused} lower(s) unchanged, ${reverified} re-verified`);
    }
  }

  /**
   * The mounted layer list of one cached image, verifying each lower first. Reuses the record's
   * layer sources; a record that is missing, belongs to another manifest, or predates recorded
   * sources is fetched from its pinned manifest instead of a tag, which may have moved.
   */
  async #verifyLowers(
    reference: ReturnType<typeof normalizeReference>,
    manifestDigest: string,
    note: (how: "persisted" | "reverified") => void,
  ): Promise<string[]> {
    const location = this.#recordPath(reference.ref);
    let record: StoredImage | undefined;
    try {
      record = await this.#readRecord(location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (record === undefined || record.manifestDigest !== manifestDigest || record.layerSources === undefined) {
      const image = await this.pull(`${reference.registry}/${reference.repository}@${manifestDigest}`);
      return image.layers;
    }
    // The record stays internally consistent without downloading its config blob again: the
    // layer sources are exactly the blobs the manifest listed, in order.
    const recorded = record.blobDigests;
    if (
      recorded !== undefined &&
      (recorded.length !== record.layerSources.length + 1 ||
        JSON.stringify(record.layerSources.map((source) => source.descriptor.digest)) !==
          JSON.stringify(recorded.slice(1)))
    ) {
      throw new Error(`cached layer sources disagree with the recorded manifest: ${reference.ref}`);
    }
    const verifications: Record<string, { content: string; fingerprint: string }> = {
      ...(record.layerVerifications ?? {}),
    };
    const empty = new Set<string>();
    for (const { diffDigest, descriptor } of record.layerSources) {
      const trusted = await this.#verifyPersistedLayer(diffDigest, record);
      note(trusted ? "persisted" : "reverified");
      if (!trusted) {
        const registry = this.#registry.request();
        const blob = await this.#ensureBlob(registry, reference, descriptor, this.#log);
        await this.#ensureLayer(blob, descriptor.mediaType, diffDigest, this.#log);
      }
      const verified = this.#verifiedLayers.get(diffDigest);
      if (verified !== undefined) verifications[diffDigest] = verified;
      if ((await readdir(this.layerDir(diffDigest))).length === 0) empty.add(diffDigest);
    }
    // BuildKit legitimately repeats its empty diff layer, which OverlayFS cannot take twice.
    const layers = omitEmptyDiffLayers(record.layerSources.map((source) => source.diffDigest), empty);
    if (layers.length === 0) throw new Error(`cached image layer selection mismatch: ${reference.ref}`);
    if (JSON.stringify(record.layers) !== JSON.stringify(layers)) {
      throw new Error(`cached image layer selection mismatch: ${reference.ref}`);
    }
    await this.#writeRecord({ ...record, layerVerifications: verifications });
    return layers;
  }

  /** Trust a lower from its persisted verification when the tree still matches it. */
  async #verifyPersistedLayer(digest: string, record: StoredImage): Promise<boolean> {
    const persisted = record.layerVerifications?.[digest];
    if (persisted === undefined) return false;
    try {
      if (await layerTreeFingerprint(this.layerDir(digest)) !== persisted.fingerprint) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    this.#verifiedLayers.set(digest, { content: persisted.content, fingerprint: persisted.fingerprint });
    return true;
  }

  async resolve(ref: string): Promise<ResolvedImage | null> {
    const normalized = normalizeReference(ref);
    let record: StoredImage;
    try {
      record = await this.#readRecord(this.#recordPath(normalized.ref));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (record.layers.length === 0) return null;
    // Seed from the record so a lower verified before this boot resolves without a pull. The
    // fingerprint check below stays the gate: an unchanged tree is trusted, a changed one is
    // forgotten and the caller's pull repairs it.
    for (const [digest, verification] of Object.entries(record.layerVerifications ?? {})) {
      if (!this.#verifiedLayers.has(digest)) this.#verifiedLayers.set(digest, verification);
    }
    const verified = await Promise.all(record.layers.map((digest) => this.#layerStillVerified(digest)));
    if (verified.includes(false)) return null;
    return publicImage(record);
  }

  async pull(ref: string, options: ImagePullOptions = {}): Promise<ResolvedImage> {
    const normalized = normalizeReference(ref);
    const registry = this.#registry.request(options.auth);
    const emit = (message: string): void => {
      options.onProgress?.(message);
      this.#log(message);
    };

    emit(`pulling manifest ${normalized.ref}`);
    const fetched = await registry.fetchManifest(normalized);
    const configPath = await this.#ensureBlob(registry, normalized, fetched.manifest.config, emit);
    const configDocument = JSON.parse(await readFile(configPath, "utf8")) as ImageConfigDocument;
    const diffIds = stringArray(configDocument.rootfs?.diff_ids);
    if (diffIds.length !== fetched.manifest.layers.length || diffIds.some((digest) => !DIGEST_PATTERN.test(digest))) {
      throw new Error(`image config has invalid rootfs.diff_ids for ${normalized.ref}`);
    }

    // The registry declares every layer's size; refuse an oversized image before downloading.
    const declared = fetched.manifest.layers.reduce((sum, layer) => sum + (layer.size ?? 0), 0);
    if (declared > this.#maxImageBytes) {
      throw new Error(`${normalized.ref} is ${declared} bytes compressed, over the ${this.#maxImageBytes}-byte image limit`);
    }
    let extractable = this.#maxImageBytes;
    const emptyDiffs = new Set<string>();
    for (let index = 0; index < fetched.manifest.layers.length; index += 1) {
      const descriptor = fetched.manifest.layers[index]!;
      const diffDigest = diffIds[index]!;
      const blob = await this.#ensureBlob(registry, normalized, descriptor, emit);
      extractable -= await this.#ensureLayer(blob, descriptor.mediaType, diffDigest, emit, extractable);
      if ((await readdir(this.layerDir(diffDigest))).length === 0) emptyDiffs.add(diffDigest);
    }
    // BuildKit legitimately repeats its empty diff layer. Giving OverlayFS the same directory
    // twice returns ELOOP; empty diffs change no filesystem state, so omit them when another
    // real lower exists rather than making valid OCI images unlaunchable.
    const mountLayers = omitEmptyDiffLayers(diffIds, emptyDiffs);

    const record: StoredImage = {
      ref: normalized.ref,
      manifestDigest: fetched.digest,
      layers: mountLayers,
      config: runtimeConfig(configDocument),
      pulledAt: new Date().toISOString(),
      blobDigests: [fetched.manifest.config.digest, ...fetched.manifest.layers.map((layer) => layer.digest)],
      layerSources: fetched.manifest.layers.map((descriptor, i) => ({ descriptor, diffDigest: diffIds[i]! })),
    };
    await this.#writeRecord(record);
    const pinnedRef = `${normalized.registry}/${normalized.repository}@${fetched.digest}`;
    if (pinnedRef !== record.ref) {
      let cacheOnly = true;
      try { cacheOnly = (await this.#readRecord(this.#recordPath(pinnedRef))).cacheOnly === true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.#writeRecord({ ...record, ref: pinnedRef, cacheOnly });
    }
    emit(`pulled ${normalized.ref}`);
    return publicImage(record);
  }

  async list(): Promise<ResolvedImage[]> {
    const records = await this.#listStored();
    return records.filter((record) => !record.cacheOnly).map(publicImage);
  }

  async gc(pinned: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    let entries: Dirent[];
    try {
      entries = await readdir(this.#layersDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries = [];
    }

    const pinnedDirectories = new Set([...pinned].map((digest) => path.basename(this.layerDir(digest))));
    for (const entry of entries) {
      if (!entry.isDirectory() || pinnedDirectories.has(entry.name) || entry.name.includes(".tmp-")) continue;
      const separator = entry.name.indexOf("-");
      if (separator < 1 || !/^[0-9a-fA-F]+$/.test(entry.name.slice(separator + 1))) continue;
      await rm(path.join(this.#layersDir, entry.name), { recursive: true, force: true });
      removed.push(`${entry.name.slice(0, separator)}:${entry.name.slice(separator + 1)}`);
    }

    const records = await this.#listStored();
    const referencedBlobs = new Set<string>();
    for (const record of records) {
      for (const digest of record.blobDigests ?? record.layers) referencedBlobs.add(digest.toLowerCase());
    }
    await this.#pruneBlobs(referencedBlobs);
    return removed;
  }

  async #ensureBlob(
    registry: RegistryRequest,
    reference: NormalizedReference,
    descriptor: OciDescriptor,
    emit: (message: string) => void,
  ): Promise<string> {
    const existing = this.#blobTasks.get(descriptor.digest);
    if (existing) return existing;
    const task = this.#downloadBlob(registry, reference, descriptor.digest, emit, descriptor.size);
    this.#blobTasks.set(descriptor.digest, task);
    try {
      return await task;
    } finally {
      if (this.#blobTasks.get(descriptor.digest) === task) this.#blobTasks.delete(descriptor.digest);
    }
  }

  async #downloadBlob(
    registry: RegistryRequest,
    reference: NormalizedReference,
    digest: string,
    emit: (message: string) => void,
    declaredSize?: number,
  ): Promise<string> {
    const { algorithm, hex } = parseDigest(digest);
    // A blob may not outgrow what its descriptor declared, nor the image limit.
    const maxBytes = Math.min(declaredSize ?? Number.POSITIVE_INFINITY, this.#maxImageBytes);
    const destination = path.join(this.#blobsDir, algorithm, hex);
    if (await isFile(destination)) {
      if (await fileDigest(destination, algorithm) === hex) {
        emit(`using verified cached blob ${digest}`);
        return destination;
      }
      emit(`discarding corrupt cached blob ${digest}`);
      await rm(destination, { force: true });
    }

    emit(`downloading blob ${digest}`);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${randomUUID()}`;
    const output = await open(temporary, "wx", 0o600);
    let verified = false;
    try {
      const response = await registry.fetchBlob(reference, digest);
      if (!response.body) throw new Error(`registry returned an empty body for blob ${digest}`);
      const hash = createHash(algorithm);
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error(`blob ${digest} is larger than its ${maxBytes}-byte limit`);
        hash.update(chunk);
        await output.write(chunk);
      }
      await output.sync();
      const actual = `${algorithm}:${hash.digest("hex")}`;
      if (actual !== `${algorithm}:${hex}`) {
        throw new Error(`blob digest verification failed for ${digest}: got ${actual}`);
      }
      verified = true;
    } finally {
      await output.close();
      if (!verified) await rm(temporary, { force: true });
    }

    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return destination;
  }

  /**
   * Whether a verified lower is unchanged since its contents were verified, by fingerprint:
   * cheap enough for every resolve, and it still sees post-boot loss or modification. A
   * changed lower is forgotten, so the next pull re-verifies and repairs it. Concurrent checks
   * of one lower share a walk.
   */
  async #layerStillVerified(digest: string): Promise<boolean> {
    const pending = this.#layerChecks.get(digest);
    if (pending) return pending;
    const check = (async () => {
      const verified = this.#verifiedLayers.get(digest);
      if (verified === undefined) return false;
      try {
        if (await layerTreeFingerprint(this.layerDir(digest)) === verified.fingerprint) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // A repair that finished meanwhile recorded a new verification; keep that one.
      if (this.#verifiedLayers.get(digest) === verified) this.#verifiedLayers.delete(digest);
      return false;
    })();
    this.#layerChecks.set(digest, check);
    try {
      return await check;
    } finally {
      if (this.#layerChecks.get(digest) === check) this.#layerChecks.delete(digest);
    }
  }

  /**
   * Re-hash every verified lower's contents, one at a time, and forget the ones that no longer
   * match, so their next resolve misses and a pull repairs them. Resolve's fingerprint sees
   * every change made through the filesystem; this sees corruption beneath it. Returns the
   * digests forgotten.
   */
  async scrub(): Promise<string[]> {
    const forgotten: string[] = [];
    for (const [digest, verified] of [...this.#verifiedLayers]) {
      if (this.#layerTasks.has(digest)) continue;
      let content: string | null = null;
      try {
        content = await layerTreeDigest(this.layerDir(digest));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (content === verified.content || this.#verifiedLayers.get(digest) !== verified) continue;
      this.#verifiedLayers.delete(digest);
      forgotten.push(digest);
    }
    return forgotten;
  }

  /** Extracts and verifies a layer; returns the bytes it newly extracted (0 when already present). */
  async #ensureLayer(
    blobPath: string,
    mediaType: string,
    digest: string,
    emit: (message: string) => void,
    maxBytes = this.#maxImageBytes,
  ): Promise<number> {
    const target = this.layerDir(digest);
    if (await this.#layerStillVerified(digest)) return 0;
    const existing = this.#layerTasks.get(digest);
    if (existing) return existing;
    const task = (async () => {
      const size = await verifyDiffDigest(blobPath, mediaType, digest, maxBytes);
      // Reconstruct a trusted comparison tree from the digest-verified blob. Even an
      // intentionally empty OCI layer is valid only if its expected tree is also empty.
      const rebuilt = `${target}.tmp-verify-${randomUUID()}`;
      try {
        await extractLayerBlob(blobPath, mediaType, rebuilt);
        const expected = await layerTreeDigest(rebuilt);
        let healthy = false;
        try { healthy = await layerTreeDigest(target) === expected; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (!healthy) {
          emit(`repairing extracted layer ${digest}`);
          await assertLayerNotMounted(target);
          await rm(target, { recursive: true, force: true });
          await rename(rebuilt, target);
          if (await layerTreeDigest(target) !== expected) throw new Error(`layer repair verification failed: ${digest}`);
        }
        this.#verifiedLayers.set(digest, { content: expected, fingerprint: await layerTreeFingerprint(target) });
        return size;
      } finally {
        await rm(rebuilt, { recursive: true, force: true });
      }
    })();
    this.#layerTasks.set(digest, task);
    try {
      return await task;
    } finally {
      if (this.#layerTasks.get(digest) === task) this.#layerTasks.delete(digest);
    }
  }

  #recordPath(normalizedRef: string): string {
    return path.join(this.#refsDir, `${encodeURIComponent(normalizedRef)}.json`);
  }

  async #readRecord(location: string): Promise<StoredImage> {
    return JSON.parse(await readFile(location, "utf8")) as StoredImage;
  }

  async #writeRecord(record: StoredImage): Promise<void> {
    await mkdir(this.#refsDir, { recursive: true });
    const destination = this.#recordPath(record.ref);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #listStored(): Promise<StoredImage[]> {
    let files: string[];
    try {
      files = (await readdir(this.#refsDir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(files.map((name) => this.#readRecord(path.join(this.#refsDir, name))));
  }

  async #pruneBlobs(referenced: ReadonlySet<string>): Promise<void> {
    let algorithms;
    try {
      algorithms = await readdir(this.#blobsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const algorithm of algorithms) {
      if (!algorithm.isDirectory()) continue;
      const directory = path.join(this.#blobsDir, algorithm.name);
      const blobs = await readdir(directory, { withFileTypes: true });
      for (const blob of blobs) {
        if (!blob.isFile()) continue;
        const digest = `${algorithm.name}:${blob.name}`.toLowerCase();
        if (!referenced.has(digest)) await rm(path.join(directory, blob.name), { force: true });
      }
      if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true, force: true });
    }
  }
}
