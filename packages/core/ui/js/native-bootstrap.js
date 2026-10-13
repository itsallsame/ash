// This file is embedded only in the APK's appassets page. The native listener is
// origin/main-frame bound; the owner credential never enters this page.
(() => {
  const native = globalThis.AshNative;
  if (!native || location.origin !== "https://appassets.androidplatform.net") return;
  const pending = new Map();
  let nextId = 0;
  let ready = false;
  const decode = (value) => Uint8Array.from(atob(value || ""), (char) => char.charCodeAt(0));
  const post = (value) => native.postMessage(JSON.stringify(value));

  // A share is plain draft text. Only the app UI may accept it; never an API request.
  let sharedText = null, shareHandler = null;
  const acceptedShares = new Set();
  const flushShare = () => {
    if (!ready || !sharedText || !shareHandler) return;
    const current = sharedText;
    let accepted = false;
    try { accepted = shareHandler(current) === true; } catch { /* Keep the native draft pending. */ }
    if (!accepted || sharedText !== current) return;
    sharedText = null; acceptedShares.add(current.id);
    if (acceptedShares.size > 64) acceptedShares.delete(acceptedShares.values().next().value);
    post({ type: 'share_text_ack', id: current.id });
  };
  globalThis.__ashShareText = Object.freeze({
    subscribe(handler) {
      if (typeof handler !== 'function') throw new TypeError('Share handler required');
      shareHandler = handler; flushShare();
      return () => { if (shareHandler === handler) shareHandler = null; };
    },
    flush: flushShare,
  });

  let materialEpoch = 0, materialRecoveryId = null, materialRecoveryMaxFiles = null;
  const materialError = code => Object.assign(new Error(code), { code });
  const closeMaterials = () => {
    materialEpoch++; materialRecoveryId = null; materialRecoveryMaxFiles = null;
    for (const [id, item] of pending) if (item.materialPicker) {
      item.finish(); item.reject(materialError('permission_denied'));
    }
    if (ready) post({ type: 'material_picker_close', id: 'material-close-' + (++nextId) });
  };
  globalThis.__ashMaterialPicker = Object.freeze({
    selectFiles(limits, signal) {
      if (!ready || location.origin !== 'https://appassets.androidplatform.net') return Promise.reject(materialError('unsupported'));
      if (![1, 4].includes(limits?.max_files) || limits?.max_file_bytes !== 4194304) return Promise.reject(materialError('invalid'));
      if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
      if ([...pending.values()].some(item => item.materialPicker)) return Promise.reject(materialError('result_unknown'));
      if (materialRecoveryId && materialRecoveryMaxFiles !== limits.max_files) return Promise.reject(materialError('result_unknown'));
      const maxFiles = limits.max_files;
      const id = materialRecoveryId || 'material-select-' + (++nextId), epoch = materialEpoch;
      return new Promise((resolve, reject) => {
        const abort = () => { if (!pending.has(id)) return; item.finish(); if (materialRecoveryId === id) materialRecoveryId = null; post({ type: 'material_cancel', id }); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { if (!pending.has(id)) return; item.finish(); materialRecoveryId = id; materialRecoveryMaxFiles = maxFiles; reject(materialError('result_unknown')); }, 300000);
        const item = { materialPicker: true, epoch, maxFiles, resolve, reject,
          finish() { pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
        pending.set(id, item); signal?.addEventListener('abort', abort, { once: true });
        try { post({ type: 'material_select', id, ...(maxFiles === 1 ? { max_files: 1, max_file_bytes: 4194304 } : {}) }); } catch { item.finish(); reject(materialError('offline')); }
      });
    },
    close: closeMaterials,
  });
  globalThis.addEventListener('pagehide', () => {
    closeMaterials();
    for(const item of [...pending.values()])if(item.resultFileSave){item.finish();item.reject(new DOMException('Page closed','AbortError'));}
  });

  globalThis.__ashFileSave = (ref) => {
    if (!ready) return Promise.reject(new Error("native file saving unavailable"));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      pending.set(id, { fileSave: true, finish() { pending.delete(id); }, resolve, reject });
      post({ type: "file_save", id, workspace: ref.workspace, path: ref.path });
    });
  };

  globalThis.__ashResultFileSave = (ref, screenToken) => {
    if (!ready || location.origin !== 'https://appassets.androidplatform.net') return Promise.reject(new Error('native result saving unavailable'));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      pending.set(id, { resultFileSave: true, finish() { pending.delete(id); }, resolve, reject });
      post({ type: 'result_file_save', id, screen_token: screenToken, save_id: ref.save_id, asset_version: ref.asset.version, sha256: ref.asset.sha256 });
    });
  };

  globalThis.__ashBrowserLogins = () => {
    if (!ready) return Promise.reject(new Error("native settings unavailable"));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      pending.set(id, { browserLogins: true, finish() { pending.delete(id); }, resolve, reject });
      post({ type: "browser_logins", id, operation: "clear" });
    });
  };

  globalThis.__ashGatewayConfig = (operation, url = "", secret = "") => {
    if (!ready || !["status", "save"].includes(operation)) return Promise.reject(new Error("native settings unavailable"));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      pending.set(id, { gatewayConfig: true, finish() { pending.delete(id); }, resolve, reject });
      post({ type: "gateway_config", id, operation, ...(operation === "save" ? { url, secret } : {}) });
    });
  };

  function request(operation, path, options = {}) {
    if (!ready) return Promise.reject(new Error("native transport unavailable"));
    const id = String(++nextId);
    const live = operation === "stream" && new URL(path, "http://ui.invalid").searchParams.get("follow") === "true";
    let resolve, reject, controller;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const signal = options.signal;
    const abort = () => {
      if (!pending.delete(id)) return;
      post({ type: "cancel", id });
      const error = new DOMException("Aborted", "AbortError");
      controller?.error(error);
      reject(error);
    };
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return result; }
    signal?.addEventListener("abort", abort, { once: true });
    pending.set(id, {
      finish() { pending.delete(id); signal?.removeEventListener("abort", abort); },
      started() {
        if (!live) return;
        resolve(new Response(new ReadableStream({ start(value) { controller = value; } }),
          { status: 200, headers: { "content-type": "text/event-stream" } }));
      },
      chunk(value) { controller?.enqueue(decode(value)); },
      done(message) {
        this.finish();
        if (live) controller?.close();
        else resolve(new Response([204, 205, 304].includes(message.status) ? null : decode(message.body), { status: message.status,
          headers: { "content-type": message.content_type || "application/octet-stream" } }));
      },
      error() { this.finish(); const error = new Error("core request unavailable"); controller?.error(error); reject(error); },
    });
    post({ type: "request", id, operation, path, method: options.method || "GET",
      headers: Object.fromEntries(new Headers(options.headers || {}).entries()), body: options.body || null });
    return result;
  }

  native.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "ready" && !ready) {
      ready = true;
      globalThis.__ashNativeBoot(request, message.endpoint);
      return;
    }
    if (message.type === 'share_text') {
      if (typeof message.id !== 'string' || !message.id || message.id.length > 128 ||
          typeof message.text !== 'string' || !/https?:\/\/[^\s<>]+/i.test(message.text) ||
          new TextEncoder().encode(message.text).length > 32768) return;
      if (acceptedShares.has(message.id)) { post({ type: 'share_text_ack', id: message.id }); return; }
      if (!sharedText) sharedText = Object.freeze({ id: message.id, text: message.text });
      if (sharedText.id === message.id) flushShare();
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    if (item.materialPicker) {
      if (message.type !== 'material_select_result') return;
      item.finish();
      if (item.epoch !== materialEpoch || location.origin !== 'https://appassets.androidplatform.net') { item.reject(materialError('permission_denied')); return; }
      if (message.ok !== true) {
        const code = ['result_unknown','offline','too_large','permission_denied','invalid','unsupported'].includes(message.error?.code) ? message.error.code : 'offline';
        if (code === 'result_unknown') { materialRecoveryId = message.id; materialRecoveryMaxFiles = item.maxFiles; } else materialRecoveryId = null; item.reject(materialError(code)); return;
      }
      if (typeof message.cancelled !== 'boolean' || !Array.isArray(message.selections) || message.selections.length > item.maxFiles || message.cancelled && message.selections.length) { item.reject(materialError('invalid')); return; }
      materialRecoveryId = null; materialRecoveryMaxFiles = null; item.resolve({ cancelled: message.cancelled, selections: message.selections }); return;
    }
    if (item.resultFileSave) {
      if (message.type === 'result_file_save_result') { item.finish(); item.resolve({ ok: message.ok === true, cancelled: message.cancelled === true }); }
      return;
    }
    if (item.fileSave) {
      if (message.type === "file_save_result") { item.finish(); item.resolve({ ok: message.ok === true, cancelled: message.cancelled === true }); }
      return;
    }
    if (item.browserLogins) {
      if (message.type === "browser_logins_result") { item.finish(); item.resolve({ ok: message.ok === true }); }
      return;
    }
    if (item.gatewayConfig) {
      if (message.type === "gateway_config_result") { item.finish(); item.resolve({ ok: message.ok === true,
        configured: message.configured === true, url: typeof message.url === "string" ? message.url : "" }); }
      return;
    }
    if (message.type === "started") item.started();
    else if (message.type === "chunk") item.chunk(message.body);
    else if (message.type === "done") item.done(message);
    else if (message.type === "error") item.error();
  };
  post({ type: "hello" });
})();
