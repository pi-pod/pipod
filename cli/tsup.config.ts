import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "ws"],
});
