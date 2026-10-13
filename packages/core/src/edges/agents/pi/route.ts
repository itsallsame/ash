/**
 * How pi reaches the model's server (the one place the route is chosen). A Codex model needs OpenAI's servers, and from
 * a phone there are two ways: through the proxy v2rayA offers inside the container, or straight out when the owner has a
 * VPN on for the whole phone. DeepSeek is always direct. This module only answers "which way is open now"; the driver
 * decides what to do with the answer.
 *
 * The hub runs in the same network as the container (proot adds no network of its own), so it can knock on the proxy's
 * port itself.
 */
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

export type Route = "proxy" | "direct" | "none";

/** The host a Codex model is served from: reaching it is what "the route is open" means. */
export const PROBE_HOST = "chatgpt.com";
/** v2rayA's default HTTP proxy port (pi speaks HTTP proxies only, not SOCKS). */
export const DEFAULT_PROXY_URL = "http://127.0.0.1:20171";
const TIMEOUT_MS = 5000;

/** Does a CONNECT to the probe host through this HTTP proxy get a 200? */
export function probeProxy(proxyUrl: string, timeoutMs = TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL(proxyUrl); } catch { resolve(false); return; }
    let done = false;
    const socket = tcpConnect({ host: url.hostname, port: Number(url.port) || 80 });
    const end = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => end(false), timeoutMs);
    let head = "";
    socket.on("connect", () => socket.write(`CONNECT ${PROBE_HOST}:443 HTTP/1.1\r\nHost: ${PROBE_HOST}:443\r\n\r\n`));
    socket.on("data", (chunk) => { head += chunk.toString("latin1"); if (head.includes("\r\n")) end(/^HTTP\/1\.[01] 200/.test(head)); });
    socket.on("error", () => end(false));
    socket.on("close", () => end(false));
  });
}

/** Does a TLS handshake with the probe host complete without any proxy? */
export function probeDirect(timeoutMs = TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const socket = tlsConnect({ host: PROBE_HOST, port: 443, servername: PROBE_HOST });
    const end = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => end(false), timeoutMs);
    socket.on("secureConnect", () => end(true));
    socket.on("error", () => end(false));
  });
}

/** The first open way, in the order proxy, direct; `none` when neither is. */
export async function chooseRoute(probe: (route: "proxy" | "direct") => Promise<boolean>): Promise<Route> {
  if (await probe("proxy").catch(() => false)) return "proxy";
  if (await probe("direct").catch(() => false)) return "direct";
  return "none";
}

/** An error text that says the network (not the account or the request) is what failed. */
export const NETWORK_ERROR = /fetch failed|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|terminated|network|timed? ?out|proxy|websocket|UND_ERR|other side closed|tunnel|EPIPE/i;
/** An error text that says the model's account has no usable login. */
export const AUTH_ERROR = /no api key|not logged in|log ?in again|sign in|could not parse your authentication|unauthorized|\b401\b|invalid[_ ](?:api[_ ]key|token)|authentication/i;
