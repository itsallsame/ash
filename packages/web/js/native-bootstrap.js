// This file is embedded only in the APK's appassets page. The page has no connection of its own: it trades two kinds of
// messages with the native layer. `{type:"frame", frame}` carries the human channel's frames of ash-link/1 unchanged, both
// ways; `{type:"link", open, client?, local?}` (native to page) says the channel opened or closed. The owner credential
// never enters this page.
//
// Nothing here may depend on which side is ready first. The page says `hello` until it hears `ready` (the native layer may
// not have noticed the page yet), and once it is running it asks for the state of the link (`link_state`) until it has been
// told once; after that every change is pushed. The last state told is kept, so a listener that registers late is given it.
(() => {
  const native = globalThis.AshNative;
  if (!native || location.origin !== "https://appassets.androidplatform.net") return;
  const LINK_ASKS = 40;
  const HELLO_TRIES = 40;
  const pending = new Map();
  let nextId = 0;
  let ready = false;
  let onFrame = null;
  let onLink = null;
  let lastLink = null;
  const doc = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const post = (value) => native.postMessage(JSON.stringify(value));
  const later = (fn, ms) => globalThis.setTimeout?.(fn, ms);

  /** Saves bytes the page already holds ({name, mime?, b64}) through the system file picker. */
  globalThis.__ashFileSave = (file) => {
    if (!ready) return Promise.reject(new Error("native file saving unavailable"));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      pending.set(id, { result: "file_save_result", resolve: (message) => resolve({ ok: message.ok === true, cancelled: message.cancelled === true }), reject });
      post({ type: "file_save", id, name: file.name, ...(file.mime ? { mime: file.mime } : {}), b64: file.b64 });
    });
  };

  globalThis.__ashBrowserLogins = () => {
    if (!ready) return Promise.reject(new Error("native settings unavailable"));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      pending.set(id, { result: "browser_logins_result", resolve: (message) => resolve({ ok: message.ok === true }), reject });
      post({ type: "browser_logins", id, operation: "clear" });
    });
  };

  /** What the page's transport talks to (see NativePort in link.js). */
  const bridge = {
    post: (frame) => post({ type: "frame", frame }),
    onFrame(fn) { onFrame = fn; },
    // A listener that registers after the state came is given it, but not from inside this call: the caller is still being built.
    onLink(fn) { onLink = fn; if (lastLink) { const told = lastLink; Promise.resolve().then(() => { if (onLink === fn) fn(told); }); } },
    /** Asks the native layer for the state of the link now; asks again until it has been told once. */
    requestLink() { askGeneration++; askLink(0, askGeneration); },
  };

  let askGeneration = 0;
  const askLink = (tries, generation) => {
    if (generation !== askGeneration) return;
    post({ type: "link_state", try: tries });
    if (tries + 1 < LINK_ASKS) later(() => { if (!lastLink) askLink(tries + 1, generation); }, Math.min(2000, 300 * 2 ** tries));
  };

  // `hello` is said again until `ready` comes, in case the first one was lost or not placed yet.
  const sayHello = (tries) => {
    if (ready || tries >= HELLO_TRIES) return;
    post({ type: "hello", doc, try: tries });
    later(() => sayHello(tries + 1), Math.min(2000, 300 * 2 ** tries));
  };

  native.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "ready" && !ready) {
      ready = true;
      globalThis.__ashNativeBoot(bridge);
      return;
    }
    if (message.type === "frame" && message.frame && typeof message.frame === "object") { onFrame?.(message.frame); return; }
    if (message.type === "link") { lastLink = message; onLink?.(message); return; }
    const item = pending.get(message.id);
    if (!item || message.type !== item.result) return;
    pending.delete(message.id);
    item.resolve(message);
  };
  sayHello(0);
})();
