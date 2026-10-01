import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { HttpError } from "../src/server/httperrors.js";
import type { ResolvedConfigReport } from "../src/server/pods/types.js";
import {
  DEFAULT_WORKSPACE_ARCHIVE_LIMITS,
  SEED_RATE_MAX_BYTES,
  SEED_RATE_MAX_REQUESTS,
  SEED_RATE_WINDOW_MS,
  WORKSPACE_EMPTY_IGNORED,
  WORKSPACE_SEED_GATE_TIMEOUT_MS,
  WorkspaceCloneBody,
  archiveAuditDetail,
  assertCloneHostAllowed,
  assertWorkspaceSeedRateLimit,
  cloneAuditDetail,
  decodeWorkspaceArchiveResult,
  decodeWorkspaceCloneResult,
  decodeWorkspaceEmptyCheck,
  parseCloneUrl,
  redactCredential,
  resetWorkspaceSeedRateLimits,
  spoolArchiveToTempFile,
  workspaceArchiveExtractSource,
  workspaceArchiveLimits,
  workspaceCloneSource,
  workspaceEmptyCheckSource,
  workspaceNotEmptyError,
  workspaceSeedGateOpen,
} from "../src/server/pods/workspace-seed.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(64);

function httpError(status: number, message?: RegExp | string) {
  return (error: unknown) => {
    if (!(error instanceof HttpError) || error.statusCode !== status) return false;
    if (message === undefined) return true;
    return typeof message === "string" ? error.message === message : message.test(error.message);
  };
}

function runPython(source: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("python3", ["-c", source, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      ...env,
    },
  });
}

function git(cwd: string, args: string[]) {
  const result = spawnSync(
    "git",
    ["-c", "init.defaultBranch=main", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.editor=true", ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function mkTmp(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function cloneReport(mode: "open" | "allowlist", allow: string[]): Pick<ResolvedConfigReport, "config" | "egress"> {
  return {
    config: { egress: { mode, builtins: true, allow } } as ResolvedConfigReport["config"],
    egress: { mode, description: mode },
  };
}

function craftArchive(dest: string, script: string, extraArgv: string[] = []): void {
  const result = spawnSync("python3", ["-c", script, dest, ...extraArgv], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "craftArchive failed");
}

function runExtract(
  workdir: string,
  archive: string,
  staging: string,
  opts: { maxUncompressed?: number; maxEntries?: number; allowSymlinks?: boolean } = {},
) {
  return runPython(workspaceArchiveExtractSource(), [
    workdir,
    archive,
    staging,
    String(opts.maxUncompressed ?? 10 * 1024 * 1024),
    String(opts.maxEntries ?? 10_000),
    opts.allowSymlinks === false ? "0" : "1",
  ]);
}

function lastJson(output: string): Record<string, unknown> {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  throw new Error(`no json in output: ${output}`);
}

describe("workspace archive limits", () => {
  it("exports the documented defaults and falls back when env keys are undefined", () => {
    assert.equal(DEFAULT_WORKSPACE_ARCHIVE_LIMITS.maxCompressedBytes, 256 * 1024 * 1024);
    assert.equal(DEFAULT_WORKSPACE_ARCHIVE_LIMITS.maxUncompressedBytes, 2 * 1024 * 1024 * 1024);
    assert.equal(DEFAULT_WORKSPACE_ARCHIVE_LIMITS.maxEntries, 200_000);
    assert.deepEqual(workspaceArchiveLimits({}), DEFAULT_WORKSPACE_ARCHIVE_LIMITS);
    assert.equal(workspaceArchiveLimits({ WORKSPACE_ARCHIVE_MAX_ENTRIES: 12 }).maxEntries, 12);
  });
});

describe("WorkspaceCloneBody schema and parseCloneUrl", () => {
  const valid = { url: "https://github.com/org/repo", branch: "main", commit: SHA };

  it("accepts https hostnames, feature branches, 40/64-char shas, and optional credentials", () => {
    assert.equal(WorkspaceCloneBody.safeParse(valid).success, true);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, branch: "feature/foo" }).success, true);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, commit: SHA2 }).success, true);
    assert.equal(
      WorkspaceCloneBody.safeParse({
        ...valid,
        credential: { username: "user", password: "pass" },
      }).success,
      true,
    );
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://github.com/org/repo   " }).success, true);
    assert.deepEqual(parseCloneUrl("https://GitHub.com:443/Org/Repo.git  "), {
      host: "github.com",
      url: "https://GitHub.com:443/Org/Repo.git",
    });
  });

  it("rejects http, userinfo, query, fragment, IP hosts, empty path, and extra keys", () => {
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "http://github.com/org/repo" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://user:pass@github.com/org/repo" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://user@github.com/org/repo" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://github.com/org/repo?q=1" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://github.com/org/repo#frag" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://1.2.3.4/org/repo" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://127.0.0.1/org/repo" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://[::1]/org/repo" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://github.com" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, url: "https://github.com/" }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, extra: true }).success, false);
    assert.throws(() => parseCloneUrl("http://github.com/org/repo"), httpError(400));
    assert.throws(() => parseCloneUrl("https://1.2.3.4/org/repo"), httpError(400));
  });

  it("rejects unsafe branch names and non-lowercase shas", () => {
    const badBranches = [
      "-main",
      "/main",
      "refs/heads/main",
      "foo..bar",
      "foo@{bar",
      "foo\\bar",
      "foo bar",
      "foo~1",
      "foo^2",
      "foo:bar",
      "foo?",
      "foo*",
      "foo[bar",
      "main/",
      "main.lock",
      "main.",
      "foo\nbar",
    ];
    for (const branch of badBranches) {
      assert.equal(WorkspaceCloneBody.safeParse({ ...valid, branch }).success, false, branch);
    }
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, commit: "A".repeat(40) }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, commit: "a".repeat(39) }).success, false);
    assert.equal(WorkspaceCloneBody.safeParse({ ...valid, commit: "a".repeat(41) }).success, false);
  });
});

