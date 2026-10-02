import { z } from "zod";
import { KEK_BYTES } from "./secrets/crypto.js";

export type ServerRole = "api" | "gateway" | "worker" | "all";

const ZitadelIssuerSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    const loopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must use HTTPS except for loopback development" });
    }
    if (url.username || url.password || url.hash || url.search) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must not contain credentials, a query, or a fragment" });
    }
  })
  .transform((value) => value.replace(/\/+$/, ""));

const SandboxServiceUrlSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must use HTTP or HTTPS" });
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must not contain credentials" });
    }
  })
  .transform((value) => value.replace(/\/+$/, ""));

const SandboxImageMirrorSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    if (value.includes("://") || value.includes("@") || value.includes("?") || value.includes("#")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be an OCI registry namespace without a scheme, credentials, query, or fragment",
      });
      return;
    }
    const normalized = value.replace(/^\/+|\/+$/g, "");
    const slash = normalized.indexOf("/");
    try {
      const parsed = new URL(`https://${normalized}`);
      if (slash < 1 || slash === normalized.length - 1 || !parsed.hostname) throw new Error();
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must include a valid OCI registry and namespace, for example ghcr.io/pi-pod",
      });
    }
  })
  .transform((value) => value.replace(/^\/+|\/+$/g, ""));

/**
 * The public all-zero dev placeholder that used to ship as the Compose default.
 * It must never encrypt real data: anyone holding a database dump encrypted under
 * it can decrypt every secret without any further key material.
 */
export const INSECURE_PLACEHOLDER_KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const KekSchema = z.string().superRefine((value, ctx) => {
  const reject = (message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  };
  const shape = `must be base64 of exactly ${KEK_BYTES} bytes, as produced by \`openssl rand -base64 32\``;
  if (value.length === 0) {
    reject(`${shape} (missing or empty: generate a real key, never a placeholder)`);
    return;
  }
  // Buffer.from(base64) silently skips invalid characters, so validate the alphabet
  // first; otherwise a malformed value could pass or fail for the wrong reason.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    reject(shape);
    return;
  }
  if (Buffer.from(value, "base64").length !== KEK_BYTES) {
    reject(shape);
    return;
  }
  if (value === INSECURE_PLACEHOLDER_KEK) {
    reject("is the insecure all-zero placeholder from docker-compose; generate a real key with `openssl rand -base64 32`");
  }
});

/** Retired KEK versions, as JSON: `{"<key id>": "<base64 32-byte key>"}`. */
const PreviousKeksSchema = z
  .string()
  .optional()
  .transform((value, ctx): Record<string, string> => {
    const raw = (value ?? "").trim();
    if (raw.length === 0) return {};
    const reject = (message: string): typeof z.NEVER => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return reject('must be a JSON object of {"<key id>": "<base64 32-byte key>"}');
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return reject('must be a JSON object of {"<key id>": "<base64 32-byte key>"}');
    }
    const entries: [string, string][] = [];
    for (const [keyId, key] of Object.entries(parsed)) {
      if (keyId.trim().length === 0) return reject("must not contain an empty key id");
      // Key material never reaches an issue message: a failed boot prints them.
      if (typeof key !== "string" || Buffer.from(key, "base64").length !== KEK_BYTES) {
        return reject(`key id "${keyId}" must map to base64 of exactly ${KEK_BYTES} bytes`);
      }
      entries.push([keyId, key]);
    }
    return Object.fromEntries(entries);
  });

/**
 * Server settings, one field schema per environment variable. An edition with settings of
 * its own spreads these into a larger object and runs `checkServerEnv` in its refinement.
 */
