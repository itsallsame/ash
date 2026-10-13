import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilitySpec, ContentPart } from "../../sdk/src/link";
import { BROWSER_ACTIONS, BROWSER_DEFAULT_SPACE, BROWSER_SPACE_PATTERN } from "../../sdk/src/namespaces";
import { WordError } from "../../sdk/src/message";
import type { CallOutcome } from "../../link/src/hand";
import { capabilityOf } from "./workspace";
import { redact } from "./redact";

// ---------------------------------------------------------------------------------------------------------------------
// the extension's socket
// ---------------------------------------------------------------------------------------------------------------------

// Protocol observed in WebBridge's installed extension: hello/tool_call/tool_result.
// Only its supported commands are used, never speculative browser operations.
const COMMANDS = ["navigate", "snapshot", "click", "fill", "evaluate", "screenshot", "upload", "network"] as const;
type Command = (typeof COMMANDS)[number];

/** A loopback listener for the extension, not a client to someone else's browser endpoint. */
export class KimiBridge {
  private server?: Server;
  private wss?: WebSocketServer;
  private socket?: WebSocket;
  private ready = false;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<() => void>();
  url = "";
  get online(): boolean { return this.ready && this.socket?.readyState === WebSocket.OPEN; }
  /** Called when the extension connects or goes away (the manifest depends on it). */
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => void this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) listener(); }
  async start(ports = [10086, 10089, 10090, 10091]): Promise<void> {
    for (const port of ports) {
      const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
      try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }
      catch { server.close(); continue; }
      this.server = server; this.url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
      const wss = this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
      server.on("upgrade", (request, socket, head) => {
        // Ordinary websites may not drive the local endpoint; only the installed extension connects.
        const origin = request.headers.origin;
        if (request.url !== "/ws" || !origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || this.socket) { socket.destroy(); return; }
        wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws));
      });
      wss.on("connection", (socket: WebSocket) => {
        this.socket = socket;
        socket.on("message", bytes => {
          try {
            const frame = JSON.parse(bytes.toString());
            if (frame.type === "hello") { this.ready = true; socket.send(JSON.stringify({ type: "hello_ack" })); this.changed(); return; }
            if (frame.type !== "tool_result") return;
            const pending = this.pending.get(frame.responseToRequestId); if (!pending) return;
            this.pending.delete(frame.responseToRequestId); clearTimeout(pending.timer);
            frame.payload?.error ? pending.reject(new WordError("failed", "Browser command failed")) : pending.resolve(frame.payload?.data);
          } catch { socket.close(1003, "Invalid browser frame"); }
        });
        socket.on("error", () => socket.close());
        socket.on("close", () => { const was = this.ready; this.socket = undefined; this.ready = false; this.failPending(); if (was) this.changed(); });
      });
      return;
    }
    throw new Error("No free loopback browser port");
  }
  private failPending(): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new WordError("result_unknown", "Browser disconnected; read the page before repeating an action", { recovery_hint: "browser.read" })); } this.pending.clear(); }
  /** One command to the extension; it answers one at a time. */
  command(name: Command, args: Record<string, unknown>): Promise<any> {
    if (!this.online) return Promise.reject(new WordError("unavailable", "Browser extension is not connected"));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID(), timer = setTimeout(() => { this.pending.delete(requestId); reject(new WordError("result_unknown", "Browser result unknown; read the page before repeating an action", { recovery_hint: "browser.read" })); }, 45000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ type: "tool_call", requestId, payload: { name, args } }));
    });
  }
  async close(): Promise<void> { this.failPending(); this.socket?.terminate(); this.wss?.close(); await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()); }
}

// ---------------------------------------------------------------------------------------------------------------------
// the standard browser.* on top of it (spec/notes/browser-namespace.md §4)
// ---------------------------------------------------------------------------------------------------------------------

