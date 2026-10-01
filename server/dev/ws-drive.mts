// Manual WS test client for /v1/pods/:podId/session (spec §9.2).
// Usage: npx tsx dev/ws-drive.mts <podId> <ticket> <prompt> [fromSeq] [timeoutSec]
import WebSocket from "ws";

const [podId, ticket, prompt, fromSeqArg, timeoutArg] = process.argv.slice(2);
const timeoutSec = Number(timeoutArg ?? 120);

const url = new URL(`ws://127.0.0.1:8080/v1/pods/${podId}/session`);
url.searchParams.set("ticket", ticket);
if (fromSeqArg) url.searchParams.set("from_seq", fromSeqArg);

const ws = new WebSocket(url);
const events: Array<{ seq: number; kind: string; summary: string }> = [];
let hello: unknown = null;
let maxSeq = 0;

const summarize = (kind: string, payload: any): string => {
  const p = payload ?? {};
  if (p.text) return String(p.text).slice(0, 80);
  if (p.delta) return `delta:${String(p.delta).slice(0, 40)}`;
  if (p.message?.content) return JSON.stringify(p.message.content).slice(0, 80);
  return JSON.stringify(p).slice(0, 80);
};

const done = new Promise<void>((resolve) => {
  const timer = setTimeout(() => { console.log("TIMEOUT"); ws.close(); resolve(); }, timeoutSec * 1000);

  ws.on("open", () => {
    if (prompt) ws.send(JSON.stringify({ type: "prompt", text: prompt }));
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === "hello") {
      hello = msg;
      if (prompt) ws.send(JSON.stringify({ type: "prompt", text: prompt }));
      return;
    }
    if (msg.type === "event") {
      maxSeq = Math.max(maxSeq, msg.seq);
      events.push({ seq: msg.seq, kind: msg.kind, summary: summarize(msg.kind, msg.payload) });
      if (msg.kind === "turn_end" || msg.kind === "session_ended") {
        clearTimeout(timer); ws.close(); resolve();
      }
      return;
    }
    if (msg.type === "interaction") {
      events.push({ seq: msg.seq, kind: `interaction:${msg.kind}`, summary: summarize(msg.kind, msg.payload) });
      return;
    }
    if (msg.type === "error") { events.push({ seq: -1, kind: "ws-error", summary: msg.message }); }
  });
  ws.on("close", () => { clearTimeout(timer); resolve(); });
  ws.on("error", (e) => { console.log("WS ERROR:", e.message); clearTimeout(timer); resolve(); });
});

await done;
console.log(JSON.stringify({
  hello,
  eventCount: events.length,
  maxSeq,
  kinds: [...new Set(events.map((e) => e.kind))],
  tail: events.slice(-6),
}, null, 1));
