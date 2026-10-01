/** Parse and dispatch integration through the account-only CLI entry point. */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { main, reportError } from "../../src/cli.js";
import { EXIT } from "../../src/errors.js";
import { setColor } from "../../src/log.js";
import { FakeAccountServer, fakePod } from "../support/fake-account-server.js";
import { isolateHome, makeTempDir, writeConfig, writeEnv } from "../support/repo-fixture.js";

setColor(false);

const HOME = isolateHome("pi-pod-cli-main-");
const savedCwd = process.cwd();
const authFile = path.join(HOME.home, ".pi-pod", "auth.json");
let server: FakeAccountServer;

before(async () => {
  server = new FakeAccountServer({
    pods: [fakePod({ id: "0198f5a0-0000-7000-8000-000000000099", name: "dispatch-pod", project: "dispatch" })],
  });
  await server.start();
});

after(async () => {
  process.chdir(savedCwd);
  await server.stop();
  HOME.restore();
});
afterEach(() => process.chdir(savedCwd));

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const sink = ((chunk: string | Uint8Array) => {
    if (typeof chunk !== "string") return origOut(chunk);
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  try {
    try {
      return { code: await main(argv), out: chunks.join("") };
    } catch (error) {
      return { code: reportError(error), out: chunks.join("") };
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

async function signIn(): Promise<void> {
  fs.rmSync(authFile, { force: true });
  const result = await capture(["login", "--server", server.url, "--token", "dispatch-token"]);
  assert.equal(result.code, EXIT.OK, result.out);
}

describe("help and version dispatch", () => {
  it("prints global and per-command help", async () => {
    const global = await capture(["--help"]);
    assert.equal(global.code, EXIT.OK);
    assert.match(global.out, /pipod \[options\]/);
    assert.match(global.out, /server-managed pods/);
    assert.match(global.out, /attach \[pod\].*\(a\)/);

    const attachAlias = await capture(["a", "--help"]);
    assert.equal(attachAlias.code, EXIT.OK);
    assert.match(attachAlias.out, /Usage: pipod attach/);
    assert.match(attachAlias.out, /Alias: a/);

    const command = await capture(["archive", "--help"]);
    assert.equal(command.code, EXIT.OK);
    assert.match(command.out, /Usage: pipod archive/);
    assert.match(command.out, /--all/);
    assert.match(command.out, /--template <name\|id>/);
    assert.match(command.out, /--idle <duration>/);
    assert.match(command.out, /--dry-run/);
    const fork = await capture(["fork", "--help"]);
    assert.equal(fork.code, EXIT.OK);
    assert.match(fork.out, /Usage: pipod fork/);
    assert.match(fork.out, /short ref \(p-…\)/);
    assert.match(command.out, /--all/);
  });

  it("prints version before account dispatch", async () => {
    fs.rmSync(authFile, { force: true });
    const result = await capture(["--version"]);
    assert.equal(result.code, EXIT.OK);
    assert.match(result.out, /pipod \d+\.\d+\.\d+/);
    assert.match(result.out, /node \d+/);
    assert.match(result.out, /pi /);
  });
});

describe("parse failures", () => {
  it("rejects an unknown command as usage", async () => {
    const result = await capture(["nonesuch"]);
    assert.equal(result.code, EXIT.USAGE);
    assert.match(result.out, /unknown pi pod command "nonesuch"/);
  });

  it("rejects an unknown flag instead of passing it to Pi", async () => {
    const result = await capture(["--nonesuch"]);
    assert.equal(result.code, EXIT.USAGE);
    assert.match(result.out, /unknown pi pod option "--nonesuch"/);
    assert.match(result.out, /Pi options after `--`/);
  });
});

describe("account dispatch", () => {
  it("hard-errors a signed-out bare launch before contacting the server", async () => {
    fs.rmSync(authFile, { force: true });
    const before = server.calls.length;
    const result = await capture([]);
    assert.notEqual(result.code, EXIT.OK);
    assert.match(result.out, /sign in required/i);
    assert.match(result.out, /pipod login/i);
    assert.equal(server.calls.length, before);
  });

  it("dispatches signed-in list through FakeAccountServer", async () => {
    await signIn();
    process.chdir(HOME.home);
    const before = server.calls.length;
    const result = await capture(["list", "--all"]);
    assert.equal(result.code, EXIT.OK, result.out);
    assert.match(result.out, /dispatch-pod/);
    assert.ok(server.calls.slice(before).some((entry) => entry.method === "GET" && entry.path === "/v1/pods"));
  });

  it("refuses retired launch-time flags as unknown options, before any request", async () => {
    await signIn();
    process.chdir(HOME.home);
    const before = server.calls.length;
    const result = await capture(["--dry-run", "--config", "missing.json"]);
    assert.equal(result.code, EXIT.USAGE, result.out);
    assert.match(result.out, /unknown pi pod option "--config"/);
    assert.match(result.out, /pass Pi options after `--`/);
    assert.equal(server.calls.length, before, "nothing was sent to the server");
  });

  it("dispatches a signed-in no-template launch dry-run without creating a pod", async () => {
    await signIn();
    const repo = makeTempDir("pi-pod-cli-dispatch-");
    writeConfig(repo, { name: "dispatch", idleTimeoutMinutes: 25 });
    writeEnv(repo, "PROJECT_TOKEN=not-printed\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".pi-pod/env\n");
    process.chdir(repo);

    const before = server.calls.length;
    const result = await capture(["--dry-run"]);
    assert.equal(result.code, EXIT.OK, result.out);
    assert.match(result.out, /account mode dry-run/);
    assert.match(result.out, /provider: sandbox/);
    assert.doesNotMatch(result.out, /not-printed/);

    const calls = server.calls.slice(before);
    const resolve = calls.filter((entry) => entry.path === "/v1/pods/resolve").at(-1);
    assert.ok(resolve);
    const body = resolve.body as { projectConfig?: Record<string, unknown>; projectEnv?: Record<string, string> };
    assert.equal(body.projectConfig?.["name"], "dispatch");
    assert.equal(body.projectConfig?.["provider"], undefined);
    assert.equal(body.projectEnv, undefined);
    assert.match(result.out, /.pi-pod\/env contains 1 entry/);
    assert.equal(calls.some((entry) => entry.method === "POST" && entry.path === "/v1/pods"), false);
  });
});
