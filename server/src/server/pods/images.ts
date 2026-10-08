import { buildImage, managedImageDerivation, type ImageRecipe } from "../../core/image.js";
import {
  supportsImageBuild,
  supportsImageDerive,
  supportsImageMirror,
  type SandboxProvider,
} from "../../core/providers/types.js";
import { query } from "../db/index.js";
import { uuidv7 } from "../ids.js";

const BUILD_LEASE_SECONDS = 15 * 60;
const WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_COOLDOWN_SECONDS = 10 * 60;

export interface ImageBuildRecord {
  status: "building" | "ready" | "failed";
  leaseOwner: string | null;
  attempt: number;
  lastError: string | null;
}

export interface ImageBuildStore {
  read(credentialScope: string, provider: string, ref: string): Promise<ImageBuildRecord | null>;
  missing(credentialScope: string, provider: string, ref: string): Promise<void>;
  claim(credentialScope: string, provider: string, ref: string, owner: string): Promise<ImageBuildRecord>;
  heartbeat(credentialScope: string, provider: string, ref: string, owner: string): Promise<void>;
  ready(credentialScope: string, provider: string, ref: string, owner?: string): Promise<void>;
  failed(credentialScope: string, provider: string, ref: string, owner: string, error: string): Promise<void>;
}

interface ImageBuildRow {
  status: "building" | "ready" | "failed";
  lease_owner: string | null;
  attempt: number;
  last_error: string | null;
}

function record(row: ImageBuildRow): ImageBuildRecord {
  return {
    status: row.status,
    leaseOwner: row.lease_owner,
    attempt: row.attempt,
    lastError: row.last_error,
  };
}

