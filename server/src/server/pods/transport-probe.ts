import { isIP } from "node:net";
import type { Sandbox } from "../../core/providers/types.js";
import { shellQuote } from "../../core/providers/util.js";

export type TransportFailureKind =
  | "dns-stale-tailscale"
  | "dns-dead"
  | "dns-selective"
  | "tcp-connect"
  | "tls-http"
  | "callback-reachable"
  | "unknown";

export interface TransportDiagnosis {
  kind: TransportFailureKind;
  summary: string;
}

type StageStatus = "ok" | "error" | "timeout" | "skipped";
interface ProbeStage {
  stage: string;
  status?: StageStatus;
  value?: string;
  code?: number;
}

/** Only this machine-readable vocabulary is accepted from the diagnostic process. Provider
 * startup output and exception text are not evidence, and never control recovery decisions. */
function readStages(output: string): ProbeStage[] {
  const stages: ProbeStage[] = [];
  for (const line of output.split("\n")) {
    try {
      const record = JSON.parse(line) as ProbeStage;
      if (!record || !["utc", "resolver", "tailscaled", "target", "dns", "dns-control", "tcp", "tls", "http"].includes(record.stage)) continue;
      if (record.status !== undefined && !["ok", "error", "timeout", "skipped"].includes(record.status)) continue;
      stages.push({
        stage: record.stage,
        ...(record.status ? { status: record.status } : {}),
        ...(typeof record.value === "string" ? { value: record.value.slice(0, 250) } : {}),
        ...(Number.isInteger(record.code) && record.code! >= 100 && record.code! <= 599 ? { code: record.code } : {}),
      });
    } catch { /* A timed-out or unavailable probe may have produced only partial records. */ }
  }
  return stages;
}

function diagnose(stages: ProbeStage[]): TransportDiagnosis {
  const find = (name: string) => stages.find((stage) => stage.stage === name);
  const dns = find("dns");
  const failed = (stage: ProbeStage | undefined) => stage?.status === "error" || stage?.status === "timeout";
  let kind: TransportFailureKind = "unknown";
  // Positive evidence wins over partial/contradictory earlier stages. HTTP 401 is normal:
  // this request intentionally has no credential and does not attempt a WebSocket upgrade.
  if (find("http")?.status === "ok") kind = "callback-reachable";
  else if (failed(dns)) {
    const resolver = find("resolver")?.value ?? "";
    kind = /100\.100\.100\.100|fd7a:115c:a1e0/.test(resolver) && find("tailscaled")?.value === "gone"
      ? "dns-stale-tailscale"
      : find("dns-control")?.status === "ok" ? "dns-selective" : "dns-dead";
  } else if (failed(find("tcp"))) kind = "tcp-connect";
  else if (failed(find("tls")) || failed(find("http"))) kind = "tls-http";
  const summary = stages.map((stage) =>
    `${stage.stage}: ${[stage.status, stage.code, stage.value].filter((part) => part !== undefined).join(" ")}`,
  ).join("; ");
  return { kind, summary: `${summary || "probe unavailable"}; websocket: not-probed (unauthenticated reachability only)` };
}

/** Probe precisely the daemon's callback origin, without proxy environment, redirects or
 * credentials. IP literals bypass DNS (reverse DNS is irrelevant). Each lookup/dial has a
 * deadline; the outer process and provider exec also bound a wedged resolver or TLS stack.
 * A reachable HTTP endpoint is not proof that an authenticated WebSocket can be upgraded. */
export async function transportNetworkProbe(args: {
  sandbox: Sandbox;
  dialUrl: string;
  controlHost?: string;
}): Promise<TransportDiagnosis> {
  const url = new URL(args.dialUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "unknown", summary: "probe unavailable: unsupported callback scheme" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const python = String.raw`
import datetime, http.client, json, os, socket, ssl, subprocess, sys, time
host, port, secure, request_path, control, literal = ${JSON.stringify(host)}, ${port}, ${url.protocol === "https:" ? "True" : "False"}, ${JSON.stringify(url.pathname + url.search)}, ${JSON.stringify(args.controlHost ?? "")}, ${isIP(host) ? "True" : "False"}
def emit(stage, status=None, value=None, code=None):
    record = {'stage': stage}
    if status is not None: record['status'] = status
    if value is not None: record['value'] = value
    if code is not None: record['code'] = code
    print(json.dumps(record), flush=True)
emit('utc', value=datetime.datetime.now(datetime.timezone.utc).isoformat())
try:
    with open('/etc/resolv.conf') as f: resolvers = ' '.join(line.split()[1] for line in f if line.strip().startswith('nameserver '))
except Exception: resolvers = 'unavailable'
emit('resolver', value=resolvers)
live = False
for pid in os.listdir('/proc'):
    if not pid.isdigit(): continue
    try:
        with open('/proc/' + pid + '/comm') as f:
            if f.read().strip() == 'tailscaled': live = True; break
    except Exception: pass
emit('tailscaled', value='live' if live else 'gone')
emit('target', value=('https' if secure else 'http') + '://' + ('[' + host + ']' if ':' in host else host) + ':' + str(port))
def resolve(name, label):
    if name == host and literal:
        emit(label, 'skipped', 'IP literal; no DNS lookup required')
        return [name]
    source = "import socket,json,sys; print(json.dumps(list(dict.fromkeys(x[4][0] for x in socket.getaddrinfo(sys.argv[1],int(sys.argv[2]),type=socket.SOCK_STREAM)))))"
    try:
        r = subprocess.run([sys.executable, '-c', source, name, str(port)], capture_output=True, text=True, timeout=3)
        ips = json.loads(r.stdout) if r.returncode == 0 else []
        if not ips: emit(label, 'error', 'forward lookup failed'); return []
        emit(label, 'ok', ','.join(ips)[:200]); return ips
    except subprocess.TimeoutExpired: emit(label, 'timeout', 'forward lookup exceeded 3s'); return []
    except Exception: emit(label, 'error', 'forward lookup unavailable'); return []
ips = resolve(host, 'dns')
if not ips:
    if control: resolve(control, 'dns-control')
    sys.exit(0)
sock = None
deadline = time.monotonic() + 3
for ip in ips[:4]:
    try:
        sock = socket.create_connection((ip, port), timeout=max(0.1, deadline-time.monotonic())); break
    except Exception: pass
    if time.monotonic() >= deadline: break
if sock is None: emit('tcp', 'error', 'connection failed on callback port'); sys.exit(0)
emit('tcp', 'ok')
sock.settimeout(3)
try:
    if secure:
        try: sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host); emit('tls', 'ok')
        except Exception as e: emit('tls', 'error', type(e).__name__); sys.exit(0)
    else: emit('tls', 'skipped', 'plain HTTP callback')
    # Reuse the connected socket: no second, unbounded DNS lookup and no environment proxy.
    conn = http.client.HTTPConnection(host, port, timeout=3)
    conn.sock = sock
    try:
        conn.request('GET', request_path, headers={'Connection': 'close'})
        response = conn.getresponse()
        emit('http', 'ok', 'unauthenticated; redirects not followed', response.status)
    except Exception as e: emit('http', 'error', type(e).__name__)
    finally: conn.close()
finally: sock.close()
`;
  const result = await args.sandbox.exec([
    "bash", "-lc", `timeout 17 python3 -u -c ${shellQuote(python)} 2>/dev/null`,
  ], { timeoutMs: 20_000 }).catch(() => null);
  return diagnose(readStages((result?.output ?? "").slice(0, 8_000)));
}
