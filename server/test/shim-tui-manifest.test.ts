/**
 * Shim v13's `tui_manifest` control command: a disk-fidelity snapshot of the pod's pi
 * config for the launcher's local TUI. These tests drive the generated script with a fake
 * pi and a temp HOME, and assert the projection, the caps, and the digest semantics.
 */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { disposeShimTree, spawnShimTree } from "./shim-process-tree.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { RemoteRpcClient, type FrameChannel } from "../src/core/client/rpc.js";
import { buildAgentdScript } from "../src/core/shim/agentd.js";

function channelFor(child: ChildProcessWithoutNullStreams): FrameChannel {
  return {
    write: (data) => child.stdin.write(data),
    onData: (cb) => child.stdout.on("data", cb),
    close: () => child.stdin.end(),
  };
}

interface Harness {
  child: ChildProcessWithoutNullStreams;
  rpc: RemoteRpcClient;
  home: string;
  agentDir: string;
  dispose(): Promise<void>;
}

async function startShim(prepare: (agentDir: string) => void): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-manifest-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const home = path.join(tmp, "home");
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    prepare(agentDir);
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(shimPath, buildAgentdScript({ exitCodeFile: path.join(tmp, "exit-code") }));
    const piScript = "setInterval(() => {}, 1000);";
    child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: { ...process.env, HOME: home },
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    await rpc.waitForHello(5_000);
    const owned = child;
    return {
      child: owned,
      rpc,
      home,
      agentDir,
      dispose: async () => {
        // Reap the whole tree before removing the cwd: deleting tmp while the
        // fake pi still runs leaves an orphan with a deleted cwd.
        await disposeShimTree(owned);
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // Startup failure (e.g. hello timeout) must not leak the tree or the tmp dir.
    if (child) await disposeShimTree(child);
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

describe("shim tui_manifest", () => {
  it("projects display keys, themes and extensions; never command-valued keys or auth.json", async () => {
    const harness = await startShim((agentDir) => {
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          theme: "pod-dark",
          hideThinkingBlock: true,
          editorPaddingX: 2,
          externalEditor: "evil-editor --wait",
          shellPath: "/bin/evil",
          npmCommand: ["curl", "http://evil"],
          packages: [
            "npm:@scope/some-ext@1.2.3",
            { source: "npm:filtered-ext@2.0.0", extensions: ["extensions/*.ts"] },
            "git:github.com/example/ignored",
            "npm:../unsafe@1.0.0",
            "npm:@scope/some-ext@1.2.3",
          ],
        }),
      );
      fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ token: "secret" }));
      fs.mkdirSync(path.join(agentDir, "themes"), { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "themes", "pod-dark.json"),
        JSON.stringify({ name: "pod-dark", colors: { accent: "#ff0000" } }),
      );
      fs.writeFileSync(path.join(agentDir, "themes", "unsafe name.json"), "{}");
      fs.symlinkSync("/etc/hostname", path.join(agentDir, "themes", "linked.json"));
      const extDir = path.join(agentDir, "npm", "node_modules", "@scope", "some-ext");
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(
        path.join(extDir, "package.json"),
        JSON.stringify({ name: "@scope/some-ext", version: "1.2.3" }),
      );
      const filteredDir = path.join(agentDir, "npm", "node_modules", "filtered-ext");
      fs.mkdirSync(filteredDir, { recursive: true });
      fs.writeFileSync(
        path.join(filteredDir, "package.json"),
        JSON.stringify({ name: "filtered-ext", version: "2.0.0" }),
      );
      const dependencyDir = path.join(agentDir, "npm", "node_modules", "express");
      fs.mkdirSync(dependencyDir, { recursive: true });
      fs.writeFileSync(
        path.join(dependencyDir, "package.json"),
        JSON.stringify({ name: "express", version: "5.2.1" }),
      );
    });
    try {
      const reply = await harness.rpc.requestTuiManifest();
      assert.ok(reply, "manifest reply arrives");
      assert.equal(reply.v, 1);
      assert.equal(reply.unchanged, undefined);
      assert.ok(reply.digest.length > 0, "digest present");
      const manifest = reply.manifest!;
      assert.equal(manifest["fidelity"], "disk");
      assert.equal(manifest["bootDigest"], reply.digest, "no drift yet: boot digest matches");
      const uiSettings = manifest["uiSettings"] as Record<string, unknown>;
      assert.deepEqual(uiSettings, { theme: "pod-dark", hideThinkingBlock: true, editorPaddingX: 2 });
      assert.ok(!("externalEditor" in uiSettings) && !("packages" in uiSettings));
      assert.ok(!JSON.stringify(manifest).includes("secret"), "auth.json never travels");
      const themes = manifest["themes"] as Array<{ name: string; theme: Record<string, unknown> }>;
      assert.deepEqual(
        themes.map((t) => t.name),
        ["pod-dark"],
      );
      const diagnostics = manifest["diagnostics"] as string[];
      assert.ok(diagnostics.some((d) => d.includes("unsafe name")), "unsafe theme name diagnosed");
      assert.ok(diagnostics.some((d) => d.includes("symlink")), "symlinked theme diagnosed");
      const extensions = manifest["extensions"] as Array<Record<string, unknown>>;
      assert.deepEqual(extensions, [
        { name: "@scope/some-ext", version: "1.2.3", origin: "npm" },
        { name: "filtered-ext", version: "2.0.0", origin: "npm" },
      ]);
      const argv = manifest["launchArgv"] as string[];
      assert.equal(argv[0], process.execPath);
    } finally {
      await harness.dispose();
    }
  });

  it("ignores dependency churn but reports configured package and settings drift", async () => {
    const harness = await startShim((agentDir) => {
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ theme: "dark", packages: ["npm:direct-ext@1.0.0"] }),
      );
      const directDir = path.join(agentDir, "npm", "node_modules", "direct-ext");
      fs.mkdirSync(directDir, { recursive: true });
      fs.writeFileSync(
        path.join(directDir, "package.json"),
        JSON.stringify({ name: "direct-ext", version: "1.0.0" }),
      );
    });
    try {
      const first = await harness.rpc.requestTuiManifest();
      assert.ok(first?.manifest, "first request carries the manifest");

      const unchanged = await harness.rpc.requestTuiManifest(first.digest);
      assert.ok(unchanged, "unchanged reply arrives");
      assert.equal(unchanged.unchanged, true);
      assert.equal(unchanged.digest, first.digest);
      assert.equal(unchanged.manifest, undefined);

      // Session and transitive dependency churn must not read as config drift.
      const sessions = path.join(harness.agentDir, "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, "s.jsonl"), "{}\n");
      const dependencyDir = path.join(harness.agentDir, "npm", "node_modules", "transitive-dep");
      fs.mkdirSync(dependencyDir, { recursive: true });
      fs.writeFileSync(
        path.join(dependencyDir, "package.json"),
        JSON.stringify({ name: "transitive-dep", version: "1.0.0" }),
      );
      const afterUnrelatedChurn = await harness.rpc.requestTuiManifest(first.digest);
      assert.equal(afterUnrelatedChurn?.unchanged, true, "sessions and dependencies are outside the digest");

      const directPackageJson = path.join(
        harness.agentDir,
        "npm",
        "node_modules",
        "direct-ext",
        "package.json",
      );
      fs.writeFileSync(
        directPackageJson,
        JSON.stringify({ name: "direct-ext", version: "10.0.0" }),
      );
      const afterPackageUpdate = await harness.rpc.requestTuiManifest(first.digest);
      assert.ok(afterPackageUpdate?.manifest, "a configured package update changes the digest");
      assert.deepEqual(afterPackageUpdate.manifest["extensions"], [
        { name: "direct-ext", version: "10.0.0", origin: "npm" },
      ]);

      fs.writeFileSync(
        path.join(harness.agentDir, "settings.json"),
        JSON.stringify({ theme: "light", hideThinkingBlock: true, packages: ["npm:direct-ext@10.0.0"] }),
      );
      const drifted = await harness.rpc.requestTuiManifest(afterPackageUpdate.digest);
      assert.ok(drifted?.manifest, "a settings edit returns the full manifest");
      assert.notEqual(drifted.digest, afterPackageUpdate.digest);
      assert.equal(drifted.manifest["bootDigest"], first.digest, "boot digest is the boot-time truth");
      assert.deepEqual(drifted.manifest["uiSettings"], { theme: "light", hideThinkingBlock: true });
    } finally {
      await harness.dispose();
    }
  });

  it("diagnoses malformed and oversized files instead of failing the manifest", async () => {
    const harness = await startShim((agentDir) => {
      fs.writeFileSync(path.join(agentDir, "settings.json"), "{not json");
      fs.mkdirSync(path.join(agentDir, "themes"), { recursive: true });
      fs.writeFileSync(path.join(agentDir, "themes", "big.json"), `{"pad":"${"x".repeat(70 * 1024)}"}`);
      fs.writeFileSync(path.join(agentDir, "themes", "broken.json"), "[1,2,3]");
    });
    try {
      const reply = await harness.rpc.requestTuiManifest();
      const manifest = reply?.manifest;
      assert.ok(manifest, "manifest still returned");
      assert.deepEqual(manifest["uiSettings"], {});
      assert.deepEqual(manifest["themes"], []);
      const diagnostics = manifest["diagnostics"] as string[];
      assert.ok(diagnostics.some((d) => d.startsWith("settings.json: invalid JSON")));
      assert.ok(diagnostics.some((d) => d.includes("big.json") && d.includes("bytes")));
      assert.ok(diagnostics.some((d) => d.includes("broken.json") && d.includes("not a JSON object")));
    } finally {
      await harness.dispose();
    }
  });
});
