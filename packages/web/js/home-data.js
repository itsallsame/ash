// The reads the home pages share. Each takes the `screen` of its page (see home.js), so an answer that arrives after the
// page or the connection moved on throws `{code: "stale"}` instead of being drawn.
import { BODY_MAIN } from "./body.js";
import { normalizeClockList, userPlans } from "./clock.js";
import { quietOf, QUIET_KEY } from "./home-text.js";

export const settled = (work) => Promise.resolve(work).then((value) => value, () => null);

/** The clock's timers, checked (`service:clock/list`). */
export async function readClock(screen) {
  return userPlans(normalizeClockList(await screen.ask("service:clock", "list", {})));
}

/** A text file of her work directory: its text, null when it is not there; anything else is thrown. */
export async function readFile(screen, path) {
  const reply = await screen.call(BODY_MAIN, "workspace.read", { path, limit: 100_000 });
  if (!reply.ok) { if (reply.error?.code === "not_found") return null; throw Object.assign(new Error(reply.error?.message ?? "read failed"), { code: reply.error?.code }); }
  const data = reply.result?.data ?? {};
  if (typeof data.text !== "string") throw new Error("not a text file");
  return { text: data.text, truncated: data.truncated === true };
}

/** Spending: `service:cost/usage.get` for the last [days] days. */
export const readUsage = (screen, days = 7) => screen.ask("service:cost", "usage.get", { days });

/** The quiet hours: "HH:MM-HH:MM", "" for none; null when unreadable. */
export async function readQuiet(screen) {
  const { settings } = await screen.ask("service:admin", "settings.get", { keys: [QUIET_KEY] });
  return quietOf(settings);
}

/** How often she asks before acting, and the rules the owner said "always" to (`service:gate/rules.list`). */
export async function readApproval(screen) {
  const data = await screen.ask("service:gate", "rules.list", { limit: 100 });
  const now = Date.now();
  const rules = Array.isArray(data.rules) ? data.rules.filter((rule) => rule && typeof rule.id === "string" && !rule.revoked_at && Number.isSafeInteger(rule.expires_at) && rule.expires_at > now) : [];
  return { mode: data.mode === "always" ? "always" : data.mode === "auto" ? "auto" : null, rules };
}

/** The devices and the requests waiting for the owner's approval. */
export async function readDevices(screen) {
  const [{ devices }, { pairs }] = await Promise.all([screen.ask("service:devices", "list", {}), screen.ask("service:devices", "pair_pending", {})]);
  return { devices: Array.isArray(devices) ? devices.filter((device) => typeof device?.device === "string" && typeof device.name === "string") : [],
    pairs: Array.isArray(pairs) ? pairs.filter((pair) => typeof pair?.pair_id === "string") : [] };
}

/** One of the persona files (SOUL.md, IDENTITY.md) as text; null when missing. */
export async function readPersona(screen, file) {
  const data = await screen.ask("service:persona", "get", { file });
  const found = Array.isArray(data.files) ? data.files.find((item) => item?.file === file) : undefined;
  return typeof found?.content === "string" ? found.content : null;
}


/** The agents the hub lists: `[{id, name, primary, runtime}]`. */
export async function readAgents(screen) {
  const { agents } = await screen.ask("service:agents", "list", {});
  return Array.isArray(agents) ? agents.filter((agent) => typeof agent?.id === "string") : [];
}

/** The apps (`service:apps/apps.list`); null when it could not be read. */
export async function readApps(screen, word = "apps.list") {
  const reply = await screen.call("service:apps", word, {});
  const list = reply?.ok === true ? reply.result?.data?.apps : null;
  return Array.isArray(list) ? list.filter((app) => app && typeof app.id === "string") : null;
}

/** The first few lines of her soul as a quote on the home page: no headings, no list marks, about [max] characters. */
export function quoteOf(markdown, max = 90) {
  const lines = String(markdown ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^#{1,6}\s/.test(line) && !/^---+$/.test(line))
    .map((line) => line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1"));
  const text = lines.join("");
  return [...text].length > max ? `${[...text].slice(0, max).join("")}…` : text;
}

