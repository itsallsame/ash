// This file is embedded only in the APK's appassets page. The page has no connection of its own: it trades two kinds of
// messages with the native layer. `{type:"frame", frame}` carries the human channel's frames of ash-link/1 unchanged, both
// ways; `{type:"link", open, client?, local?}` (native to page) says the channel opened or closed. The owner credential
// never enters this page.
(() => {
  const native = globalThis.AshNative;
  if (!native || location.origin !== "https://appassets.androidplatform.net") return;
  const pending = new Map();
  let nextId = 0;
  let ready = false;
  let onFrame = null;
  let onLink = null;
  let lastLink = null;
  const post = (value) => native.postMessage(JSON.stringify(value));

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
    onLink(fn) { onLink = fn; if (lastLink) fn(lastLink); },
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
  post({ type: "hello" });
})();
