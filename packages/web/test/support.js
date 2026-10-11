// Shared by the page's tests: an in-memory outbox store and a Net wired to a test kernel.
import { Net } from "../js/net.js";
import { quickClock } from "./kernel.js";

export class MemoryPending {
  constructor() { this.items = new Map(); }
  async list() { return [...this.items.values()]; }
  async enqueue(wire) {
    const item = { wire, client_id: wire.client_id, text: wire.body.text, attachments: [], status: "unsent", id: null, seq: null, leaseOwner: null, leaseUntil: 0 };
    this.items.set(wire.client_id, item); return item;
  }
  async claim(owner) {
    const item = [...this.items.values()].find((value) => value.wire && !value.id && value.status !== "rejected" && !value.leaseOwner);
    if (!item) return null;
    item.leaseOwner = owner; item.status = "sending"; return { ...item };
  }
  async renew() {}
  async release(item, owner, status) { const saved = this.items.get(item.client_id); if (saved?.leaseOwner === owner) { saved.leaseOwner = null; saved.status = status; } }
  async accept(item, owner, id, seq) { const saved = this.items.get(item.client_id); if (saved?.leaseOwner === owner) { saved.id = id; saved.seq = seq; saved.status = "accepted"; saved.wire = null; saved.leaseOwner = null; } }
  async removeAccepted(id) { for (const [key, value] of this.items) if (value.id === id) this.items.delete(key); }
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until [test] is true (polling), or fails after [ms]. */
export async function until(test, ms = 2000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await tick(5); }
  throw new Error(`timed out waiting for ${what}`);
}

/** A Net on the test kernel's memory connection. */
export function netFor(kernel, options = {}) {
  const events = { messages: [], histories: [], current: [], ready: 0, states: [], opens: [], queues: [], presents: [] };
  const net = new Net({
    url: () => "ws://test/link", connector: kernel.connector, clock: quickClock, pendingStore: new MemoryPending(),
    onMessage: (message, context) => events.messages.push({ message, ...context }),
    onHistory: (page) => events.histories.push(page),
    onCurrent: (current) => events.current.push(current),
    onHistoryReady: () => { events.ready++; },
    onState: (status, detail) => events.states.push(detail === undefined ? status : [status, detail]),
    onOpen: (info) => events.opens.push(info),
    onQueue: (count, outbox) => events.queues.push({ count, outbox }),
    onPresent: async (target) => { events.presents.push(target); return { ok: true, data: { opened: true } }; },
    ...options,
  });
  return { net, events };
}

/** A hand-made DOM element, enough for the settings drawer's builders (no layout, no real events). */
export class FakeElement {
  constructor(tag) { this.tag = tag; this.children = []; this.hidden = false; this.listeners = new Map(); this.attributes = {}; this.textContent = ""; this.value = ""; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes[name] = value; this[name] = value; }
  click() { this.listeners.get("click")?.(); }
  find(id) { return this.id === id ? this : this.children.map((child) => child.find?.(id)).find(Boolean); }
  all() { return [this, ...this.children.flatMap((child) => child.all?.() ?? [])]; }
  /** All the text below this element, children included. */
  get text() { return [this.textContent ?? "", ...this.children.map((child) => child.text ?? "")].join(""); }
}

/** A Net on the test kernel that is started and online. */
export async function connect(kernel, options) {
  const handle = netFor(kernel, options);
  handle.net.start();
  await until(() => handle.net.status === "online", 2000, "online");
  return handle;
}

/**
 * The app's native layer for a test: it holds the one connection to the kernel (a raw socket speaking ash-link/1) and hands
 * the page's human frames across unchanged, as HomeActivity's ChatBridge does. Returns the bridge the page gets and a `link`
 * control for opening and closing the channel.
 */
export async function nativeBridgeFor(kernel) {
  const { memoryPair } = await import("../../link/test/fixtures/memory.ts");
  const pair = memoryPair();
  kernel.server.accept(pair.server, {});
  let onFrame = () => {};
  let onLink = () => {};
  let lastLink = null;
  const sent = [];
  pair.hand.on("message", (data) => {
    const frame = JSON.parse(data);
    if (frame.t === "challenge") {
      pair.hand.send(JSON.stringify({ t: "hello", protocol: "ash-link/1", hand: { kind: "phone", name: "test phone", version: "1", platform: "test" },
        channels: { human: { label: "手机 · 对话", surfaces: ["chat"] } } }));
    } else if (frame.t === "welcome") {
      const human = frame.channels.human;
      lastLink = { type: "link", open: true, client: human.client, local: human.local };
      onLink(lastLink);
    } else if (frame.t === "ping") pair.hand.send(JSON.stringify({ t: "pong", at: frame.at }));
    else onFrame(frame);
  });
  const bridge = {
    post: (frame) => { sent.push(frame); pair.hand.send(JSON.stringify(frame)); },
    onFrame: (fn) => { onFrame = fn; },
    onLink: (fn) => { onLink = fn; if (lastLink) fn(lastLink); },
  };
  return {
    bridge, sent,
    linked: () => lastLink !== null,
    close: () => { lastLink = { type: "link", open: false }; onLink(lastLink); pair.hand.close(1000, "test"); },
  };
}