/** Click, type and evaluate act with the owner's real logins here: a higher risk than the standard default (note §7.1). */
const RAISED = new Set(["browser.click", "browser.type", "browser.evaluate"]);
const MAX_SPACES = 4;
const MAX_ELEMENTS = 300;
const MAX_TEXT = 20_000;
const MAX_VALUE = 50_000;
/** A picture bigger than this travels as a file path only (one frame holds 4 MiB). */
const MAX_INLINE_IMAGE_B64 = 2_500_000;
const SPACE = new RegExp(BROWSER_SPACE_PATTERN);

const EXTENSION_SPACE_PROPS = { space: { type: "string", pattern: BROWSER_SPACE_PATTERN, description: "Which browser space (tab) to use; default main." } };
const PASS_THROUGH = (name: string, description: string, effect: "act" | "read", label: string): CapabilitySpec => ({
  name, label, description, effect, risk: "structure",
  input_schema: { type: "object", additionalProperties: false, required: ["args"], properties: { ...EXTENSION_SPACE_PROPS, args: { type: "object", description: "The extension command's own arguments." } } },
});
const EXTENSIONS: CapabilitySpec[] = [
  PASS_THROUGH("x.kimi.browser.upload", "Kimi WebBridge upload in this caller's tab of the space: args {selector, files} (files are paths on this computer).", "act", "在网页上传文件"),
  PASS_THROUGH("x.kimi.browser.network", "Kimi WebBridge network inspection in this caller's tab of the space: args {cmd}.", "read", "在看网页的网络请求"),
];

interface Element { ref: number; tag: string; type?: string; text: string; href?: string; disabled?: boolean; inViewport?: boolean }
interface Page { space: string; url: string; title: string; text: string; scroll?: { y: number; height: number }; elements: Element[]; truncated?: boolean }
interface Space { tab: number; page?: Page; usedAt: number }

const first = (...values: unknown[]): string | undefined => values.find((v): v is string => typeof v === "string" && v.length > 0);
const REF = /^@?e(\d+)$/;

/**
 * The extension's snapshot as the standard page. The snapshot's own layout is the extension's; this reads it
 * generously (a tree of nodes, or text lines) and takes every `@eN` reference as control number N.
 * UNVERIFIED against the live extension (note §7.2): a layout it does not recognise gives text only.
 */
