import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", "scripts/verify-images": "src/images/verify-cli.ts",
    "scripts/service-observations": "src/service-observations-cli.ts" },
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  external: ["better-sqlite3", "node-pty"],
});
