/**
 * The host's proxy (SPEC-07 `network.proxy`) as the environment variables programs in the container read. The phone's
 * proxy is the only way out for some networks, and nothing inside the container can find it on its own.
 */
import type { HostNetwork } from "./host";

/** Addresses that never go through the proxy: the hub's tool address is `127.0.0.1`, and a proxy cannot reach the phone's loopback. */
export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

/**
 * `HTTP_PROXY`/`HTTPS_PROXY` (both spellings), `NO_PROXY` and `NODE_USE_ENV_PROXY` for one network state. Nothing when there is no proxy.
 * `NO_PROXY` always ends with the loopback addresses, after whatever the host excluded.
 */
export function proxyEnv(network: HostNetwork | null | undefined): Record<string, string> {
  const proxy = network?.proxy;
  if (!proxy || (!proxy.http && !proxy.https)) return {};
  const out: Record<string, string> = {};
  if (proxy.http) { out.HTTP_PROXY = proxy.http; out.http_proxy = proxy.http; }
  if (proxy.https) { out.HTTPS_PROXY = proxy.https; out.https_proxy = proxy.https; }
  // The host's own list first; a loopback address it already names is not added again.
  const listed = (proxy.no_proxy ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const noProxy = [...listed, ...LOOPBACK_NO_PROXY.split(",").filter((entry) => !listed.includes(entry))].join(",");
  out.NO_PROXY = noProxy;
  out.no_proxy = noProxy;
  out.NODE_USE_ENV_PROXY = "1"; // Node (DSH, apps) reads the proxy variables only when told to
  return out;
}
