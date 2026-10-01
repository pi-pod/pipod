import { loadConfig } from "../config.js";
import { Store } from "../db/index.js";
import { OciImageStore } from "./store.js";

// Offline boot prerequisite: does not create loop nodes, networking or listeners.
// Same environment as the service. Run only while the service is stopped.
const cfg = loadConfig();
const store = new Store(cfg.paths.db);
try {
  const images = new OciImageStore({ stateDir: cfg.stateDir, auth: cfg.registryAuth, log: (message) => console.error(message) });
  await images.validateAndRepair(store.all().filter((row) => row.tier !== "archived"));
  console.log("OCI image integrity gate passed");
} finally {
  store.close();
}
