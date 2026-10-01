import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import {
  HOST_CHILD_ENV,
  childRuntimeDir,
  createHostProvider,
  formatHostSandboxId,
  parseHostSandboxId,
  type HostMachine,
} from "../src/core/providers/host.js";
import type { ExecOpts, ExecResult, SandboxSpec, SandboxState } from "../src/core/providers/types.js";
import { uuidv7 } from "../src/server/ids.js";

/** A host machine that is this machine: exec runs real bash, files are real files. */
class LocalMachine implements HostMachine {
  stateValue: SandboxState = "started";
  ensureStartedCalls = 0;
  refreshCalls = 0;

  constructor(readonly hostId: string) {}

  async state(): Promise<SandboxState> {
    return this.stateValue;
  }

  async ensureStarted(_timeoutMs: number): Promise<void> {
    this.ensureStartedCalls += 1;
    this.stateValue = "started";
  }

  exec(argv: string[], opts?: ExecOpts): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        argv[0]!,
        argv.slice(1),
        {
          cwd: opts?.cwd && fs.existsSync(opts.cwd) ? opts.cwd : undefined,
          env: { ...process.env, ...opts?.env },
          timeout: opts?.timeoutMs ?? 30_000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolve({ exitCode: typeof code === "number" ? code : 1, output: `${stdout}${stderr}` });
        },
      );
    });
  }

  async uploadFile(destPath: string, contents: Uint8Array, mode?: number): Promise<void> {
    fs.mkdirSync(destPath.slice(0, destPath.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(destPath, contents, mode !== undefined ? { mode } : {});
  }

  async uploadLocalFile(sourcePath: string, destPath: string): Promise<void> {
    fs.copyFileSync(sourcePath, destPath);
  }

  async downloadFile(sourcePath: string): Promise<Uint8Array> {
    return fs.readFileSync(sourcePath);
  }

  openPty(): Promise<never> {
    throw new Error("no PTY in this test");
  }

  async refreshActivity(): Promise<void> {
    this.refreshCalls += 1;
  }
}

const HOST_WORKDIR = "/tmp/host-provider-test-shared";

function spec(overrides: Partial<SandboxSpec> & { placement?: SandboxSpec["placement"] }): SandboxSpec {
  return {
    image: "unused",
    workdir: overrides.workdir ?? HOST_WORKDIR,
    env: overrides.env ?? {},
    labels: overrides.labels ?? {},
    archiveAfterMinutes: 0,
    idleTimeoutMinutes: 0,
    egress: { mode: "open" },
    ...(overrides.placement ? { placement: overrides.placement } : {}),
  };
}

function sharedPlacement(hostId: string): NonNullable<SandboxSpec["placement"]> {
  return { hostId, ownsWorkdir: false, hostWorkdir: HOST_WORKDIR };
}

describe("host provider", () => {
  // CI runners are unprivileged; the real default is /var/lib/pi-pod/children.
  process.env.PI_POD_HOST_CHILDREN_DIR = fs.mkdtempSync("/tmp/host-provider-children-");
  const hostId = uuidv7();
  const machine = new LocalMachine(hostId);
  const provider = createHostProvider(async (id) => (id === hostId ? machine : null));
  const cleanups: string[] = [];
  after(() => {
    for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(process.env.PI_POD_HOST_CHILDREN_DIR!, { recursive: true, force: true });
    delete process.env.PI_POD_HOST_CHILDREN_DIR;
  });

  function track(childId: string, ...extra: string[]): void {
    cleanups.push(childRuntimeDir(childId), ...extra);
  }

  it("formats and parses sandbox ids", () => {
    const id = formatHostSandboxId("h-1", "c-2");
    assert.equal(id, "host:h-1:c-2");
    assert.deepEqual(parseHostSandboxId(id), { hostId: "h-1", childId: "c-2" });
    assert.equal(parseHostSandboxId("sandbox-orphan-id"), null);
  });

  it("creates a child runtime and reports started", async () => {
    const childId = uuidv7();
    track(childId);
    const sandbox = await provider.create(
      spec({ labels: { "pi-pod-server/pod": childId }, placement: sharedPlacement(hostId) }),
    );
    assert.equal(sandbox.id, formatHostSandboxId(hostId, childId));
    assert.ok(fs.existsSync(`${childRuntimeDir(childId)}/meta.json`));
    assert.equal(await sandbox.state(), "started");
    await sandbox.waitUntilStarted(1_000);
  });

  it("refuses creation without placement, ownership of the host workdir, and unknown hosts", async () => {
    await assert.rejects(() => provider.create(spec({})), /placement/);
    await assert.rejects(
      () =>
        provider.create(
          spec({ placement: { hostId, ownsWorkdir: true, hostWorkdir: HOST_WORKDIR } }),
        ),
      /cannot own its host's workdir/,
    );
    assert.equal(await provider.get(formatHostSandboxId("nope", "child")), null);
  });

  it("merges base env under per-exec env and always carries the child marker", async () => {
    const childId = uuidv7();
    track(childId);
    const sandbox = await provider.create(
      spec({
        env: { FROM_BASE: "base", SHADOWED: "base" },
        labels: { "pi-pod-server/pod": childId },
        placement: sharedPlacement(hostId),
      }),
    );
    const result = await sandbox.exec(["bash", "-c", 'echo "$FROM_BASE/$SHADOWED/${' + HOST_CHILD_ENV + '}"'], {
      env: { SHADOWED: "exec" },
    });
    assert.equal(result.output?.trim(), `base/exec/${childId}`);
    sandbox.rehydrateEnv({ FROM_BASE: "rehydrated" });
    const after = await sandbox.exec(["bash", "-c", 'echo "$FROM_BASE"']);
    assert.equal(after.output?.trim(), "rehydrated");
  });

  it("stop kills marked process groups, is idempotent, and start clears the marker", async () => {
    const childId = uuidv7();
    track(childId);
    const sandbox = await provider.create(
      spec({ labels: { "pi-pod-server/pod": childId }, placement: sharedPlacement(hostId) }),
    );
    const started = await sandbox.exec([
      "bash",
      "-c",
      "setsid sleep 120 >/dev/null 2>&1 < /dev/null & echo $!",
    ]);
    const pid = Number(started.output?.trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `spawned pid: ${started.output}`);
    assert.ok(fs.existsSync(`/proc/${pid}`), "worker process is alive before stop");

    await sandbox.stop(5_000);
    // A double-forked survivor would still carry the env marker; assert full extinction.
    for (let i = 0; i < 20 && fs.existsSync(`/proc/${pid}`); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(!fs.existsSync(`/proc/${pid}`), "worker process is gone after stop");
    assert.equal(await sandbox.state(), "stopped");
    await sandbox.stop(5_000);
    assert.equal(await sandbox.state(), "stopped");

    await sandbox.start(5_000);
    assert.equal(await sandbox.state(), "started");
  });

  it("archive is stop", async () => {
    const childId = uuidv7();
    track(childId);
    const sandbox = await provider.create(
      spec({ labels: { "pi-pod-server/pod": childId }, placement: sharedPlacement(hostId) }),
    );
    await sandbox.archive(5_000);
    assert.equal(await sandbox.state(), "stopped");
  });

  it("mirrors a host at rest and treats stop as already met", async () => {
    const childId = uuidv7();
    track(childId);
    const resting = new LocalMachine(hostId);
    const restingProvider = createHostProvider(async () => resting);
    const sandbox = await restingProvider.create(
      spec({ labels: { "pi-pod-server/pod": childId }, placement: sharedPlacement(hostId) }),
    );
    resting.stateValue = "stopped";
    assert.equal(await sandbox.state(), "stopped");
    await sandbox.stop(5_000);
    resting.stateValue = "archived";
    assert.equal(await sandbox.state(), "archived");
    resting.stateValue = "gone";
    assert.equal(await sandbox.state(), "gone");
    // delete against an unreachable machine leaves litter but must not fail the row transition
    await sandbox.delete();

    resting.stateValue = "stopped";
    await sandbox.start(5_000);
    assert.equal(resting.ensureStartedCalls, 1);
    assert.equal(await sandbox.state(), "started");
  });

  it("delete removes the runtime dir, and the workdir only when child-owned", async () => {
    for (const ownsWorkdir of [true, false]) {
      const childId = uuidv7();
      const workdir = `/tmp/host-provider-test-${childId}`;
      track(childId, workdir);
      const sandbox = await provider.create(
        spec({
          workdir,
          labels: { "pi-pod-server/pod": childId },
          placement: { hostId, ownsWorkdir, hostWorkdir: HOST_WORKDIR },
        }),
      );
      assert.ok(fs.existsSync(workdir));
      await sandbox.delete();
      assert.ok(!fs.existsSync(childRuntimeDir(childId)), "runtime dir removed");
      assert.equal(fs.existsSync(workdir), !ownsWorkdir, `workdir ownership ${ownsWorkdir}`);
    }
  });

  it("never deletes a workdir that is the host's own, even under a corrupt ownership claim", async () => {
    const childId = uuidv7();
    track(childId);
    const sandbox = await provider.create(
      spec({ labels: { "pi-pod-server/pod": childId }, placement: sharedPlacement(hostId) }),
    );
    // Corrupt the recorded meta to claim ownership of the shared workdir; delete must still
    // refuse because the workdir equals the recorded host workdir.
    const metaPath = `${childRuntimeDir(childId)}/meta.json`;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.ownsWorkdir = true;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    fs.mkdirSync(HOST_WORKDIR, { recursive: true });
    await sandbox.delete();
    assert.ok(fs.existsSync(HOST_WORKDIR), "the host workdir survives a corrupt ownership claim");
  });

  it("reconnects by id and probes state through hints", async () => {
    const childId = uuidv7();
    track(childId);
    const created = await provider.create(
      spec({ labels: { "pi-pod-server/pod": childId }, placement: sharedPlacement(hostId) }),
    );
    const again = await provider.get(created.id, { workdir: HOST_WORKDIR });
    assert.ok(again);
    assert.equal(await again.state(), "started");
    const missing = await provider.get(formatHostSandboxId(hostId, uuidv7()));
    assert.ok(missing);
    assert.equal(await missing.state(), "gone");
  });

  it("forwards refreshActivity to the host machine", async () => {
    const childId = uuidv7();
    track(childId);
    const sandbox = await provider.create(
      spec({ labels: { "pi-pod-server/pod": childId }, placement: sharedPlacement(hostId) }),
    );
    const before = machine.refreshCalls;
    await sandbox.refreshActivity();
    assert.equal(machine.refreshCalls, before + 1);
  });
});