describe("assertCloneHostAllowed", () => {
  it("is a no-op in open mode and allows listed and wildcard hosts", () => {
    assertCloneHostAllowed(cloneReport("open", []), "evil.example");
    assertCloneHostAllowed(cloneReport("allowlist", ["github.com"]), "github.com");
    assertCloneHostAllowed(cloneReport("allowlist", ["*.example.com"]), "api.example.com");
    assertCloneHostAllowed(cloneReport("allowlist", ["*.example.com"]), "example.com");
  });

  it("throws 403 when allowlist mode refuses the host", () => {
    assert.throws(
      () => assertCloneHostAllowed(cloneReport("allowlist", ["github.com"]), "evil.example"),
      httpError(403),
    );
  });
});

describe("redactCredential", () => {
  it("redacts password, long usernames, url-encoding, and basic-auth base64", () => {
    const credential = { username: "user", password: "p@ss word" };
    const encodedPass = encodeURIComponent(credential.password);
    const basic = Buffer.from("user:p@ss word", "utf8").toString("base64");
    const text = `user ${credential.password} ${encodedPass} ${basic} leftover`;
    assert.equal(redactCredential(text, credential), "[redacted] [redacted] [redacted] [redacted] leftover");
  });

  it("does not redact usernames shorter than 4 characters and is a no-op without a credential", () => {
    const credential = { username: "ab", password: "secret" };
    assert.equal(redactCredential("ab secret ab", credential), "ab [redacted] ab");
    assert.equal(redactCredential("unchanged", undefined), "unchanged");
    assert.equal(redactCredential("unchanged", null), "unchanged");
  });
});

describe("workspace seed rate limit", () => {
  it("rejects the 11th request, the bytes cap, and recovers after reset or window expiry", () => {
    resetWorkspaceSeedRateLimits();
    for (let i = 0; i < SEED_RATE_MAX_REQUESTS; i += 1) assertWorkspaceSeedRateLimit("tok", 0);
    assert.throws(() => assertWorkspaceSeedRateLimit("tok", 0), httpError(429));
    resetWorkspaceSeedRateLimits();
    assert.throws(() => assertWorkspaceSeedRateLimit("tok", SEED_RATE_MAX_BYTES + 1), httpError(429));
    resetWorkspaceSeedRateLimits();
    assertWorkspaceSeedRateLimit("tok", 1);
    resetWorkspaceSeedRateLimits();
    const t0 = 1_000_000;
    for (let i = 0; i < SEED_RATE_MAX_REQUESTS; i += 1) assertWorkspaceSeedRateLimit("win", 0, t0);
    assert.throws(() => assertWorkspaceSeedRateLimit("win", 0, t0), httpError(429));
    assertWorkspaceSeedRateLimit("win", 0, t0 + SEED_RATE_WINDOW_MS);
  });
});

