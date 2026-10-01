/**
 * Source-less launches through the real `main()`: a directory with no `.pi-pod/config.json`
 * seeds the fresh pod by exact clone when that is lossless and by tar archive otherwise.
 * Every case here asks two things of the fake control plane's call log — which workspace
 * route was hit, and with what — because the transport choice is the feature.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { main, reportError } from "../../src/cli.js";
import { setColor } from "../../src/log.js";
import { FakeAccountServer, fakePod, type RecordedCall } from "../support/fake-account-server.js";
import { installStoredGitCredential, servePrivateBareRepo } from "../support/private-git-remote.js";
import { gitignore, initRepo, isolateHome, makeTempDir, serveBareRepo, writeConfig, type Fixture } from "../support/repo-fixture.js";

setColor(false);

const HOME = isolateHome("pi-pod-seed-home-");
const savedCwd = process.cwd();
const authFile = path.join(HOME.home, ".pi-pod", "auth.json");
let server: FakeAccountServer;

before(async () => {
  server = new FakeAccountServer({
    pods: [fakePod({ id: "0198f5a0-0000-7000-8000-00000000000a", name: "fix-auth", project: "repo" })],
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

async function signIn(url = server.url): Promise<void> {
  fs.rmSync(authFile, { force: true });
  const result = await capture(["login", "--server", url, "--token", "dev-jwt"]);
  assert.equal(result.code, 0, result.out);
}

const isClone = (call: RecordedCall): boolean => call.method === "POST" && /\/workspace\/clone$/.test(call.path);
const isArchive = (call: RecordedCall): boolean => call.method === "PUT" && /\/workspace\/archive$/.test(call.path);
const isFiles = (call: RecordedCall): boolean => call.method === "POST" && /\/files$/.test(call.path);
const isSkip = (call: RecordedCall): boolean => call.method === "POST" && /\/workspace\/skip$/.test(call.path);
const isLaunch = (call: RecordedCall): boolean => call.method === "POST" && call.path === "/v1/pods";

/** List an archive the fake server received, through the system tar the sandbox would use. */
function archiveListing(podId: string): string[] {
  const bytes = server.workspaceArchives.get(podId);
  assert.ok(bytes, "the server must have received an archive for this pod");
  const file = path.join(makeTempDir("pi-pod-seed-listing-"), "seed.tar.gz");
  fs.writeFileSync(file, bytes);
  try {
    return execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).split("\n").filter((line) => line !== "");
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

function launchedPodId(calls: RecordedCall[]): string {
  const seeded = calls.find((call) => isClone(call) || isArchive(call) || isFiles(call));
  const match = seeded ? /^\/v1\/pods\/([^/]+)\//.exec(seeded.path) : null;
  assert.ok(match, "a workspace transfer names the pod it seeds");
  return match[1]!;
}

/** A clean checkout pushed to a bare repository served over dumb HTTP, ready to be cloned. */
async function publicCheckout(): Promise<{ repo: Fixture; remote: Fixture; url: string; commit: string; close(): Promise<void> }> {
  const remote = initRepo({ bare: true });
  const repo = initRepo();
  const serving = await serveBareRepo(remote.dir);
  repo.write("src/app.ts", "export const x = 1;\n");
  repo.commit("initial");
  repo.git("remote", "add", "origin", remote.dir);
  repo.git("push", "-u", "origin", "main");
  serving.refresh();
  repo.git("remote", "set-url", "origin", serving.url);
  const commit = repo.git("rev-parse", "HEAD");
  return {
    repo,
    remote,
    url: serving.url,
    commit,
    close: async () => {
      await serving.close();
      repo.cleanup();
      remote.cleanup();
    },
  };
}

describe("source-less workspace seeding", () => {
  it("clones a clean public checkout at its exact commit and sends no files", async () => {
    await signIn();
    const checkout = await publicCheckout();
    try {
      process.chdir(checkout.repo.dir);
      const before = server.calls.length;
      const result = await capture([]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, new RegExp(`workspace seed: the pod will clone ${checkout.url} at main \\(${checkout.commit.slice(0, 12)}\\)`));
      assert.match(result.out, /workspace seeded: cloned main at/);
      const calls = server.calls.slice(before);
      assert.deepEqual(
        calls.find(isLaunch)?.body,
        { project: { name: path.basename(checkout.repo.dir) }, workspaceSeed: true },
        "the launch names its project, arms the seed gate and carries nothing else",
      );
      const clone = calls.find(isClone);
      assert.ok(clone, "the clone route must be called");
      assert.deepEqual(clone.body, { url: checkout.url, branch: "main", commit: checkout.commit });
      assert.equal(calls.some(isArchive), false);
      assert.equal(calls.some(isFiles), false);
      assert.equal(calls.some(isSkip), false, "a successful seed opens the gate on the server");
      const seeded = server.pods.find((pod) => pod.id === launchedPodId(calls));
      assert.equal(seeded?.resolvedConfig.workspaceSeed?.status, "seeded");
    } finally {
      await checkout.close();
    }
  });

  it("falls back to an archive when the server's clone fails", async () => {
    await signIn();
    const checkout = await publicCheckout();
    try {
      process.chdir(checkout.repo.dir);
      server.workspaceCloneFailures = 1;
      const before = server.calls.length;
      const result = await capture([]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /clone failed: .*falling back to an archive/);
      assert.match(result.out, /workspace seeded from archive with \.git history/);
      const calls = server.calls.slice(before);
      assert.ok(calls.some(isClone));
      const archive = calls.find(isArchive);
      assert.ok(archive, "the archive route must be called after the clone fails");
      const body = archive.body as { gzip: boolean; bytes: number; contentLength: string | null };
      assert.equal(body.gzip, true, "the body is a gzip stream");
      assert.equal(String(body.bytes), body.contentLength, "Content-Length names the streamed size");
      const listing = archiveListing(launchedPodId(calls));
      assert.ok(listing.includes("src/app.ts"), listing.join(" "));
      assert.ok(listing.some((entry) => entry.startsWith(".git/")), "a clone-eligible tree keeps its history in the archive");
    } finally {
      server.workspaceCloneFailures = 0;
      await checkout.close();
    }
  });

  it("archives a dirty repository with its history and without ignored, vendored, or secret files", async () => {
    await signIn();
    const checkout = await publicCheckout();
    try {
      const { repo } = checkout;
      gitignore(repo.dir, ["build/", "*.log"]);
      repo.write("src/app.ts", "export const x = 2;\n");
      repo.write("build/out.js", "generated\n");
      repo.write("node_modules/left-pad/index.js", "module.exports = 1;\n");
      repo.write("notes.log", "ignored\n");
      repo.write(".pi-pod/env", "SECRET=never\n");
      fs.symlinkSync("../etc/passwd", path.join(repo.dir, "escape"));
      fs.symlinkSync("src/app.ts", path.join(repo.dir, "safe-link"));

      process.chdir(repo.dir);
      const before = server.calls.length;
      const result = await capture([]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /will be archived into the pod with \.git history \(uncommitted changes would be lost by a clone\)/);
      assert.match(result.out, /skipped 1 entry that cannot travel .*escape/);
      const calls = server.calls.slice(before);
      assert.equal(calls.some(isClone), false, "a dirty tree never tries the clone route");
      assert.equal(calls.some(isFiles), false);
      const listing = archiveListing(launchedPodId(calls));
      for (const expected of ["src/app.ts", ".gitignore", "safe-link", ".git/HEAD"]) {
        assert.ok(listing.includes(expected), `${expected} in ${listing.join(" ")}`);
      }
      for (const excluded of ["build/out.js", "node_modules/left-pad/index.js", "notes.log", ".pi-pod/env", "escape"]) {
        assert.equal(listing.includes(excluded), false, excluded);
      }
    } finally {
      await checkout.close();
    }
  });

  it("archives a plain directory without inventing a .git", async () => {
    await signIn();
    const dir = makeTempDir("pi-pod-seed-plain-");
    fs.mkdirSync(path.join(dir, "notes"));
    fs.writeFileSync(path.join(dir, "notes", "todo.md"), "- ship it\n");
    fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    try {
      process.chdir(dir);
      const before = server.calls.length;
      const result = await capture([]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /will be archived into the pod \(not a git repository\)/);
      assert.match(result.out, /workspace seeded from archive\b/);
      assert.doesNotMatch(result.out, /with \.git history/);
      const calls = server.calls.slice(before);
      assert.equal(calls.some(isClone), false);
      const listing = archiveListing(launchedPodId(calls));
      assert.deepEqual(listing.sort(), ["notes/", "notes/todo.md", "run.sh"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seeds the repository root when launched from a subdirectory", async () => {
    await signIn();
    const checkout = await publicCheckout();
    try {
      checkout.repo.write("src/lib/util.ts", "export const y = 1;\n");
      process.chdir(path.join(checkout.repo.dir, "src", "lib"));
      const before = server.calls.length;
      const result = await capture([]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /launched from src\/lib\//);
      const listing = archiveListing(launchedPodId(server.calls.slice(before)));
      assert.ok(listing.includes("src/app.ts"), "the whole repository seeds the pod, not the subdirectory");
      assert.ok(listing.includes("src/lib/util.ts"));
    } finally {
      await checkout.close();
    }
  });

  it("dry-runs the decision without prompting, reading credentials, or creating a pod", async () => {
    await signIn();
    const checkout = await publicCheckout();
    try {
      process.chdir(checkout.repo.dir);
      const before = server.calls.length;
      const result = await capture(["--dry-run"]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, new RegExp(`workspace seed: clone ${checkout.url} at main \\(${checkout.commit.slice(0, 12)}\\)`));
      const calls = server.calls.slice(before);
      assert.equal(calls.some(isLaunch), false);
      assert.equal(calls.some((call) => isClone(call) || isArchive(call) || isFiles(call)), false);
    } finally {
      await checkout.close();
    }
  });

  it("predicts a credentialed clone for a private remote on a dry run without touching credentials", async () => {
    await signIn();
    const remote = initRepo({ bare: true });
    const repo = initRepo();
    const serving = await servePrivateBareRepo(remote.dir, { username: "octocat", password: "ghp_dryrun_secret" });
    try {
      repo.write("src/app.ts", "export const x = 1;\n");
      repo.commit("initial");
      repo.git("remote", "add", "origin", remote.dir);
      repo.git("push", "-u", "origin", "main");
      serving.refresh();
      repo.git("remote", "set-url", "origin", serving.url);
      process.chdir(repo.dir);
      const result = await capture(["--dry-run"]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, new RegExp(`workspace seed: clone ${serving.url} at main .* with forwarded ${serving.host} credentials`));
      assert.match(result.out, /forwarded only if you approve/);
    } finally {
      await serving.close();
      repo.cleanup();
      remote.cleanup();
    }
  });

  describe("private remotes", () => {
    it("forwards the host's git credential to the clone route only after --yes consent, and archives when declined", async () => {
      await signIn();
      const remote = initRepo({ bare: true });
      const repo = initRepo();
      const credentialDir = makeTempDir("pi-pod-seed-cred-");
      const serving = await servePrivateBareRepo(remote.dir, { username: "octocat", password: "ghp_private_token_value" });
      const restoreGitConfig = installStoredGitCredential(credentialDir, serving);
      try {
        repo.write("src/app.ts", "export const x = 1;\n");
        repo.commit("initial");
        repo.git("remote", "add", "origin", remote.dir);
        repo.git("push", "-u", "origin", "main");
        serving.refresh();
        repo.git("remote", "set-url", "origin", serving.url);
        const commit = repo.git("rev-parse", "HEAD");
        process.chdir(repo.dir);

        // No TTY and no --yes: the prompt's non-interactive answer is "no", so an archive travels.
        let before = server.calls.length;
        const declined = await capture([]);
        assert.equal(declined.code, 0, declined.out);
        assert.match(declined.out, /credential forwarding declined/);
        let calls = server.calls.slice(before);
        assert.equal(calls.some(isClone), false, "a declined credential never reaches the server");
        assert.ok(calls.some(isArchive));
        assert.equal(declined.out.includes("ghp_private_token_value"), false, "the token never appears in output");

        before = server.calls.length;
        const approved = await capture(["--yes"]);
        assert.equal(approved.code, 0, approved.out);
        assert.match(approved.out, new RegExp(`with forwarded ${serving.host} credentials`));
        calls = server.calls.slice(before);
        const clone = calls.find(isClone);
        assert.ok(clone, "with consent the clone route is used");
        assert.deepEqual(clone.body, {
          url: serving.url,
          branch: "main",
          commit,
          credential: { username: "octocat", password: "ghp_private_token_value" },
        });
        assert.equal(approved.out.includes("ghp_private_token_value"), false, "the token never appears in output");
        assert.equal(calls.some(isArchive), false);
      } finally {
        restoreGitConfig();
        await serving.close();
        repo.cleanup();
        remote.cleanup();
        fs.rmSync(credentialDir, { recursive: true, force: true });
      }
    });

    it("archives a private remote the host holds no credentials for", async () => {
      await signIn();
      const remote = initRepo({ bare: true });
      const repo = initRepo();
      const serving = await servePrivateBareRepo(remote.dir, { username: "octocat", password: "nobody-has-this" });
      try {
        repo.write("src/app.ts", "export const x = 1;\n");
        repo.commit("initial");
        repo.git("remote", "add", "origin", remote.dir);
        repo.git("push", "-u", "origin", "main");
        serving.refresh();
        repo.git("remote", "set-url", "origin", serving.url);
        process.chdir(repo.dir);
        const before = server.calls.length;
        const result = await capture(["--yes"]);
        assert.equal(result.code, 0, result.out);
        assert.match(result.out, new RegExp(`no git credentials for ${serving.host}`));
        const calls = server.calls.slice(before);
        assert.equal(calls.some(isClone), false);
        assert.ok(calls.some(isArchive));
      } finally {
        await serving.close();
        repo.cleanup();
        remote.cleanup();
      }
    });
  });

  describe("launches that never seed", () => {
    it("--no-seed leaves the pod empty", async () => {
      await signIn();
      const checkout = await publicCheckout();
      try {
        process.chdir(checkout.repo.dir);
        const before = server.calls.length;
        const result = await capture(["--no-seed"]);
        assert.equal(result.code, 0, result.out);
        assert.match(result.out, /workspace seed: none \(--no-seed\)/);
        const calls = server.calls.slice(before);
        assert.deepEqual(calls.find(isLaunch)?.body, { project: { name: path.basename(checkout.repo.dir) } }, "--no-seed never arms the seed gate");
        assert.equal(calls.some((call) => isClone(call) || isArchive(call) || isFiles(call) || isSkip(call)), false);
      } finally {
        await checkout.close();
      }
    });

    it("fork copies the conversation, not the launch directory", async () => {
      await signIn();
      const checkout = await publicCheckout();
      try {
        process.chdir(checkout.repo.dir);
        const before = server.calls.length;
        const result = await capture(["fork", "0198f5a0-0000-7000-8000-00000000000a"]);
        assert.equal(result.code, 0, result.out);
        assert.match(result.out, /workspace seed: none \(fork copies the conversation/);
        const calls = server.calls.slice(before);
        assert.equal(calls.some((call) => isClone(call) || isArchive(call) || isFiles(call)), false);
      } finally {
        await checkout.close();
      }
    });

    it("--on co-locates without seeding the shared host workdir", async () => {
      await signIn();
      const checkout = await publicCheckout();
      try {
        process.chdir(checkout.repo.dir);
        const before = server.calls.length;
        const result = await capture(["--on", "0198f5a0-0000-7000-8000-00000000000a"]);
        assert.equal(result.code, 0, result.out);
        assert.match(result.out, /workspace seed: none \(a co-located pod shares its host's workdir\)/);
        const calls = server.calls.slice(before);
        assert.deepEqual(calls.find(isLaunch)?.body, {
          project: { name: path.basename(checkout.repo.dir) },
          placement: { host: "0198f5a0-0000-7000-8000-00000000000a" },
        });
        assert.equal(calls.some((call) => isClone(call) || isArchive(call) || isFiles(call)), false);
      } finally {
        await checkout.close();
      }
    });

    it("a reused pod keeps its warm workspace", async () => {
      await signIn();
      const checkout = await publicCheckout();
      const stopped = fakePod({
        id: "0198f5a0-0000-7000-8000-0000000000d2",
        name: "warm",
        // Reuse picks only this project's own stopped pod.
        project: path.basename(checkout.repo.dir),
        templateId: null,
        ready: false,
        initializing: false,
      });
      server.pods.push(stopped);
      try {
        process.chdir(checkout.repo.dir);
        const before = server.calls.length;
        const result = await capture(["--reuse"]);
        assert.equal(result.code, 0, result.out);
        assert.match(result.out, /reusing this pod's warm workspace/);
        const calls = server.calls.slice(before);
        const reuse = calls.find((call) => call.path.endsWith(`/pods/${stopped.id}/reuse`));
        assert.ok(reuse);
        assert.deepEqual(reuse.body, { project: { name: path.basename(checkout.repo.dir) } }, "a reuse never arms the seed gate");
        assert.equal(calls.some((call) => isClone(call) || isArchive(call) || isFiles(call) || isSkip(call)), false);
      } finally {
        server.pods = server.pods.filter((pod) => pod.id !== stopped.id);
        await checkout.close();
      }
    });

    it("a configured project keeps the legacy /files copy and never enters the clone-or-archive workflow", async () => {
      await signIn();
      const checkout = await publicCheckout();
      try {
        // Commit and push the project config so the checkout stays clone-eligible.
        writeConfig(checkout.repo.dir, { name: "configured" });
        checkout.repo.commit("configure");
        checkout.repo.git("remote", "set-url", "origin", checkout.remote.dir);
        checkout.repo.git("push", "origin", "main");
        checkout.repo.git("remote", "set-url", "origin", checkout.url);
        execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.editor=true", "update-server-info"], {
          cwd: checkout.remote.dir,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_EDITOR: "true",
            GIT_SEQUENCE_EDITOR: "true",
          },
        });
        process.chdir(checkout.repo.dir);
        const before = server.calls.length;
        const result = await capture([]);
        assert.equal(result.code, 0, result.out);
        assert.match(result.out, new RegExp(`copied into the pod \\(cloneable from ${checkout.url} at main\\)`));
        const calls = server.calls.slice(before);
        assert.deepEqual(calls.find(isLaunch)?.body, { project: { name: "configured" } }, "the legacy copy keeps its post-start timing: no seed gate");
        assert.ok(calls.some(isFiles), "configured projects still copy over /files");
        assert.equal(calls.some((call) => isClone(call) || isArchive(call) || isSkip(call)), false);
      } finally {
        await checkout.close();
      }
    });
  });

  describe("degraded servers", () => {
    it("copies a small tree over /files when the server predates the workspace routes", async () => {
      const legacy = new FakeAccountServer({ supportsWorkspaceSeed: false });
      await legacy.start();
      const dir = makeTempDir("pi-pod-seed-legacy-");
      fs.writeFileSync(path.join(dir, "README.md"), "# old server\n");
      try {
        await signIn(legacy.url);
        process.chdir(dir);
        const result = await capture([]);
        assert.equal(result.code, 0, result.out);
        assert.match(result.out, /this server predates workspace archives — copying files individually/);
        assert.match(result.out, /workspace seeded\n/);
        const launches = legacy.calls.filter(isLaunch);
        const project = { name: path.basename(dir) };
        assert.deepEqual(
          launches.map((call) => call.body),
          [{ project, workspaceSeed: true }, { project }],
          "the gate flag is retried away on a strict old server",
        );
        assert.ok(legacy.calls.some(isArchive), "the archive route is tried first");
        assert.equal(legacy.calls.some(isSkip), false, "an ungated launch has no gate to release");
        const files = legacy.calls.find(isFiles);
        assert.ok(files, "the legacy route carries the tree");
        assert.deepEqual((files.body as { entries: Array<{ relPath: string }> }).entries.map((entry) => entry.relPath), ["README.md"]);
      } finally {
        process.chdir(savedCwd);
        fs.rmSync(dir, { recursive: true, force: true });
        await legacy.stop();
        await signIn();
      }
    });

    it("warns and leaves a usable empty pod when the archive transfer fails", async () => {
      await signIn();
      const dir = makeTempDir("pi-pod-seed-fail-");
      fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
      try {
        process.chdir(dir);
        server.workspaceArchiveFailures = 1;
        const before = server.calls.length;
        const result = await capture([]);
        assert.equal(result.code, 0, "the session still runs: " + result.out);
        assert.match(result.out, /could not seed the workspace: .*archive extraction failed.*pipod send/);
        const calls = server.calls.slice(before);
        assert.ok(calls.some(isArchive));
        assert.equal(calls.some((call) => call.method === "DELETE"), false, "a failed seed never deletes the pod");
        const skip = calls.find(isSkip);
        assert.ok(skip, "a failed seed releases the gate so Pi starts");
        assert.match((skip.body as { reason: string }).reason, /archive extraction failed/);
        const podId = launchedPodId(calls);
        assert.equal(server.pods.find((pod) => pod.id === podId)?.resolvedConfig.workspaceSeed?.status, "skipped");
        assert.ok(calls.some((call) => call.path.endsWith("/ws-ticket")), "the session attaches to the empty pod");
      } finally {
        server.workspaceArchiveFailures = 0;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("skips safely when an init script already populated the workspace", async () => {
      await signIn();
      const checkout = await publicCheckout();
      try {
        process.chdir(checkout.repo.dir);
        const nextPodId = `0198f5a0-0000-7000-8000-${String(server.pods.length + 2).padStart(12, "0")}`;
        server.workspaceNotEmptyPods.add(nextPodId);
        const before = server.calls.length;
        const result = await capture([]);
        assert.equal(result.code, 0, result.out);
        assert.match(result.out, /workspace already populated .* leaving it in place/);
        const calls = server.calls.slice(before);
        assert.ok(calls.some(isClone));
        assert.equal(calls.some(isArchive), false, "a populated workspace is not archived over either");
        assert.match((calls.find(isSkip)?.body as { reason?: string } | undefined)?.reason ?? "", /workspace not empty/);
      } finally {
        server.workspaceNotEmptyPods.clear();
        await checkout.close();
      }
    });
  });
});

describe("doctor reports the seed decision", () => {
  it("names the seed root and the clone decision without creating anything", async () => {
    await signIn();
    const checkout = await publicCheckout();
    try {
      process.chdir(checkout.repo.dir);
      const before = server.calls.length;
      const result = await capture(["doctor"]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, new RegExp(`workspace seed root: ${checkout.repo.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(result.out, new RegExp(`workspace seed: clone ${checkout.url} at main`));
      assert.equal(server.calls.slice(before).some(isLaunch), false);
    } finally {
      await checkout.close();
    }
  });
});
