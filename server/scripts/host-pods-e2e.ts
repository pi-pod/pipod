/**
 * Live manual-test harness for co-located pods (docs: host pods).
 *
 * Runs the real server stack — postgres rows, GatewayService, HTTP+WS routes, pod-token
 * auth — against a "host machine" that is THIS machine: the host pod's Sandbox executes
 * real bash, uploads real files, and the co-located child it provisions is a real agentd
 * supervising a real `pi --mode rpc`, dialing the local gateway over a real WebSocket.
 *
 * Usage: PI_POD_TEST_DATABASE_URL=postgres://… node --import tsx scripts/host-pods-e2e.ts
 * (use a dedicated, migrated database — the gateway sweeps whatever pods it finds).
 *
 * Exercises, end to end: placement launch via the pi-pod CLI (`--on self` with a pod
 * token), workdir inheritance, per-child runtime paths, gateway attach + client WS
 * session, `pi-pod list` grouping, `pi-pod list <pod>`, `pi-pod stop` (real process-group
 * kill), wake-on-attach, and host-stop cascade. Prints PASS/FAIL per step.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import WebSocket from "ws";
import { registerProvider } from "../src/core/providers/registry.js";
import type { ExecOpts, ExecResult, Sandbox, SandboxProvider } from "../src/core/providers/types.js";
import { makeAuthHook } from "../src/server/auth/plugin.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { registerGatewayRoutes } from "../src/server/gateway/routes.js";
import { GatewayService } from "../src/server/gateway/service.js";
import { mintTicket } from "../src/server/gateway/tickets.js";
import { uuidv7 } from "../src/server/ids.js";
import { runProviderPodCommand } from "../src/server/pods/lifecycle.js";
import { createPodToken } from "../src/server/pods/podtoken.js";
import { registerPodRoutes } from "../src/server/pods/routes.js";
import type { PodRow, PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
if (!databaseUrl) {
  console.error("set PI_POD_TEST_DATABASE_URL");
  process.exit(2);
}

const CLI = "/workspace/pi-pod/dist/cli.js";
const RUN_DIR = fs.mkdtempSync("/tmp/pi-pod-e2e-");
const HOST_WORKSPACE = path.join(RUN_DIR, "workspace");
fs.mkdirSync(HOST_WORKSPACE, { recursive: true });

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function step(name: string): void {
  console.log(`\n== ${name}`);
}

/** The host machine is this machine: exec is real bash, files are real files. */
function cleanBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "NODE_OPTIONS" || key.startsWith("PI_POD")) continue;
    env[key] = value;
  }
  return env;
}

const hostSandboxId = "local-machine-e2e";
let hostMachineState: "started" | "stopped" = "started";
const localHostSandbox = {
  id: hostSandboxId,
  state: async () => hostMachineState,
  waitUntilStarted: async () => {},
  start: async () => {
    hostMachineState = "started";
  },
  rehydrateEnv: () => {},
  exec: (argv: string[], opts?: ExecOpts): Promise<ExecResult> =>
    new Promise((resolve) => {
      execFile(
        argv[0]!,
        argv.slice(1),
        {
          cwd: opts?.cwd && fs.existsSync(opts.cwd) ? opts.cwd : RUN_DIR,
          env: { ...cleanBaseEnv(), ...opts?.env },
          timeout: opts?.timeoutMs ?? 60_000,
          maxBuffer: 32 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolve({ exitCode: typeof code === "number" ? code : 1, output: `${stdout}${stderr}` });
        },
      );
    }),
  uploadFile: async (destPath: string, contents: Uint8Array, mode?: number) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, contents, mode !== undefined ? { mode } : {});
  },
  uploadLocalFile: async (sourcePath: string, destPath: string) => {
    fs.copyFileSync(sourcePath, destPath);
  },
  downloadFile: async (sourcePath: string) => fs.readFileSync(sourcePath),
  openPty: async () => {
    throw new Error("openPty is not part of this harness");
  },
  setLabels: async () => {},
  applyRetention: async () => false,
  archive: async () => {},
  refreshActivity: async () => {},
  stop: async () => {
    hostMachineState = "stopped";
  },
  delete: async () => {},
} as unknown as Sandbox;