describe("spoolArchiveToTempFile", () => {
  it("writes a 0600 gzip file, counts bytes, and cleans up idempotently", async () => {
    const gz = gzipSync(Buffer.from("hello-archive"));
    const spooled = await spoolArchiveToTempFile(Readable.from([gz]), { maxCompressedBytes: 10_000 });
    try {
      assert.equal(spooled.bytes, gz.length);
      assert.equal(fs.statSync(spooled.path).mode & 0o777, 0o600);
      assert.ok(path.basename(spooled.path).startsWith("pi-pod-archive-"));
      assert.ok(spooled.path.endsWith(".tgz"));
    } finally {
      await spooled.cleanup();
      await spooled.cleanup();
      assert.equal(fs.existsSync(spooled.path), false);
    }
  });

  it("throws 413 on overflow and leaves no temp file", async () => {
    const gz = gzipSync(Buffer.from("hello-archive".repeat(50)));
    assert.ok(gz.length > 20);
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-")));
    await assert.rejects(
      () => spoolArchiveToTempFile(Readable.from([gz]), { maxCompressedBytes: 20 }),
      httpError(413),
    );
    const leftover = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-") && !before.has(name));
    assert.deepEqual(leftover, []);
  });

  it("throws 413 on declaredLength before reading", async () => {
    let read = false;
    const source = new Readable({
      read() {
        read = true;
        this.push(gzipSync(Buffer.from("x")));
        this.push(null);
      },
    });
    await assert.rejects(
      () => spoolArchiveToTempFile(source, { maxCompressedBytes: 10, declaredLength: 11 }),
      httpError(413),
    );
    assert.equal(read, false);
  });

  it("rejects non-gzip and empty bodies with 400", async () => {
    await assert.rejects(
      () => spoolArchiveToTempFile(Readable.from([Buffer.from("not-gzip")]), { maxCompressedBytes: 1000 }),
      httpError(400, /not gzip/),
    );
    await assert.rejects(
      () => spoolArchiveToTempFile(Readable.from([]), { maxCompressedBytes: 1000 }),
      httpError(400),
    );
  });

  it("deletes the file when aborted", async () => {
    const ac = new AbortController();
    const source = new Readable({
      read() {
        this.push(gzipSync(Buffer.from("chunk")));
      },
    });
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-")));
    const pending = spoolArchiveToTempFile(source, { maxCompressedBytes: 10_000_000, signal: ac.signal });
    ac.abort();
    await assert.rejects(() => pending);
    const leftover = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-") && !before.has(name));
    assert.deepEqual(leftover, []);
  });

  it("creates no temp file when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let read = false;
    const source = new Readable({
      read() {
        read = true;
        this.push(gzipSync(Buffer.from("chunk")));
        this.push(null);
      },
    });
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-")));
    await assert.rejects(
      () => spoolArchiveToTempFile(source, { maxCompressedBytes: 10_000_000, signal: ac.signal }),
      (error: unknown) => (error as { name?: unknown })?.name === "AbortError",
    );
    assert.equal(read, false);
    const leftover = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-") && !before.has(name));
    assert.deepEqual(leftover, []);
  });

  it("leaves no temp file across repeated aborts during async open", async () => {
    // Each abort races the spool file's async creation; repeat enough times that
    // a late create-after-unlink would surface as a leftover temp file.
    for (let i = 0; i < 40; i += 1) {
      const ac = new AbortController();
      const source = new Readable({
        read() {
          this.push(gzipSync(Buffer.from("chunk")));
        },
      });
      const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-")));
      const pending = spoolArchiveToTempFile(source, { maxCompressedBytes: 10_000_000, signal: ac.signal });
      ac.abort();
      await assert.rejects(() => pending);
      const leftover = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-") && !before.has(name));
      assert.deepEqual(leftover, [], `iteration ${i} leaked a temp file`);
    }
  });

  it("rejects and cleans up when aborted mid-flow", async () => {
    const ac = new AbortController();
    let reads = 0;
    const source = new Readable({
      read() {
        reads += 1;
        if (reads === 1) {
          this.push(gzipSync(Buffer.from("chunk")));
          return;
        }
        // The pipeline consumed the first chunk and is still demanding more, so
        // aborting here lands mid-flow without relying on timers.
        queueMicrotask(() => ac.abort());
      },
    });
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-")));
    await assert.rejects(
      () => spoolArchiveToTempFile(source, { maxCompressedBytes: 10_000_000, signal: ac.signal }),
      (error: unknown) => (error as { name?: unknown })?.name === "AbortError",
    );
    assert.ok(reads >= 2, `expected a mid-flow abort, saw ${reads} read(s)`);
    assert.equal(source.destroyed, true);
    const leftover = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-") && !before.has(name));
    assert.deepEqual(leftover, []);
  });
});

