// Drives the fake-provider API for manual app testing. Usage:
//   drive.mts new                      -> prints a new pod id (waits until ready)
//   drive.mts say <podId> <prompt...>  -> one turn, waits until pi settles
//   drive.mts fill <podId> <turns>     -> that many scripted turns
//   drive.mts set <podId> <provider> <id> <thinking>
//   drive.mts stop <podId>
import WebSocket from "ws";
import fs from "node:fs";
const base = "http://127.0.0.1:18081";
const token = fs.readFileSync(""+process.env.WALK_TOKEN_FILE+"", "utf8").trim();
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};
const attach = async (podId: string) => {
  const { ticket } = await api("POST", `/v1/pods/${podId}/ws-ticket`, {});
  const ws = new WebSocket(`ws://127.0.0.1:18081/v1/pods/${podId}/session?ticket=${encodeURIComponent(ticket)}`);
  const frames: any[] = []; const waiters: Array<{ test: (m: any) => boolean; resolve: (m: any) => void }> = [];
  ws.on("message", (data) => { const m = JSON.parse(String(data)); frames.push(m); for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (test: (m: any) => boolean, ms = 60000) => new Promise<any>((resolve, reject) => { const hit = frames.find(test); if (hit) return resolve(hit); const t = setTimeout(() => reject(new Error("timeout waiting for frame")), ms); waiters.push({ test, resolve: (m) => { clearTimeout(t); resolve(m); } }); });
  await next((m) => m.type === "hello");
  return { ws, next, send: (m: unknown) => ws.send(JSON.stringify(m)), clear: () => { frames.length = 0; } };
};
const turn = async (s: Awaited<ReturnType<typeof attach>>, text: string) => { s.clear(); s.send({ type: "prompt", text }); await s.next((m) => m.type === "event" && m.kind === "agent_settled"); };
const [mode, podArg, ...rest] = process.argv.slice(2);
if (mode === "new") {
  const created = await api("POST", "/v1/pods", {});
  const podId = created.pod?.id ?? created.id;
  for (let i = 0; i < 60; i++) { const p = await api("GET", `/v1/pods/${podId}`); if (!(p.pod ?? p).initializing) break; await new Promise((r) => setTimeout(r, 500)); }
  console.log(podId);
} else if (mode === "say") {
  const s = await attach(podArg); await turn(s, rest.join(" ")); s.ws.close(); console.log("ok");
} else if (mode === "fill") {
  const s = await attach(podArg);
  const scripts = ["THINK what changed in the build", "TOOLS fix the call site", "MARKDOWN summarize", "TOOL run it BRIDGE", "plain question number"];
  for (let i = 0; i < Number(rest[0]); i++) await turn(s, `${scripts[i % scripts.length]} ${i + 1}`);
  s.ws.close(); console.log("ok");
} else if (mode === "set") {
  const s = await attach(podArg); s.send({ type: "set", model: { provider: rest[0], id: rest[1] }, thinkingLevel: rest[2], requestId: "drive" });
  const m = await s.next((f) => f.type === "models" && f.requestId === "drive"); console.log(`${m.current?.provider}/${m.current?.id} ${m.thinkingLevel}`); s.ws.close();
} else if (mode === "stop") { await api("POST", `/v1/pods/${podArg}/stop`, {}); console.log("stopped"); }
process.exit(0);
