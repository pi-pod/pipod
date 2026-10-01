import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { assertLayerNotMounted, fileDigest, layerTreeDigest, verifyDiffDigest } from "./integrity.js";
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
  type RegistryAuth,
} from "./registry.js";

interface StoredImage extends ResolvedImage {
  blobDigests?: string[];
  layerSources?: Array<{ diffDigest: string; descriptor: OciDescriptor }>;
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
  readonly #layerTasks = new Map<string, Promise<void>>();
  readonly #verifiedLayers = new Map<string, string>();

  constructor(options: { stateDir: string; auth?: RegistryAuth; log?: (message: string) => void }) {
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

  /** Must finish before runtime reconciliation or any listener is started. Failure is fatal. */
  async validateAndRepair(required: Array<{ image: string; imageDigest: string; layers: string[] }> = []): Promise<void> {
    this.#verifiedLayers.clear();
    const verifiedManifests = new Map<string, string[]>();
    for (const record of await this.#listStored()) {
      const reference = normalizeReference(record.ref);
      const registry = this.#registry.request();
      let sources = record.layerSources;
      let diffs: string[] | undefined;
      if (record.blobDigests?.length) {
        const config = await this.#downloadBlob(registry, reference, record.blobDigests[0]!, this.#log);
        const doc = JSON.parse(await readFile(config, "utf8")) as ImageConfigDocument;
        diffs = stringArray(doc.rootfs?.diff_ids);
        if (diffs.length !== record.blobDigests.length - 1) throw new Error(`invalid cached layer mapping: ${record.ref}`);
        if (sources && (JSON.stringify(sources.map((s) => s.diffDigest)) !== JSON.stringify(diffs)
          || JSON.stringify(sources.map((s) => s.descriptor.digest)) !== JSON.stringify(record.blobDigests.slice(1)))) {
          throw new Error(`cached layer sources disagree with verified image config: ${record.ref}`);
        }
      }
      if (!sources && diffs && record.blobDigests) {
        // Upgrade the pre-integrity cache offline: old records retained the config followed
        // by compressed blobs in manifest order. Detect compression from the verified bytes.
        sources = [];
        for (let i = 0; i < diffs.length; i++) {
          parseDigest(diffs[i]!);
          const digest = record.blobDigests[i + 1]!;
          const blob = await this.#downloadBlob(registry, reference, digest, this.#log);
          const file = await open(blob, "r");
          const magic = Buffer.alloc(4);
          try { await file.read(magic, 0, 4, 0); } finally { await file.close(); }
          const suffix = magic[0] === 0x1f && magic[1] === 0x8b ? "+gzip"
            : magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) ? "+zstd" : "";
          sources.push({ diffDigest: diffs[i]!, descriptor: { digest, mediaType: `application/vnd.oci.image.layer.v1.tar${suffix}` } });
        }
      }
      if (!sources) {
        // Never silently refresh a mutable tag during recovery.
        const image = await this.pull(`${reference.registry}/${reference.repository}@${record.manifestDigest}`);
        if (JSON.stringify(record.layers) !== JSON.stringify(image.layers)) throw new Error(`cached image layer selection mismatch: ${record.ref}`);
        verifiedManifests.set(record.manifestDigest, image.layers);
      } else {
        for (const { diffDigest, descriptor } of sources) {
          const blob = await this.#ensureBlob(registry, reference, descriptor, this.#log);
          await this.#ensureLayer(blob, descriptor.mediaType, diffDigest, this.#log);
        }
        const empty = new Set<string>();
        for (const { diffDigest } of sources) {
          if ((await readdir(this.layerDir(diffDigest))).length === 0) empty.add(diffDigest);
        }
        const expectedLayers = omitEmptyDiffLayers(sources.map((source) => source.diffDigest), empty);
        if (expectedLayers.length === 0 || JSON.stringify(record.layers) !== JSON.stringify(expectedLayers)) {
          throw new Error(`cached image layer selection mismatch: ${record.ref}`);
        }
        verifiedManifests.set(record.manifestDigest, expectedLayers);
        await this.#writeRecord({ ...record, layerSources: sources });
      }
    }
    // A mutable tag may have moved since a stopped pod was created. Recover its pinned
    // manifest, not today's tag, and never admit a row with an unverified lowerdir.
    for (const row of required) {
      if (!verifiedManifests.has(row.imageDigest) || row.layers.some((digest) => !this.#verifiedLayers.has(digest))) {
        const ref = normalizeReference(row.image);
        const image = await this.pull(`${ref.registry}/${ref.repository}@${row.imageDigest}`);
        verifiedManifests.set(row.imageDigest, image.layers);
      }
      if (JSON.stringify(row.layers) !== JSON.stringify(verifiedManifests.get(row.imageDigest))) {
        throw new Error(`sandbox image layer selection mismatch: ${row.imageDigest}`);
      }
    }
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
    for (const digest of record.layers) {
      if (!(await this.#layerStillVerified(digest))) return null;
    }
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

    const emptyDiffs = new Set<string>();
    for (let index = 0; index < fetched.manifest.layers.length; index += 1) {
      const descriptor = fetched.manifest.layers[index]!;
      const diffDigest = diffIds[index]!;
      const blob = await this.#ensureBlob(registry, normalized, descriptor, emit);
      await this.#ensureLayer(blob, descriptor.mediaType, diffDigest, emit);
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
    const task = this.#downloadBlob(registry, reference, descriptor.digest, emit);
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
  ): Promise<string> {
    const { algorithm, hex } = parseDigest(digest);
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
      for await (const chunk of response.body) {
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

  async #layerStillVerified(digest: string): Promise<boolean> {
    const expected = this.#verifiedLayers.get(digest);
    if (expected === undefined) return false;
    try {
      if (await layerTreeDigest(this.layerDir(digest)) === expected) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#verifiedLayers.delete(digest);
    return false;
  }

  async #ensureLayer(blobPath: string, mediaType: string, digest: string, emit: (message: string) => void): Promise<void> {
    const target = this.layerDir(digest);
    if (await this.#layerStillVerified(digest)) return;
    const existing = this.#layerTasks.get(digest);
    if (existing) return existing;
    const task = (async () => {
      await verifyDiffDigest(blobPath, mediaType, digest);
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
        this.#verifiedLayers.set(digest, expected);
      } finally {
        await rm(rebuilt, { recursive: true, force: true });
      }
    })();
    this.#layerTasks.set(digest, task);
    try {
      await task;
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