describe("workspace empty-check script", () => {
  it("reports empty, ignores lost+found, truncates entries, and flags a missing dir", () => {
    const tmp = mkTmp("pi-pod-empty-");
    try {
      const emptyDir = path.join(tmp.root, "empty");
      fs.mkdirSync(emptyDir);
      const emptyRun = runPython(workspaceEmptyCheckSource(), [emptyDir]);
      assert.equal(emptyRun.status, 0, emptyRun.stderr);
      assert.deepEqual(decodeWorkspaceEmptyCheck(emptyRun.stdout), { empty: true, entries: [], missing: false });

      const ignored = path.join(tmp.root, "ignored");
      fs.mkdirSync(ignored);
      fs.mkdirSync(path.join(ignored, WORKSPACE_EMPTY_IGNORED[0]!));
      const ignoredRun = runPython(workspaceEmptyCheckSource(), [ignored]);
      assert.equal(ignoredRun.status, 0, ignoredRun.stderr);
      assert.deepEqual(decodeWorkspaceEmptyCheck(ignoredRun.stdout), { empty: true, entries: [], missing: false });

      const populated = path.join(tmp.root, "pop");
      fs.mkdirSync(populated);
      for (let i = 0; i < 15; i += 1) fs.writeFileSync(path.join(populated, `f${String(i).padStart(2, "0")}`), "x");
      const popRun = runPython(workspaceEmptyCheckSource(), [populated]);
      assert.equal(popRun.status, 0, popRun.stderr);
      const decoded = decodeWorkspaceEmptyCheck(popRun.stdout);
      assert.equal(decoded.empty, false);
      assert.equal(decoded.entries.length, 10);
      assert.equal(decoded.missing, false);

      const missingRun = runPython(workspaceEmptyCheckSource(), [path.join(tmp.root, "nope")]);
      assert.equal(missingRun.status, 0, missingRun.stderr);
      assert.deepEqual(decodeWorkspaceEmptyCheck(missingRun.stdout), { empty: true, entries: [], missing: true });
    } finally {
      tmp.cleanup();
    }
  });
});

describe("decode helpers and audit/gate", () => {
  it("decodes clone/archive JSON, maps workspace_not_empty to 409, and rejects malformed output", () => {
    const commit = SHA;
    assert.deepEqual(decodeWorkspaceCloneResult(`noise\n{"ok":true,"commit":"${commit}","entries":2}\n`), {
      commit,
      entries: 2,
    });
    assert.throws(
      () => decodeWorkspaceCloneResult('{"error":"workspace_not_empty","entries":["README"]}'),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 409 &&
        error.message === "workspace_not_empty",
    );
    assert.throws(() => decodeWorkspaceCloneResult('{"error":"git clone failed"}'), httpError(400, "git clone failed"));
    assert.throws(() => decodeWorkspaceCloneResult("not json"), httpError(400, /invalid clone result/));
    assert.throws(() => decodeWorkspaceEmptyCheck("not json"), httpError(400));
    assert.deepEqual(decodeWorkspaceArchiveResult('{"entries":3,"bytes":12}'), { entries: 3, bytes: 12 });
    assert.throws(() => decodeWorkspaceArchiveResult("nope"), httpError(400, /invalid archive result/));
    const conflictErr = workspaceNotEmptyError(["a"]);
    assert.equal(conflictErr.statusCode, 409);
    assert.deepEqual(conflictErr.detail, { code: "workspace_not_empty", entries: ["a"] });
  });

  it("builds audit details without credentials and opens the seed gate on timeout", () => {
    const clone = cloneAuditDetail({
      host: "github.com",
      branch: "main",
      commit: SHA,
      credentialed: true,
      entries: 2,
      durationMs: 9,
      fromPod: "pod-1",
    });
    assert.equal(clone.host, "github.com");
    assert.equal(clone.credentialed, true);
    assert.equal("url" in clone, false);
    assert.equal("password" in clone, false);
    const archive = archiveAuditDetail({ bytes: 10, entries: 2, uncompressedBytes: 20, durationMs: 4 });
    assert.equal(archive.bytes, 10);
    assert.equal(archive.uncompressedBytes, 20);
    assert.equal(workspaceSeedGateOpen(null), true);
    assert.equal(workspaceSeedGateOpen({}), true);
    assert.equal(workspaceSeedGateOpen({ workspaceSeed: { status: "seeded", requestedAt: new Date().toISOString() } }), true);
    const requestedAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    assert.equal(workspaceSeedGateOpen({ workspaceSeed: { status: "pending", requestedAt } }, Date.parse(requestedAt) + 1000), false);
    // A seed in flight holds Pi back exactly like an armed gate: no boot into a half-moved tree.
    assert.equal(workspaceSeedGateOpen({ workspaceSeed: { status: "seeding", requestedAt } }, Date.parse(requestedAt) + 1000), false);
    for (const status of ["failed", "skipped"]) {
      assert.equal(workspaceSeedGateOpen({ workspaceSeed: { status, requestedAt } }, Date.parse(requestedAt) + 1000), true);
    }
    assert.equal(
      workspaceSeedGateOpen(
        { workspaceSeed: { status: "pending", requestedAt } },
        Date.parse(requestedAt) + WORKSPACE_SEED_GATE_TIMEOUT_MS,
      ),
      true,
    );
  });
});

