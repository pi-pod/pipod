/**
 * `pipod secrets` and `pipod templates` through the real main() (§7, §8.5).
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { after, afterEach, before, describe, it } from "node:test";
import { main, reportError } from "../../src/cli.js";
import { secretsTestHooks } from "../../src/commands/secrets.js";
import { setColor } from "../../src/log.js";
import { FakeAccountServer } from "../support/fake-account-server.js";
import { writeFakeOp } from "../support/fake-op.js";
import { isolateHome } from "../support/repo-fixture.js";

setColor(false);

const HOME = isolateHome();
const savedCwd = process.cwd();
let server: FakeAccountServer;
let repo: string;

before(async () => {
  server = new FakeAccountServer({ permissions: ["secrets:org:write", "templates:write"] });
  await server.start();
  repo = fs.mkdtempSync(path.join(HOME.home, "repo-"));
  fs.mkdirSync(path.join(repo, ".pi-pod"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".pi-pod", "env"), "SHARED=from-project\nPROJECT_ONLY=1\n");
  process.chdir(repo);
  await capture(["login", "--server", server.url, "--token", "dev-jwt"]);
});

after(async () => {
  process.chdir(savedCwd);
  await server.stop();
  HOME.restore();
});

// `pipod secrets set` reads the value from piped stdin (argv never carries secrets). The
// suite has no TTY to pipe through, so it stubs the piped branch deterministically: a
// non-TTY stdin plus a substituted reader, restored after every test.
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
const defaultPipedReader = secretsTestHooks.readPipedStdin;
function pipeSecret(value: string): void {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = false;
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  secretsTestHooks.readPipedStdin = () => value;
}
afterEach(() => {
  Object.defineProperty(process, "stdin", realStdin);
  secretsTestHooks.readPipedStdin = defaultPipedReader;
});

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
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
    // The real entry point renders a thrown PiPodError and turns it into an exit code, so
    // asserting on codes here means asserting on what a user actually gets.
    try {
      return { code: await main(argv), out: chunks.join("") };
    } catch (e) {
      return { code: reportError(e), out: chunks.join("") };
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe("pipod secrets", () => {
  it("attributes each name to the layer that wins and names what it shadows", async () => {
    server.secrets["user/user-1"] = { SHARED: "from-user" };
    try {
      const r = await capture(["secrets"]);
      assert.equal(r.code, 0);
      assert.match(r.out, /SHARED\s+project/);
      assert.match(r.out, /shadows user/);
      assert.match(r.out, /PROJECT_ONLY\s+project/);
    } finally {
      delete server.secrets["user/user-1"];
    }
  });

  it("writes to the scope it is told and never guesses one", async () => {
    const bad = await capture(["secrets", "set", "org"]);
    assert.notEqual(bad.code, 0);

    pipeSecret("abc");
    const ok = await capture(["secrets", "set", "org", "ORG_KEY"]);
    assert.equal(ok.code, 0);
    assert.equal(server.secrets["org/org-1"]?.ORG_KEY, "abc");
  });

  it("refuses NAME=value: argv is visible to other processes", async () => {
    const r = await capture(["secrets", "set", "org", "ORG_ARGV_KEY=abc"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no longer accepts NAME=value/);
    assert.match(r.out, /pipod secrets set org ORG_ARGV_KEY < \/path\/to\/protected-value-file/);
    assert.equal(server.secrets["org/org-1"]?.ORG_ARGV_KEY, undefined);
  });

  it("errors when piped stdin is empty", async () => {
    pipeSecret("");
    const r = await capture(["secrets", "set", "org", "ORG_KEY"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no value for ORG_KEY on stdin/);
  });

  it("refuses an unknown scope and lists the real ones", async () => {
    const r = await capture(["secrets", "set", "global", "X"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /org, user, template, project/);
  });

  it("redirects the removed machine scope to its replacements", async () => {
    const r = await capture(["secrets", "set", "machine", "X"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /machine secret scope was removed/);
    assert.match(r.out, /secrets sync user/);
  });

  it("permanently refuses retired provider credentials in template scope", async () => {
    await capture(["templates", "create", "reserved-credential"]);
    try {
      pipeSecret("retired-control-plane-key");
      const r = await capture([
        "secrets",
        "set",
        "template/reserved-credential",
        "BOX_API_KEY",
      ]);
      assert.notEqual(r.code, 0);
      assert.match(r.out, /BOX_API_KEY is a provider credential and can never be stored/);
      const template = server.templates.find((entry) => entry.name === "reserved-credential");
      assert.ok(template);
      assert.equal(server.secrets[`template/${template.id}`]?.BOX_API_KEY, undefined);
    } finally {
      await capture(["templates", "rm", "reserved-credential", "--yes"]);
    }
  });

  it("warns when ~/.pi-pod/env still holds keys", async () => {
    const envFile = path.join(HOME.home, ".pi-pod", "env");
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, "LEFT_BEHIND=1\n");
    try {
      const r = await capture(["secrets"]);
      assert.equal(r.code, 0);
      assert.match(r.out, /no longer read/);
      assert.match(r.out, /LEFT_BEHIND/);
      assert.doesNotMatch(r.out, /LEFT_BEHIND\s+machine/);
    } finally {
      fs.rmSync(envFile, { force: true });
    }
  });

  it("warns when the value written is outranked by another layer", async () => {
    pipeSecret("from-org");
    const r = await capture(["secrets", "set", "org", "SHARED"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /still see SHARED from the project layer/);
  });

  it("writes and removes the project file layer in place", async () => {
    pipeSecret("42");
    const set = await capture(["secrets", "set", "project", "NEW_ONE"]);
    assert.equal(set.code, 0);
    const envFile = path.join(repo, ".pi-pod", "env");
    assert.match(fs.readFileSync(envFile, "utf8"), /^NEW_ONE=42$/m);
    assert.match(fs.readFileSync(envFile, "utf8"), /^PROJECT_ONLY=1$/m);

    const rm = await capture(["secrets", "rm", "project", "NEW_ONE"]);
    assert.equal(rm.code, 0);
    assert.doesNotMatch(fs.readFileSync(envFile, "utf8"), /NEW_ONE/);
  });

  it("addresses template secrets by template name", async () => {
    await capture(["templates", "create", "web-dev"]);
    pipeSecret("t");
    const r = await capture(["secrets", "set", "template/web-dev", "NPM_TOKEN"]);
    assert.equal(r.code, 0);
    assert.equal(server.secrets["template/tpl-1"]?.NPM_TOKEN, "t");
  });

  it("keeps project secret writes above the selected template", async () => {
    await capture(["templates", "create", "exclusive"]);
    const config = path.join(repo, ".pi-pod", "config.json");
    fs.writeFileSync(config, JSON.stringify({ template: "exclusive" }));
    try {
      pipeSecret("value");
      const r = await capture(["secrets", "set", "project", "IGNORED_LOCAL"]);
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.out, /ignore.*project secret scope/);
      const listed = await capture(["secrets"]);
      assert.match(listed.out, /IGNORED_LOCAL\s+project/);
    } finally {
      fs.rmSync(config, { force: true });
    }
  });
});

describe("pipod templates", () => {
  it("creates, shows, edits, and removes", async () => {
    const created = await capture(["templates", "create", "api-dev", "--description", "for services"]);
    assert.equal(created.code, 0);

    const list = await capture(["templates"]);
    assert.match(list.out, /api-dev/);
    assert.match(list.out, /for services/);

    const edited = await capture(["templates", "edit", "api-dev", "--description", "changed"]);
    assert.equal(edited.code, 0);

    const shown = await capture(["templates", "show", "api-dev"]);
    assert.match(shown.out, /changed/);

    const removed = await capture(["templates", "rm", "api-dev", "--yes"]);
    assert.equal(removed.code, 0);
    assert.equal(
      (await capture(["templates"])).out.includes("api-dev"),
      false,
    );
  });

  it("names the templates that exist when one is misspelled", async () => {
    const r = await capture(["templates", "show", "nope"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no template named "nope"/);
  });
});

describe("pipod secrets sync", () => {
  const savedPath = process.env.PATH;

  function useFakeOp(map: Record<string, string>): void {
    const op = writeFakeOp(HOME.home);
    process.env.PATH = `${path.dirname(op)}${path.delimiter}${savedPath ?? ""}`;
    process.env.FAKE_OP_MAP = JSON.stringify(map);
  }

  after(async () => {
    process.env.PATH = savedPath;
    delete process.env.FAKE_OP_MAP;
  });

  it("dry-run names what would be set and pruned without resolving", async () => {
    const dir = path.join(HOME.home, ".pi-pod", "secrets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "user.env"), "NEW_ONE=op://v/i/new\nKEEP=op://v/i/keep\n", { mode: 0o600 });
    server.secrets["user/user-1"] = { KEEP: "old", STALE: "gone" };

    const dry = await capture(["secrets", "sync", "user", "--dry-run", "--prune"]);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /would set 2 secret\(s\)/);
    assert.match(dry.out, /NEW_ONE/);
    assert.match(dry.out, /would prune 1 secret\(s\) not in the file: STALE/);
    assert.equal(server.secrets["user/user-1"]?.STALE, "gone");
    assert.equal(server.secrets["user/user-1"]?.NEW_ONE, undefined);
  });

  it("resolves refs, uploads them, and prunes stale names", async () => {
    useFakeOp({ "op://v/i/new": "resolved-new", "op://v/i/keep": "resolved-keep" });
    const dir = path.join(HOME.home, ".pi-pod", "secrets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "user.env"), "NEW_ONE=op://v/i/new\nKEEP=op://v/i/keep\n", { mode: 0o600 });
    server.secrets["user/user-1"] = { KEEP: "old", STALE: "gone" };

    const r = await capture(["secrets", "sync", "user", "--prune"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(server.secrets["user/user-1"]?.NEW_ONE, "resolved-new");
    assert.equal(server.secrets["user/user-1"]?.KEEP, "resolved-keep");
    assert.equal(server.secrets["user/user-1"]?.STALE, undefined);
    assert.doesNotMatch(r.out, /resolved-new|resolved-keep/);
  });

  it("resolves a ref on secrets set before it reaches the server", async () => {
    useFakeOp({ "op://v/i/set": "resolved-set" });
    pipeSecret("op://v/i/set");
    const r = await capture(["secrets", "set", "org", "FROM_REF"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(server.secrets["org/org-1"]?.FROM_REF, "resolved-set");
  });

  it("skips empty resolved values and provider credentials on a template", async () => {
    useFakeOp({ "op://v/i/empty": "", "op://v/i/ok": "ok" });
    await capture(["templates", "create", "sync-tpl"]);
    const file = path.join(HOME.home, "tpl.env");
    fs.writeFileSync(file, "DAYTONA_API_KEY=op://v/i/ok\nBOX_API_KEY=op://v/i/ok\nEMPTY=op://v/i/empty\nOK=op://v/i/ok\n");
    const r = await capture(["secrets", "sync", "template/sync-tpl", "--file", file]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /DAYTONA_API_KEY is a provider credential/);
    assert.match(r.out, /BOX_API_KEY is a provider credential/);
    assert.match(r.out, /skip empty field: EMPTY/);
    const stored = Object.values(server.secrets).find((scope) => scope.OK === "ok");
    assert.ok(stored, r.out);
    assert.equal(stored.DAYTONA_API_KEY, undefined);
    assert.equal(stored.BOX_API_KEY, undefined);
    assert.equal(stored.EMPTY, undefined);
  });
});
