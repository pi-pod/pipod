import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import WebSocket from "ws";

/** Keep session attaches (including reconnects) on the configured proxy route. */
export function createSessionWebSocket(url: string): WebSocket {
  const target = new URL(url);
  const transportUrl = new URL(url);
  transportUrl.protocol = target.protocol === "wss:" ? "https:" : "http:";
  // Prefer WS(S)_PROXY and generic proxy settings, then HTTP(S)_PROXY.
  // Both lookups apply NO_PROXY, including the WebSocket default ports.
  const proxy = getProxyForUrl(target.href) || getProxyForUrl(transportUrl.href);
  if (!proxy) return new WebSocket(url);

  let agent: HttpsProxyAgent<string>;
  try {
    const proxyUrl = new URL(proxy);
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      throw new Error("unsupported proxy protocol");
    }
    agent = new HttpsProxyAgent(proxyUrl);
  } catch {
    // Invalid URLs can contain credentials; do not include them in attach errors.
    throw new Error("Invalid session proxy configuration: expected an HTTP(S) proxy URL");
  }
  // ws supplies its own createConnection, so Node's environment-aware global
  // agent is insufficient. CONNECT also leaves DNS resolution to the proxy.
  // Keep the agent and ws TLS verification defaults for both TLS hops.
  return new WebSocket(url, { agent });
}
