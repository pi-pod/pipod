import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { pino } from "pino";
import { makeAuthHook } from "./auth/plugin.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerVersionRoute } from "./release.js";
import { registerOrgRoutes } from "./orgs/routes.js";
import { registerSettingsDefaultsRoute, registerSettingsRoutes } from "./settings/routes.js";
import { registerSecretRoutes } from "./secrets/routes.js";
import { registerModelCredentialRoutes } from "./model-credentials/routes.js";
import { registerTemplateRoutes } from "./templates/routes.js";
import { registerJobRoutes } from "./jobs/routes.js";
import { registerPodRoutes } from "./pods/routes.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { registerDashboard } from "./dashboard.js";
import {
  HttpError,
  isLaunchAdmissionHeldError,
  LAUNCH_ADMISSION_HELD_MESSAGE,
} from "./httperrors.js";
import { edition } from "./edition.js";
import { query } from "./db/index.js";
import {
  PINO_REDACT_PATHS,
  FLEET_UNAVAILABLE_MESSAGE,
  boatHostDemandDetail,
  fleetUnavailableDetail,
  isProviderValidationFailure,
  launchAdmissionHeldDetail,
  redactUrlForLog,
  renderBoatHostDemand,
  sanitizeForLog,
  scrubValidationIssues,
} from "./safe-errors.js";
import { supportedProviders } from "../core/providers/registry.js";
import { capacityWaitTerminalDetail, renderCapacityWaitTerminal } from "./pods/provision-failure.js";
import { registerMetrics, type MetricsHttpApp } from "./metrics.js";

/** Whether the database will accept writes, which a reachability check does not answer.
 *
 * A managed cluster that fills its volume is set read-only rather than taken down: every SELECT
 * still succeeds, so /healthz stayed 200 through an outage in which every mutating route 500'd.
 * Reported rather than thrown — a failing liveness probe would restart-loop a container whose
 * problem is on the database side, which is exactly when staying up to serve reads is worth more.
 */
async function databaseHealth(): Promise<{ reachable: boolean; writable: boolean }> {
  try {
    const row = await query<{ read_only: string; in_recovery: boolean }>(
      `SELECT current_setting('default_transaction_read_only') AS read_only,
              pg_is_in_recovery() AS in_recovery`,
    );
    const readOnly = row.rows[0]?.read_only === "on" || row.rows[0]?.in_recovery === true;
    return { reachable: true, writable: !readOnly };
  } catch {
    return { reachable: false, writable: false };
  }
}
import type { ServerEnv } from "./env.js";
import type { GatewayService } from "./gateway/service.js";
import type { PodServiceDeps } from "./pods/service.js";
import type { KekProvider } from "./secrets/crypto.js";

export interface AppDeps {
  env: ServerEnv;
  kek: KekProvider;
  gateway: GatewayService | null;
  podDeps: PodServiceDeps;
  roles: { api: boolean; gateway: boolean };
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: ReturnType<typeof makeAuthHook>;
  }
}

interface ErrorHttpApp {
  log: { error: (error: unknown, message?: string) => void };
  setErrorHandler(
    handler: (error: FastifyError, req: FastifyRequest, reply: FastifyReply) => unknown,
  ): unknown;
}

function safeLogger(level: string) {
  return pino({
    level,
    redact: { paths: PINO_REDACT_PATHS, censor: "[redacted]" },
    serializers: {
      err: (error: unknown) => sanitizeForLog(error),
      // Fastify's request serializer, with credential query values redacted from the URL.
      req: (req: FastifyRequest) => ({
        method: req.method,
        url: redactUrlForLog(req.url),
        version: req.headers?.["accept-version"],
        host: req.host,
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort,
      }),
    },
  });
}

/**
 * Pod launch routes whose body `provider` enum carries the old-client hint.
 * routeOptions.url includes the /v1 prefix when registered under it (probe:
 * /v1/pods, /v1/pods/resolve); bare /pods forms cover prefix-less test apps
 * and future refactors that move the prefix. Anything else stays generic.
 */