const provider = {
  name: "sandbox",
  capabilities: {},
  get: async (id: string) => (id === hostSandboxId ? localHostSandbox : null),
} as unknown as SandboxProvider;

/** Async on purpose: the server runs in this same process, so blocking would deadlock it. */
function cli(args: string[], token: string, serverUrl: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd: HOST_WORKSPACE,
        env: {
          ...cleanBaseEnv(),
          PI_POD_SERVER_URL: serverUrl,
          PI_POD_SERVER_TOKEN: token,
          NO_COLOR: "1",
        },
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === "number" ? code : 1, output: `${stdout}${stderr}` });
      },
    );
  });
}

function pgrep(pattern: string): string[] {
  try {
    return execFileSync("pgrep", ["-f", pattern]).toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForRow(podId: string, want: (row: PodRow) => boolean, ms = 60_000): Promise<PodRow> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = await query<PodRow>("SELECT * FROM pods WHERE id = $1", [podId]);
    const row = rows.rows[0];
    if (row && want(row)) return row;
    if (Date.now() > deadline) {
      throw new Error(`pod ${podId} never reached the wanted state (now: ${row?.provider_state}/${row?.state_reason})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  initPool(databaseUrl!);
  process.env["PI_POD_SANDBOX_TOKEN"] = "e2e-provider-token";
  registerProvider("sandbox", async () => () => provider);

  const orgId = uuidv7();
  const userId = uuidv7();
  const hostPodId = uuidv7();
  const kek = new EnvKekProvider("e2e-kek", randomBytes(32).toString("base64"));
  const env = {
    GATEWAY_ID: "gateway-e2e",
    POD_TRANSPORT: "ws",
    LOG_LEVEL: "silent",
    WEB_ORIGINS: [],
    PUBLIC_URL: "",
  } as unknown as ServerEnv;
  const log = {
    info: (m: string) => console.log(`   [server] ${m}`),
    warn: (m: string) => console.log(`   [server:warn] ${m}`),
    error: (m: string) => console.log(`   [server:error] ${m}`),
  };
  const gateway = new GatewayService({ env, kek, log });
  const deps: PodServiceDeps = {
    env,
    kek,
    log,
    onPodStarted: (podId) => {
      void gateway.ensureSession(orgId, podId).catch((e) => log.warn(`ensureSession: ${e.message}`));
    },
  };

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(websocket);
  app.decorate("authenticate", makeAuthHook(env, log));
  await app.register(
    async (v1) => {
      registerPodRoutes(v1, deps, gateway);
      registerGatewayRoutes(v1, gateway);
    },
    { prefix: "/v1" },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  (env as { PUBLIC_URL: string }).PUBLIC_URL = address;
  gateway.start();
  console.log(`server listening at ${address}; run dir ${RUN_DIR}`);

  await query("INSERT INTO organizations (id, name) VALUES ($1, 'host e2e')", [orgId]);
  await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  await query(
    `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state,
       provider_state, resolved_config, lineage_root_id, lineage_depth, transport, last_activity_at)
     VALUES ($1, $2, $3, 'e2e-host', 'sandbox', $4, 'active', 'started', $5::jsonb, $1, 0, 'ws', now())`,
    [
      hostPodId,
      orgId,
      userId,
      hostSandboxId,
      JSON.stringify({
        config: { providers: {}, image: "e2e-image", workdir: HOST_WORKSPACE, idleTimeoutMinutes: 30, pi: { sessionNaming: "off" } },
        image: { ref: "e2e-image", managed: false, provenance: "config", assetDigest: "", status: "ready" },
        egress: { description: "open", mode: "open" },
        workdir: HOST_WORKSPACE,
        warnings: [],
      }),
    ],
  );
  const hostToken = await createPodToken({ podId: hostPodId, orgId, userId });

  const childIds: string[] = [];
  let stepError: unknown = null;
  try {
    step("CLI: pi-pod list from inside the host pod (pod token)");
    const list0 = await cli(["list", "--all"], hostToken, address);
    check("list shows the host pod", list0.code === 0 && list0.output.includes("e2e-host"), list0.output.trim().split("\n").pop());

    step("CLI: pi-pod --on self (co-located launch through the real CLI + server)");
    const launch = await cli(["--on", "self"], hostToken, address);
    console.log(launch.output.split("\n").filter(Boolean).slice(0, 12).map((l) => `   ${l}`).join("\n"));
    check("launch exited 0 and mentioned co-location", launch.code === 0 && /co-located on this pod's machine/.test(launch.output), `exit ${launch.code}`);

    const childRows = await query<PodRow>("SELECT * FROM pods WHERE host_pod_id = $1", [hostPodId]);
    check("child row exists with provider host", childRows.rows.length === 1 && childRows.rows[0]!.provider === "host");
    if (childRows.rows.length === 0) throw new Error("no child row; aborting the remaining checks");
    const child = childRows.rows[0]!;
    childIds.push(child.id);
    check("lineage records the host as parent and machine", child.parent_pod_id === hostPodId && child.host_pod_id === hostPodId);
    await waitForRow(child.id, (row) => row.provider_state === "started");
    check("child provisioned to started", true);

    // Safety invariants before anything destructive: the child inherited the host workdir
    // and therefore owns nothing it could delete.
    const startedChild = (await query<PodRow>("SELECT * FROM pods WHERE id = $1", [child.id])).rows[0]!;
    check("child inherited the host workdir", startedChild.resolved_config.workdir === HOST_WORKSPACE, startedChild.resolved_config.workdir);
    const metaRaw = fs.readFileSync(`/var/lib/pi-pod/children/${child.id}/meta.json`, "utf8");
    const meta = JSON.parse(metaRaw) as { ownsWorkdir: boolean; workdir: string; hostWorkdir: string };
    check("child does not own the shared workdir", meta.ownsWorkdir === false && meta.hostWorkdir === HOST_WORKSPACE, metaRaw);
    if (meta.ownsWorkdir) throw new Error("refusing to continue: child claims workdir ownership");

    check(
      "per-child runtime files landed on the machine",
      fs.existsSync(`/tmp/pi-pod-agentd.${child.id}.cjs`) && fs.existsSync(`/var/lib/pi-pod/children/${child.id}/meta.json`),
    );
    const agentdPids = pgrep(`pi-pod-agentd.${child.id}.cjs`);
    check("a real agentd process supervises the child", agentdPids.length > 0, `pids: ${agentdPids.join(",") || "none"}`);

    step("Gateway: client WebSocket attach to the co-located child");
    await gateway.ensureSession(orgId, child.id);
    const ticket = await mintTicket(userId, child.id);
    const wsUrl = `${address.replace(/^http/, "ws")}/v1/pods/${child.id}/session?ticket=${ticket.ticket}`;
    const seen: string[] = [];
    const attachProof = await new Promise<{ helloPod: string | null; liveState: boolean; models: boolean }>(
      (resolve, reject) => {
        const proof = { helloPod: null as string | null, liveState: false, models: false };
        const socket = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error(`incomplete attach proof; saw: ${seen.join(",")}`));
        }, 30_000);
        socket.on("message", (data) => {
          let message: { type?: string; podId?: string; state?: unknown } | null = null;
          try {
            message = JSON.parse(String(data));
          } catch {
            return;
          }
          if (message?.type) seen.push(message.type);
          if (message?.type === "hello") {
            // The hello carries a live get_state snapshot: client ↔ gateway ↔ agentd ↔ pi.
            proof.helloPod = message.podId ?? null;
            proof.liveState = typeof message.state === "object" && message.state !== null;
            // Then round-trip an on-demand command through the same splice.
            socket.send(JSON.stringify({ type: "get_models" }));
          } else if (message?.type && /model/i.test(message.type)) {
            proof.models = true;
            clearTimeout(timer);
            socket.close();
            resolve(proof);
          }
        });
        socket.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      },
    );
    check(
      "client attach spliced through to the child's live pi",
      attachProof.helloPod === child.id && attachProof.liveState && attachProof.models,
      `frames: ${[...new Set(seen)].join(", ")}`,
    );

    step("CLI: grouped listing and the machine-scoped view");
    const list1 = await cli(["list", "--all"], hostToken, address);
    console.log(list1.output.split("\n").map((l) => `   ${l}`).join("\n"));
    check("child renders grouped under the host with a location column", /└/.test(list1.output) && /on e2e-host/.test(list1.output));
    const groupList = await cli(["list", child.id], hostToken, address);
    check("`list <pod>` shows the machine group", groupList.code === 0 && /machine:/.test(groupList.output) && groupList.output.includes("e2e-host"), groupList.output.trim().split("\n")[0]);

    step("CLI: pi-pod stop <child> — a real process-group kill");
    const stop = await cli(["stop", child.id], hostToken, address);
    check("stop exited 0", stop.code === 0, stop.output.trim());
    await waitForRow(child.id, (row) => row.provider_state === "stopped");
    for (let i = 0; i < 40 && pgrep(`pi-pod-agentd.${child.id}.cjs`).length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check("child processes are gone after stop", pgrep(`pi-pod-agentd.${child.id}.cjs`).length === 0);
    check("stopped marker written", fs.existsSync(`/var/lib/pi-pod/children/${child.id}/stopped`));

    step("CLI: attach wakes the stopped child (fresh agentd, same pod)");
    const attach = await cli(["attach", child.id], hostToken, address);
    check(
      "headless attach connected and detached",
      attach.code === 0 && /nothing to send|detaching/.test(attach.output),
      attach.output.trim().split("\n").pop(),
    );
    await waitForRow(child.id, (row) => row.provider_state === "started");
    check("child is started again after wake", true);
    check("a fresh agentd is supervising", pgrep(`pi-pod-agentd.${child.id}.cjs`).length > 0);

    step("Cascade: host stop takes the co-located child's row and processes with it");
    const hostRow = (await query<PodRow>("SELECT * FROM pods WHERE id = $1", [hostPodId])).rows[0]!;
    await gateway.closePod(child.id, "host_stopped").catch(() => {});
    await runProviderPodCommand(deps, hostRow, "stop", userId);
    const cascaded = await waitForRow(child.id, (row) => row.provider_state === "stopped" && row.last_stop_cause === "host_stopped");
    check("host stop cascaded child row to host_stopped", cascaded.last_stop_cause === "host_stopped");
    // The fake host stop kills nothing (this machine is not actually stopping); on a real
    // provider the machine's processes die by physics. The row cascade is the server's part.
  } catch (e) {
    stepError = e;
    check("harness step", false, e instanceof Error ? e.message : String(e));
  } finally {
    step("cleanup");
    hostMachineState = "started";
    await query("UPDATE pods SET provider_state = 'started' WHERE id = $1", [hostPodId]).catch(() => {});
    for (const childId of childIds) {
      const rows = await query<PodRow>("SELECT * FROM pods WHERE id = $1", [childId]);
      const row = rows.rows[0];
      if (row && row.provider_state !== "gone") {
        await query("UPDATE pods SET provider_state = 'started' WHERE id = $1 AND provider_state = 'stopped'", [childId]);
        await runProviderPodCommand(deps, (await query<PodRow>("SELECT * FROM pods WHERE id = $1", [childId])).rows[0]!, "delete", userId).catch((e) =>
          console.log(`   cleanup delete ${childId}: ${e instanceof Error ? e.message : e}`),
        );
      }
      check(`runtime dir removed for ${childId.slice(0, 8)}…`, !fs.existsSync(`/var/lib/pi-pod/children/${childId}`));
      check(`shared workspace intact after deleting ${childId.slice(0, 8)}…`, fs.existsSync(HOST_WORKSPACE));
    }
    await gateway.shutdown().catch(() => {});
    await app.close();
    await query("DELETE FROM ws_tickets WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM queued_prompts WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pod_tokens WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_launch_env WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM session_events WHERE session_id IN (SELECT id FROM sessions WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1))", [orgId]);
    await query("DELETE FROM sessions WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  }

  if (stepError) {
    console.error(`\nstep error: ${stepError instanceof Error ? stepError.stack ?? stepError.message : stepError}`);
  }
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nharness error: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