export const serverEnvShape = {
    ROLE: z.enum(["api", "gateway", "worker", "all"]).default("all"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().default(8080),
    DATABASE_URL: z.string().min(1),
    /**
     * The server owns its database upgrades: at boot it refuses a database a newer release
     * migrated, applies pending migrations, and opens a launch gate a migration held (see
     * db/upgrade.ts). Safe only when no other server process can run against the database —
     * the single-container self-hosted bundle. Production keeps it off and does both steps in
     * its deploy pipeline.
     */
    UPGRADE_ON_START: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
    LOG_LEVEL: z.string().default("info"),

    /**
     * Optional scrape secret for GET /metrics. Unset leaves the endpoint open, which is the
     * right default for a private network (the same trust model as /healthz). When set, scrapers
     * must send `Authorization: Bearer <token>`. Never logged. A set value must be at least 16
     * characters so a copied placeholder cannot be guessed.
     */
    METRICS_TOKEN: z
      .string()
      .optional()
      .transform((value, ctx) => {
        const token = (value ?? "").trim();
        if (token.length === 0) return undefined;
        if (token.length < 16) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "must be at least 16 characters when set",
          });
          return z.NEVER;
        }
        return token;
      }),

    /** Stable identity of this gateway instance, for pod leases (pods.gateway_id). */
    GATEWAY_ID: z.string().default(`gw-${process.pid}-${Math.random().toString(36).slice(2, 8)}`),

    /**
     * Zitadel instance issuer, e.g. `https://auth.example.com`.
     * Discovery and JWKS are derived from this unless ZITADEL_JWKS_URL is set.
     */
    ZITADEL_ISSUER: ZitadelIssuerSchema,
    /**
     * Resource-server audience; must appear in access-token `aud`. In production this is
     * the Zitadel project id of the `pipod` project (tokens issued to apps of that project
     * carry it automatically). The default only matches the local dev signer.
     */
    ZITADEL_API_AUDIENCE: z
      .string()
      .min(
        1,
        "set ZITADEL_API_AUDIENCE to the project id printed by " +
          "zitadel/scripts/reconcile-zitadel.mjs --apply",
      )
      .default("pipod-api"),
    /**
     * Client id of the `pipod-cli` app, published at GET /v1/auth/config so `pipod login
     * --server <url>` needs nothing else. Unset, the CLI falls back to its built-in id.
     */
    ZITADEL_CLI_CLIENT_ID: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined),
    /**
     * Client id of the `pipod-mobile` app, published at GET /v1/auth/config so the phone apps
     * can sign in to this server from its address alone. Unset, they use their built-in id.
     */
    ZITADEL_MOBILE_CLIENT_ID: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined),
    /**
     * Client id of the `pipod-dashboard` app, published at GET /v1/auth/config for the web
     * dashboard this server serves at /dashboard/. Unset, the dashboard cannot sign in.
     */
    ZITADEL_DASHBOARD_CLIENT_ID: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined),
    /** Override for tests / local signer; defaults to `<issuer>/oauth/v2/keys`. */
    ZITADEL_JWKS_URL: z.string().url().optional(),
    /** Optional self-service console URL; derived from the issuer when omitted. */
    ZITADEL_ACCOUNT_URL: z.string().url().optional(),
    /** Optional Zitadel Console URL; derived from the issuer when omitted. */
    ZITADEL_ADMIN_URL: z.string().url().optional(),

    /**
     * Base64-encoded 32-byte key-encryption key for envelope encryption of secrets (§7). It
     * stays in the server's env file only — 0600, root-owned — and is never logged.
     * Validated here so that a truncated key fails the boot instead of the first secret write.
     */
    SECRETS_KEK: KekSchema,
    /** Names the KEK version, stored beside every ciphertext (`key_id`) for rotation. */
    SECRETS_KEK_ID: z.string().min(1).default("kek-1"),
    /**
     * Retired KEKs that must still unwrap already-stored secrets, as a JSON object of
     * `{"<key id>": "<base64 32-byte key>"}`. Rotation: move the current pair in here, point
     * SECRETS_KEK/SECRETS_KEK_ID at the new key, restart. Old rows stay readable and every
     * write re-wraps under the new id, so the tables migrate lazily; drop a version from this
     * map once no key_id in secrets, pi_auth, pi_settings, pod_launch_env, or
     * model_credentials still names it.
     */
    SECRETS_KEK_PREVIOUS: PreviousKeksSchema,

    /**
     * Where pods run. `static` (self-hosted) places them on the hosts the operator registered
     * with the fleet CLI, or on PI_POD_SANDBOX_URL. Any other name selects an edition's backend
     * that provisions a host per owner; the server refuses a name its edition does not serve.
     */
    SANDBOX_HOST_BACKEND: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).default("static"),
    /** Platform sandbox credential (per-org BYO tokens override via org secrets). */
    PI_POD_SANDBOX_TOKEN: z.string().optional(),
    /** Deployment-owned sandbox service wiring; user account config need not carry it. */
    PI_POD_SANDBOX_URL: SandboxServiceUrlSchema.default("http://pi-pod-sandbox:8433"),
    /**
     * Where platform sandbox launches may run (plan §4.1). `single` keeps the historical
     * single-host deployment: an empty fleet falls back to PI_POD_SANDBOX_URL. `fleet`
     * is production: an empty or unreachable fleet fails closed with a typed
     * capacity/unavailable error and never executes on the control-plane fallback.
     * Pinned remote workspaces keep their frozen host URL; that is not a fallback.
     */
    SANDBOX_PLACEMENT_MODE: z.enum(["single", "fleet"]).default("single"),
    /**
     * Explicit opt-in to pre-contract (legacy) hosts in fleet placement
     * (§6.4). Default OFF: once the fleet speaks the versioned capacity
     * contract, silent ranked-last trust in hosts it cannot see is how
     * placements quietly exceed every budget. Malformed or misidentified
     * reports are never eligible regardless of this flag. Single mode
     * always keeps the legacy compat path (dev/BYOK deployments).
     */
    SANDBOX_ALLOW_LEGACY_HOSTS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /** OCI namespace containing the signed pi-pod-base tags mirrored into sandbox caches. */
    PI_POD_SANDBOX_IMAGE_MIRROR: SandboxImageMirrorSchema.default("ghcr.io/pi-pod"),
    /** Best-effort platform image warmup on worker startup; launch-time building remains authoritative. */
    IMAGE_PREWARM_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),

    /** Public base URL of this server, injected into pods as PI_POD_SERVER_URL (§8.5). */
    PUBLIC_URL: z.string().url().optional(),
    /** Browser origins allowed to call /v1, comma-separated. Empty disables CORS entirely,
     * which is the right default for a server whose only clients are native apps: an
     * allowlist that is never set cannot be widened by accident. */
    WEB_ORIGINS: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),

    APNS_TEAM_ID: z.string().optional(),
    APNS_KEY_ID: z.string().optional(),
    /** PEM/PKCS8 contents of the .p8 signing key (not a path). */
    APNS_KEY_P8: z.string().optional(),
    APNS_BUNDLE_ID: z.string().optional(),

    FCM_PROJECT_ID: z.string().optional(),
    FCM_CLIENT_EMAIL: z.string().optional(),
    /** PEM/PKCS8 contents of the service-account key (not a path). */
    FCM_PRIVATE_KEY: z.string().optional(),

    /**
     * Deployment-wide limits. POD_MAX_CONCURRENT_PER_USER counts the pods a user has holding
     * across ALL organizations (global user budget), enforced atomically on every launch
     * and every wake — a stopped pod holds no slot, and waking one has to win a slot back;
     * `stopping` still holds until a confirmed stop. An org policy maxConcurrentPods is a
     * separate aggregate over the whole org and can only narrow further. Requested resources
     * are clamped to the POD_MAX_* ceilings before the provider's own maximums apply.
     * Self-hosters raise or lower these per deployment.
     */
    POD_MAX_CONCURRENT_PER_USER: z.coerce.number().int().positive().default(20),
    /**
     * Deployment ceiling for platform-funded native sandbox retention (plan §3.1).
     * Scoped to the platform fleet only — BYOK and non-sandbox providers are untouched.
     * A requested zero/unlimited delay never bypasses this finite maximum.
     */
    POD_SANDBOX_MAX_ARCHIVE_AFTER_MINUTES: z.coerce.number().int().positive().default(60),
    /**
     * Largest pod this deployment launches (§7.4). Larger CPU and disk requests clamp with a
     * warning; memory follows assertSandboxMemoryWithinDeployment. Each sandbox host also
     * refuses a shape above its own PI_POD_SANDBOX_MAX_*, so raising a ceiling takes both sides.
     */
    POD_MAX_CPU: z.coerce.number().positive().default(2),
    POD_MAX_MEMORY_GB: z.coerce.number().positive().default(4),
    POD_MAX_DISK_GB: z.coerce.number().positive().default(20),
    /**
     * Bounded capacity wait (§6.6, default OFF until the wait contract is
     * published to clients). When on, otherwise-valid launches refused with
     * retryable capacity detail wait up to CAPACITY_WAIT_SECONDS (default 60)
     * holding one user concurrency slot but no host reservation; invalid
     * shapes, quota refusals, and unsupported_shape never wait.
     */
    CAPACITY_WAIT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CAPACITY_WAIT_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
    /** How old a capacity sample may be before placement assumes no headroom. */
    CAPACITY_FRESHNESS_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
    /**
     * Fleet CPU fairness allocator (§7.3, default OFF until qualification).
     * When off, hosts stay on local equal weights and nothing here issues
     * grants or gates admissions.
     */
    CPU_FAIRNESS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /** Host-local grant validity per issue (native measures expiry monotonically). */
    CPU_GRANT_TTL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
    /** How often the allocator re-solves and re-issues grants. */
    CPU_ALLOCATOR_INTERVAL_MS: z.coerce.number().int().min(5000).max(300_000).default(15_000),

    /**
     * Workspace seeding limits for `PUT /pods/:id/workspace/archive` and the clone route. The
     * compressed cap bounds what the server spools to disk per request; the uncompressed cap and
     * entry count bound what the in-pod extractor will materialize, which is what stops a
     * gzip bomb or a million-entry archive from filling the sandbox disk.
     */
    WORKSPACE_ARCHIVE_MAX_COMPRESSED_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .default(256 * 1024 * 1024),
    WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .default(2 * 1024 * 1024 * 1024),
    WORKSPACE_ARCHIVE_MAX_ENTRIES: z.coerce.number().int().min(1).max(10_000_000).default(200_000),
    /** Wall-clock budget for one in-pod clone or archive extraction. */
    WORKSPACE_SEED_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
    /**
     * A launch flagged `workspaceSeed` holds Pi back until the client has seeded the workdir.
     * After this long the gate opens on its own so an abandoned launch still becomes a usable
     * (empty) pod instead of leaking forever.
     */
    WORKSPACE_SEED_GATE_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),

    /** How long session_events rows are kept before the retention worker expires them. */
    EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    /** Hard ceiling on session_events rows, enforced oldest-first after the age window. */
    EVENT_MAX_ROWS: z.coerce.number().int().min(100_000).max(1_000_000_000).default(4_000_000),
};

