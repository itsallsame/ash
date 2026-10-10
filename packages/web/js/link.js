// The page's one connection to the kernel: the `human` channel of ash-link/1 (SPEC-03 §5).
//
// Two transports, one interface. In a browser the page opens the WebSocket itself with the browser client of
// packages/link (the handshake, the heartbeat and the reconnecting are the client's). In the app the page has no
// socket: the native layer owns the one connection and hands the page's frames across `AshNative` unchanged
// (`{type:"frame", frame}` both ways, and `{type:"link", open, client?, local?}` when the channel opens or closes).
//
// Everything above this file (net.js and the sheets) sees only a `Port`:
//   start() / stop() / reconnect()
//   state       "connecting" | "online" | "offline" | "closed"      info   {client, local, session} while online
//   send(request)                    -> the `send.result` frame (never rejects; a lost connection is an error result)
//   call(to, word, body, options)    -> the word's `Reply` (see below)
//   sync(params, {page, message})    -> {sid, close()} or null when there is no connection
//   presence({visible?, typing?, agent?})
//   stream(sid)                      -> Promise<{mime, data: Uint8Array}> for a `resource` the kernel answered with
import { HandClient, browserConnector } from "./link-browser.js";

const newId = (prefix) => `${prefix}${globalThis.crypto.randomUUID()}`;
const text = (error) => (error instanceof Error ? error.message : String(error));
const failure = (code, message) => ({ ok: false, error: { code, message } });

/** What went wrong when a word did not succeed. `code` is one of the error codes of SPEC-02 §7. */
export class WordFailure extends Error {
  constructor(error) {
    super(error?.message || "没有成功");
    this.code = error?.code || "failed";
    this.detail = error?.detail;
    this.recovery_hint = error?.recovery_hint;
  }
}

/** The data of a successful `Reply`; a failed one throws [WordFailure]. */
export function unwrap(reply) {
  if (reply?.ok === true) return reply.result?.data ?? {};
  throw new WordFailure(reply?.ok === false ? reply.error : { code: "result_unknown", message: "没有收到确认" });
}

/** True when the failure says only that the answer did not arrive, so the same request may be sent again. */
export const retryable = (error) => ["offline", "unavailable", "timeout", "result_unknown", "internal"].includes(error?.code);

/** The close codes that end a connection for good (SPEC-03 §7), as the owner should hear them. */
export const FINAL_CLOSE = { 4003: "这台设备已被撤销，不能再连接。", 4008: "页面和 Ash 的版本对不上，需要更新。", 4009: "已在别处打开，这一个断开了。" };

// --- shared by both transports --------------------------------------------------------------------------------------------

class Streams {
  constructor() { this.waiting = new Map(); this.arrived = new Map(); }
  /** A stream arrived whole. */
  deliver(stream) {
    const waiter = this.waiting.get(stream.sid);
    if (waiter) { this.waiting.delete(stream.sid); waiter.resolve(stream); return; }
    this.arrived.set(stream.sid, stream);
    // Nobody asked for it (yet): keep a few, the result frame may simply be late.
    if (this.arrived.size > 16) this.arrived.delete(this.arrived.keys().next().value);
  }
  take(sid) {
    const have = this.arrived.get(sid);
    if (have) { this.arrived.delete(sid); return Promise.resolve(have); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(sid); reject(new WordFailure({ code: "timeout", message: "文件没有送到" })); }, 60_000);
      this.waiting.set(sid, { resolve: (stream) => { clearTimeout(timer); resolve(stream); }, reject });
    });
  }
  broken(sid, code, message) {
    const waiter = this.waiting.get(sid);
    if (waiter) { this.waiting.delete(sid); waiter.reject(new WordFailure({ code, message })); }
  }
  reset() { this.arrived.clear(); for (const [sid, waiter] of this.waiting) waiter.reject(new WordFailure({ code: "offline", message: "连接断了" })); this.waiting.clear(); }
}

/** The common part of a port: `call` over `send`, and the streams the kernel sends. */
class BasePort {
  constructor(hooks) {
    this.hooks = hooks;
    this.state = "connecting";
    this.info = null;
    this.streams = new Streams();
  }

  stream(sid) { return this.streams.take(sid); }