/** PostgreSQL lease: one builder per provider credential scope/ref, reclaimable after process death. */
export const pgImageBuildStore: ImageBuildStore = {
  async read(credentialScope, provider, ref) {
    const result = await query<ImageBuildRow>(
      `SELECT status, lease_owner, attempt, last_error
         FROM image_builds WHERE credential_scope = $1 AND provider = $2 AND image_ref = $3`,
      [credentialScope, provider, ref],
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  },

  async missing(credentialScope, provider, ref) {
    await query(
      `UPDATE image_builds SET status = 'failed', attempt = 0, lease_owner = NULL,
         lease_expires_at = NULL, last_error = 'provider image is missing', updated_at = now()
       WHERE credential_scope = $1 AND provider = $2 AND image_ref = $3 AND status = 'ready'`,
      [credentialScope, provider, ref],
    );
  },

  async claim(credentialScope, provider, ref, owner) {
    const claimed = await query<ImageBuildRow>(
      `INSERT INTO image_builds (credential_scope, provider, image_ref, status, lease_owner, lease_expires_at, attempt)
       VALUES ($1, $2, $3, 'building', $4, now() + make_interval(secs => $5), 1)
       ON CONFLICT (credential_scope, provider, image_ref) DO UPDATE
          SET status = 'building', lease_owner = $4,
              lease_expires_at = now() + make_interval(secs => $5),
              attempt = CASE
                WHEN image_builds.status = 'failed' AND image_builds.attempt >= $6 THEN 1
                ELSE image_builds.attempt + 1
              END,
              last_error = NULL, updated_at = now()
        WHERE (image_builds.status = 'failed' AND
               (image_builds.attempt < $6 OR
                image_builds.updated_at < now() - make_interval(secs => $7)))
           OR (image_builds.status = 'building' AND image_builds.lease_expires_at < now())
       RETURNING status, lease_owner, attempt, last_error`,
      [credentialScope, provider, ref, owner, BUILD_LEASE_SECONDS, MAX_ATTEMPTS, RETRY_COOLDOWN_SECONDS],
    );
    if (claimed.rows[0]) return record(claimed.rows[0]);
    const current = await this.read(credentialScope, provider, ref);
    if (!current) throw new Error(`image build coordination row disappeared for ${ref}`);
    return current;
  },

  async heartbeat(credentialScope, provider, ref, owner) {
    await query(
      `UPDATE image_builds
          SET lease_expires_at = now() + make_interval(secs => $5), updated_at = now()
        WHERE credential_scope = $1 AND provider = $2 AND image_ref = $3
          AND status = 'building' AND lease_owner = $4`,
      [credentialScope, provider, ref, owner, BUILD_LEASE_SECONDS],
    );
  },

  async ready(credentialScope, provider, ref, owner) {
    await query(
      `INSERT INTO image_builds (credential_scope, provider, image_ref, status, attempt)
       VALUES ($1, $2, $3, 'ready', 0)
       ON CONFLICT (credential_scope, provider, image_ref) DO UPDATE
          SET status = 'ready', lease_owner = NULL, lease_expires_at = NULL,
              last_error = NULL, updated_at = now()
        WHERE $4::text IS NULL OR image_builds.lease_owner = $4`,
      [credentialScope, provider, ref, owner ?? null],
    );
  },

  async failed(credentialScope, provider, ref, owner, error) {
    await query(
      `UPDATE image_builds
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              last_error = $5, updated_at = now()
        WHERE credential_scope = $1 AND provider = $2 AND image_ref = $3
          AND status = 'building' AND lease_owner = $4`,
      [credentialScope, provider, ref, owner, error.slice(0, 500)],
    );
  },
};

const inFlight = new Map<string, Promise<void>>();

export interface EnsureHostedImageOptions {
  credentialScope: string;
  provider: SandboxProvider;
  recipe: Extract<ImageRecipe, { managed: true }>;
  resources: { cpu: number; memoryGB: number; diskGB: number };
  assetRoot: string;
  store?: ImageBuildStore;
  owner?: string;
  waitTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolve or prepare one managed image. Build-capable providers publish it; a host that can
 * derive it from its base does that; mirror-capable providers otherwise materialize the exact
 * canonical ref into their runtime cache. In-process callers share a Promise, while
 * PostgreSQL leases deduplicate work across API replicas and recover abandoned preparation
 * after a restart.
 */
export function ensureHostedImage(options: EnsureHostedImageOptions): Promise<void> {
  const key = `${options.credentialScope}\0${options.provider.name}\0${options.recipe.ref}`;
  const current = inFlight.get(key);
  if (current) return current;
  const task = ensureHostedImageInner(options).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function ensureHostedImageInner(options: EnsureHostedImageOptions): Promise<void> {
  const store = options.store ?? pgImageBuildStore;
  const owner = options.owner ?? uuidv7();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.waitTimeoutMs ?? WAIT_TIMEOUT_MS);
  const ref = options.recipe.ref;
  const providerName = options.provider.name;

  if (await options.provider.resolveImage(ref)) {
    await store.ready(options.credentialScope, providerName, ref);
    return;
  }

  for (;;) {
    const state = await store.claim(options.credentialScope, providerName, ref, owner);
    if (state.status === "ready") {
      // The first provider miss may have raced a builder that was about to publish. Only a
      // coordinated ready observation plus a fresh miss may invalidate stale readiness.
      if (await options.provider.resolveImage(ref)) return;
      await store.missing(options.credentialScope, providerName, ref);
      continue;
    }
    if (state.status === "failed" && state.attempt >= MAX_ATTEMPTS) {
      throw new Error(
        `image ${ref} failed after ${state.attempt} attempts: ${state.lastError ?? "unknown error"}; ` +
        `automatic retries resume after a ${Math.round(RETRY_COOLDOWN_SECONDS / 60)} minute cooldown`,
      );
    }
    if (state.status === "building" && state.leaseOwner === owner) break;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for image ${ref} to finish building`);
    await sleep(options.pollMs ?? 1000);
  }

  const heartbeat = setInterval(() => {
    void store.heartbeat(options.credentialScope, providerName, ref, owner).catch(() => {});
  }, 30_000);
  heartbeat.unref?.();
  try {
    if (supportsImageBuild(options.provider)) {
      await buildImage({
        provider: options.provider,
        ref,
        resources: options.resources,
        packages: options.recipe.packages,
        bakeScript: options.recipe.bakeScript,
        assetRoot: options.assetRoot,
        allowOutdatedPi: true,
      });
    } else if (supportsImageMirror(options.provider)) {
      // A self-hosted deployment publishes only the base to its bundled registry, so its host
      // derives the package and bake variants itself; a host that cannot (it refuses for a
      // remote mirror) leaves the mirror as the only source.
      const derivation = managedImageDerivation(options.recipe);
      const derived = derivation !== null && supportsImageDerive(options.provider) &&
        await options.provider.deriveImage({ ...derivation, ref, resources: options.resources });
      // Public mirrors can populate themselves here. Production's GHCR package is private, so
      // the deploy workflow normally makes this a cache hit before the worker starts; an auth
      // failure carries an operator-directed preload message from the adapter.
      if (!derived) await options.provider.fetchMirroredImage(ref);
    } else {
      throw new Error(
        `provider ${providerName} can neither build managed image ${ref} nor fetch it from an image mirror`,
      );
    }
    const published = await options.provider.resolveImage(ref);
    if (!published) {
      throw new Error(`provider prepared image ${ref}, but it is still not visible`);
    }
    await store.ready(options.credentialScope, providerName, ref, owner);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.failed(options.credentialScope, providerName, ref, owner, message).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