/** Cross-field rules the field schemas cannot express. */
export function checkServerEnv(
  env: z.infer<z.ZodObject<typeof serverEnvShape>>,
  ctx: z.RefinementCtx,
): void {
  if (Object.keys(env.SECRETS_KEK_PREVIOUS).includes(env.SECRETS_KEK_ID)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SECRETS_KEK_PREVIOUS"],
      message: `must not repeat the current SECRETS_KEK_ID "${env.SECRETS_KEK_ID}"; it names retired versions only`,
    });
  }
}

export const EnvSchema = z.object(serverEnvShape).superRefine(checkServerEnv);

export type ServerEnv = z.infer<typeof EnvSchema>;

let cached: ServerEnv | null = null;

/** Parses settings with any schema built on `serverEnvShape`, naming failures without values. */
export function parseEnv<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, source: NodeJS.ProcessEnv): T {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Issue messages only: a value here would print SECRETS_KEK on a failed boot.
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid server environment: ${missing}`);
  }
  return parsed.data;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  if (cached) return cached;
  cached = parseEnv(EnvSchema, source);
  return cached;
}

/**
 * Provider adapters preserve the CLI factory contract and therefore read deployment fallbacks
 * from process.env. Install the schema-normalized, defaulted value once at server startup; the
 * credential lock swaps only provider token variables and cannot affect this URL.
 */
export function applyProviderDeploymentEnv(
  env: Pick<ServerEnv, "PI_POD_SANDBOX_URL" | "PI_POD_SANDBOX_IMAGE_MIRROR">,
): void {
  process.env["PI_POD_SANDBOX_URL"] = env.PI_POD_SANDBOX_URL;
  process.env["PI_POD_SANDBOX_IMAGE_MIRROR"] = env.PI_POD_SANDBOX_IMAGE_MIRROR;
}

export function resetEnvCache(): void {
  cached = null;
}

export function jwksUrl(env: ServerEnv): string {
  if (env.ZITADEL_JWKS_URL) return env.ZITADEL_JWKS_URL;
  return `${env.ZITADEL_ISSUER.replace(/\/+$/, "")}/oauth/v2/keys`;
}
