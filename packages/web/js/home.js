import { fill } from "./home-dom.js";
// 她的主页 and the pages under it. The page shell (index.html) knows nothing of them: they hang their own markup on <body> and
// open when the page says `ash:open` ({page: "home" | "apps", agent?, section?}, see design/app/IMPLEMENTATION.md).
import { navbar, h } from "./home-ui.js";
import { IdentityName } from "./identity-name.js";
import { unwrap } from "./link.js";
import { PAGES } from "./home-pages.js";

const stale = () => Object.assign(new Error("连接已经换了"), { code: "stale" });

/** The shell: a layer over the conversation holding a stack of pages, the first of which is the home page. */
class HomeShell {
  constructor(net, feed) {
    this.net = net;
    this.feed = feed;
    this.root = h("div", { id: "home", class: "hm-root", hidden: true, "aria-hidden": "true", role: "dialog", "aria-label": "她的主页" });
    this.banner = h("div", { class: "banner hm-banner", role: "status", hidden: true }, "还没连上。连上后这里会自动刷新。");
    this.stage = h("div", { class: "hm-stage" });
    this.root.append(this.banner, this.stage);
    document.body.append(this.root);
    this.stack = [];
    this.screens = [];
    this.agent = null;
    this.name = "Ash";
    this.session = null;
    this.identity = new IdentityName(net, (name) => { this.name = name; });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && this.isOpen()) this.back(); });
    globalThis.addEventListener("ash:net-state", (event) => { if (event.detail?.net === net) this.connection(); });
  }

  isOpen() { return !this.root.hidden; }

  /** Opens the home page (of the agent [agent], or of her), and [section] on top of it. */
  open({ agent = null, section = null, arg = null } = {}) {
    this.agent = typeof agent === "string" && /^agent:[a-z][a-z0-9_-]*$/.test(agent) && agent !== this.net.primary ? agent : null;
    this.stack = [{ id: "home" }];
    if (section && PAGES[section]) this.stack.push({ id: section, arg });
    this.session = this.key();
    this.dispose();
    this.root.hidden = false;
    this.root.setAttribute("aria-hidden", "false");
    this.root.classList.remove("closing");
    void this.identity.refresh();
    this.draw(false);
    this.connection();
    return true;
  }

  close() {
    if (!this.isOpen()) return;
    this.dispose();
    this.root.classList.add("closing");
    const done = () => { this.root.hidden = true; this.root.setAttribute("aria-hidden", "true"); this.root.classList.remove("closing"); fill(this.stage); };
    if (matchMedia?.("(prefers-reduced-motion: reduce)").matches) done(); else setTimeout(done, 360);
  }

  key() { return this.net.session ? `${this.net.session}\0${this.net.generation}` : null; }

  /** The connection changed: a page drawn for another connection is drawn again; the banner says when there is none. */
  connection() {
    if (!this.isOpen()) return;
    const online = this.net.status === "online" && Boolean(this.net.session);
    this.banner.hidden = online;
    const key = this.key();
    if (online && key !== this.session) { this.session = key; void this.identity.refresh(); this.draw(false); }
    else if (!online) this.session = null;
  }

  go(id, arg = null) {
    if (!PAGES[id]) return;
    this.stack.push({ id, arg });
    this.draw(true);
  }

  back() {
    if (this.stack.length <= 1) { this.close(); return; }
    const leaving = this.screens.pop();
    this.stack.pop();
    this.retire(leaving, "out");
    this.screens.at(-1)?.page.refresh?.();
    this.screens.at(-1)?.el.removeAttribute("aria-hidden");
  }

  dispose() { for (const screen of this.screens) screen.dispose(); this.screens = []; fill(this.stage); }

  /** Draws the whole stack (after a connection change or at the start), or just the new top page (after a push). */
  draw(animate) {
    if (!animate) { this.dispose(); for (const entry of this.stack) this.mount(entry, false); return; }
    this.screens.at(-1)?.el.setAttribute("aria-hidden", "true");
    this.mount(this.stack.at(-1), true);
  }

  context() {
    const shell = this;
    return {
      net: this.net, feed: this.feed, agent: this.agent,
      get name() { return shell.name; },
      go: (id, arg) => this.go(id, arg),
      /** The name may have changed (her IDENTITY.md was saved): read it again; every other reader of it follows. */
      refreshName: () => { void this.identity.refresh(); },
      back: () => this.back(),
      close: () => this.close(),
      jump: id => { this.close(); globalThis.dispatchEvent(new CustomEvent("ash:jump", { cancelable: true, detail: { id } })); },
      /** Puts words in the conversation's box (the chat page listens for `ash:compose`; failing that, the plain text box). */
      compose: (text, extra = {}) => {
        const event = new CustomEvent("ash:compose", { cancelable: true, detail: { text, ...extra } });
        if (globalThis.dispatchEvent(event)) { const input = document.querySelector("#t"); if (input) { input.value = text; input.focus?.(); } }
        this.close();
      },
      home: () => { while (this.stack.length > 1) { this.stack.pop(); this.screens.pop()?.dispose(); } this.draw(false); },
    };
  }

  mount(entry, animate) {
    const factory = PAGES[entry.id];
    const binding = this.net.binding();
    let alive = true;
    const subscriptions = [];
    const timers = [];
    const wakes = new Map();
    const guard = () => { if (!alive || !this.net.same(binding)) throw stale(); };
    const screen = {
      alive: () => alive && this.net.same(binding),
      binding,
      /** One word as the owner: its data, or a thrown WordFailure; a stale connection or page is `{code: "stale"}`. */
      ask: async (to, word, body = {}, options) => { guard(); const reply = await this.net.call(to, word, body, options); guard(); return unwrap(reply); },
      /** The same, but the Reply itself (an error is a value). */
      call: async (to, word, body = {}, options) => { guard(); const reply = await this.net.call(to, word, body, options); guard(); return reply; },
      onName: (fn) => { subscriptions.push(this.identity.subscribe(() => { if (alive) fn(); })); },
      /** One timer by [key]: [fn] runs at [ts]; calling again with the key moves it. Stopped with the page. */
      wake: (key, fn, ts) => { clearTimeout(wakes.get(key)); if (Number.isFinite(ts)) wakes.set(key, setTimeout(() => { if (alive) fn(); }, Math.min(Math.max(0, ts - Date.now()) + 50, 2_147_000_000))); },
      onView: (fn) => { subscriptions.push(this.feed.subscribe(() => { if (alive) fn(); })); },
      listen: (target, event, fn) => { const run = () => { if (alive) fn(); }; target.addEventListener(event, run); subscriptions.push(() => target.removeEventListener(event, run)); },
      every: (fn, ms) => { const timer = setInterval(() => { if (alive && !document.hidden) fn(); }, ms); timers.push(timer); },
      later: (fn, ms) => { const timer = setTimeout(() => { if (alive) fn(); }, ms); timers.push(timer); },
    };
    const ctx = this.context();
    const page = factory(ctx, screen, entry.arg);
    const bar = navbar({ title: page.title ?? "", backLabel: this.stack.length <= 1 ? "返回对话" : "返回", onBack: () => this.back(), right: page.right ?? null });
    const el = h("section", { class: `hm-screen${entry.id === "home" ? " hm-screen-home" : ""}`, dataset: { page: entry.id } }, bar, h("div", { class: "hm-scroll" }, h("div", { class: "hm-col" }, page.body)));
    if (animate) el.classList.add("entering");
    this.stage.append(el);
    const entryScreen = { el, page, dispose: () => { alive = false; for (const off of subscriptions) off(); for (const timer of [...timers, ...wakes.values()]) { clearInterval(timer); clearTimeout(timer); } page.dispose?.(); } };
    this.screens.push(entryScreen);
    if (animate) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("entering")));
    void page.refresh?.();
    return entryScreen;
  }

  retire(screen, direction) {
    screen.dispose();
    screen.el.classList.add(direction === "out" ? "leaving" : "entering");
    const done = () => screen.el.remove();
    if (matchMedia?.("(prefers-reduced-motion: reduce)").matches) done(); else setTimeout(done, 360);
  }
}

let shell = null;
let connection = null;
/** Boot owns the connection and explicitly shares the finite current picture. */
export function connectHome(net, feed) { connection = { net, feed }; }
const shellFor = (net) => { if (!shell || shell.net !== net) shell = new HomeShell(net, connection.feed); return shell; };

globalThis.addEventListener?.("ash:open", (event) => {
  const { page, agent, section, arg } = event.detail ?? {};
  if (page !== "home" && page !== "apps") return;
  const net = connection?.net;
  if (!net) return;
  event.preventDefault();
  shellFor(net).open({ agent, section: page === "apps" ? "apps" : section, arg });
});
