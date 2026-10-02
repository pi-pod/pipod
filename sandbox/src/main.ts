import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig, unknownSandboxEnv } from "./config.js";
import { createLogger } from "./log.js";
import { Store } from "./db/index.js";
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

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  const metrics = new Metrics({ defaultMetrics: true, version: VERSION });
  const bootId = randomUUID();
  // A knob the service does not parse is a promise it is not keeping; say so at startup.
  const unknown = unknownSandboxEnv();
  if (unknown.length > 0) {
    log.warn({ variables: unknown }, "PI_POD_SANDBOX_* variables set but not recognised by this service (no-op)");
  }

  const store = new Store(cfg.paths.db);
  if(cfg.serviceObservations.mode==="off" && ShadowObservationJournal.exists(cfg.stateDir))
    throw new Error("retained shadow journal cannot boot with observation mode off");
  const observations=cfg.serviceObservations.mode==="shadow-v1"
    ? new ShadowObservationJournal(cfg.stateDir,cfg.serviceObservations.keyPath!,cfg.serviceObservations.keyId!)
    : null;
  observations?.reconcile(store.all(),bootId,cfg.hostId);
  const ociImages = new OciImageStore({
    stateDir: cfg.stateDir,
    auth: cfg.registryAuth,
    maxImageBytes: cfg.maxImageBytes,
    log: (msg) => log.debug({ images: msg }, "image store"),
  });
  // No network, cgroup reconciliation, reaper, or listener until every retained lower
  // has been checked against verified blobs. Boat snapshots can retain empty directories.
  await ociImages.validateAndRepair(store.all().filter((row) => row.tier !== "archived"));
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

  const reaper = new Reaper(cfg, store, manager, cgroups, objects, log, metrics);
  reaper.start();

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
