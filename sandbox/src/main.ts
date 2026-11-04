import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig, unknownSandboxEnv } from "./config.js";
import { createLogger } from "./log.js";
import { Store } from "./db/index.js";
import { removeAbandonedImageBuilds } from "./images/derive.js";
import { OciImageStore } from "./images/store.js";
import { createObjectStore } from "./archive/objectstore.js";
import { CgroupTree } from "./runtime/cgroup.js";
import { Runtime } from "./runtime/crun.js";
import { Network } from "./runtime/netns.js";
import { Manager } from "./core/manager.js";
import { ShadowObservationJournal } from "./core/service-observation-journal.js";
import { Reaper } from "./core/reaper.js";
import { buildServer } from "./api/server.js";
import {
  Metrics,
  instrumentImageStore,
  instrumentObjectStore,
  instrumentRuntime,
} from "./metrics.js";

const VERSION = "0.1.0";
/** How often verified image lowers have their contents re-hashed after boot. */
const IMAGE_SCRUB_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Boot-phase timing. A restart of this service has to adopt the host's whole retained state,
 * and none of that used to be visible: the API simply did not answer for minutes and the only
 * symptom was a healthcheck that said `unhealthy`. One line per phase at info level makes the
 * slow one a measurement instead of an argument, and keeps a long boot explainable in a log.
 */
function bootPhases(log: ReturnType<typeof createLogger>) {
  const started = process.hrtime.bigint();
  let last = started;
  return {
    mark(phase: string, fields: Record<string, number | string> = {}): void {
      const now = process.hrtime.bigint();
      log.info(
        { phase, ms: Number((now - last) / 1_000_000n), totalMs: Number((now - started) / 1_000_000n), ...fields },
        "sandbox boot phase",
      );
      last = now;
    },
    elapsedMs: () => Number((process.hrtime.bigint() - started) / 1_000_000n),
  };
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  const boot = bootPhases(log);
  const metrics = new Metrics({ defaultMetrics: true, version: VERSION });
  const bootId = randomUUID();
  // A knob the service does not parse is a promise it is not keeping; say so at startup.
  const unknown = unknownSandboxEnv();
  if (unknown.length > 0) {
    log.warn({ variables: unknown }, "PI_POD_SANDBOX_* variables set but not recognised by this service (no-op)");
  }

  const store = new Store(cfg.paths.db);
  boot.mark("store", { rows: store.all().length });
  if(cfg.serviceObservations.mode==="off" && ShadowObservationJournal.exists(cfg.stateDir))
    throw new Error("retained shadow journal cannot boot with observation mode off");
  const observations=cfg.serviceObservations.mode==="shadow-v1"
    ? new ShadowObservationJournal(cfg.stateDir,cfg.serviceObservations.keyPath!,cfg.serviceObservations.keyId!)
    : null;
  observations?.reconcile(store.all(),bootId,cfg.hostId);
  if (observations) boot.mark("observations");
  const ociImages = new OciImageStore({
    stateDir: cfg.stateDir,
    auth: cfg.registryAuth,
    maxImageBytes: cfg.maxImageBytes,
    log: (msg) => log.debug({ images: msg }, "image store"),
  });
  // No network, cgroup reconciliation, reaper, or listener until every retained lower
  // has been checked against verified blobs. Boat snapshots can retain empty directories.
  await ociImages.validateAndRepair(store.all().filter((row) => row.tier !== "archived"));
  boot.mark("image-verify", { requiredRows: store.all().filter((row) => row.tier !== "archived").length });
  const images = instrumentImageStore(ociImages, metrics);
  const runtime = instrumentRuntime(new Runtime(cfg.runtime), metrics);
  const network = new Network(cfg.bridge.name, cfg.bridge.cidr, cfg.dns, undefined, {
    apiPort: cfg.port,
    privateEgress: cfg.privateEgress,
  });
  const cgroups = new CgroupTree();
  const objects = instrumentObjectStore(createObjectStore(cfg.archive), metrics);

  const manager = new Manager(cfg, store, images, runtime, network, cgroups, objects, log, metrics, {
    bootId,
    serviceVersion: VERSION,
    observations: observations ?? undefined,
  });
  await manager.init();
  boot.mark("manager-init");
  await removeAbandonedImageBuilds(manager, log);
  boot.mark("image-builds");

  const reaper = new Reaper(cfg, store, manager, cgroups, objects, log, metrics);
  reaper.start();

  // Resolve checks each lower's fingerprint; this re-hashes their contents for corruption
  // beneath the filesystem. Chained, so a slow pass never overlaps the next.
  let imageScrub: NodeJS.Timeout | undefined;
  const scheduleImageScrub = (): void => {
    imageScrub = setTimeout(() => {
      void ociImages.scrub().then(
        (forgotten) => {
          for (const digest of forgotten) log.error({ digest }, "image layer no longer matches its verified contents; the next pull repairs it");
        },
        (err: unknown) => log.error({ err }, "image layer scrub failed"),
      ).finally(() => {
        if (!shutdownStarted) scheduleImageScrub();
      });
    }, IMAGE_SCRUB_INTERVAL_MS);
    imageScrub.unref();
  };
  scheduleImageScrub();

  metrics.bind({
    snapshot: () => ({
      ...manager.metricsSnapshot(),
      hostPressure: cgroups.hostPressure(),
      hostMemoryAvailableBytes: os.freemem(),
      hostMemoryTotalBytes: os.totalmem(),
    }),
  });

  const app = await buildServer({
    cfg,
    manager,
    objects,
    log,
    version: VERSION,
    runtimeName: await runtime.version(),
    metrics,
  });

  await app.listen({ host: cfg.host, port: cfg.port });
  boot.mark("listening");
  log.info(
    {
      port: cfg.port,
      runtime: cfg.runtime,
      archive: objects.kind,
      bootId,
      memoryAdmission: cfg.admission.memoryMode,
      grantManaged: manager.grants.managedMode(),
    },
    "pi pod sandbox listening",
  );

  let shutdownStarted=false;
  const shutdown = async (signal: string): Promise<void> => {
    if(shutdownStarted)return;
    shutdownStarted=true;
    log.info({ signal }, "shutting down");
    reaper.stop();
    clearTimeout(imageScrub);
    // Closing admission precedes quiescence. The service manager's stop deadline
    // is the outer bound; never close SQLite or write a hold midway through an
    // archive/delete that is already inside its serialized critical section.
    await app.close();
    if(observations){
      try{await reaper.quiesce(60_000);}
      catch(error){
        log.error({err:error},"reaper work did not quiesce; leaving state open for service-manager fencing");
        process.exitCode=1;
        return;
      }
      while(manager.shadowWorkInFlight>0)await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(observations)try{observations.fenceShutdown(bootId);}
    catch(error){
      try{observations?.markHold("shutdown-fence-write-failed",bootId);}catch{}
      log.error({err:error},"shadow shutdown fence could not be persisted");
      process.exitCode=1;
      return;
    }
    observations?.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
