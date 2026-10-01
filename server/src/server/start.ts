import { applyProviderDeploymentEnv, type ServerEnv } from "./env.js";
import { assertHostBackendServed } from "./edition.js";
import { describePlatformCredentials, snapshotPlatformCredentials } from "./pods/providercred.js";
import { initPool } from "./db/index.js";
import { startPoolWatchdog } from "./db/watchdog.js";
import { migrate, type MigrationSet } from "./db/migrate.js";
import { EnvKekProvider } from "./secrets/crypto.js";
import { assertConfiguredKeyReferences } from "./secrets/maintenance.js";
import { backfillPiAuthToModelCredentials } from "./model-credentials/backfill.js";
import { GatewayService } from "./gateway/service.js";
import { buildApp } from "./app.js";
import { setMetricsSources } from "./metrics.js";
import { startWorkers } from "./workers/index.js";
import { startJobScheduler } from "./workers/jobs.js";
import type { PodServiceDeps } from "./pods/service.js";
import { readLaunchControl } from "./pods/launch-control.js";
import { pino } from "pino";

/**
 * Boots every role in `env.ROLE` and serves until SIGINT/SIGTERM. An edition calls
 * `installEdition` first and passes its own parsed environment and migration set.
 */
export async function startServer(env: ServerEnv, migrations?: MigrationSet): Promise<void> {
  assertHostBackendServed(env);
  applyProviderDeploymentEnv(env);
  // Boot snapshot of the platform provider credentials, BEFORE any provider overlay can
  // exist in this process (the credential lock swaps per-org BYO keys into process.env
  // while building adapters). Threaded below into gateway/pod/worker deps; runtime callers
  // must consume this snapshot, never ambient reads. Names only in logs, never values.
  const platformCredentials = snapshotPlatformCredentials(env);
  const log = pino({ level: env.LOG_LEVEL });
  log.info(`platform provider credentials: ${describePlatformCredentials(platformCredentials)}`);
  // URL syntax and placement mode are validated by loadEnv; registered fleet membership
  // controls placement, while the mode is logged so it stays observable per boot.
  const { describePlacementMode, sandboxPlacementMode } = await import("./pods/sandboxfleet.js");
  const placementMode = sandboxPlacementMode(env);
  log.info(`sandbox placement: ${describePlacementMode(placementMode)}`);
  const flatLog = {
    info: (m: string) => log.info(m),
    warn: (m: string) => log.warn(m),
    error: (m: string) => log.error(m),
  };

  // Schema changes run through the separate migrate job / `npm run migrate`.
  // Auto-migrate only in non-production so the runtime role stays non-owner.
  if (process.env.NODE_ENV !== "production") {
    const applied = await migrate(env.DATABASE_URL, migrations);
    if (applied.length) log.info(`migrations applied: ${applied.join(", ")}`);
  }
  initPool(env.DATABASE_URL);
  const launchControl = await readLaunchControl();
  log.info(`launch admission mode=${launchControl.mode} epoch=${launchControl.epoch} protocol=${launchControl.required_protocol}`);

  const kek = new EnvKekProvider(env.SECRETS_KEK_ID, env.SECRETS_KEK, env.SECRETS_KEK_PREVIOUS);
  // Fail before backfill, listeners, or workers if retained encrypted rows require a
  // missing key. Inventory checks references only; operators run maintenance verify
  // to authenticate every row before retiring a key.
  await assertConfiguredKeyReferences(kek);
  const backfill = await backfillPiAuthToModelCredentials(kek);
  log.info(
    `model credential backfill: users=${backfill.users} providers=${backfill.providers} skipped=${backfill.skipped}`,
  );

  const stopPoolWatchdog = startPoolWatchdog({
    onWedged: (checks) => {
      log.error(
        `database pool wedged across ${checks} checks: every connection held with callers queued — exiting for a restart`,
      );
      process.exit(1);
    },
  });

  const wantsApi = env.ROLE === "api" || env.ROLE === "all";
  const wantsGateway = env.ROLE === "gateway" || env.ROLE === "all";
  const wantsWorker = env.ROLE === "worker" || env.ROLE === "all";

  let gateway: GatewayService | null = null;
  let stopJobScheduler: (() => void) | null = null;
  if (wantsGateway) {
    gateway = new GatewayService({ env, kek, platformCredentials, log: flatLog });
    // Sweep/heartbeat/resolution loops are the gateway's own, not the worker role's:
    // a split deployment needs them wherever pods are actually held.
    gateway.start();
    stopJobScheduler = startJobScheduler({ env, kek, gateway, log: flatLog });
  }

  const podDeps: PodServiceDeps = {
    env,
    kek,
    platformCredentials,
    onPodStarted: (podId) => {
      if (!gateway) return;
      void (async () => {
        const row = await import("./db/index.js").then((m) =>
          m.query<{ org_id: string }>("SELECT org_id FROM pods WHERE id = $1", [podId]),
        );
        if (row.rows[0]) await gateway.ensureSession(row.rows[0].org_id, podId).catch(() => {});
      })();
    },
    log: flatLog,
  };

  let stopWorkers: (() => void) | null = null;
  if (wantsWorker) {
    stopWorkers = startWorkers({ env, kek, platformCredentials, gateway, log: flatLog });
  }

  setMetricsSources({
    role: env.ROLE,
    gatewaySessions: () => gateway?.heldSessionCount() ?? 0,
    gatewayPodTransports: () => gateway?.podTransports.size ?? 0,
    gatewayAttachesInFlight: () => gateway?.attachesInFlight() ?? 0,
  });

  // Every role binds HTTP. api/gateway serve /v1; worker still exposes /healthz and /metrics
  // so a split deployment can scrape the process that actually runs the loops.
  const app = await buildApp({
    env,
    kek,
    gateway,
    podDeps,
    roles: { api: wantsApi, gateway: wantsGateway },
  });
  await app.listen({ host: env.HOST, port: env.PORT });
  log.info(`pi-pod-server role=${env.ROLE} listening on ${env.HOST}:${env.PORT}`);

  const shutdown = async () => {
    log.info("shutting down");
    stopWorkers?.();
    stopPoolWatchdog();
    stopJobScheduler?.();
    if (gateway) await gateway.shutdown();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Runs `start` as the process entrypoint: any startup failure exits 1 with a safe message. */
export function runEntrypoint(start: () => Promise<void>): void {
  start().catch(() => {
    // Startup can cross credential and SDK boundaries. Never serialize an arbitrary
    // exception (which may contain plaintext); maintenance provides safe diagnostics.
    console.error("server startup failed; check configuration, database, and secrets maintenance status");
    process.exit(1);
  });
}
