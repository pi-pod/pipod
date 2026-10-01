import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { decodeReceiveManifest, receiveManifestSource, sendPlacerSource } from "../src/server/pods/files.js";

describe("send placement", () => {
  /**
   * The placer never renames out of staging: the workdir may be a different filesystem, so a
   * rename from /tmp can fail with EXDEV and the whole send dies. It copies beside the
   * destination and swaps from there instead, which this exercises verbatim.
   */
  function place(entries: unknown[]): { status: number | null; stderr: string; workdir: string; staging: string; cleanup: () => void } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-placer-"));
    const workdir = path.join(tmp, "work");
    const staging = path.join(tmp, "staging");
    fs.mkdirSync(workdir);
    fs.mkdirSync(staging);
    for (const entry of entries as Array<{ relPath: string; kind: string; body?: string }>) {
      if (entry.kind !== "file") continue;
      const src = path.join(staging, entry.relPath);
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, entry.body ?? "");
    }
    const manifest = path.join(tmp, "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify(entries));
    const result = spawnSync("python3", ["-c", sendPlacerSource(), workdir, staging, manifest], { encoding: "utf8" });
    return { status: result.status, stderr: result.stderr, workdir, staging, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  }

  it("places a tree with its modes and empties the staging copy", () => {
    const run = place([
      { relPath: "src", kind: "dir" },
      { relPath: "src/app.ts", kind: "file", body: "export const x = 1;\n", mode: 0o600 },
      { relPath: "README.md", kind: "file", body: "# hi\n", mode: 0o644 },
    ]);
    try {
      assert.equal(run.status, 0, run.stderr);
      assert.equal(fs.readFileSync(path.join(run.workdir, "src", "app.ts"), "utf8"), "export const x = 1;\n");
      assert.equal(fs.statSync(path.join(run.workdir, "src", "app.ts")).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(run.workdir, "README.md")).mode & 0o777, 0o644);
      assert.equal(fs.existsSync(path.join(run.staging, "README.md")), false, "staging is consumed");
      assert.deepEqual(
        fs.readdirSync(run.workdir).sort(),
        ["README.md", "src"],
        "no partial file may survive a placement",
      );
    } finally {
      run.cleanup();
    }
  });

  it("refuses to reuse anything already sitting where it stages the copy", () => {
    const run = place([{ relPath: "app.ts", kind: "file", body: "new\n", mode: 0o644 }]);
    try {
      const secret = path.join(run.workdir, "..", "secret.txt");
      fs.writeFileSync(secret, "untouched\n");
      fs.symlinkSync(secret, path.join(run.workdir, "app.ts.pi-pod-partial"));
      fs.writeFileSync(path.join(run.staging, "app.ts"), "new\n");
      const again = spawnSync(
        "python3",
        ["-c", sendPlacerSource(), run.workdir, run.staging, path.join(run.workdir, "..", "manifest.json")],
        { encoding: "utf8" },
      );
      assert.notEqual(again.status, 0);
      assert.match(again.stderr, /FileExistsError/);
      assert.equal(fs.readFileSync(secret, "utf8"), "untouched\n");
    } finally {
      run.cleanup();
    }
  });
});

describe("receive manifest snapshot", () => {
  it("snapshots a binary tree before the server downloads it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-receive-manifest-"));
    const workdir = path.join(tmp, "work");
    const staging = path.join(tmp, "staging");
    try {
      fs.mkdirSync(path.join(workdir, "artifacts", "nested"), { recursive: true });
      const expected = Buffer.from([0, 1, 2, 255]);
      fs.writeFileSync(path.join(workdir, "artifacts", "nested", "result.bin"), expected);
      fs.symlinkSync("nested/result.bin", path.join(workdir, "artifacts", "latest"));
      const result = spawnSync(
        "python3",
        ["-c", receiveManifestSource(), workdir, "artifacts", staging],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const manifest = decodeReceiveManifest(result.stdout.trim());
      assert.equal(manifest.bytes, expected.byteLength);
      assert.deepEqual(fs.readFileSync(path.join(staging, "tree", "nested", "result.bin")), expected);
      assert.equal(manifest.entries.find((entry) => entry.relPath === "latest")?.target, "nested/result.bin");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
