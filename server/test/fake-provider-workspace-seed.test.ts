/**
 * The fake provider used to no-op exec/upload, so workspace clone/archive always failed
 * with "invalid empty-check result". These cases pin the host-mapped /workspace that
 * local `npx tsx dev/main-fake.mts` sessions need for seeding.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { createFakeSandboxForTests, type FakeSandbox } from "../dev/fake-provider.mjs";
import {
  decodeWorkspaceArchiveResult,
  decodeWorkspaceCloneResult,
  decodeWorkspaceEmptyCheck,
  workspaceArchiveExtractSource,
  workspaceCloneSource,
  workspaceEmptyCheckSource,
} from "../src/server/pods/workspace-seed.js";

const sandboxes: FakeSandbox[] = [];

after(() => {
  for (const sandbox of sandboxes) {
    void sandbox.delete();
  }
});

function sandbox(): FakeSandbox {
  const created = createFakeSandboxForTests(`test-${sandboxes.length}`);
  sandboxes.push(created);
  return created;
}

function initRepo(): { dir: string; commit: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-fake-repo-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_AUTHOR_NAME: "Dev",
    GIT_AUTHOR_EMAIL: "dev@example.com",
    GIT_COMMITTER_NAME: "Dev",
    GIT_COMMITTER_EMAIL: "dev@example.com",
  };
  const gitArgs = (args: string[]): string[] => [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "core.editor=true",
    ...args,
  ];
  execFileSync("git", gitArgs(["init", "-b", "main"]), { cwd: dir, env: gitEnv });
  execFileSync("git", gitArgs(["config", "user.email", "dev@example.com"]), { cwd: dir, env: gitEnv });
  execFileSync("git", gitArgs(["config", "user.name", "Dev"]), { cwd: dir, env: gitEnv });
  fs.writeFileSync(path.join(dir, "README"), "hello from fake seed\n");
  execFileSync("git", gitArgs(["add", "README"]), { cwd: dir, env: gitEnv });
  execFileSync("git", gitArgs(["commit", "-m", "initial"]), { cwd: dir, env: gitEnv });
  const commit = execFileSync("git", gitArgs(["rev-parse", "HEAD"]), { cwd: dir, encoding: "utf8", env: gitEnv }).trim();
  return { dir, commit };
}

function craftTar(kind: "safe" | "traverse"): string {
  const dest = path.join(os.tmpdir(), `pi-pod-fake-tar-${kind}-${Date.now()}.tar.gz`);
  const py = `
import io, sys, tarfile
dest, kind = sys.argv[1], sys.argv[2]
with tarfile.open(dest, "w:gz") as tar:
    def add_file(name, data=b"ok\\n", mode=0o644):
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = mode
        tar.addfile(info, io.BytesIO(data))
    if kind == "safe":
        add_file("hello.txt", b"from archive\\n")
    elif kind == "traverse":
        add_file("../evil", b"nope")
`;
  execFileSync("python3", ["-c", py, dest, kind]);
  return dest;
}

describe("fake provider workspace seed filesystem", () => {
  it("canonicalizes a symlinked temp root before enforcing containment", () => {
    const realTemp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-fake-temp-real-"));
    const tempAlias = `${realTemp}-alias`;
    fs.symlinkSync(realTemp, tempAlias, "dir");
    const script = [
      'import assert from "node:assert/strict";',
      'import * as fs from "node:fs";',
      'import * as os from "node:os";',
      'import * as path from "node:path";',
      'import { createFakeSandboxForTests } from "./dev/fake-provider.mts";',
      'const box = createFakeSandboxForTests("tmpdir-alias");',
      'const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-fake-outside-"));',
      'try {',
      '  assert.equal(box.hostRoot, fs.realpathSync(box.hostRoot));',
      '  const destination = "/tmp/pi-pod-agentd.cjs";',
      '  await box.uploadFile(destination, Buffer.from("contained"));',
      '  assert.equal(Buffer.from(await box.downloadFile(destination)).toString(), "contained");',
      '  fs.symlinkSync(outside, path.join(box.hostRoot, "escape"), "dir");',
      '  await assert.rejects(box.uploadFile("/escape/leak", Buffer.from("no")), /private root/);',
      '  await assert.rejects(box.downloadFile("/escape/leak"), /private root/);',
      '  assert.equal(fs.existsSync(path.join(outside, "leak")), false);',
      '  console.log("contained");',
      '} finally { await box.delete(); fs.rmSync(outside, {recursive:true, force:true}); }',
    ].join("\n");
    try {
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: process.cwd(),
          env: { ...process.env, TMPDIR: tempAlias, TMP: tempAlias, TEMP: tempAlias },
          encoding: "utf8",
        },
      );
      assert.match(output, /contained/);
    } finally {
      fs.rmSync(tempAlias, { recursive: true, force: true });
      fs.rmSync(realTemp, { recursive: true, force: true });
    }
  });

  it("maps absolute uploads/downloads into the private root and rejects symlink escapes", async () => {
    const box = sandbox();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-fake-outside-"));
    try {
      const destination = "/tmp/pi-pod-agentd.cjs";
      const mapped = box.hostPath(destination);
      assert.ok(mapped.startsWith(`${box.hostRoot}${path.sep}`));
      await box.uploadFile(destination, Buffer.from("sandbox-only"));
      assert.equal(fs.readFileSync(mapped, "utf8"), "sandbox-only");
      assert.deepEqual(Buffer.from(await box.downloadFile(destination)), Buffer.from("sandbox-only"));

      fs.symlinkSync(outside, path.join(box.hostRoot, "escape"));
      await assert.rejects(
        box.uploadFile("/escape/outside.txt", Buffer.from("must not escape")),
        /escapes its private root/
      );
      await assert.rejects(box.downloadFile("/escape/missing.txt"), /escapes its private root/);
      assert.equal(fs.existsSync(path.join(outside, "outside.txt")), false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports an empty mapped /workspace", async () => {
    const box = sandbox();
    const result = await box.exec(["python3", "-c", workspaceEmptyCheckSource(), "/workspace"]);
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual(decodeWorkspaceEmptyCheck(result.output ?? ""), { empty: true, entries: [], missing: false });
  });

  it("clones an exact local commit into /workspace", async () => {
    const box = sandbox();
    const repo = initRepo();
    const scratch = path.join(os.tmpdir(), `pi-pod-seed-clone-${Date.now()}`);
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    await box.uploadFile(`${scratch}/clone.py`, Buffer.from(workspaceCloneSource(), "utf8"), 0o700);
    const cloned = await box.exec(
      [
        "python3", `${scratch}/clone.py`, "/workspace", `${scratch}/work`,
        pathToFileURL(repo.dir).href, "main", repo.commit,
      ],
      { timeoutMs: 60_000 },
    );
    assert.equal(cloned.exitCode, 0, cloned.output);
    const decoded = decodeWorkspaceCloneResult(cloned.output ?? "");
    assert.equal(decoded.commit, repo.commit);
    assert.ok(decoded.entries >= 1);
    const readme = fs.readFileSync(path.join(box.hostRoot, "workspace", "README"), "utf8");
    assert.equal(readme, "hello from fake seed\n");
    const empty = await box.exec(["python3", "-c", workspaceEmptyCheckSource(), "/workspace"]);
    assert.equal(decodeWorkspaceEmptyCheck(empty.output ?? "").empty, false);
  });

  it("extracts a safe archive and rejects path traversal", async () => {
    const box = sandbox();
    const scratch = path.join(os.tmpdir(), `pi-pod-seed-extract-${Date.now()}`);
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    await box.uploadFile(`${scratch}/extract.py`, Buffer.from(workspaceArchiveExtractSource(), "utf8"), 0o700);

    const safe = craftTar("safe");
    await box.uploadLocalFile(safe, `${scratch}/archive.tgz`, { mode: 0o600 });
    const extracted = await box.exec(
      ["python3", `${scratch}/extract.py`, "/workspace", `${scratch}/archive.tgz`, `${scratch}/staging`, "1048576", "100", "1"],
      { timeoutMs: 30_000 },
    );
    assert.equal(extracted.exitCode, 0, extracted.output);
    const decoded = decodeWorkspaceArchiveResult(extracted.output ?? "");
    assert.equal(decoded.entries, 1);
    assert.equal(fs.readFileSync(path.join(box.hostRoot, "workspace", "hello.txt"), "utf8"), "from archive\n");

    const box2 = sandbox();
    const scratch2 = path.join(os.tmpdir(), `pi-pod-seed-extract-bad-${Date.now()}`);
    fs.mkdirSync(scratch2, { recursive: true, mode: 0o700 });
    await box2.uploadFile(`${scratch2}/extract.py`, Buffer.from(workspaceArchiveExtractSource(), "utf8"), 0o700);
    const evil = craftTar("traverse");
    await box2.uploadLocalFile(evil, `${scratch2}/archive.tgz`, { mode: 0o600 });
    const rejected = await box2.exec(
      ["python3", `${scratch2}/extract.py`, "/workspace", `${scratch2}/archive.tgz`, `${scratch2}/staging`, "1048576", "100", "1"],
      { timeoutMs: 30_000 },
    );
    assert.notEqual(rejected.exitCode, 0);
    assert.match(rejected.output ?? "", /unsafe path|error/i);
    assert.equal(fs.existsSync(path.join(box2.hostRoot, "workspace", "evil")), false);
  });
});
