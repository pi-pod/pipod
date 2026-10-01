import { createHash } from "node:crypto";

export const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
export const DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json";
export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";

export const MANIFEST_ACCEPT = [OCI_INDEX, DOCKER_INDEX, OCI_MANIFEST, DOCKER_MANIFEST].join(", ");

export interface RegistryAuth {
  username: string;
  password: string;
}

export interface NormalizedReference {
  ref: string;
  registry: string;
  apiHost: string;
  repository: string;
  reference: string;
}

export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size?: number;
  platform?: {
    architecture?: string;
    os?: string;
    variant?: string;
  };
}

export interface OciManifest {
  schemaVersion: number;
  mediaType?: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
}

export interface OciIndex {
  schemaVersion: number;
  mediaType?: string;
  manifests: OciDescriptor[];
}

export interface FetchedManifest {
  digest: string;
  manifest: OciManifest;
}

export interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

const DIGEST_PATTERN = /^[A-Za-z0-9_+.-]+:[0-9a-fA-F]+$/;

export function normalizeReference(input: string): NormalizedReference {
  const value = input.trim();
  if (!value || value.includes(" ") || value.startsWith("/") || value.endsWith("/")) {
    throw new Error(`invalid image reference: ${input}`);
  }

  const components = value.split("/");
  const first = components[0]!;
  const hasRegistry = components.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  const registry = hasRegistry ? first : "docker.io";
  let repositoryWithReference = hasRegistry ? components.slice(1).join("/") : value;
  if (!repositoryWithReference) {
    throw new Error(`invalid image reference: ${input}`);
  }

  let reference: string;
  const at = repositoryWithReference.lastIndexOf("@");
  if (at >= 0) {
    reference = repositoryWithReference.slice(at + 1);
    repositoryWithReference = repositoryWithReference.slice(0, at);
    if (!DIGEST_PATTERN.test(reference)) {
      throw new Error(`invalid image digest reference: ${input}`);
    }
  } else {
    const slash = repositoryWithReference.lastIndexOf("/");
    const colon = repositoryWithReference.lastIndexOf(":");
    if (colon > slash) {
      reference = repositoryWithReference.slice(colon + 1);
      repositoryWithReference = repositoryWithReference.slice(0, colon);
      if (!reference) {
        throw new Error(`invalid image tag: ${input}`);
      }
    } else {
      reference = "latest";
    }
  }

  let repository = repositoryWithReference;
  if (!repository || repository.split("/").some((part) => !part)) {
    throw new Error(`invalid image repository: ${input}`);
  }
  if (registry === "docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }

  const separator = DIGEST_PATTERN.test(reference) ? "@" : ":";
  return {
    ref: `${registry}/${repository}${separator}${reference}`,
    registry,
    apiHost: registry === "docker.io" ? "registry-1.docker.io" : registry,
    repository,
    reference,
  };
}

export function parseBearerChallenge(header: string): BearerChallenge | null {
  const match = /\bBearer\s+/i.exec(header);
  if (!match) return null;

  const values = new Map<string, string>();
  const parameters = header.slice(match.index + match[0].length);
  const expression = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
  for (const parameter of parameters.matchAll(expression)) {
    const quoted = parameter[2];
    const value = quoted === undefined ? parameter[3]! : quoted.replace(/\\([\\"])/g, "$1");
    values.set(parameter[1]!.toLowerCase(), value);
  }

  const realm = values.get("realm");
  if (!realm) return null;
  return {
    realm,
    service: values.get("service"),
    scope: values.get("scope"),
  };
}

export function ociArchitecture(nodeArchitecture: NodeJS.Architecture = process.arch): string {
  if (nodeArchitecture === "x64") return "amd64";
  if (nodeArchitecture === "arm64") return "arm64";
  throw new Error(`unsupported host architecture for OCI images: ${nodeArchitecture}`);
}

export function selectPlatformManifest(
  index: OciIndex,
  nodeArchitecture: NodeJS.Architecture = process.arch,
): OciDescriptor {
  const architecture = ociArchitecture(nodeArchitecture);
  const descriptor = index.manifests.find(
    (candidate) => candidate.platform?.os === "linux" && candidate.platform.architecture === architecture,
  );
  if (!descriptor) {
    throw new Error(`image index has no manifest for linux/${architecture}`);
  }
  return descriptor;
}

function digestBytes(bytes: Uint8Array, algorithm = "sha256"): string {
  return `${algorithm}:${createHash(algorithm).update(bytes).digest("hex")}`;
}

function isIndex(value: unknown, mediaType: string): value is OciIndex {
  if (mediaType === OCI_INDEX || mediaType === DOCKER_INDEX) return true;
  return typeof value === "object" && value !== null && Array.isArray((value as { manifests?: unknown }).manifests);
}

function isManifest(value: unknown, mediaType: string): value is OciManifest {
  if (mediaType === OCI_MANIFEST || mediaType === DOCKER_MANIFEST) return true;
  const candidate = value as Partial<OciManifest> | null;
  return candidate !== null && typeof candidate === "object" && !!candidate.config && Array.isArray(candidate.layers);
}

export interface RegistryRequest {
  fetchManifest(reference: NormalizedReference): Promise<FetchedManifest>;
  fetchBlob(reference: NormalizedReference, digest: string): Promise<Response>;
}

interface RequestContext {
  auth?: RegistryAuth;
  tokens: Map<string, string>;
}

function registryProtocol(apiHost: string): "http" | "https" {
  // OCI references have no scheme. Loopback registries conventionally run without TLS,
  // which also lets integration tests exercise the real HTTP client without weakening
  // transport security for any remote registry.
  return apiHost === "localhost" || apiHost.startsWith("localhost:") || /^127(?:\.\d{1,3}){3}(?::|$)/.test(apiHost)
    ? "http"
    : "https";
}

export class RegistryClient {
  readonly #auth?: RegistryAuth;
  readonly #log: (message: string) => void;

  constructor(options: { auth?: RegistryAuth; log?: (message: string) => void } = {}) {
    this.#auth = options.auth;
    this.#log = options.log ?? (() => undefined);
  }

  /**
   * One request object owns one credential and its bearer-token cache. A pull keeps this
   * object only until it returns, so an override is neither stored on the shared client nor
   * observable by a concurrent pull.
   */
  request(auth?: RegistryAuth): RegistryRequest {
    const context: RequestContext = { auth: auth ?? this.#auth, tokens: new Map() };
    return {
      fetchManifest: async (reference) => await this.#fetchManifest(reference, reference.reference, 0, context),
      fetchBlob: async (reference, digest) => await this.#fetchBlob(reference, digest, context),
    };
  }

  async fetchManifest(reference: NormalizedReference, auth?: RegistryAuth): Promise<FetchedManifest> {
    return await this.request(auth).fetchManifest(reference);
  }

  async fetchBlob(reference: NormalizedReference, digest: string, auth?: RegistryAuth): Promise<Response> {
    return await this.request(auth).fetchBlob(reference, digest);
  }

  async #fetchBlob(reference: NormalizedReference, digest: string, context: RequestContext): Promise<Response> {
    if (!DIGEST_PATTERN.test(digest)) throw new Error(`invalid blob digest: ${digest}`);
    const response = await this.#request(reference, `blobs/${encodeURIComponent(digest)}`, context);
    if (!response.ok) {
      throw new Error(`registry blob request failed for ${digest}: HTTP ${response.status}`);
    }
    return response;
  }

  async #fetchManifest(
    reference: NormalizedReference,
    manifestReference: string,
    depth: number,
    context: RequestContext,
  ): Promise<FetchedManifest> {
    if (depth > 4) throw new Error("image index nesting is too deep");
    const response = await this.#request(
      reference,
      `manifests/${encodeURIComponent(manifestReference)}`,
      context,
      { Accept: MANIFEST_ACCEPT },
    );
    if (!response.ok) {
      throw new Error(`registry manifest request failed for ${reference.ref}: HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    let document: unknown;
    try {
      document = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new Error(`registry returned invalid manifest JSON for ${reference.ref}`);
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    const declaredMediaType = (document as { mediaType?: unknown } | null)?.mediaType;
    const mediaType = typeof declaredMediaType === "string" ? declaredMediaType : contentType;
    const schemaVersion = (document as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (schemaVersion !== 2 || mediaType === "application/vnd.docker.distribution.manifest.v1+json") {
      throw new Error(`unsupported schema1 image manifest for ${reference.ref}`);
    }

    const responseDigest = response.headers.get("docker-content-digest") ?? digestBytes(bytes);
    if (
      DIGEST_PATTERN.test(manifestReference) &&
      digestBytes(bytes, manifestReference.split(":", 1)[0]) !== manifestReference.toLowerCase()
    ) {
      throw new Error(`manifest digest verification failed for ${manifestReference}`);
    }

    if (isIndex(document, mediaType)) {
      const selected = selectPlatformManifest(document);
      this.#log(`selected ${selected.platform?.os}/${selected.platform?.architecture} manifest ${selected.digest}`);
      return await this.#fetchManifest(reference, selected.digest, depth + 1, context);
    }
    if (!isManifest(document, mediaType)) {
      throw new Error(`unsupported manifest media type: ${mediaType || "unknown"}`);
    }
    return { digest: responseDigest, manifest: document };
  }

  async #request(
    reference: NormalizedReference,
    resource: string,
    context: RequestContext,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const repository = reference.repository.split("/").map(encodeURIComponent).join("/");
    const url = `${registryProtocol(reference.apiHost)}://${reference.apiHost}/v2/${repository}/${resource}`;
    const initialHeaders = new Headers(headers);
    if (context.auth) initialHeaders.set("Authorization", this.#basicAuthorization(context.auth));

    let response = await fetch(url, { headers: initialHeaders, redirect: "follow" });
    if (response.status !== 401) return response;

    const challenge = parseBearerChallenge(response.headers.get("www-authenticate") ?? "");
    if (!challenge) return response;
    await response.body?.cancel();

    const token = await this.#bearerToken(challenge, context);
    const retryHeaders = new Headers(headers);
    retryHeaders.set("Authorization", `Bearer ${token}`);
    response = await fetch(url, { headers: retryHeaders, redirect: "follow" });
    return response;
  }

  async #bearerToken(challenge: BearerChallenge, context: RequestContext): Promise<string> {
    const key = `${challenge.realm}\n${challenge.service ?? ""}\n${challenge.scope ?? ""}`;
    const cached = context.tokens.get(key);
    if (cached) return cached;

    const url = new URL(challenge.realm);
    if (challenge.service) url.searchParams.set("service", challenge.service);
    if (challenge.scope) url.searchParams.set("scope", challenge.scope);
    const headers = new Headers({ Accept: "application/json" });
    if (context.auth) headers.set("Authorization", this.#basicAuthorization(context.auth));

    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) throw new Error(`registry token request failed: HTTP ${response.status}`);
    const body = (await response.json()) as { token?: unknown; access_token?: unknown };
    const token = typeof body.token === "string" ? body.token : body.access_token;
    if (typeof token !== "string" || !token) throw new Error("registry token response did not include a token");
    context.tokens.set(key, token);
    return token;
  }

  #basicAuthorization(auth: RegistryAuth): string {
    return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
  }
}