function isPodLaunchProviderRoute(req: unknown): boolean {
  const routeUrl = (req as { routeOptions?: { url?: unknown } })?.routeOptions?.url;
  if (
    routeUrl === "/v1/pods" ||
    routeUrl === "/v1/pods/resolve" ||
    routeUrl === "/pods" ||
    routeUrl === "/pods/resolve"
  ) {
    return true;
  }
  // Fallback to the raw URL (querystring stripped) for robustness across
  // Fastify prefix handling.
  const raw = (req as { url?: unknown })?.url;
  if (typeof raw === "string") {
    const path = raw.split("?")[0];
    return path === "/v1/pods" || path === "/v1/pods/resolve" || path === "/pods" || path === "/pods/resolve";
  }
  return false;
}

/** Shared error boundary for the API/gateway apps; exported for route-level tests. */
export function installErrorHandler(app: ErrorHttpApp): void {
  app.setErrorHandler((error, req, reply) => {
    // Error types only the edition throws; none of them is an HttpError below 500.
    const rendered = edition().renderError(error);
    if (rendered) return reply.code(rendered.statusCode).send(rendered.body);
    if (isLaunchAdmissionHeldError(error)) {
      const detail = launchAdmissionHeldDetail(error);
      if (detail) {
        return reply.code(503).send({ error: LAUNCH_ADMISSION_HELD_MESSAGE, detail });
      }
      // The issued object was mutated or has a malformed detail. Do not let it
      // fall through to client-error passthrough or any other typed allowlist.
      app.log.error("malformed issued launch admission error");
      return reply.code(500).send({ error: "internal server error", detail: null });
    }
    // Locally constructed client errors are returned only to the same caller.
    // Server/provider errors and validator prose must not echo foreign values.
    if (error instanceof HttpError && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message, detail: error.detail ?? null });
    }
    // Typed fleet-unavailable 503s are actionable client signals (retryable
    // with a bounded hint), not server faults: answer 503 with the static
    // message plus the validated detail. Anything unrecognized still fails
    // closed to 500 below.
    const fleet = fleetUnavailableDetail(error);
    if (fleet) {
      return reply.code(503).send({ error: FLEET_UNAVAILABLE_MESSAGE, detail: fleet });
    }
    // Typed capacity-wait expiry 503s (create and wake waiters) carry the
    // allowlisted `capacity_wait_expired` shape: answer 503 with the same
    // rendering the failure recorder writes to `state_reason`, never 500.
    // Anything unrecognized still fails closed to 500 below.
    const waitTerminal = capacityWaitTerminalDetail(error);
    if (waitTerminal) {
      return reply.code(503).send({ error: renderCapacityWaitTerminal(waitTerminal), detail: waitTerminal });
    }
    // Typed Boat host-demand 503s carry the allowlisted admission shape the
    // demand contract documents (docs/boat-placement.md): answer 503 with static
    // per-reason copy plus the validated detail, so the client polls the owned
    // workstation status and retries the same pod instead of reading an opaque
    // 500. Anything unrecognized still fails closed to 500 below.
    const hostDemand = boatHostDemandDetail(error);
    if (hostDemand) {
      return reply.code(503).send({ error: renderBoatHostDemand(hostDemand), detail: hostDemand });
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (!(error instanceof HttpError) && typeof statusCode === "number" && statusCode < 500) {
      const validation = (error as { validation?: unknown }).validation;
      // Retired/unknown provider names (old clients sending e2b/daytona) fail
      // zod-enum validation before the handler runs. The scrubbed detail drops
      // the enum list by design, so answer with the static registry-driven
      // list here — but ONLY for pod launch/resolve body validation. A global
      // /provider check would mislabel unrelated routes (e.g. a path param or
      // body field also named provider) with the sandbox/host list. No
      // message/params/data is echoed — only the static copy plus the
      // scrubbed location/rule pair below.
      const validationContext = (error as { validationContext?: unknown }).validationContext;
      if (
        validationContext === "body" &&
        isPodLaunchProviderRoute(req) &&
        isProviderValidationFailure(validation)
      ) {
        const supported = supportedProviders().join(", ");
        return reply.code(400).send({
          error: `unsupported provider; supported providers: ${supported}`,
          detail: scrubValidationIssues(validation),
        });
      }
      return reply.code(statusCode).send({ error: "validation failed", detail: scrubValidationIssues(validation) });
    }
    app.log.error({ err: sanitizeForLog(error) }, "unhandled request error");
    return reply.code(500).send({ error: "internal server error", detail: null });
  });
}

