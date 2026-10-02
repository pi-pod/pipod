// Manual check for the reconnect-dialog fix (§5.3): prompt a blocking approval, drop the
// socket without answering, reattach, and see whether the gateway re-presents it.
//   npx tsx dev/drive-dialog.mts <podId> <token>
import WebSocket from "ws";

const [podId, token] = process.argv.slice(2);
const base = "http://127.0.0.1:8080";

async function ticket(): Promise<string> {
  const res = await fetch(`${base}/v1/pods/${podId}/ws-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}

interface Seen {
  frames: string[];
  dialogIds: string[];
  settled: boolean;
}

async function attach(label: string, onOpen?: (ws: WebSocket, seen: Seen) => void): Promise<{ ws: WebSocket; seen: Seen }> {
  const url = `ws://127.0.0.1:8080/v1/pods/${podId}/session?ticket=${await ticket()}`;
  const ws = new WebSocket(url);
  const seen: Seen = { frames: [], dialogIds: [], settled: false };
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as Record<string, any>;
    const payload = msg["payload"] ?? {};
    if (msg["type"] === "hello") seen.frames.push("hello");
    else if (payload.type === "extension_ui_request") {
      seen.frames.push(`${msg["type"]}:${payload.method}:${payload.id}`);
      seen.dialogIds.push(payload.id);
    } else if (msg["type"] === "event") seen.frames.push(`event:${msg["kind"]}`);
    else seen.frames.push(String(msg["type"]));
    if (msg["kind"] === "agent_settled") seen.settled = true;
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  onOpen?.(ws, seen);
  return { ws, seen };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (predicate: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !predicate()) await wait(50);
  return predicate();
};

const first = await attach("first");
// The message handler is registered after attachClient resolves, so wait for hello.
await until(() => first.seen.frames.includes("hello"));
first.ws.send(JSON.stringify({ type: "prompt", text: "please CONFIRM this" }));
console.log("dialog reached the first client:", await until(() => first.seen.dialogIds.length > 0));
console.log("  frames:", first.seen.frames.join(" | "));

// The drop: this client goes away without ever answering.
first.ws.terminate();
await wait(500);

const second = await attach("reattached");
const represented = await until(() => second.seen.dialogIds.length > 0);
console.log("dialog re-presented to the reattached client:", represented);
console.log("  frames:", second.seen.frames.join(" | "));

if (represented) {
  second.ws.send(JSON.stringify({
    type: "ui_response",
    response: { type: "extension_ui_response", id: second.seen.dialogIds[0], confirmed: true },
  }));
  console.log("turn finished after answering:", await until(() => second.seen.settled));
}

// A third client must not be shown a dialog somebody already answered.
second.ws.close();
await wait(500);
const third = await attach("third");
await wait(1500);
console.log("answered dialog re-presented again (must be false):", third.seen.dialogIds.length > 0);
console.log("  frames:", third.seen.frames.join(" | "));
third.ws.close();
process.exit(0);
