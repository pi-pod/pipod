import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import Fastify, { type FastifyReply } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { registerProvider } from "../src/core/providers/registry.js";
import type { ExecOpts, Sandbox, SandboxProvider } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import { LaunchBody, registerPodRoutes } from "../src/server/pods/routes.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { snapshotPlatformCredentials } from "../src/server/pods/providercred.js";
import {
  SEED_RATE_MAX_REQUESTS,
  resetWorkspaceSeedRateLimits,
} from "../src/server/pods/workspace-seed.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { writeLayer } from "../src/server/settings/merge.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const log = { info: () => {}, warn: () => {}, error: () => {} };
const USERNAME = "x-access-token";
const PASSWORD = "ghp_SUPERSECRETTOKEN1234";
const CLONE_URL = "https://git.test/repo.git";
const MISSING_URL = "https://git.test/missing.git";
const GITHUB_URL = "https://github.com/test/repo.git";
const GITLAB_URL = "https://gitlab.com/x/y.git";

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
        add_file("../evil", b"nope")
    elif kind == "escape-symlink":
        info = tarfile.TarInfo("link")
        info.type = tarfile.SYMTYPE
        info.linkname = "../../outside"
        tar.addfile(info)
    elif kind == "safe-symlink":
        add_file("hello.txt", b"hello\\n", 0o640)
        info = tarfile.TarInfo("link")
        info.type = tarfile.SYMTYPE
        info.linkname = "hello.txt"
        tar.addfile(info)
    elif kind == "three-then-traverse":
        add_file("a.txt", b"a")
        add_file("b.txt", b"b")
        add_file("c.txt", b"c")
        add_file("../evil", b"nope")
    elif kind == "bomb-entries":
        n = int(sys.argv[3])
        for i in range(n):
            add_file("e%05d" % i, b"")
    elif kind == "gzip-bomb":
        data = b"\\x00" * int(sys.argv[3])
        add_file("zeros", data)
    else:
        raise SystemExit("unknown kind")
