import type { HostEvent, HostNetwork } from "../../../../sdk/src/host";

export type HostEventParse = { ok: true; event: HostEvent } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseNetwork(value: unknown): HostNetwork | null {
  if (!isObject(value)) return null;
  const proxy = value.proxy;
  if (proxy === null) return { proxy: null };
  if (!isObject(proxy)) return null;
  const out: { http?: string; https?: string; no_proxy?: string } = {};
  for (const key of ["http", "https", "no_proxy"] as const) {
    if (proxy[key] === undefined) continue;
    if (typeof proxy[key] !== "string") return null;
    out[key] = proxy[key];
  }
  return { proxy: out };
}

/** One stdin line to a typed host event. Unknown events and malformed ones are refused with a reason, never thrown. */
export function parseHostEvent(line: string): HostEventParse {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return { ok: false, reason: "not JSON" }; }
  if (!isObject(value) || typeof value.event !== "string") return { ok: false, reason: "not an event object" };
  switch (value.event) {
    case "wake.fired":
      return isTime(value.at) ? { ok: true, event: { event: "wake.fired", at: value.at } } : { ok: false, reason: "wake.fired needs a numeric at" };
    case "lifecycle.stop":
      return isTime(value.deadline) && typeof value.reason === "string"
        ? { ok: true, event: { event: "lifecycle.stop", deadline: value.deadline, reason: value.reason } }
        : { ok: false, reason: "lifecycle.stop needs deadline and reason" };
    case "env.changed": {
      if (value.what === "network") {
        const network = parseNetwork(value.network);
        return network && typeof value.online === "boolean"
          ? { ok: true, event: { event: "env.changed", what: "network", network, online: value.online } }
          : { ok: false, reason: "env.changed/network needs network and online" };
      }
      if (value.what === "power") {
        return typeof value.saver === "boolean"
          ? { ok: true, event: { event: "env.changed", what: "power", saver: value.saver } }
          : { ok: false, reason: "env.changed/power needs saver" };
      }
      return { ok: false, reason: `unknown env.changed what: ${String(value.what)}` };
    }
    default:
      return { ok: false, reason: `unknown event: ${value.event}` };
  }
}