  async call(to, word, body = {}, { clientId, signal } = {}) {
    if (signal?.aborted) return failure("cancelled", "已取消");
    const result = await this.send({ to, kind: "request", word, body, wait: true, ...(clientId ? { client_id: clientId } : {}) });
    if (!result.ok) return { ok: false, error: result.error };
    // The kernel waits up to 60 s for the answer; without one the word may still be running.
    return result.response ?? failure("result_unknown", "还没有收到结果");
  }

  set(state, info = null) {
    this.state = state;
    this.info = info;
    this.hooks.state?.(state, info);
  }
}

// --- the browser ------------------------------------------------------------------------------------------------------------

const wsUrl = () => {
  const here = new URL("/link", globalThis.location.href);
  here.protocol = here.protocol === "https:" ? "wss:" : "ws:";
  return here.href;
};

/**
 * A browser tab is a hand of kind `browser` that opens only the `human` channel. It has no key to sign with: the relay
 * vouches for the browser's device (SPEC-03 §2.2), so the hello carries no `public_key`.
 */
export class BrowserPort extends BasePort {
  constructor(hooks, { url, label = "网页", connector, clock, random } = {}) {
    super(hooks);
    this.native = false;
    this.client = new HandClient({
      url: url ?? wsUrl, connector: connector ?? browserConnector, ...(clock ? { clock } : {}), ...(random ? { random } : {}),
      hand: { kind: "browser", name: label, version: "web", platform: globalThis.navigator?.platform || "web" },
      channels: { human: { label, surfaces: ["chat"] } },
      handlers: {
        welcome: (welcome) => {
          const human = welcome.channels.human;
          if (!human || !("client" in human)) {
            this.stopped = true;
            this.set("closed", { denied: human?.reason || "这台设备没有被允许使用聊天。" });
            this.client.stop();
            return;
          }
          this.set("online", { client: human.client, local: human.local === true, session: welcome.session });
        },
        closed: ({ code, willReconnect }) => {
          this.streams.reset();
          if (this.stopped) return;
          if (willReconnect) this.set("offline");
          else this.set("closed", { denied: FINAL_CLOSE[code] || "连接已关闭。", code });
        },
        present: (frame) => this.hooks.present(frame),
        stream: (stream) => this.streams.deliver(stream),
        log: (message, error) => this.hooks.log?.(message, error),
      },
    });
  }

  start() { this.stopped = false; this.set("connecting"); this.client.start(); }
  stop() { this.stopped = true; this.client.stop(); this.streams.reset(); this.set("offline"); }
  reconnect() { this.stopped = false; this.set("connecting"); this.client.reconnectNow(); }

  async send(request) {
    try {
      return await this.client.send(request);
    } catch (error) {
      // The connection ended before the answer: the kernel may have taken the request.
      return failure("result_unknown", text(error));
    }
  }

  sync(params, listener) {
    try { return this.client.openSync(params, listener); } catch { return null; }
  }

  presence(state) {
    try { this.client.presence(state); } catch { /* not connected: the next connection tells the kernel again */ }
  }
}

// --- the app ----------------------------------------------------------------------------------------------------------------

/**
 * The page inside the app. [bridge] is what native-bootstrap.js sets up over `AshNative`:
 * `{post(frame), onFrame(fn), onLink(fn)}`.
 */
export class NativePort extends BasePort {
  constructor(hooks, bridge) {
    super(hooks);
    this.native = true;
    this.bridge = bridge;
    this.requests = new Map();
    this.syncs = new Map();
    this.incoming = new Map();
    this.epoch = 0;
    this.started = false;
    this.early = null;
    bridge.onFrame((frame) => this.receive(frame));
    // A state told while the page is still being built (it came before the port was ready) waits for `start`: whoever reacts
    // to the port going online may need the rest of the page.
    bridge.onLink((message) => { if (this.started) this.linked(message); else this.early = message; });
  }

  start() {
    this.started = true;
    if (this.state !== "online") this.set("connecting");
    if (this.early) { const message = this.early; this.early = null; this.linked(message); }
    // The native layer pushes every change, but a page that came late (a slow phone) or missed the first one asks once.
    this.bridge.requestLink?.();
  }
  stop() { this.drop(); this.lastLinkKey = null; this.set("offline"); }
  reconnect() { this.bridge.requestLink?.(); /* the native layer keeps the connection and says when it changes */ }