function registerHealthAndMetrics(app: MetricsHttpApp, deps: Pick<AppDeps, "env" | "roles">): void {
  registerMetrics(app, { token: deps.env.METRICS_TOKEN, role: deps.env.ROLE });
  const startedAt = new Date().toISOString();
  app.get("/healthz", async () => ({
    ok: true,
    roles: deps.roles,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    db: await databaseHealth(),
  }));
}

/** Worker-only listener: /healthz and /metrics, no product routes, Swagger, or WebSocket. */
export async function buildOpsApp(deps: Pick<AppDeps, "env" | "roles">) {
  const logger = safeLogger(deps.env.LOG_LEVEL);
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 4 * 1024 * 1024,
  });
  installErrorHandler(app);
  registerHealthAndMetrics(app, deps);
  return app;
}

export async function buildApp(deps: AppDeps) {
  if (!deps.roles.api && !deps.roles.gateway) {
    return buildOpsApp(deps);
  }

  const logger = safeLogger(deps.env.LOG_LEVEL);
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 4 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  installErrorHandler(app);

  // The Flutter web client is a browser origin, so /v1 needs CORS; native clients never
  // send Origin and are unaffected. Credentials stay off: auth is a bearer header, so
  // allowing cookies would only widen what a hostile page could do with a logged-in browser.
  if (deps.env.WEB_ORIGINS.length > 0) {
    await app.register(cors, {
      origin: deps.env.WEB_ORIGINS,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type"],
      credentials: false,
      maxAge: 86_400,
    });
  }

  await app.register(swagger, {
    openapi: {
      info: {
        title: "pi pod server",
        description:
          "Hosted control plane for pi pod (server-spec §10). All routes under /v1, bearer-authenticated with a Zitadel access token. Tenant scope is the token's single organization claim.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(websocket);

  app.decorate("authenticate", makeAuthHook(deps.env, { warn: (m) => app.log.warn(m) }));

  if (deps.roles.api) {
    // Edition routes live outside the /v1 prefix in their own encapsulated plugins, so
    // a receiver that needs its own body parser cannot change how any JSON route parses.
    await app.register(async (scope) => {
      await edition().registerRoutes(scope, { env: deps.env, kek: deps.kek, gateway: deps.gateway });
    });
  }
  registerHealthAndMetrics(app, deps);
  app.get("/v1/openapi.json", async () => app.swagger());
  // Where the dashboard is, for /v1/me to send the phone apps to; set once its plugin loads.
  let dashboardUrl: string | null = null;
  if (deps.roles.api) {
    await app.register(async (scope) => {
      dashboardUrl = registerDashboard(scope, deps.env);
    });
  }

  await app.register(async (v1) => {
    if (deps.roles.api) {
      registerAuthRoutes(v1, deps.env, dashboardUrl);
      registerVersionRoute(v1);
      registerOrgRoutes(v1, deps.env);
      registerSettingsRoutes(v1);
      registerSettingsDefaultsRoute(v1, deps.env);
      registerSecretRoutes(v1, deps.kek);
      registerModelCredentialRoutes(v1, { kek: deps.kek, podDeps: deps.podDeps });
      registerTemplateRoutes(v1);
      registerJobRoutes(v1);
      registerPodRoutes(v1, deps.podDeps, deps.gateway);
    }
    if (deps.roles.gateway) {
      registerGatewayRoutes(v1, deps.gateway!);
    }
  }, { prefix: "/v1" });

  return app;
}
