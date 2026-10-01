/**
 * End-to-end: the real pi-pod-server adapter against a real running pi-pod-sandbox service.
 * This is the pairing nothing else exercises — the adapter's unit tests stub the service, and
 * the service's own integration suite never loads the adapter.
 *
 * Run it from a pi-pod-server checkout (it needs that package's dependencies), against a
 * service started with PI_POD_SANDBOX_TOKEN=dev-token-0123456789abcdef:
 *
 *   cp scripts/adapter-e2e.mts /path/to/pi-pod-server/ && cd /path/to/pi-pod-server
 *   npx tsx adapter-e2e.mts
 */
import { createSandboxProvider } from "/workspace/pi-pod-server/src/core/providers/sandbox.js";

process.env.PI_POD_SANDBOX_TOKEN = "dev-token-0123456789abcdef";
const provider = createSandboxProvider({ url: "http://localhost:8433" });

const log = (...a: unknown[]) => console.log(...a);
const dec = new TextDecoder();

log("capabilities.workdirSurvivesStop =", provider.capabilities.workdirSurvivesStop);
log("credentialEnvNames =", provider.credentialEnvNames);
log("keepaliveApiHost =", provider.keepaliveApiHost);

await provider.checkAuth();
log("checkAuth: ok");

log("resolveImage(busybox:latest) =", (await provider.resolveImage("busybox:latest"))?.ref);
log("resolveImage(nope:doesnotexist) =", await provider.resolveImage("nope:doesnotexist"));

const sandbox = await provider.create({
  image: "busybox:latest",
  workdir: "/workspace",
  resources: { cpu: 0.25, memoryGB: 0.5 },
  env: { ADAPTER_CANARY: "adapter-e2e-value" },
  labels: { "pi-pod.org": "acme", "pi-pod.session": "e2e" },
  archiveAfterMinutes: 4320,
  idleTimeoutMinutes: 0,
  egress: { mode: "open" },
});
log("created", sandbox.id, "state =", await sandbox.state());

await sandbox.waitUntilStarted(30_000);

let out = "";
const result = await sandbox.exec(["/bin/sh", "-c", "echo canary=$ADAPTER_CANARY; pwd; id -u"], {
  onStdout: (c) => (out += dec.decode(c)),
});
log("exec exit =", result.exitCode, "output =", JSON.stringify(out.trim()));

const stderrExec = await sandbox.exec(["/bin/sh", "-c", "echo to-stderr >&2; exit 7"], {
  onStderr: (c) => log("  stderr:", dec.decode(c).trim()),
});
log("exec exit code propagation =", stderrExec.exitCode);

await sandbox.uploadFile("/workspace/uploaded.txt", new TextEncoder().encode("hello from adapter"), 0o600);
const downloaded = await sandbox.downloadFile("/workspace/uploaded.txt");
log("upload/download round trip =", JSON.stringify(dec.decode(downloaded)));

const pty = await sandbox.openPty({ argv: ["/bin/sh", "-i"], cols: 90, rows: 25 });
const chunks: string[] = [];
pty.onData((d) => chunks.push(dec.decode(d)));
// A shell discards pending input when it configures the terminal at startup, so type only
// once it has shown a prompt — exactly what a human does.
const waitForPrompt = async (buf: string[]) => {
  for (let i = 0; i < 100 && !buf.join("").includes("# "); i++) await new Promise((r) => setTimeout(r, 50));
};
await waitForPrompt(chunks);
pty.write(new TextEncoder().encode("PTY_MARK=set; stty size\n"));
await new Promise((r) => setTimeout(r, 600));
log("pty output =", JSON.stringify(chunks.join("")));
const sessionId = pty.id;
pty.close();
await new Promise((r) => setTimeout(r, 300));

const rejoined = await sandbox.reconnectPty!(sessionId, { cols: 90, rows: 25 });
log("reconnectPty(live session) =", rejoined ? "rejoined" : "null");
const after: string[] = [];
rejoined!.onData((d) => after.push(dec.decode(d)));
rejoined!.write(new TextEncoder().encode("echo mark-is=$PTY_MARK\n"));
await new Promise((r) => setTimeout(r, 800));
log("state survived reattach =", JSON.stringify(after.join("").match(/mark-is=\w+/)?.[0]));
rejoined!.close();

log("reconnectPty(dead session) =", await sandbox.reconnectPty!("00000000-0000-0000-0000-000000000000", { cols: 80, rows: 24 }));

await sandbox.setLabels({ "pi-pod.extra": "label" });
const listed = await provider.list({ "pi-pod.org": "acme" });
log("list by label =", listed.length, "first labels =", JSON.stringify(listed[0]?.labels));
log("lastActivityAt present =", Boolean(listed[0]?.lastActivityAt));

await sandbox.refreshActivity();
log("applyRetention(changed?) =", await sandbox.applyRetention({ archiveAfterMinutes: 1440 }));
log("applyRetention(same again) =", await sandbox.applyRetention({ archiveAfterMinutes: 1440 }));

await sandbox.stop(30_000);
log("after stop, state =", await sandbox.state());

const regot = await provider.get(sandbox.id);
regot!.rehydrateEnv({ ADAPTER_CANARY: "rehydrated-value" });
await regot!.start(60_000);
let out2 = "";
await regot!.exec(["/bin/sh", "-c", "cat /workspace/uploaded.txt; echo; echo canary=$ADAPTER_CANARY"], {
  onStdout: (c) => (out2 += dec.decode(c)),
});
log("after restart =", JSON.stringify(out2.trim()));

await regot!.archive(300_000);
log("after archive, state =", await regot!.state());
await regot!.start(300_000);
let out3 = "";
await regot!.exec(["/bin/sh", "-c", "cat /workspace/uploaded.txt"], { onStdout: (c) => (out3 += dec.decode(c)) });
log("after restore from archive =", JSON.stringify(out3.trim()));

const script = provider.keepaliveScript!(sandbox.id, { piCommand: "pi", idleTimeoutMinutes: 30 });
log("keepaliveScript leaks token? =", script.includes("dev-token-0123456789abcdef"));

await regot!.delete();
log("get after delete =", await provider.get(sandbox.id));
log("\nALL ADAPTER E2E CHECKS COMPLETED");
process.exit(0);