describe("workspace clone script", () => {
  function makeRemote(root: string) {
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    git(src, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(src, "README.md"), "hello\n");
    git(src, ["add", "README.md"]);
    git(src, ["commit", "-m", "first"]);
    const first = git(src, ["rev-parse", "HEAD"]).stdout.trim();
    fs.writeFileSync(path.join(src, "README.md"), "hello2\n");
    git(src, ["add", "README.md"]);
    git(src, ["commit", "-m", "second"]);
    const second = git(src, ["rev-parse", "HEAD"]).stdout.trim();
    git(src, ["checkout", "-b", "other"]);
    fs.writeFileSync(path.join(src, "other.txt"), "other\n");
    git(src, ["add", "other.txt"]);
    git(src, ["commit", "-m", "other"]);
    const other = git(src, ["rev-parse", "HEAD"]).stdout.trim();
    git(src, ["checkout", "main"]);
    git(src, ["tag", "-m", "v1", "v1"]);
    const bare = path.join(root, "remote.git");
    git(root, ["clone", "--bare", src, bare]);
    return { url: `file://${bare}`, first, second, other, branch: "main" };
  }

  function runClone(args: {
    workdir: string;
    tmpdir: string;
    url: string;
    branch: string;
    commit: string;
    env?: NodeJS.ProcessEnv;
  }) {
    return runPython(workspaceCloneSource(), [args.workdir, args.tmpdir, args.url, args.branch, args.commit], args.env);
  }

  it("clones, checks out the requested commit, moves into an empty workdir, and strips helpers", () => {
    const tmp = mkTmp("pi-pod-clone-ok-");
    try {
      const remote = makeRemote(tmp.root);
      const workdir = path.join(tmp.root, "work");
      fs.mkdirSync(workdir);
      const cloneTmp = path.join(tmp.root, "clone-tmp");
      const result = runClone({
        workdir,
        tmpdir: cloneTmp,
        url: remote.url,
        branch: remote.branch,
        commit: remote.second,
        env: { PI_POD_GIT_USERNAME: "cloneUser", PI_POD_GIT_PASSWORD: "clonePass_secret" },
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const decoded = decodeWorkspaceCloneResult(result.stdout);
      assert.equal(decoded.commit, remote.second);
      assert.equal(fs.readFileSync(path.join(workdir, "README.md"), "utf8"), "hello2\n");
      assert.equal(fs.existsSync(path.join(workdir, ".git")), true);
      assert.equal(fs.existsSync(cloneTmp), false);
      const config = fs.readFileSync(path.join(workdir, ".git", "config"), "utf8");
      assert.doesNotMatch(config, /credential\.helper/);
      const head = spawnSync("git", ["-C", workdir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
        },
      });
      assert.equal(head.stdout.trim(), "main");
    } finally {
      tmp.cleanup();
    }
  });

  it("fetches and resets when HEAD does not match the requested commit", () => {
    const tmp = mkTmp("pi-pod-clone-reset-");
    try {
      const remote = makeRemote(tmp.root);
      const workdir = path.join(tmp.root, "work");
      fs.mkdirSync(workdir);
      const result = runClone({
        workdir,
        tmpdir: path.join(tmp.root, "clone-tmp"),
        url: remote.url,
        branch: remote.branch,
        commit: remote.other,
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(decodeWorkspaceCloneResult(result.stdout).commit, remote.other);
      assert.equal(fs.readFileSync(path.join(workdir, "other.txt"), "utf8"), "other\n");
    } finally {
      tmp.cleanup();
    }
  });

  it("errors when the checked-out branch does not match", () => {
    const tmp = mkTmp("pi-pod-clone-branch-");
    try {
      const remote = makeRemote(tmp.root);
      const workdir = path.join(tmp.root, "work");
      fs.mkdirSync(workdir);
      const result = runClone({
        workdir,
        tmpdir: path.join(tmp.root, "clone-tmp"),
        url: remote.url,
        branch: "v1",
        commit: remote.second,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /branch/);
      assert.equal(fs.existsSync(path.join(tmp.root, "clone-tmp")), false);
    } finally {
      tmp.cleanup();
    }
  });

  it("exits 3 and leaves a populated workdir untouched", () => {
    const tmp = mkTmp("pi-pod-clone-full-");
    try {
      const remote = makeRemote(tmp.root);
      const workdir = path.join(tmp.root, "work");
      fs.mkdirSync(workdir);
      fs.writeFileSync(path.join(workdir, "keep.txt"), "keep\n");
      const result = runClone({
        workdir,
        tmpdir: path.join(tmp.root, "clone-tmp"),
        url: remote.url,
        branch: remote.branch,
        commit: remote.second,
      });
      assert.equal(result.status, 3, result.stdout);
      assert.equal(lastJson(result.stdout).error, "workspace_not_empty");
      assert.equal(fs.readFileSync(path.join(workdir, "keep.txt"), "utf8"), "keep\n");
      assert.deepEqual(fs.readdirSync(workdir), ["keep.txt"]);
    } finally {
      tmp.cleanup();
    }
  });

  it("scrubs credential env values from a failed clone and always removes tmpdir", () => {
    const tmp = mkTmp("pi-pod-clone-scrub-");
    try {
      const workdir = path.join(tmp.root, "work");
      fs.mkdirSync(workdir);
      const cloneTmp = path.join(tmp.root, "clone-tmp");
      const password = "SuperSecretPassword_12345";
      const result = runClone({
        workdir,
        tmpdir: cloneTmp,
        url: "https://127.0.0.1:1/definitely-not-a-repo.git",
        branch: "main",
        commit: SHA,
        env: { PI_POD_GIT_USERNAME: "cloneUser_UNIQUE", PI_POD_GIT_PASSWORD: password },
      });
      assert.notEqual(result.status, 0);
      const combined = `${result.stdout}${result.stderr}`;
      assert.equal(combined.includes(password), false);
      assert.equal(combined.includes("cloneUser_UNIQUE"), false);
      assert.equal(fs.existsSync(cloneTmp), false);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("workspace archive extract script", () => {
  const CRAFT_MEMBER = `
import io, sys, tarfile
dest, kind = sys.argv[1], sys.argv[2]
with tarfile.open(dest, "w:gz") as tar:
    def add_file(name, data=b"ok", mode=0o644):
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = mode
        tar.addfile(info, io.BytesIO(data))
    if kind == "hardlink":
        add_file("orig", b"x")
        info = tarfile.TarInfo("hard")
        info.type = tarfile.LNKTYPE
        info.linkname = "orig"
        tar.addfile(info)
    elif kind == "chr":
        info = tarfile.TarInfo("null")
        info.type = tarfile.CHRTYPE
        info.devmajor = 1
        info.devminor = 3
        tar.addfile(info)
    elif kind == "blk":
        info = tarfile.TarInfo("disk")
        info.type = tarfile.BLKTYPE
        info.devmajor = 8
        info.devminor = 0
        tar.addfile(info)
    elif kind == "fifo":
        info = tarfile.TarInfo("fifo")
        info.type = tarfile.FIFOTYPE
        tar.addfile(info)
    elif kind == "absolute":
        add_file("/etc/passwd", b"nope")
    elif kind == "traverse":
        add_file("../escape", b"nope")
    elif kind == "escape-symlink":
        info = tarfile.TarInfo("link")
        info.type = tarfile.SYMTYPE
        info.linkname = "../../outside"
        tar.addfile(info)
    elif kind == "symlink-then-file":
        info = tarfile.TarInfo("link")
        info.type = tarfile.SYMTYPE
        info.linkname = "."
        tar.addfile(info)
        add_file("link/evil", b"evil")
    elif kind == "safe-symlink":
        add_file("hello.txt", b"hello\\n", 0o640)
        info = tarfile.TarInfo("link")
        info.type = tarfile.SYMTYPE
        info.linkname = "hello.txt"
        tar.addfile(info)
    elif kind == "partial":
        add_file("ok.txt", b"ok")
        add_file("../escape", b"nope")
    elif kind == "nested":
        info = tarfile.TarInfo("dir")
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        tar.addfile(info)
        info = tarfile.TarInfo("dir/sub")
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        tar.addfile(info)
        add_file("dir/sub/file.txt", b"nested\\n", 0o640)
        add_file("hello.txt", b"hello\\n", 0o644)
        info = tarfile.TarInfo("link")
        info.type = tarfile.SYMTYPE
        info.linkname = "hello.txt"
        tar.addfile(info)
    elif kind == "bomb-entries":
        n = int(sys.argv[3])
        for i in range(n):
            add_file("e%05d" % i, b"")
    elif kind == "gzip-bomb":
        data = b"\\x00" * int(sys.argv[3])
        add_file("zeros", data)
    elif kind == "oversize-header":
        data = b"x" * int(sys.argv[3])
        add_file("big", data)
    else:
        raise SystemExit("unknown kind")
`;

  function extractOnce(
    kind: string,
    extra: string[] = [],
    opts: { maxUncompressed?: number; maxEntries?: number; allowSymlinks?: boolean; prefill?: (workdir: string) => void } = {},
  ) {
    const tmp = mkTmp("pi-pod-extract-");
    const workdir = path.join(tmp.root, "work");
    const staging = path.join(tmp.root, "staging");
    const archive = path.join(tmp.root, "archive.tgz");
    fs.mkdirSync(workdir);
    craftArchive(archive, CRAFT_MEMBER, [kind, ...extra]);
    opts.prefill?.(workdir);
    const result = runExtract(workdir, archive, staging, opts);
    return { tmp, workdir, staging, archive, result };
  }

  it("extracts nested files, modes, and a safe symlink then removes staging and the archive", () => {
    const run = extractOnce("nested");
    try {
      assert.equal(run.result.status, 0, run.result.stderr + run.result.stdout);
      const decoded = decodeWorkspaceArchiveResult(run.result.stdout);
      assert.ok(decoded.entries >= 4);
      assert.equal(fs.readFileSync(path.join(run.workdir, "hello.txt"), "utf8"), "hello\n");
      assert.equal(fs.readFileSync(path.join(run.workdir, "dir", "sub", "file.txt"), "utf8"), "nested\n");
      assert.equal(fs.statSync(path.join(run.workdir, "dir", "sub", "file.txt")).mode & 0o777, 0o640);
      assert.equal(fs.readlinkSync(path.join(run.workdir, "link")), "hello.txt");
      assert.equal(fs.existsSync(run.staging), false);
      assert.equal(fs.existsSync(run.archive), false);
    } finally {
      run.tmp.cleanup();
    }
  });

  it("round-trips a system tar.gz of regular files", () => {
    const tmp = mkTmp("pi-pod-tar-bin-");
    try {
      const src = path.join(tmp.root, "src");
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, "a.txt"), "alpha\n", { mode: 0o644 });
      fs.mkdirSync(path.join(src, "nested"));
      fs.writeFileSync(path.join(src, "nested", "b.txt"), "beta\n");
      const archive = path.join(tmp.root, "archive.tgz");
      const tar = spawnSync("tar", ["-czf", archive, "-C", src, "."], { encoding: "utf8" });
      assert.equal(tar.status, 0, tar.stderr);
      const workdir = path.join(tmp.root, "work");
      fs.mkdirSync(workdir);
      const staging = path.join(tmp.root, "staging");
      const result = runExtract(workdir, archive, staging);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(fs.readFileSync(path.join(workdir, "a.txt"), "utf8"), "alpha\n");
      assert.equal(fs.readFileSync(path.join(workdir, "nested", "b.txt"), "utf8"), "beta\n");
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses hostile members and leaves the workdir empty", () => {
    const kinds = ["hardlink", "chr", "blk", "fifo", "absolute", "traverse", "escape-symlink", "symlink-then-file"];
    for (const kind of kinds) {
      const run = extractOnce(kind);
      try {
        assert.notEqual(run.result.status, 0, kind);
        assert.notEqual(run.result.status, 3, kind);
        assert.equal(fs.readdirSync(run.workdir).length, 0, kind);
        assert.equal(fs.existsSync(run.staging), false, kind);
        assert.equal(fs.existsSync(run.archive), false, kind);
      } finally {
        run.tmp.cleanup();
      }
    }
  });

  it("rolls back a partial archive so the workdir stays empty", () => {
    const run = extractOnce("partial");
    try {
      assert.notEqual(run.result.status, 0);
      assert.equal(fs.readdirSync(run.workdir).length, 0);
      assert.equal(fs.existsSync(run.staging), false);
    } finally {
      run.tmp.cleanup();
    }
  });

  it("refuses symlinks when allowSymlinks=0", () => {
    const run = extractOnce("safe-symlink", [], { allowSymlinks: false });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stdout, /symlink/);
      assert.equal(fs.readdirSync(run.workdir).length, 0);
    } finally {
      run.tmp.cleanup();
    }
  });

  it("rejects an entry bomb", () => {
    const run = extractOnce("bomb-entries", ["200001"], { maxEntries: 200 });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stdout, /entry limit/);
      assert.equal(fs.readdirSync(run.workdir).length, 0);
    } finally {
      run.tmp.cleanup();
    }
  });

  it("rejects a gzip bomb of zeros against the uncompressed cap", () => {
    const run = extractOnce("gzip-bomb", [String(2 * 1024 * 1024)], { maxUncompressed: 64 * 1024 });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stdout, /uncompressed/);
      assert.equal(fs.readdirSync(run.workdir).length, 0);
    } finally {
      run.tmp.cleanup();
    }
  });

  it("rejects a truncated gzip", () => {
    const tmp = mkTmp("pi-pod-trunc-");
    try {
      const workdir = path.join(tmp.root, "work");
      const staging = path.join(tmp.root, "staging");
      const archive = path.join(tmp.root, "archive.tgz");
      fs.mkdirSync(workdir);
      const gz = gzipSync(Buffer.from("not-a-tar"));
      fs.writeFileSync(archive, gz.subarray(0, Math.min(8, gz.length)));
      const result = runExtract(workdir, archive, staging);
      assert.notEqual(result.status, 0);
      assert.equal(fs.readdirSync(workdir).length, 0);
      assert.equal(fs.existsSync(staging), false);
      assert.equal(fs.existsSync(archive), false);
    } finally {
      tmp.cleanup();
    }
  });

  it("rejects a member whose header size exceeds the uncompressed cap", () => {
    const run = extractOnce("oversize-header", ["20000"], { maxUncompressed: 1000 });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stdout, /uncompressed/);
      assert.equal(fs.readdirSync(run.workdir).length, 0);
    } finally {
      run.tmp.cleanup();
    }
  });

  it("exits 3 and leaves an existing workdir file untouched", () => {
    const run = extractOnce("nested", [], {
      prefill: (workdir) => fs.writeFileSync(path.join(workdir, "keep.txt"), "keep\n"),
    });
    try {
      assert.equal(run.result.status, 3, run.result.stdout);
      assert.equal(lastJson(run.result.stdout).error, "workspace_not_empty");
      assert.equal(fs.readFileSync(path.join(run.workdir, "keep.txt"), "utf8"), "keep\n");
      assert.deepEqual(fs.readdirSync(run.workdir), ["keep.txt"]);
    } finally {
      run.tmp.cleanup();
    }
  });
});

describe("python sources", () => {
  it("compile", () => {
    for (const source of [workspaceEmptyCheckSource(), workspaceCloneSource(), workspaceArchiveExtractSource()]) {
      const result = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
        encoding: "utf8",
        input: source,
      });
      assert.equal(result.status, 0, result.stderr);
    }
  });
});
