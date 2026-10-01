/** Account-only CLI behavior through the real `main()` with a fake control plane. */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { main, reportError } from "../../src/cli.js";
import { EXIT } from "../../src/errors.js";
import { setColor } from "../../src/log.js";
import { FakeAccountServer, fakePod } from "../support/fake-account-server.js";
import { gitignore, initRepo, isolateHome, makeTempDir, serveBareRepo, writeConfig, writeEnv } from "../support/repo-fixture.js";

setColor(false);

const HOME = isolateHome();
const savedCwd = process.cwd();
const authFile = path.join(HOME.home, ".pi-pod", "auth.json");
let server: FakeAccountServer;

before(async () => {
  server = new FakeAccountServer({
    pods: [
      fakePod({ id: "0198f5a0-0000-7000-8000-00000000000a", name: "fix-auth", project: "repo" }),
      fakePod({
        id: "0198f5a0-0000-7000-8000-00000000000b",
        name: "release-notes",
        project: "other",
        state: "archived",
      }),
      fakePod({
        id: "0198f5a0-0000-7000-8000-00000000000c",
        name: "docs-site",
        project: "docs",
        templateId: "tpl-1",
      }),
    ],
  });
  server.templates = [
    {
      id: "tpl-1",
      name: "web",
      description: null,
      status: "active",
      scope: "org",
      initScript: null,
      config: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "tpl-2",
      name: "unused",
      description: null,
      status: "active",
      scope: "org",
      initScript: null,
      config: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
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

function signOut(): void {
  fs.rmSync(authFile, { force: true });
}

async function signIn(): Promise<void> {
  signOut();
  const result = await capture(["login", "--server", server.url, "--token", "dev-jwt"]);
  assert.equal(result.code, 0, result.out);
  assert.ok(fs.existsSync(authFile));
}

describe("signed-out command allowlist", () => {
  it("allows login, whoami, init, doctor, update help, help, and version without auth.json", async () => {
    signOut();

    const whoami = await capture(["whoami"]);
    assert.equal(whoami.code, 1);
    assert.match(whoami.out, /not signed in|sign in/i);

    const doctor = await capture(["doctor"]);
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, /not signed in|sign in/i);

    const dir = makeTempDir("pi-pod-unsigned-init-");
    process.chdir(dir);
    const init = await capture(["init"]);
    assert.equal(init.code, 0, init.out);
    assert.ok(fs.existsSync(path.join(dir, ".pi-pod", "config.json")));
    process.chdir(savedCwd);

    for (const argv of [["update", "--help"], ["--help"], ["--version"]]) {
      const result = await capture(argv);
      assert.equal(result.code, 0, `${argv.join(" ")}: ${result.out}`);
    }

    const login = await capture(["login", "--server", server.url, "--token", "dev-jwt"]);
    assert.equal(login.code, 0, login.out);
    assert.match(login.out, /signed in .* as dev@example\.com/);
    signOut();
  });

  it("blocks every pod/account operation and bare launch with the sign-in fix", async () => {
    signOut();
    const blocked = [
      ["list"],
      ["attach"],
      ["archive", "pod"],
      ["restore", "pod"],
      ["gc"],
      ["send", "pod", "file"],
      ["receive", "pod", "file"],
      ["rename", "pod", "name"],
      ["fork", "pod"],
      ["jobs"],
      ["credentials"],
      ["secrets"],
      ["templates"],
      [],
    ];
    for (const argv of blocked) {
      const result = await capture(argv);
      assert.notEqual(result.code, 0, argv.length ? argv.join(" ") : "bare launch");
      assert.match(result.out, /sign in/i, `${argv.join(" ")}\n${result.out}`);
      assert.match(result.out, /pipod login/i, `${argv.join(" ")}\n${result.out}`);
    }
  });

  it("fails closed on corrupt auth.json and never resolves or launches", async () => {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, "{ definitely-not-json\n");
    const before = server.calls.length;
    const result = await capture([]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /sign in/i);
    assert.match(result.out, /pipod login/i);
    assert.equal(server.calls.length, before, "corrupt local auth must not reach the launch API");
    signOut();
  });
});

describe("signed-in account CLI", () => {
  it("stores login, reports whoami, and lists through FakeAccountServer", async () => {
    await signIn();
    const auth = JSON.parse(fs.readFileSync(authFile, "utf8")) as { orgId: string; accessToken: string };
    assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
    assert.equal(auth.orgId, "org-1");
    assert.equal(auth.accessToken, "dev-jwt");

    const whoami = await capture(["whoami"]);
    assert.equal(whoami.code, 0, whoami.out);
    assert.match(whoami.out, /dev@example\.com/);

    process.chdir(HOME.home);
    const list = await capture(["list", "--archived"]);
    assert.equal(list.code, 0, list.out);
    assert.match(list.out, /fix-auth \(repo\)/);
    assert.match(list.out, /release-notes \(other\)/);
    assert.match(list.out, /p-000000000a/);
    assert.match(list.out, /p-000000000b/);
    assert.doesNotMatch(list.out, /\b0198f5a0\b/);
  });

  it("filters list by server-side template identity", async () => {
    await signIn();
    process.chdir(HOME.home);
    const before = server.calls.length;
    const result = await capture(["list", "--template", "web"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /pods from template web/);
    assert.match(result.out, /docs-site/);
    assert.doesNotMatch(result.out, /fix-auth/);
    const call = server.calls.slice(before).find((entry) => entry.path === "/v1/pods");
    assert.match(call?.search ?? "", /templateId=tpl-1/);
  });

  it("uses the current project's configured template as the default list scope", async () => {
    await signIn();
    const project = makeTempDir("pi-pod-list-template-");
    try {
      writeConfig(project, { name: "unrelated-project-name", template: "web" });
      process.chdir(project);

      const before = server.calls.length;
      const result = await capture(["ls"]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /pods from template web/);
      assert.match(result.out, /docs-site/);
      assert.doesNotMatch(result.out, /fix-auth/);
      const call = server.calls.slice(before).find((entry) => entry.path === "/v1/pods");
      assert.match(call?.search ?? "", /templateId=tpl-1/);

      const allBefore = server.calls.length;
      const all = await capture(["ls", "--all"]);
      assert.equal(all.code, 0, all.out);
      assert.match(all.out, /fix-auth/);
      assert.match(all.out, /docs-site/);
      const allCall = server.calls.slice(allBefore).find((entry) => entry.path === "/v1/pods");
      assert.doesNotMatch(allCall?.search ?? "", /templateId=/);
    } finally {
      process.chdir(HOME.home);
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("forks by posting forkFrom for the resolved source pod", async () => {
    await signIn();
    process.chdir(HOME.home);
    const id = "0198f5a0-0000-7000-8000-00000000000a";
    const before = server.calls.length;
    const result = await capture(["fork", id, "--dry-run"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /fork from/);
    const resolve = server.calls.slice(before).find((entry) => entry.path === "/v1/pods/resolve");
    assert.deepEqual((resolve?.body as { forkFrom?: unknown }).forkFrom, { podId: id });
    assert.equal(
      server.calls.slice(before).some((entry) => entry.method === "POST" && entry.path === "/v1/pods"),
      false,
    );
  });

  it("dispatches archive, restore, rename, and gc through the account server", async () => {
    await signIn();
    const id = "0198f5a0-0000-7000-8000-00000000000a";
    const ambiguous = await capture(["archive", "0198f5a0"]);
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.out, /matches 3 pods/);
    assert.match(ambiguous.out, /p-000000000a.*fix-auth.*active/);
    assert.match(ambiguous.out, /p-000000000b.*release-notes.*archived/);

    const archived = await capture(["archive", "p-000000000a"]);
    assert.equal(archived.code, 0, archived.out);
    assert.match(
      archived.out,
      /archived p-000000000a: hidden from `pipod list`, files kept; `pipod restore p-000000000a` brings it back/,
    );
    const restored = await capture(["restore", "000000000a"]);
    assert.equal(restored.code, 0, restored.out);
    assert.match(restored.out, /restored p-000000000a \(active\)/);
    assert.equal((await capture(["rename", id, "fixer"])).code, 0);
    assert.equal((await capture(["gc"])).code, 0);
    assert.ok(server.calls.some((entry) => entry.method === "POST" && entry.path.endsWith("/archive")));
    assert.ok(server.calls.some((entry) => entry.method === "POST" && entry.path.endsWith("/restore")));
    assert.ok(server.calls.some((entry) => entry.method === "PATCH" && entry.path.includes("/pods/")));
  });

  it("resolves a full UUID by fetching the pod rather than listing", async () => {
    await signIn();
    process.chdir(HOME.home);
    const id = "0198f5a0-0000-7000-8000-00000000000c";
    const before = server.calls.length;
    const dry = await capture(["archive", id, "--dry-run"]);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /docs-site/);
    assert.match(dry.out, /would archive 1 pod\(s\)/);
    const calls = server.calls.slice(before);
    assert.ok(calls.some((entry) => entry.method === "GET" && entry.path === `/v1/pods/${id}`));
    assert.equal(calls.some((entry) => entry.path === "/v1/pods"), false, "an exact id skips the listing");
    assert.equal(calls.some((entry) => entry.method === "POST" && entry.path.endsWith("/archive")), false);

    const disposable = fakePod({
      id: "0198f5a0-0000-7000-8000-00000000001d",
      name: "disposable-uuid",
      project: null,
      templateId: "tpl-1",
    });
    server.pods.push(disposable);
    try {
      const live = await capture(["archive", disposable.id]);
      assert.equal(live.code, 0, live.out);
      assert.ok(server.calls.some((entry) => entry.method === "POST" && entry.path === `/v1/pods/${disposable.id}/archive`));
      assert.equal(disposable.state, "archived");
    } finally {
      server.pods = server.pods.filter((pod) => pod.id !== disposable.id);
    }
  });

  it("archives by template and idle time, with a dry-run that posts nothing", async () => {
    await signIn();
    process.chdir(HOME.home);
    const stale = fakePod({
      id: "0198f5a0-0000-7000-8000-00000000001e",
      name: "stale-web",
      project: null,
      templateId: "tpl-1",
      lastActivityAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    server.pods.push(stale);
    try {
      const before = server.calls.length;
      const dry = await capture(["archive", "--template", "web", "--idle", "4h", "--dry-run"]);
      assert.equal(dry.code, 0, dry.out);
      assert.match(dry.out, /p-000000001e.*stale-web/);
      assert.doesNotMatch(dry.out, /docs-site|fix-auth/);
      assert.match(dry.out, /would archive 1 pod\(s\)/);
      assert.equal(
        server.calls.slice(before).some((entry) => entry.method === "POST" && entry.path.endsWith("/archive")),
        false,
      );

      const mixed = await capture(["archive", "--idle", "4h", "--template", "web", "p-000000001e"]);
      assert.notEqual(mixed.code, 0);
      assert.match(mixed.out, /cannot be combined with pod ids/);
      for (const bad of ["0h", "4"]) {
        const invalid = await capture(["archive", "--idle", bad]);
        assert.equal(invalid.code, EXIT.USAGE, invalid.out);
        assert.match(invalid.out, /invalid --idle duration/);
      }
      assert.equal(stale.state, "active", "nothing so far archived it");

      const live = await capture(["archive", "--template", "web", "--idle", "4h", "--yes"]);
      assert.equal(live.code, 0, live.out);
      assert.match(live.out, /archived p-000000001e/);
      const archives = server.calls
        .slice(before)
        .filter((entry) => entry.method === "POST" && entry.path.endsWith("/archive"))
        .map((entry) => entry.path);
      assert.deepEqual(archives, [`/v1/pods/${stale.id}/archive`]);
      assert.equal(server.pods.find((pod) => pod.name === "docs-site")?.state, "active");

      const empty = await capture(["archive", "--template", "web", "--idle", "4h"]);
      assert.equal(empty.code, 0, empty.out);
      assert.match(empty.out, /no pods from template web idle longer than 4h/);
    } finally {
      server.pods = server.pods.filter((pod) => pod.id !== stale.id);
    }
  });

  it("runs doctor and init while signed in", async () => {
    await signIn();
    const dir = makeTempDir("pi-pod-signed-tools-");
    process.chdir(dir);

    const doctor = await capture(["doctor"]);
    assert.equal(doctor.code, 0, doctor.out);
    assert.match(doctor.out, /server: reachable/);
    assert.match(doctor.out, /account checks passed/);
    assert.ok(server.calls.some((entry) => entry.path === "/v1/version"));
    assert.ok(server.calls.some((entry) => entry.path === "/v1/pods/resolve"));

    const init = await capture(["init"]);
    assert.equal(init.code, 0, init.out);
    assert.ok(fs.existsSync(path.join(dir, ".pi-pod", "config.json")));
    assert.ok(fs.existsSync(authFile), "init must not disturb the signed-in account");
  });

  it("dry-runs a source-less account launch and creates no pod", async () => {
    await signIn();
    process.chdir(HOME.home);
    const before = server.calls.length;
    const result = await capture(["--dry-run"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /template: none/);
    const calls = server.calls.slice(before);
    assert.deepEqual(calls.find((entry) => entry.path === "/v1/pods/resolve")?.body, {});
    assert.equal(calls.some((entry) => entry.path === "/v1/pods"), false);
  });

  it("uses project config only for bootstrap preview and launches with no local layer", async () => {
    await signIn();
    const repo = makeTempDir("pi-pod-overlay-launch-");
    writeConfig(repo, { name: "overlay-project", idleTimeoutMinutes: 21 });
    writeEnv(repo, "PROJECT_SECRET=project-value\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".pi-pod/env\n");
    fs.writeFileSync(path.join(repo, ".pi-pod", "init.sh"), "echo project-init\n");
    fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ theme: "project-theme" }));

    const machine = path.join(HOME.home, ".pi-pod");
    fs.mkdirSync(machine, { recursive: true });
    fs.writeFileSync(path.join(machine, "config.json"), JSON.stringify({ archiveAfterMinutes: 75 }));
    const userPi = path.join(HOME.home, ".pi", "agent");
    fs.mkdirSync(userPi, { recursive: true });
    fs.writeFileSync(path.join(userPi, "settings.json"), JSON.stringify({ theme: "machine-theme" }));

    process.chdir(repo);
    const before = server.calls.length;
    const result = await capture([]);
    assert.equal(result.code, 0, result.out);
    const calls = server.calls.slice(before);
    assert.match(result.out, /.pi-pod\/env contains 1 entry/);
    const resolveCalls = calls.filter((entry) => entry.path === "/v1/pods/resolve");
    const resolveBodies = resolveCalls.map((entry) => entry.body as Record<string, unknown>);
    assert.deepEqual(resolveBodies[0]?.["projectConfig"], { name: "overlay-project", idleTimeoutMinutes: 21 });
    assert.ok(resolveBodies.slice(1).every((body) => body["projectConfig"] === undefined));
    assert.ok(resolveBodies.every((body) => body["projectEnv"] === undefined && body["piSettings"] === undefined));

    const launch = calls.find(
      (entry) => entry.method === "POST" && entry.path === "/v1/pods",
    )?.body as Record<string, unknown>;
    assert.deepEqual(launch, { project: { name: "overlay-project" } }, "the project names the pod; nothing else travels");
  });

  it("sends only template selection and invocation flags for a pinned-template launch", async () => {
    await signIn();
    const repo = makeTempDir("pi-pod-template-launch-");
    writeConfig(repo, { name: "pinned", template: "web", idleTimeoutMinutes: 21 });
    writeEnv(repo, "PROJECT_SECRET=not-a-launch-input\n");
    fs.writeFileSync(path.join(repo, ".pi-pod", "init.sh"), "echo not-sent\n");
    fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ theme: "not-sent" }));

    process.chdir(repo);
    const before = server.calls.length;
    const result = await capture([]);
    assert.equal(result.code, 0, result.out);
    const calls = server.calls.slice(before);
    const resolves = calls.filter((entry) => entry.path === "/v1/pods/resolve");
    assert.ok(resolves.length > 0);
    for (const resolve of resolves) {
      assert.deepEqual(resolve.body, { templateId: "tpl-1" });
    }
    const launch = calls.find((entry) => entry.method === "POST" && entry.path === "/v1/pods")?.body;
    assert.deepEqual((launch as Record<string, unknown>), { templateId: "tpl-1", project: { name: "pinned" } });
  });

  it("rejects the retired --provider flag instead of launching", async () => {
    await signIn();
    const result = await capture(["--provider", "sandbox"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown pi pod option "--provider"/);
  });

  it("copies the working directory into a fresh pod when the project has no init script", async () => {
    await signIn();
    const repo = initRepo();
    writeConfig(repo.dir, { name: "seed-copy" });
    writeEnv(repo.dir, "PROJECT_SECRET=project-value\n");
    gitignore(repo.dir, [".pi-pod/env", "build/"]);
    repo.write("src/app.ts", "export const x = 1;\n");
    repo.write("build/out.js", "generated\n");
    repo.write("node_modules/left-pad/index.js", "module.exports = 1;\n");

    process.chdir(repo.dir);
    const before = server.calls.length;
    try {
      const result = await capture([]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /copied into the pod \(no origin remote\)/);
      assert.match(result.out, /workspace seeded/);

      const calls = server.calls.slice(before);
      const launch = calls.find((entry) => entry.method === "POST" && entry.path === "/v1/pods")?.body as Record<string, unknown>;
      assert.deepEqual(launch, { project: { name: "seed-copy" } }, "workspace transport is not a settings layer");

      const send = calls.find((entry) => entry.method === "POST" && /\/files$/.test(entry.path));
      assert.ok(send, "the launch must send the workspace to the pod it created");
      const paths = (send.body as { entries: Array<{ relPath: string }> }).entries.map((entry) => entry.relPath);
      assert.ok(paths.includes("src/app.ts"), paths.join(" "));
      assert.ok(paths.includes(".pi-pod/config.json"));
      assert.ok(paths.includes(".gitignore"));
      for (const excluded of [".pi-pod/env", "build/out.js", "node_modules/left-pad/index.js"]) {
        assert.equal(paths.some((relPath) => relPath.startsWith(excluded.split("/")[0]!) && relPath === excluded), false, excluded);
      }
      assert.equal(paths.some((relPath) => relPath === ".git" || relPath.startsWith(".git/")), false, "never send the git directory");
    } finally {
      repo.cleanup();
    }
  });

  it("copies a cloneable checkout without adding generated init/env to the launch", async () => {
    await signIn();
    const remote = initRepo({ bare: true });
    const repo = initRepo();
    const serving = await serveBareRepo(remote.dir);
    try {
      writeConfig(repo.dir, { name: "seed-clone" });
      repo.write("src/app.ts", "export const x = 1;\n");
      repo.commit("initial");
      repo.git("remote", "add", "origin", remote.dir);
      repo.git("push", "-u", "origin", "main");
      serving.refresh();
      repo.git("remote", "set-url", "origin", serving.url);

      process.chdir(repo.dir);
      const before = server.calls.length;
      const result = await capture([]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, new RegExp(`copied into the pod \\(cloneable from ${serving.url} at main\\)`));

      const calls = server.calls.slice(before);
      const launch = calls.find((entry) => entry.method === "POST" && entry.path === "/v1/pods")?.body as Record<string, unknown>;
      assert.deepEqual(launch, { project: { name: "seed-clone" } });
      assert.equal(calls.some((entry) => /\/files$/.test(entry.path)), true);
    } finally {
      await serving.close();
      repo.cleanup();
      remote.cleanup();
    }
  });

  it("leaves a reused pod's warm workspace alone", async () => {
    await signIn();
    const repo = initRepo();
    writeConfig(repo.dir, { name: "seed-reuse" });
    repo.write("src/app.ts", "export const x = 1;\n");
    const stopped = fakePod({
      id: "0198f5a0-0000-7000-8000-0000000000d1",
      name: "seed-reuse",
      project: "seed-reuse",
      ready: false,
      initializing: false,
    });
    server.pods.push(stopped);

    process.chdir(repo.dir);
    const before = server.calls.length;
    try {
      const result = await capture(["--reuse"]);
      assert.equal(result.code, 0, result.out);
      const calls = server.calls.slice(before);
      assert.ok(calls.some((entry) => entry.path.endsWith(`/pods/${stopped.id}/reuse`)), "the stopped pod must be reused");
      assert.equal(calls.some((entry) => /\/files$/.test(entry.path)), false, "a warm disk keeps its own workspace");
    } finally {
      server.pods = server.pods.filter((pod) => pod.id !== stopped.id);
      repo.cleanup();
    }
  });

  it("seeds nothing when forking, which copies the conversation and not the workspace", async () => {
    await signIn();
    const repo = initRepo();
    writeConfig(repo.dir, { name: "seed-fork" });
    repo.write("src/app.ts", "export const x = 1;\n");

    process.chdir(repo.dir);
    const before = server.calls.length;
    try {
      const result = await capture(["fork", "0198f5a0-0000-7000-8000-00000000000a"]);
      assert.equal(result.code, 0, result.out);
      assert.doesNotMatch(result.out, /copied into the pod|will clone/);
      const calls = server.calls.slice(before);
      const launch = calls.find((entry) => entry.method === "POST" && entry.path === "/v1/pods")?.body as Record<string, unknown>;
      assert.equal(launch["project"], undefined);
      assert.equal(calls.some((entry) => /\/files$/.test(entry.path)), false);
    } finally {
      repo.cleanup();
    }
  });

  it("logout removes auth and makes whoami/list/attach signed-out operations", async () => {
    await signIn();
    const logout = await capture(["logout"]);
    assert.equal(logout.code, 0, logout.out);
    assert.match(logout.out, /signed out of .*; sign back in with `pipod login --server /i);
    assert.equal(fs.existsSync(authFile), false);

    const whoami = await capture(["whoami"]);
    assert.equal(whoami.code, 1);
    assert.match(whoami.out, /not signed in/i);
    for (const argv of [["list"], ["attach"]]) {
      const result = await capture(argv);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /sign in/i);
      assert.match(result.out, /pipod login/i);
    }
  });

  it("deletes a legacy refresh session that strict auth parsing rejects", async () => {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        serverUrl: server.url,
        accessToken: "legacy-access",
        refreshToken: "legacy-refresh",
        user: { id: "u1", email: "legacy@example.com" },
        orgId: "org-1",
      }),
      { mode: 0o600 },
    );
    const logout = await capture(["logout"]);
    assert.equal(logout.code, 0, logout.out);
    assert.match(logout.out, /unsupported local session was removed/);
    assert.equal(fs.existsSync(authFile), false);
  });

  it("never prints the logout URL's ID token hint", async () => {
    const issuer = "https://auth.example";
    const idToken = "secret-id-token-hint";
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        serverUrl: server.url,
        accessToken: "access",
        refreshToken: "refresh",
        idToken,
        issuer,
        clientId: "pipod-cli",
        user: { id: "u1", email: "dev@example.com" },
        orgId: "org-1",
      }),
      { mode: 0o600 },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/certs`,
          revocation_endpoint: `${issuer}/revoke`,
          end_session_endpoint: `${issuer}/logout`,
        });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const logout = await capture(["logout"]);
      assert.equal(logout.code, 0, logout.out);
      assert.match(logout.out, /https:\/\/auth\.example\/logout/);
      assert.doesNotMatch(logout.out, /id_token_hint|secret-id-token-hint/);
      assert.equal(fs.existsSync(authFile), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