export function pageFromSnapshot(space: string, raw: any, meta: { url: string; title: string; y?: number; height?: number }): Page {
  const elements: Element[] = [];
  const texts: string[] = [];
  const visit = (node: any): void => {
    if (typeof node === "string") { texts.push(node); return; }
    if (!node || typeof node !== "object") return;
    const ref = REF.exec(String(node.ref ?? node.id ?? node.selector ?? node.uid ?? ""));
    const label = first(node.name, node.text, node.label, node.title, node.placeholder, node.value);
    const children = node.children ?? node.nodes;
    if (ref) {
      elements.push({
        ref: Number(ref[1]), tag: String(node.tag ?? node.role ?? "element"), text: label ?? "",
        ...(typeof node.type === "string" ? { type: node.type } : {}),
        ...(typeof (node.href ?? node.url) === "string" ? { href: node.href ?? node.url } : {}),
        ...(node.disabled === true ? { disabled: true } : {}),
      });
    } else if (label && !Array.isArray(children)) texts.push(label);
    if (Array.isArray(children)) children.forEach(visit);
  };
  const tree = raw?.tree ?? raw?.nodes ?? raw;
  if (typeof tree === "string") {
    for (const line of tree.split("\n")) {
      const m = /@e(\d+)|\[ref=e(\d+)\]/.exec(line);
      const clean = line.replace(/\[ref=e\d+\]|@e\d+/g, "").replace(/^[\s\-*]+/, "").trim();
      if (m) {
        const role = /^([a-zA-Z]+)\b/.exec(clean)?.[1] ?? "element";
        elements.push({ ref: Number(m[1] ?? m[2]), tag: role, text: /"([^"]*)"/.exec(clean)?.[1] ?? clean.replace(/^[a-zA-Z]+\s*/, "") });
      } else if (clean) texts.push(clean);
    }
  } else if (Array.isArray(tree)) tree.forEach(visit);
  else if (tree && typeof tree === "object") visit(tree);
  const fullText = first(raw?.text) ?? texts.join("\n");
  const truncated = elements.length > MAX_ELEMENTS || fullText.length > MAX_TEXT;
  return {
    space, url: meta.url, title: meta.title,
    text: fullText.slice(0, MAX_TEXT), elements: elements.slice(0, MAX_ELEMENTS),
    ...(meta.y !== undefined && meta.height !== undefined ? { scroll: { y: meta.y, height: meta.height } } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

const ok = (data: unknown, content?: ContentPart[]): CallOutcome =>
  ({ ok: true, data, content: content ?? [{ type: "text", text: JSON.stringify(data) }] });

/** The standard `browser.*` over the Kimi extension, with one tab per (caller, space). Registered only while the extension is online. */
export class KimiBrowser {
  private spaces = new Map<string, Space>();
  private calling = false;
  /** Whose snapshot the extension's `@eN` numbers belong to: they are valid only until another space takes a snapshot. */
  private refOwner = "";
  constructor(private readonly bridge: KimiBridge, private readonly stateDir: string, private readonly now: () => number = Date.now) {}

  get online(): boolean { return this.bridge.online; }
  get busy(): boolean { return this.calling; }

  capabilities(): CapabilitySpec[] {
    if (!this.online) return [];
    return [
      ...BROWSER_ACTIONS.map((action) => capabilityOf(action, RAISED.has(action.name) ? "structure" : action.risk)),
      ...EXTENSIONS,
    ];
  }

  async call(name: string, input: Record<string, unknown>, caller: string, signal?: AbortSignal): Promise<CallOutcome> {
    const space = input.space === undefined ? BROWSER_DEFAULT_SPACE : input.space;
    const valid = name === "browser.spaces" || (typeof space === "string" && (SPACE.test(space) || (name === "browser.close" && space === "*")));
    if (!valid) throw new WordError("bad_request", "space must be 1-24 of a-z 0-9 _ -");
    if (this.calling) throw new WordError("unavailable", "The browser is busy with another command; try again", { recovery_hint: "retry" });
    this.calling = true;
    try {
      signal?.throwIfAborted();
      const outcome = await this.run(name, input, caller, String(space), signal);
      // Cancelling does not prove the browser action was undone; it is never reported as if it were.
      signal?.throwIfAborted();
      return outcome;
    } catch (error) {
      if (error instanceof WordError) throw error;
      if (signal?.aborted) throw new WordError("cancelled", "Browser command cancelled; its effect may already have happened", { recovery_hint: "browser.read" });
      throw new WordError("failed", error instanceof Error ? error.message : "Browser command failed");
    } finally { this.calling = false; }
  }

  private key(caller: string, space: string): string { return JSON.stringify([caller, space]); }
  private mine(caller: string): [string, Space][] {
    return [...this.spaces].filter(([key]) => (JSON.parse(key) as string[])[0] === caller);
  }
  private opened(caller: string, space: string): Space {
    const found = this.spaces.get(this.key(caller, space));
    if (!found) throw new WordError("not_found", `Space ${space} has no page`, { recovery_hint: "browser.open" });
    return found;
  }

  private async run(name: string, input: Record<string, unknown>, caller: string, space: string, signal?: AbortSignal): Promise<CallOutcome> {
    switch (name) {
      case "browser.open": {
        const url = input.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new WordError("bad_request", "Use an http or https URL");
        const key = this.key(caller, space);
        let tab = this.spaces.get(key);
        if (!tab) {
          // Past the few spaces a caller may keep open, the one used longest ago is forgotten (its tab stays in the browser).
          const mine = this.mine(caller);
          if (mine.length >= MAX_SPACES) this.spaces.delete(mine.sort((a, b) => a[1].usedAt - b[1].usedAt)[0]![0]);
        }
        const result = await this.bridge.command("navigate", { url, ...(tab ? { _tabId: tab.tab } : { newTab: true, _session: `ash-${randomUUID()}` }) });
        if (!tab) {
          if (!Number.isSafeInteger(result?.tabId)) throw new WordError("failed", "The browser did not open a tab");
          tab = { tab: result.tabId, usedAt: this.now() };
          this.spaces.set(key, tab);
        }
        return this.page(key, space, tab);
      }
      case "browser.read": {
        const key = this.key(caller, space);
        return this.page(key, space, this.opened(caller, space));
      }
      case "browser.click":
      case "browser.type": {
        const key = this.key(caller, space);
        const tab = this.opened(caller, space);
        const element = this.target(key, tab, input);
        if (name === "browser.type") {
          if (element.type === "password" || element.type === "file") throw new WordError("forbidden", `A ${element.type} field is not filled by an agent`);
          if (typeof input.text !== "string") throw new WordError("bad_request", "text is required");
          await this.bridge.command("fill", { selector: `@e${element.ref}`, value: input.text, _tabId: tab.tab });
          if (input.submit === true) await this.bridge.command("evaluate", { code: "(()=>{const e=document.activeElement;const f=e&&e.form;if(f){f.requestSubmit?f.requestSubmit():f.submit();}})()", _tabId: tab.tab });
        } else {
          await this.bridge.command("click", { selector: `@e${element.ref}`, _tabId: tab.tab });
        }
        this.refOwner = "";
        return this.page(key, space, tab);
      }
      case "browser.scroll":
      case "browser.back": {
        const key = this.key(caller, space);
        const tab = this.opened(caller, space);
        const code = name === "browser.back" ? "history.back()" : `window.scrollBy(0, ${input.direction === "up" ? "-" : ""}Math.round(window.innerHeight * 0.9))`;
        await this.bridge.command("evaluate", { code, _tabId: tab.tab });
        if (name === "browser.back") await new Promise((resolve) => setTimeout(resolve, 300));
        this.refOwner = "";
        return this.page(key, space, tab);
      }
      case "browser.screenshot": {
        const tab = this.opened(caller, space);
        const shot = await this.bridge.command("screenshot", { _tabId: tab.tab });
        if (typeof shot?.data !== "string") throw new WordError("failed", "The browser returned no picture");
        const mime = shot.format === "jpeg" || shot.format === "jpg" ? "image/jpeg" : "image/png";
        await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
        const path = join(this.stateDir, `browser-${randomUUID()}.${mime === "image/jpeg" ? "jpg" : "png"}`);
        await writeFile(path, Buffer.from(shot.data, "base64"), { mode: 0o600 });
        const where = await this.where(tab);
        const data = { space, url: where.url, title: where.title, mime, path };
        return ok(data, [{ type: "text", text: JSON.stringify(data) }, ...(shot.data.length <= MAX_INLINE_IMAGE_B64 ? [{ type: "image" as const, mime, b64: shot.data }] : [])]);
      }
      case "browser.evaluate": {
        const tab = this.opened(caller, space);
        if (typeof input.code !== "string" || !input.code) throw new WordError("bad_request", "code is required");
        const raw = await this.bridge.command("evaluate", { code: input.code, _tabId: tab.tab });
        let value: unknown = redact(raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw) ?? null;
        let truncated = false;
        const text = JSON.stringify(value);
        if (text !== undefined && text.length > MAX_VALUE) { value = text.slice(0, MAX_VALUE); truncated = true; }
        tab.usedAt = this.now();
        return ok({ space, value, ...(truncated ? { truncated: true } : {}) });
      }
      case "browser.close": {
        const closed: string[] = [];
        for (const [key] of this.mine(caller)) {
          const open = (JSON.parse(key) as string[])[1]!;
          if (space === "*" || open === space) { this.spaces.delete(key); closed.push(open); }
        }
        // The tab stays in the browser: only this program's memory of it is dropped (note §7.5).
        return ok({ closed });
      }
      case "browser.spaces": {
        const list = this.mine(caller).sort((a, b) => b[1].usedAt - a[1].usedAt)
          .map(([key, tab]) => ({ space: (JSON.parse(key) as string[])[1]!, url: tab.page?.url ?? "", title: tab.page?.title ?? "", last_used: tab.usedAt }));
        return ok({ spaces: list });
      }
      case "x.kimi.browser.upload":
      case "x.kimi.browser.network": {
        const tab = this.opened(caller, space);
        const args = input.args;
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new WordError("bad_request", "args must be an object");
        const clean = Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith("_") && key !== "newTab"));
        const result = redact(await this.bridge.command(name.endsWith("upload") ? "upload" : "network", { ...clean, _tabId: tab.tab }));
        const text = JSON.stringify(result) ?? "null";
        if (text.length > MAX_VALUE) {
          const path = join(this.stateDir, `browser-${randomUUID()}.json`);
          await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
          await writeFile(path, text, { mode: 0o600 });
          return ok({ path, preview: text.slice(0, 12000), truncated: true });
        }
        return ok(result ?? null);
      }
      default: throw new WordError("not_found", `This browser does not serve ${name}`);
    }
  }

  /** The control a click or type means, checked against the last page of that space: its number, the site and, when the page gave one, its name. */
  private target(key: string, tab: Space, input: Record<string, unknown>): Element {
    const page = tab.page;
    if (!page || this.refOwner !== key) throw new WordError("conflict", "The page numbers are stale", { recovery_hint: "browser.read" });
    const element = page.elements.find((e) => e.ref === input.ref);
    if (!element) throw new WordError("conflict", `No control ${String(input.ref)} on the latest page`, { recovery_hint: "browser.read" });
    const host = hostOf(page.url), site = String(input.site ?? "").toLowerCase().replace(/^www\./, "");
    if (!site || !host || !(host === site || host.endsWith(`.${site}`))) throw new WordError("conflict", `The page is ${host || "unknown"}, not ${site}`, { recovery_hint: "browser.read" });
    // Without a name for the control only the site can be checked (note §7.2).
    const label = String(input.label ?? "").trim().toLowerCase(), name = element.text.trim().toLowerCase();
    if (name && label && !name.includes(label) && !label.includes(name)) throw new WordError("conflict", `Control ${element.ref} is "${element.text}", not "${String(input.label)}"`, { recovery_hint: "browser.read" });
    return element;
  }

  private async where(tab: Space): Promise<{ url: string; title: string; y?: number; height?: number }> {
    const code = "JSON.stringify({url: location.href, title: document.title, y: Math.round(window.scrollY), height: window.innerHeight})";
    const raw = await this.bridge.command("evaluate", { code, _tabId: tab.tab });
    const value = raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return { url: String(parsed?.url ?? ""), title: String(parsed?.title ?? ""), ...(Number.isFinite(parsed?.y) ? { y: parsed.y } : {}), ...(Number.isFinite(parsed?.height) ? { height: parsed.height } : {}) };
    } catch { return { url: tab.page?.url ?? "", title: tab.page?.title ?? "" }; }
  }

  private async page(key: string, space: string, tab: Space): Promise<CallOutcome> {
    const snapshot = await this.bridge.command("snapshot", { _tabId: tab.tab });
    const where = await this.where(tab);
    const page = pageFromSnapshot(space, redact(snapshot), where);
    tab.page = page; tab.usedAt = this.now();
    this.refOwner = key;
    return ok(page, [{ type: "text", text: `${page.title}\n${page.url}\n\n${page.text}\n\n${page.elements.map((e) => `[${e.ref}] ${e.tag} ${e.text}`).join("\n")}`.slice(0, MAX_TEXT) }]);
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