`;

function git(cwd: string, args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "init.defaultBranch=main",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "core.editor=true",
      ...args,
    ],
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
  return (result.stdout ?? "").trim();
}

function mapRemotePath(root: string, remote: string): string {
  if (!path.isAbsolute(remote)) return remote;
  return path.join(root, remote.replace(/^\/+/, ""));
}

function remapArgv(root: string, argv: string[]): string[] {
  return argv.map((arg, index) => {
    if (index === 0) return arg;
    if (argv[0] === "python3" && argv[1] === "-c" && index === 2) return arg;
    if (path.isAbsolute(arg)) return mapRemotePath(root, arg);
    return arg;
  });
}

function treeContains(dir: string, needle: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.name.includes(needle)) return true;
      if (entry.isSymbolicLink()) {
        try {
          if (fs.readlinkSync(full).includes(needle)) return true;
        } catch {
          // ignore
        }
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) {
        try {
          if (fs.readFileSync(full).includes(needle)) return true;
        } catch {
          // ignore
        }
      }
    }
  }
  return false;
}

function archiveTemps(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-pod-archive-"));
}

function craftArchive(kind: string, extra: string[] = []): Buffer {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-seed-test-craft-"));
  const dest = path.join(tmp, "a.tgz");
  try {
    const result = spawnSync("python3", ["-c", CRAFT_MEMBER, dest, kind, ...extra], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "craftArchive failed");
    return fs.readFileSync(dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function buildTarFromTree(build: (dir: string) => void): Buffer {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-seed-test-tar-"));
  try {
    const src = path.join(tmp, "src");
    fs.mkdirSync(src);
    build(src);
    const archive = path.join(tmp, "a.tgz");
    const tar = spawnSync("tar", ["-czf", archive, "-C", src, "."], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(tar.stderr || "tar failed");
    return fs.readFileSync(archive);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("workspace seed routes (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  const rootId = uuidv7();
  const childId = uuidv7();
  const unrelatedId = uuidv7();
  const gatedId = uuidv7();
  const allowlistedId = uuidv7();
  const freshGatedId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  // Boot-shaped env (mirrors main(): keys live in the parsed env, never ambient). The
  // threaded snapshot below is what withProviderCredential consumes as platform fallback.
  const env = {
    GATEWAY_ID: "gateway-workspace-seed-routes",
    PI_POD_SANDBOX_TOKEN: "test-provider-token",
    WORKSPACE_ARCHIVE_MAX_COMPRESSED_BYTES: 64 * 1024,
    WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES: 1024 * 1024,
    WORKSPACE_ARCHIVE_MAX_ENTRIES: 50,
    WORKSPACE_SEED_TIMEOUT_SECONDS: 120,
    WORKSPACE_SEED_GATE_TIMEOUT_SECONDS: 600,
    POD_MAX_CONCURRENT_PER_USER: 10,
  } as unknown as ServerEnv;
  const started: string[] = [];
  const deps: PodServiceDeps = {
    env,
    kek,
    log,
    onPodStarted: (id) => started.push(id),
    platformCredentials: snapshotPlatformCredentials(env),
  };
  const execs: { argv: string[]; env?: Record<string, string> }[] = [];
  const podRoots = new Map<string, string>();
  const sandboxes = new Map<string, Sandbox>();
  const initialConfigs = new Map<string, string>();
  let gitRoot = "";
  let bareRepo = "";
  let commit = "";
  let auth = {
    userId,
    email: `${userId}@example.test`,
    orgId,
    permissions: [] as string[],
    podId: undefined as string | undefined,
  };
  let app: ReturnType<typeof Fastify>;

  const openResolved = {
    config: { providers: {}, egress: { mode: "open" as const, builtins: true, allow: [] as string[] } },
    egress: { mode: "open" as const, description: "open" },
    workdir: "/workspace",
    warnings: [] as string[],
  };
  const allowlistedResolved = {
    config: {
      providers: {},
      egress: { mode: "allowlist" as const, builtins: true, allow: ["github.com"] },
    },
    egress: { mode: "allowlist" as const, description: "allowlist" },
    workdir: "/workspace",
    warnings: [] as string[],
  };

  function ownerAuth(overrides: Partial<typeof auth> = {}): typeof auth {
    return {
      userId,
      email: `${userId}@example.test`,
      orgId,
      permissions: [],
      podId: undefined,
      ...overrides,
    };
  }

  function workspaceDir(podId: string): string {
    const root = podRoots.get(podId);
    if (!root) throw new Error(`missing sandbox root for ${podId}`);
    return path.join(root, "workspace");
  }

  function scratchLeftovers(podId: string): string[] {
    const root = podRoots.get(podId);
    if (!root) return [];
    const tmp = path.join(root, "tmp");
    if (!fs.existsSync(tmp)) return [];
    return fs.readdirSync(tmp).filter((name) => name.startsWith("pi-pod-seed-"));
  }

  function resetWorkdir(podId: string): void {
    const root = podRoots.get(podId);
    if (!root) return;
    const ws = path.join(root, "workspace");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(ws, { recursive: true });
    const tmp = path.join(root, "tmp");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  function rewriteCloneUrl(url: string): string {
    if (url === CLONE_URL || url === GITHUB_URL) return `file://${bareRepo}`;
    if (url === MISSING_URL) return `file://${path.join(gitRoot, "missing.git")}`;
    return url;
  }

  function makeSandbox(id: string, root: string): Sandbox {
    return {
      id,
      exec: async (argv: string[], opts?: ExecOpts) => {
        execs.push({ argv: [...argv], env: opts?.env ? { ...opts.env } : undefined });
        const mapped = remapArgv(root, argv);
        if (argv[0] === "python3" && mapped[4]) mapped[4] = rewriteCloneUrl(mapped[4]);
        if (argv[0] === "python3" || argv[0] === "mkdir" || argv[0] === "rm") {
          const result = spawnSync(mapped[0]!, mapped.slice(1), {
            encoding: "utf8",
            env: { ...process.env, ...(opts?.env ?? {}) },
            timeout: opts?.timeoutMs ?? 60_000,
          });
          return {
            exitCode: result.status ?? 1,
            output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
          };
        }
        return { exitCode: 1, output: `unsupported command: ${argv[0] ?? ""}` };
      },
      uploadFile: async (dest: string, bytes: Uint8Array, mode?: number) => {
        const mapped = mapRemotePath(root, dest);
        fs.mkdirSync(path.dirname(mapped), { recursive: true });
        fs.writeFileSync(mapped, bytes);
        if (mode !== undefined) fs.chmodSync(mapped, mode);
      },
      uploadLocalFile: async (src: string, dest: string, opts?: { mode?: number }) => {
        const mapped = mapRemotePath(root, dest);
        fs.mkdirSync(path.dirname(mapped), { recursive: true });
        fs.copyFileSync(src, mapped);
        if (opts?.mode !== undefined) fs.chmodSync(mapped, opts.mode);
      },
      downloadFile: async (sourcePath: string) => fs.readFileSync(mapRemotePath(root, sourcePath)),
      state: async () => "started" as const,
      stop: async () => {},
      start: async () => {},
      waitUntilStarted: async () => {},
      rehydrateEnv: () => {},
    } as unknown as Sandbox;
  }

  async function insertPod(args: {
    id: string;
    parent: string | null;
    root: string;
    depth: number;
    resolved: unknown;
  }): Promise<void> {
    const sandboxId = `seed-${args.id}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-seed-fs-"));
    podRoots.set(args.id, root);
    const sandbox = makeSandbox(sandboxId, root);
    sandboxes.set(sandboxId, sandbox);
    fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
    const resolved = JSON.stringify(args.resolved);
    initialConfigs.set(args.id, resolved);
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
          resolved_config, parent_pod_id, lineage_root_id, lineage_depth)
       VALUES ($1, $2, $3, 'seed pod', 'sandbox', $4, 'active', 'started', $5::jsonb,
               $6, $7, $8)`,
      [args.id, orgId, userId, sandboxId, resolved, args.parent, args.root, args.depth],
    );
  }

  async function podConfig(podId: string): Promise<{
    workspaceSeed?: {
      status?: string;
      kind?: string;
      host?: string;
      branch?: string;
      commit?: string;
      credentialed?: boolean;
      durationMs?: number;
      bytes?: number;
      reason?: string;
      entries?: number;
    };
    timings?: { workspaceSeed?: number };
  }> {
    const rows = await query<{ resolved_config: Record<string, unknown> }>(
      "SELECT resolved_config FROM pods WHERE id = $1",
      [podId],
    );
    return (rows.rows[0]?.resolved_config ?? {}) as ReturnType<typeof podConfig> extends Promise<infer T> ? T : never;
  }

  async function seedAudits(podId: string): Promise<{ detail: Record<string, unknown> }[]> {
    const rows = await query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_log WHERE action = 'pod.workspace_seed' AND target_id = $1 ORDER BY created_at ASC",
      [podId],
    );
    return rows.rows;
  }

  function cloneBody(overrides: Record<string, unknown> = {}) {
    return { url: CLONE_URL, branch: "main", commit, ...overrides };
  }

  function postClone(podId: string, body: Record<string, unknown> = cloneBody()) {
    return app.inject({ method: "POST", url: `/pods/${podId}/workspace/clone`, payload: body });
  }

  function putArchive(podId: string, body: Buffer, headers: Record<string, string> = {}) {
    return app.inject({
      method: "PUT",
      url: `/pods/${podId}/workspace/archive`,
      headers: {
        "content-type": "application/x-tar+gzip",
        "content-length": String(body.length),
        ...headers,
      },
      payload: body,
    });
  }

  function postSkip(podId: string, body?: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/pods/${podId}/workspace/skip`,
      ...(body ? { payload: body } : {}),
    });
  }

  const provider = {
    name: "sandbox",
    capabilities: {},
    get: async (id: string) => sandboxes.get(id) ?? null,
  } as unknown as SandboxProvider;

  before(async () => {
    initPool(databaseUrl!);

    gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-seed-git-"));
    const work = path.join(gitRoot, "work");
    fs.mkdirSync(work);
    git(work, ["init", "-b", "main"]);
    git(work, ["config", "user.email", "test@example.com"]);
    git(work, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(work, "README.md"), "hello\n");
    fs.mkdirSync(path.join(work, "src"));
    fs.writeFileSync(path.join(work, "src", "app.ts"), "export {}\n");
    git(work, ["add", "README.md", "src/app.ts"]);
    git(work, ["commit", "-m", "first"]);
    commit = git(work, ["rev-parse", "HEAD"]);
    bareRepo = path.join(gitRoot, "repo.git");
    git(gitRoot, ["clone", "--bare", work, bareRepo]);
    fs.writeFileSync(path.join(work, "README.md"), "hello2\n");
    git(work, ["add", "README.md"]);
    git(work, ["commit", "-m", "second"]);
    git(work, ["push", bareRepo, "main"]);

    registerProvider("sandbox", async () => () => provider);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'workspace seed route test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [otherUserId, `${otherUserId}@example.test`]);

    const pending = () => ({
      ...openResolved,
      workspaceSeed: { status: "pending", requestedAt: new Date().toISOString() },
    });
    await insertPod({ id: rootId, parent: null, root: rootId, depth: 0, resolved: openResolved });
    await insertPod({ id: childId, parent: rootId, root: rootId, depth: 1, resolved: openResolved });
    await insertPod({ id: unrelatedId, parent: null, root: unrelatedId, depth: 0, resolved: openResolved });
    await insertPod({ id: gatedId, parent: null, root: gatedId, depth: 0, resolved: pending() });
    await insertPod({ id: allowlistedId, parent: null, root: allowlistedId, depth: 0, resolved: allowlistedResolved });
    await insertPod({ id: freshGatedId, parent: null, root: freshGatedId, depth: 0, resolved: pending() });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error: unknown, _req: unknown, reply: FastifyReply) => {
      if (error instanceof HttpError) {
        return reply.code(error.statusCode).send({ error: error.message, detail: error.detail ?? null });
      }
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === "number" && statusCode < 500) {
        const validation = (error as { validation?: unknown }).validation;
        return reply.code(statusCode).send({ error: (error as Error).message, detail: validation ?? null });
      }
      return reply.code(500).send({ error: "internal server error", detail: (error as Error).message });
    });
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      req.auth = auth;
    });
    registerPodRoutes(app, deps, null);
    await app.ready();
  });

  beforeEach(async () => {
    auth = ownerAuth();
    execs.length = 0;
    started.length = 0;
    resetWorkspaceSeedRateLimits();
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    for (const id of podRoots.keys()) resetWorkdir(id);
    for (const [id, config] of initialConfigs) {
      let resolved = config;
      if (id === gatedId || id === freshGatedId) {
        const parsed = JSON.parse(config) as { workspaceSeed?: { status: string; requestedAt: string } };
        parsed.workspaceSeed = { status: "pending", requestedAt: new Date().toISOString() };
        resolved = JSON.stringify(parsed);
      }
      await query("UPDATE pods SET resolved_config = $2::jsonb WHERE id = $1", [id, resolved]);
    }
  });

  after(async () => {
    await app.close();
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("UPDATE pods SET parent_pod_id = NULL WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = ANY($1)", [[userId, otherUserId]]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
    registerProvider("sandbox", async () => (await import("../src/core/providers/sandbox.js")).createSandboxProvider);
    for (const root of podRoots.values()) fs.rmSync(root, { recursive: true, force: true });
    if (gitRoot) fs.rmSync(gitRoot, { recursive: true, force: true });
  });

  it("1. user JWT can seed own pod; other users need pods:manage_any", async () => {
    const own = await postClone(rootId);
    assert.equal(own.statusCode, 200, own.body);

    execs.length = 0;
    auth = ownerAuth({ userId: otherUserId });
    const refused = await postClone(rootId);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(execs.length, 0);

    resetWorkdir(rootId);
    auth = ownerAuth({ userId: otherUserId, permissions: ["pods:manage_any"] });
    const managed = await postClone(rootId);
    assert.equal(managed.statusCode, 200, managed.body);
  });

  it("2. pod token may seed descendants only and audits fromPod", async () => {
    auth = ownerAuth({ podId: rootId });
    const allowed = await postClone(childId);
    assert.equal(allowed.statusCode, 200, allowed.body);
    const audits = await seedAudits(childId);
    assert.equal(audits[0]?.detail.fromPod, rootId);

    execs.length = 0;
    const refused = await postClone(unrelatedId);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(execs.length, 0);
  });

  it("3. org policy allowFileSend=false blocks pod tokens before exec, not user JWTs", async () => {
    await writeLayer({
      scopeType: "org_policy",
      scopeId: orgId,
      orgId,
      config: { nestedPods: { allowFileSend: false } },
      expectedVersion: 0,
      updatedBy: userId,
    });

    auth = ownerAuth({ podId: rootId });
    const refused = await postClone(childId);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.match(refused.body, /allowFileSend/);
    assert.equal(execs.length, 0);

    auth = ownerAuth();
    const allowed = await postClone(rootId);
    assert.equal(allowed.statusCode, 200, allowed.body);
  });

  it("4. clone happy path seeds workdir, report, timings, and audit without credentials", async () => {
    const response = await postClone(rootId);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      kind: string;
      status: string;
      commit: string;
      entries: number;
      piStarting: boolean;
    };
    assert.equal(body.kind, "clone");
    assert.equal(body.status, "seeded");
    assert.equal(body.commit, commit);
    assert.ok(body.entries > 0);
    assert.equal(body.piStarting, false);

    const ws = workspaceDir(rootId);
    assert.equal(fs.existsSync(path.join(ws, "README.md")), true);
    assert.equal(fs.existsSync(path.join(ws, ".git")), true);
    const head = spawnSync("git", ["-C", ws, "rev-parse", "HEAD"], {
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
    assert.equal(head.stdout.trim(), commit);
    const branch = spawnSync("git", ["-C", ws, "rev-parse", "--abbrev-ref", "HEAD"], {
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
    assert.equal(branch.stdout.trim(), "main");
    const gitConfig = fs.readFileSync(path.join(ws, ".git", "config"), "utf8");
    assert.doesNotMatch(gitConfig, /credential/);

    const resolved = await podConfig(rootId);
    assert.equal(resolved.workspaceSeed?.status, "seeded");
    assert.equal(resolved.workspaceSeed?.host, "git.test");
    assert.equal(resolved.workspaceSeed?.branch, "main");
    assert.equal(resolved.workspaceSeed?.commit, commit);
    assert.equal(resolved.workspaceSeed?.credentialed, false);
    assert.equal(typeof resolved.workspaceSeed?.durationMs, "number");
    assert.equal(typeof resolved.timings?.workspaceSeed, "number");

    const audits = await seedAudits(rootId);
    const detail = audits[0]?.detail ?? {};
    assert.equal(detail.kind, "clone");
    assert.equal(detail.host, "git.test");
    assert.equal(detail.branch, "main");
    assert.equal(detail.commit, commit);
    assert.equal(detail.credentialed, false);
    assert.equal(JSON.stringify(detail).includes("password"), false);
  });

  it("5. credentialed clone keeps the password off argv, responses, audit, report, and .git", async () => {
    const response = await postClone(rootId, cloneBody({ credential: { username: USERNAME, password: PASSWORD } }));
    assert.equal(response.statusCode, 200, response.body);
    const cloneCall = execs.find((call) => call.argv.some((arg) => arg.endsWith("clone.py")));
    assert.ok(cloneCall, "clone.py exec was not recorded");
    assert.equal(cloneCall.env?.["PI_POD_GIT_PASSWORD"], PASSWORD);
    const argvText = cloneCall.argv.join("\0");
    assert.equal(argvText.includes(PASSWORD), false);
    assert.equal(argvText.includes(USERNAME), false);
    assert.equal(response.body.includes(PASSWORD), false);

    const audits = await seedAudits(rootId);
    assert.equal(JSON.stringify(audits).includes(PASSWORD), false);
    const rows = await query<{ resolved_config: unknown }>("SELECT resolved_config FROM pods WHERE id = $1", [rootId]);
    assert.equal(JSON.stringify(rows.rows[0]?.resolved_config).includes(PASSWORD), false);
    assert.equal(treeContains(path.join(workspaceDir(rootId), ".git"), PASSWORD), false);
  });

  it("6. failed credentialed clone is 4xx, redacted, marks failed, and leaves the workdir empty", async () => {
    const response = await postClone(
      rootId,
      cloneBody({ url: MISSING_URL, credential: { username: USERNAME, password: PASSWORD } }),
    );
    assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body);
    assert.equal(response.body.includes(PASSWORD), false);
    const resolved = await podConfig(rootId);
    assert.equal(resolved.workspaceSeed?.status, "failed");
    assert.equal(typeof resolved.workspaceSeed?.reason, "string");
    assert.equal((resolved.workspaceSeed?.reason ?? "").includes(PASSWORD), false);
    assert.deepEqual(fs.readdirSync(workspaceDir(rootId)), []);
    assert.deepEqual(scratchLeftovers(rootId), []);
  });

  it("7. clone of an older commit resets HEAD to the requested sha", async () => {
    const response = await postClone(rootId);
    assert.equal(response.statusCode, 200, response.body);
    const head = spawnSync("git", ["-C", workspaceDir(rootId), "rev-parse", "HEAD"], {
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
    assert.equal(head.stdout.trim(), commit);
  });

  it("8. populated workdir clone returns 409 workspace_not_empty and does not clone", async () => {
    const marker = path.join(workspaceDir(rootId), "keep.txt");
    fs.writeFileSync(marker, "keep\n");
    const response = await postClone(rootId);
    assert.equal(response.statusCode, 409, response.body);
    const body = response.json() as { error: string; detail: { code?: string } };
    assert.equal(body.error, "workspace_not_empty");
    assert.equal(body.detail.code, "workspace_not_empty");
    assert.equal(fs.readFileSync(marker, "utf8"), "keep\n");
    assert.equal(fs.existsSync(path.join(workspaceDir(rootId), ".git")), false);
  });

  it("9. clone schema rejects http, userinfo, IP hosts, bad branches, and non-hex commits without exec", async () => {
    const cases = [
      cloneBody({ url: "http://git.test/repo.git" }),
      cloneBody({ url: "https://user:pass@git.test/repo.git" }),
      cloneBody({ url: "https://127.0.0.1/repo.git" }),
      cloneBody({ url: "https://[::1]/repo.git" }),
      cloneBody({ branch: "-x" }),
      cloneBody({ branch: "a..b" }),
      cloneBody({ branch: "refs/heads/main" }),
      cloneBody({ commit: "not-a-hex-commit" }),
    ];
    for (const body of cases) {
      execs.length = 0;
      const response = await postClone(rootId, body);
      assert.equal(response.statusCode, 400, `${JSON.stringify(body)} -> ${response.body}`);
      assert.equal(execs.length, 0, JSON.stringify(body));
    }
  });

  it("10. allowlist egress refuses gitlab.com before exec and accepts github.com", async () => {
    const refused = await postClone(allowlistedId, cloneBody({ url: GITLAB_URL }));
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(execs.length, 0);

    const allowed = await postClone(allowlistedId, cloneBody({ url: GITHUB_URL }));
    assert.notEqual(allowed.statusCode, 403, allowed.body);
    assert.ok(execs.length > 0);
  });

  it("11. archive happy path extracts files, modes, symlink, report, audit, and cleans temps", async () => {
    const beforeTemps = new Set(archiveTemps());
    const archive = buildTarFromTree((dir) => {
      fs.writeFileSync(path.join(dir, "hello.txt"), "hello\n");
      fs.mkdirSync(path.join(dir, "nested", "dir"), { recursive: true });
      fs.writeFileSync(path.join(dir, "nested", "dir", "file.txt"), "nested\n");
      const run = path.join(dir, "run.sh");
      fs.writeFileSync(run, "#!/bin/sh\necho hi\n");
      fs.chmodSync(run, 0o755);
      fs.symlinkSync("hello.txt", path.join(dir, "link"));
    });
    const response = await putArchive(rootId, archive);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      kind: string;
      status: string;
      bytes: number;
      uncompressedBytes: number;
      entries: number;
      piStarting: boolean;
    };
    assert.equal(body.kind, "archive");
    assert.equal(body.status, "seeded");
    assert.equal(body.bytes, archive.length);
    assert.ok(body.uncompressedBytes > 0);
    assert.ok(body.entries > 0);
    assert.equal(body.piStarting, false);

    const ws = workspaceDir(rootId);
    assert.equal(fs.readFileSync(path.join(ws, "hello.txt"), "utf8"), "hello\n");
    assert.equal(fs.readFileSync(path.join(ws, "nested", "dir", "file.txt"), "utf8"), "nested\n");
    assert.equal(fs.statSync(path.join(ws, "run.sh")).mode & 0o777, 0o755);
    assert.equal(fs.readlinkSync(path.join(ws, "link")), "hello.txt");

    const resolved = await podConfig(rootId);
    assert.equal(resolved.workspaceSeed?.status, "seeded");
    // The report keeps the compressed size the client sent; the extractor's uncompressed
    // total is audit-only and must not overwrite it.
    assert.equal(resolved.workspaceSeed?.bytes, archive.length);
    assert.equal(resolved.workspaceSeed?.entries, body.entries);
    const audits = await seedAudits(rootId);
    const detail = audits[0]?.detail ?? {};
    assert.equal(detail.kind, "archive");
    assert.equal(detail.bytes, archive.length);
    assert.equal(typeof detail.entries, "number");
    assert.deepEqual(scratchLeftovers(rootId), []);
    const leftover = archiveTemps().filter((name) => !beforeTemps.has(name));
    assert.deepEqual(leftover, []);
  });

  it("12. hostile archive members are 400 and leave the workdir empty", async () => {
    const kinds = ["traverse", "absolute", "hardlink", "fifo", "chr", "escape-symlink"] as const;
    for (const kind of kinds) {
      resetWorkdir(rootId);
      execs.length = 0;
      const response = await putArchive(rootId, craftArchive(kind));
      assert.equal(response.statusCode, 400, `${kind}: ${response.body}`);
      assert.deepEqual(fs.readdirSync(workspaceDir(rootId)), [], kind);
      assert.deepEqual(scratchLeftovers(rootId), [], kind);
    }
  });

  it("13. partial archive with a later traversal member rolls back to an empty workdir", async () => {
    const response = await putArchive(rootId, craftArchive("three-then-traverse"));
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(fs.readdirSync(workspaceDir(rootId)), []);
    assert.deepEqual(scratchLeftovers(rootId), []);
  });

  it("14. pod tokens may not send archive symlinks; user JWTs may", async () => {
    const archive = craftArchive("safe-symlink");
    auth = ownerAuth({ podId: rootId });
    const refused = await putArchive(childId, archive);
    assert.equal(refused.statusCode, 400, refused.body);
    assert.deepEqual(fs.readdirSync(workspaceDir(childId)), []);

    resetWorkdir(childId);
    auth = ownerAuth();
    const allowed = await putArchive(childId, archive);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(fs.readlinkSync(path.join(workspaceDir(childId), "link")), "hello.txt");
  });

  it("15. archive compressed, declared-length, uncompressed, and entry limits", async () => {
    const beforeTemps = new Set(archiveTemps());
    const compressed = gzipSync(randomBytes(200 * 1024));
    assert.ok(compressed.length > 64 * 1024);
    const tooBig = await putArchive(rootId, compressed);
    assert.equal(tooBig.statusCode, 413, tooBig.body);
    assert.equal(execs.length, 0);
    assert.deepEqual(
      archiveTemps().filter((name) => !beforeTemps.has(name)),
      [],
    );

    execs.length = 0;
    const tiny = gzipSync(Buffer.from("tiny"));
    const declared = await putArchive(rootId, tiny, { "content-length": String(64 * 1024 + 1) });
    assert.equal(declared.statusCode, 413, declared.body);
    assert.equal(execs.length, 0);

    const bomb = await putArchive(rootId, craftArchive("gzip-bomb", [String(2 * 1024 * 1024)]));
    assert.equal(bomb.statusCode, 400, bomb.body);
    assert.match(bomb.body, /limit/i);
    assert.deepEqual(fs.readdirSync(workspaceDir(rootId)), []);

    const entries = await putArchive(rootId, craftArchive("bomb-entries", ["51"]));
    assert.equal(entries.statusCode, 400, entries.body);
    assert.deepEqual(fs.readdirSync(workspaceDir(rootId)), []);
  });

  it("16. archive requires content-length, gzip content-type, and gzip bytes", async () => {
    const missingLength = await app.inject({
      method: "PUT",
      url: `/pods/${rootId}/workspace/archive`,
      headers: {
        "content-type": "application/x-tar+gzip",
        // inject always sets Content-Length for a payload; a negative value takes the
        // same 411 branch as a missing header (`!Number.isSafeInteger || < 0`).
        "content-length": "-1",
      },
      payload: Buffer.from([0x1f, 0x8b]),
    });
    assert.equal(missingLength.statusCode, 411, missingLength.body);
    assert.equal(execs.length, 0);

    const jsonType = await app.inject({
      method: "PUT",
      url: `/pods/${rootId}/workspace/archive`,
      headers: { "content-type": "application/json" },
      payload: { nope: true },
    });
    assert.ok(jsonType.statusCode >= 400 && jsonType.statusCode < 500, jsonType.body);
    assert.equal(execs.length, 0);

    // A 1-byte body fails the gzip-magic check *after* the stream ends. A longer
    // non-gzip payload errors inside ArchiveSpoolTransform and Fastify inject never
    // settles (the same check is covered with Readable.from in workspace-seed.test.ts).
    const notGzip = await putArchive(rootId, Buffer.from([0x00]));
    assert.equal(notGzip.statusCode, 400, notGzip.body);
    assert.equal(execs.length, 0);
  });

  it("17. populated workdir archive returns 409 and leaves the file untouched", async () => {
    const marker = path.join(workspaceDir(rootId), "keep.txt");
    fs.writeFileSync(marker, "keep\n");
    const response = await putArchive(rootId, craftArchive("safe-symlink"));
    assert.equal(response.statusCode, 409, response.body);
    const body = response.json() as { error: string; detail: { code?: string } };
    assert.equal(body.error, "workspace_not_empty");
    assert.equal(body.detail.code, "workspace_not_empty");
    assert.equal(fs.readFileSync(marker, "utf8"), "keep\n");
  });

  it("18. seed gate starts Pi on success/skip and stays pending on a failed gated clone", async () => {
    const archive = buildTarFromTree((dir) => {
      fs.writeFileSync(path.join(dir, "hello.txt"), "hello\n");
    });
    const seeded = await putArchive(gatedId, archive);
    assert.equal(seeded.statusCode, 200, seeded.body);
    assert.equal(seeded.json().piStarting, true);
    assert.deepEqual(started, [gatedId]);

    const failed = await postClone(freshGatedId, cloneBody({ url: MISSING_URL }));
    assert.ok(failed.statusCode >= 400 && failed.statusCode < 500, failed.body);
    const resolved = await podConfig(freshGatedId);
    assert.equal(resolved.workspaceSeed?.status, "pending");
    assert.equal(typeof resolved.workspaceSeed?.reason, "string");
    assert.deepEqual(started, [gatedId]);

    const skipped = await postSkip(freshGatedId, { reason: "user cancelled" });
    assert.equal(skipped.statusCode, 200, skipped.body);
    assert.deepEqual(skipped.json(), { id: freshGatedId, status: "skipped", piStarting: true });
    assert.deepEqual(started, [gatedId, freshGatedId]);

    const ungated = await postSkip(rootId, { reason: "user cancelled" });
    assert.equal(ungated.statusCode, 200, ungated.body);
    assert.equal(ungated.json().piStarting, false);
    assert.deepEqual(started, [gatedId, freshGatedId]);
  });

  it("19. GET /pods/:id exposes resolvedConfig.workspaceSeed and report.workspaceSeed", async () => {
    const seeded = await postClone(rootId);
    assert.equal(seeded.statusCode, 200, seeded.body);
    const response = await app.inject({ method: "GET", url: `/pods/${rootId}` });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      resolvedConfig: { workspaceSeed?: { status?: string; kind?: string } };
      report: { workspaceSeed?: { status?: string; kind?: string } };
    };
    assert.equal(body.resolvedConfig.workspaceSeed?.status, "seeded");
    assert.equal(body.resolvedConfig.workspaceSeed?.kind, "clone");
    assert.equal(body.report.workspaceSeed?.status, "seeded");
    assert.equal(body.report.workspaceSeed?.kind, "clone");
  });

  it("20. the 11th seed request is 429", async () => {
    fs.writeFileSync(path.join(workspaceDir(rootId), "keep.txt"), "keep\n");
    for (let i = 0; i < SEED_RATE_MAX_REQUESTS; i += 1) {
      const response = await postClone(rootId);
      assert.equal(response.statusCode, 409, `attempt ${i}: ${response.body}`);
    }
    const limited = await postClone(rootId);
    assert.equal(limited.statusCode, 429, limited.body);
  });

  it("21. LaunchBody.workspaceSeed parses and co-located launches are refused", async () => {
    assert.equal(LaunchBody.safeParse({ workspaceSeed: true }).success, true);
    auth = ownerAuth({ permissions: ["pods:launch"] });
    const response = await app.inject({
      method: "POST",
      url: "/pods",
      payload: { placement: { host: rootId }, workspaceSeed: true },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /co-located/);
    // forkFrom + workspaceSeed is refused inside launchPod and needs a real provider image
    // to reach that check without provisioning; not covered here.
  });
});
