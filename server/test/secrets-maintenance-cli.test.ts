import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/secrets-maintenance.ts", ...args], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, DATABASE_URL: "postgres://postgres@127.0.0.1:1/unused", MIGRATION_DATABASE_URL: "",
      SECRETS_KEK: randomBytes(32).toString("base64"), SECRETS_KEK_ID: "cli-test", SECRETS_KEK_PREVIOUS: "{}", ...extra },
  });
}

describe("secrets maintenance CLI safe failures", () => {
  it("prints help without requiring configuration", () => {
    const result = run(["--help"], { SECRETS_KEK: "" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /status[\s\S]*verify[\s\S]*migrate[\s\S]*rewrap/);
  });
  it("never serializes database errors or connection credentials", () => {
    const canary = "disposable-maintenance-dsn-canary";
    const result = run(["status"], { MIGRATION_DATABASE_URL: `not-a-database-url-${canary}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /secrets maintenance failed/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(canary));
    assert.ok(!result.stderr.includes("\n    at "));
  });
  it("never serializes invalid key values", () => {
    const canary = "disposable-maintenance-key-canary";
    const result = run(["verify"], { MIGRATION_DATABASE_URL: "postgres://postgres@127.0.0.1:1/unused", SECRETS_KEK: canary });
    assert.equal(result.status, 2);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(canary));
    assert.match(result.stderr, /invalid KEK configuration/);
  });
});
