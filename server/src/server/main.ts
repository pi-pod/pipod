/** Entrypoint of the self-hosted server (`node dist/main.js`). */
import { loadEnv } from "./env.js";
import { runEntrypoint, startServer } from "./start.js";

runEntrypoint(async () => startServer(loadEnv()));
