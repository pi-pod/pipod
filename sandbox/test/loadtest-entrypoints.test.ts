import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("both load entrypoints refuse absent and empty owner input before network", () => {
  const entrypoints = [
    [fileURLToPath(new URL("../scripts/loadtest.mjs", import.meta.url))],
    [fileURLToPath(new URL("../scripts/loadtest/lt.mjs", import.meta.url)), "stat"],
  ];
  for (const argv of entrypoints) {
    for (const value of [undefined, ""]) {
      const env = { PATH: process.env.PATH, PI_POD_SANDBOX_TOKEN: "synthetic-token" };
      if (value !== undefined) Object.assign(env, { LT_OWNER_KEY: value });
      const result = spawnSync(process.execPath, argv, { env, encoding: "utf8", timeout: 5_000 });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /LT_OWNER_KEY must match owner\.userKey/);
      assert.equal(result.stdout, "");
    }
  }
});

