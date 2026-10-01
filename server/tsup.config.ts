import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/server/main.ts",
    migrate: "src/server/db/migrate-main.ts",
    fleet: "src/server/pods/sandboxfleet-cli.ts",
    "secrets-maintenance": "src/secrets-maintenance.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // Runtime-only SDKs stay external: bundling CommonJS packages such as ws into an ESM
  // dynamic chunk leaves require("events") calls that Node cannot execute.
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@prometheus-io/client",
    "pg",
    "ws",
  ],
});
