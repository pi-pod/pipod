/** Entrypoint of the fleet operator CLI (`npm run fleet`, `node dist/fleet.js`); see fleet-cli.ts. */
import { runFleetCli } from "./fleet-cli.js";

await runFleetCli(process.argv.slice(2));
