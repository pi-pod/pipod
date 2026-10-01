import type { RegistryAuth } from "./registry.js";

/** OCI image config subset the runtime actually reads when building a crun spec. */
export interface ImageRuntimeConfig {
  env: string[];
  entrypoint: string[];
  cmd: string[];
  workingDir?: string;
  user?: string;
}

export interface ResolvedImage {
  /** Reference as requested, normalized (docker.io/library/x:tag form). */
  ref: string;
  manifestDigest: string;
  /** Layer diff digests, lowest first — the order overlayfs lowerdirs must reverse. */
  layers: string[];
  config: ImageRuntimeConfig;
  pulledAt: string;
}

export interface ImagePullOptions {
  /** Request-scoped override; omitted credentials fall back to service configuration. */
  auth?: RegistryAuth;
  onProgress?: (line: string) => void;
}

export interface ImageStore {
  /** Local cache only — `null` when the image has never been pulled (§12 fail-fast). */
  resolve(ref: string): Promise<ResolvedImage | null>;
  /** Pull-through from the registry into the content-addressed layer store. */
  pull(ref: string, options?: ImagePullOptions): Promise<ResolvedImage>;
  /** Extracted layer directory for a diff digest; used as an overlayfs lowerdir. */
  layerDir(digest: string): string;
  /** Deletes extracted layers not in `pinned`. Returns the digests removed. */
  gc(pinned: ReadonlySet<string>): Promise<string[]>;
  list(): Promise<ResolvedImage[]>;
}
