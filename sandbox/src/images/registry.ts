import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP, isIPv4 } from "node:net";

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

/** Whether a registry is reached over plain HTTP on this host's loopback (see registryProtocol). */
export function isLoopbackRegistry(apiHost: string): boolean {
  return registryProtocol(apiHost) === "http";
}

/**
 * Writes images into one repository of a loopback registry: in a self-hosted deployment, the
 * bundled registry the sandbox shares a network namespace with. Writing is confined there by
 * construction — no credential is ever sent, and nothing lands in a registry another
 * deployment reads.
 */
export class LoopbackRegistryWriter {
  readonly #repositoryUrl: string;

  constructor(reference: NormalizedReference) {
    if (!isLoopbackRegistry(reference.apiHost)) {
      throw new Error(`${reference.registry} is not a loopback registry, the only kind images are written to`);
    }
    const repository = reference.repository.split("/").map(encodeURIComponent).join("/");
    this.#repositoryUrl = `http://${reference.apiHost}/v2/${repository}`;
  }

  async hasManifest(tag: string): Promise<boolean> {
    return await this.#exists(`manifests/${encodeURIComponent(tag)}`, { Accept: MANIFEST_ACCEPT });
  }

  /** Monolithic upload; a blob the repository already holds is not sent again. */
  async putBlob(digest: string, content: Blob): Promise<void> {
    if (!DIGEST_PATTERN.test(digest)) throw new Error(`invalid blob digest: ${digest}`);
    if (await this.#exists(`blobs/${encodeURIComponent(digest)}`)) return;
    const started = await this.#send("POST", new URL(`${this.#repositoryUrl}/blobs/uploads/`), 202);
    const location = started.headers.get("location");
    if (!location) throw new Error("registry did not return a blob upload location");
    const target = new URL(location, `${this.#repositoryUrl}/`);
    if (target.origin !== new URL(this.#repositoryUrl).origin) {
      throw new Error(`registry moved a blob upload to ${target.origin}`);
    }
    target.searchParams.set("digest", digest);
    await this.#send("PUT", target, 201, { "content-type": "application/octet-stream" }, content);
  }

  async putManifest(tag: string, manifest: Uint8Array, mediaType: string): Promise<void> {
    await this.#send(
      "PUT",
      new URL(`${this.#repositoryUrl}/manifests/${encodeURIComponent(tag)}`),
      201,
      { "content-type": mediaType },
      new Blob([manifest]),
    );
  }

  async #exists(resource: string, headers: Record<string, string> = {}): Promise<boolean> {
    const response = await fetch(`${this.#repositoryUrl}/${resource}`, { method: "HEAD", headers, redirect: "error" });
    if (response.status === 404) return false;
    if (response.ok) return true;
    throw new Error(`registry HEAD ${resource} failed: HTTP ${response.status}`);
  }

  async #send(method: string, url: URL, expected: number, headers: Record<string, string> = {}, body?: Blob): Promise<Response> {
    const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), redirect: "error" });
    if (response.status !== expected) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 500);
      throw new Error(`registry ${method} ${url.pathname} failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    await response.body?.cancel();
    return response;
  }
}

/** A host-wide credential and the one registry it belongs to. */
export interface HostRegistryAuth extends RegistryAuth {
  registry: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function privateAddress(address: string): boolean {
  if (isIPv4(address)) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateAddress(mapped[1]!);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

/**
 * Where a pull may send a request. Image references, redirects and token realms are chosen
 * by whoever runs the registry, and this process runs as root on the host's networks: only
 * HTTPS to public addresses, or plain HTTP back to the loopback registry the pull began at.
 * (The check resolves the name before fetch does; it is not proof against DNS rebinding.)
 */
async function assertFetchable(target: URL, registryHost: string): Promise<void> {
  if (target.host === registryHost && registryProtocol(registryHost) === "http") return;
  if (target.protocol !== "https:") throw new Error(`registry request to ${target.origin} is not HTTPS`);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true })).map((a) => a.address);
  if (addresses.some(privateAddress)) {
    throw new Error(`registry request to ${target.origin} resolves to a private address`);
  }
}

/** Follows redirects itself, checking each hop and dropping credentials across origins. */
async function fetchChecked(url: string | URL, headers: Headers, registryHost: string): Promise<Response> {
  let target = new URL(url);
  for (let hop = 0; hop <= 5; hop++) {
    await assertFetchable(target, registryHost);
    const response = await fetch(target, { headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    await response.body?.cancel();
    const next = new URL(location, target);
    if (next.origin !== target.origin) headers.delete("authorization");
    target = next;
  }
  throw new Error("too many registry redirects");
}

export class RegistryClient {
  readonly #auth?: HostRegistryAuth;
  readonly #log: (message: string) => void;

  constructor(options: { auth?: HostRegistryAuth; log?: (message: string) => void } = {}) {
    this.#auth = options.auth;
    this.#log = options.log ?? (() => undefined);
  }

  /**
   * One request object owns one credential and its bearer-token cache. A pull keeps this
   * object only until it returns, so an override is neither stored on the shared client nor
   * observable by a concurrent pull.
   */
  request(auth?: RegistryAuth): RegistryRequest {
    const context: RequestContext = { auth, tokens: new Map() };
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
    // An image reference can name any registry; the host's credential goes only to its own.
    const host = this.#auth;
    const auth = context.auth ??
      (host && (host.registry === reference.registry || host.registry === reference.apiHost) ? host : undefined);
    const initialHeaders = new Headers(headers);
    if (auth) initialHeaders.set("Authorization", this.#basicAuthorization(auth));

    let response = await fetchChecked(url, initialHeaders, reference.apiHost);
    if (response.status !== 401) return response;

    const challenge = parseBearerChallenge(response.headers.get("www-authenticate") ?? "");
    if (!challenge) return response;
    await response.body?.cancel();

    const token = await this.#bearerToken(challenge, context, auth, reference.apiHost);
    const retryHeaders = new Headers(headers);
    retryHeaders.set("Authorization", `Bearer ${token}`);
    response = await fetchChecked(url, retryHeaders, reference.apiHost);
    return response;
  }

  async #bearerToken(
    challenge: BearerChallenge,
    context: RequestContext,
    auth: RegistryAuth | undefined,
    registryHost: string,
  ): Promise<string> {
    const key = `${challenge.realm}\n${challenge.service ?? ""}\n${challenge.scope ?? ""}`;
    const cached = context.tokens.get(key);
    if (cached) return cached;

    const url = new URL(challenge.realm);
    if (challenge.service) url.searchParams.set("service", challenge.service);
    if (challenge.scope) url.searchParams.set("scope", challenge.scope);
    const headers = new Headers({ Accept: "application/json" });
    if (auth) headers.set("Authorization", this.#basicAuthorization(auth));

    const response = await fetchChecked(url, headers, registryHost);
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
