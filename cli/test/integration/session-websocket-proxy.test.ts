import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";

// Real WebSocket upgrades and CONNECT tunnels, entirely on loopback. Child
// processes isolate proxy settings and load a disposable test CA at startup.
const dir = mkdtempSync(join(tmpdir(), "pipod-proxy-test-"));
const certPath = join(dir, "cert.pem");
const sockets = new Set<Socket>();
const servers: Server[] = [];
const authorities: string[] = [];
let wsPort: number;
let wssPort: number;
let proxyPort: number;
let tlsProxyPort: number;

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

function echo(server: Server): void {
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
}

function tunnel(server: Server): void {
  server.on("connect", (req, client, head) => {
    authorities.push(req.url!);
    // Only our two local fixture destinations may be reached.
    const port = Number(req.url!.split(":").at(-1));
    assert.ok(port === wsPort || port === wssPort);
    const upstream = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
}

before(async () => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(dir, "key.pem"), "-out", certPath, "-days", "1",
    "-subj", "/CN=session.invalid", "-addext",
    "subjectAltName=DNS:session.invalid,IP:127.0.0.1"], { stdio: "ignore" });
  const tls = { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(certPath) };
  const plain = createServer();
  const secure = createTlsServer(tls);
  echo(plain);
  echo(secure);
  wsPort = await listen(plain);
  wssPort = await listen(secure);
  const proxy = createServer();
  const tlsProxy = createTlsServer(tls);
  tunnel(proxy);
  tunnel(tlsProxy);
  proxyPort = await listen(proxy);
  tlsProxyPort = await listen(tlsProxy);
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  rmSync(dir, { recursive: true, force: true });
});

async function roundTrip(url: string, settings: Record<string, string>, trusted = true): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/proxy/i.test(key) || key === "NODE_EXTRA_CA_CERTS" || key === "NODE_OPTIONS") delete env[key];
  }
  Object.assign(env, settings);
  if (trusted) env["NODE_EXTRA_CA_CERTS"] = certPath;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createSessionWebSocket } from './src/account/session-websocket.ts';
    const socket = createSessionWebSocket(process.argv[1]);
    const timeout = setTimeout(() => process.exit(2), 5000);
    socket.on('open', () => socket.send('harmless echo'));
    socket.on('message', (data) => { console.log(data.toString()); socket.close(); });
    socket.on('error', (error) => { console.log(error.code); });
    socket.on('close', () => clearTimeout(timeout));
  `, url], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stderr = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  return output.trim();
}

test("WSS_PROXY tunnels an unresolvable hostname and takes precedence over HTTPS_PROXY", async () => {
  const count = authorities.length;
  assert.equal(await roundTrip(`wss://session.invalid:${wssPort}`, {
    WSS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: "http://127.0.0.1:1",
    NODE_USE_ENV_PROXY: "1",
  }), "harmless echo");
  assert.deepEqual(authorities.slice(count), [`session.invalid:${wssPort}`]);
});

test("HTTPS_PROXY fallback and lowercase settings work over a TLS proxy", async () => {
  assert.equal(await roundTrip(`wss://session.invalid:${wssPort}`, {
    https_proxy: `https://127.0.0.1:${tlsProxyPort}`, HTTPS_PROXY: "http://127.0.0.1:1",
  }), "harmless echo");
});

test("WS_PROXY, HTTP_PROXY fallback and ALL_PROXY support plain WebSockets", async () => {
  for (const key of ["WS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
    assert.equal(await roundTrip(`ws://session.invalid:${wsPort}`, {
      [key]: `http://127.0.0.1:${proxyPort}`,
    }), "harmless echo");
  }
});

test("NO_PROXY host, port and wildcard bypass configured proxies", async () => {
  const count = authorities.length;
  for (const noProxy of ["127.0.0.1", `127.0.0.1:${wssPort}`, "*"]) {
    assert.equal(await roundTrip(`wss://127.0.0.1:${wssPort}`, {
      WSS_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", no_proxy: noProxy,
    }), "harmless echo");
  }
  assert.equal(authorities.length, count);
});

test("no configured proxy preserves direct WS and WSS connections", async () => {
  const count = authorities.length;
  for (const url of [`ws://127.0.0.1:${wsPort}`, `wss://127.0.0.1:${wssPort}`]) {
    assert.equal(await roundTrip(url, {}), "harmless echo");
  }
  assert.equal(authorities.length, count);
});

test("untrusted destination and proxy certificates remain rejected", async () => {
  for (const [url, settings] of [
    [`wss://session.invalid:${wssPort}`, { WSS_PROXY: `http://127.0.0.1:${proxyPort}` }],
    [`ws://session.invalid:${wsPort}`, { WS_PROXY: `https://127.0.0.1:${tlsProxyPort}` }],
    [`wss://127.0.0.1:${wssPort}`, {}],
  ] as Array<[string, Record<string, string>]>) {
    assert.equal(await roundTrip(url, settings, false), "DEPTH_ZERO_SELF_SIGNED_CERT");
  }
});

test("NO_PROXY port mismatch still uses the proxy", async () => {
  assert.equal(await roundTrip(`wss://session.invalid:${wssPort}`, {
    WSS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "session.invalid:1",
  }), "harmless echo");
});