  linked(message) {
    // The same state told twice (pushed and asked for) is one state.
    const key = JSON.stringify([message.open === true, message.client ?? null, message.local === true]);
    if (key === this.lastLinkKey) return;
    this.lastLinkKey = key;
    if (message.open === true && typeof message.client === "string") {
      this.epoch++;
      this.set("online", { client: message.client, local: message.local === true, session: `${message.client}#${this.epoch}` });
    } else {
      this.drop();
      this.set("offline");
    }
  }

  /** The channel closed: what was waiting for the kernel will not get an answer on this connection. */
  drop() {
    for (const waiter of this.requests.values()) waiter.resolve(failure("result_unknown", "连接断了，还不知道有没有送到"));
    this.requests.clear();
    for (const sync of this.syncs.values()) sync.listener.error?.(failure("offline", "连接断了").error);
    this.syncs.clear();
    this.incoming.clear();
    this.streams.reset();
  }

  post(frame) { this.bridge.post(frame); }

  send(request) {
    if (this.state !== "online") return Promise.resolve(failure("offline", "还没连上"));
    const id = newId("s_");
    return new Promise((resolve) => {
      this.requests.set(id, { resolve });
      this.post({ t: "send", ch: "human", id, request });
    });
  }

  sync(params, listener) {
    if (this.state !== "online") return null;
    const sid = newId("y_");
    this.syncs.set(sid, { listener });
    this.post({ t: "sync", ch: "human", sid, ...params });
    return { sid, close: () => { if (this.syncs.delete(sid)) this.post({ t: "sync.close", sid }); } };
  }

  presence(state) {
    if (this.state === "online") this.post({ t: "presence", ch: "human", ...state });
  }

  receive(frame) {
    switch (frame.t) {
      case "send.result": {
        const waiter = this.requests.get(frame.id);
        this.requests.delete(frame.id);
        return waiter?.resolve(frame);
      }
      case "sync.page": return this.syncs.get(frame.sid)?.listener.page(frame);
      case "sync.msg": return this.syncs.get(frame.sid)?.listener.message(frame);
      case "present": return void this.present(frame);
      case "stream": return this.stream_(frame);
      case "error": {
        // The native layer could not send the frame, or the kernel refused it; [id] names the send or the sync.
        const waiter = this.requests.get(frame.id);
        if (waiter) { this.requests.delete(frame.id); return waiter.resolve(failure(frame.code, frame.message)); }
        const sync = this.syncs.get(frame.id);
        if (sync) { this.syncs.delete(frame.id); sync.listener.error?.({ code: frame.code, message: frame.message }); }
        return;
      }
      default:
    }
  }

  async present(frame) {
    let outcome;
    try { outcome = await this.hooks.present(frame); }
    catch (error) { outcome = failure("failed", text(error)); }
    this.post(outcome.ok
      ? { t: "present.result", id: frame.id, ok: true, ...(outcome.data !== undefined ? { data: outcome.data } : {}) }
      : { t: "present.result", id: frame.id, ok: false, error: outcome.error });
  }

  stream_(frame) {
    if (frame.op === "open") { this.incoming.set(frame.sid, { mime: frame.mime, chunks: [] }); return; }
    const partial = this.incoming.get(frame.sid);
    if (!partial) return;
    if (frame.op === "data") { partial.chunks.push(Uint8Array.from(atob(frame.b64), (char) => char.charCodeAt(0))); return; }
    this.incoming.delete(frame.sid);
    if (frame.op === "error") { this.streams.broken(frame.sid, frame.code, frame.message); return; }
    const size = partial.chunks.reduce((total, chunk) => total + chunk.length, 0);
    const data = new Uint8Array(size);
    let at = 0;
    for (const chunk of partial.chunks) { data.set(chunk, at); at += chunk.length; }
    this.streams.deliver({ sid: frame.sid, mime: partial.mime, data });
  }
}

/** The port for this page: the native one when the app's bridge is there, else the browser's own. */
export function openPort(hooks, { bridge, ...browser } = {}) {
  return bridge ? new NativePort(hooks, bridge) : new BrowserPort(hooks, browser);
}
