/**
 * The host's proxy (SPEC-07 `network.proxy`) as the environment variables programs in the container read. The phone's
 * proxy is the only way out for some networks, and nothing inside the container can find it on its own.
 */
import type { HostNetwork } from "../../../../sdk/src/host";

/** Addresses that never go through the proxy: the hub's tool address is `127.0.0.1`, and a proxy cannot reach the phone's loopback. */
export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

/**
 * `HTTP_PROXY`/`HTTPS_PROXY` (both spellings) and `NO_PROXY` for one network state. Nothing when there is no proxy.
 * `NO_PROXY` always ends with the loopback addresses, after whatever the host excluded.
 */
export function proxyEnv(network: HostNetwork | null | undefined): Record<string, string> {
  const proxy = network?.proxy;
  if (!proxy || (!proxy.http && !proxy.https)) return {};
  const out: Record<string, string> = {};
  if (proxy.http) { out.HTTP_PROXY = proxy.http; out.http_proxy = proxy.http; }
  if (proxy.https) { out.HTTPS_PROXY = proxy.https; out.https_proxy = proxy.https; }
  const noProxy = [proxy.no_proxy?.trim(), LOOPBACK_NO_PROXY].filter(Boolean).join(",");
  out.NO_PROXY = noProxy;
  out.no_proxy = noProxy;
  return out;
}
