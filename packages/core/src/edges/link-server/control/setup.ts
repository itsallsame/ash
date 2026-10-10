/**
 * Building the relay in the owner's own Cloudflare account (SPEC-03 §9.5.3).
 *
 * The owner signs in to Cloudflare with OAuth (PKCE) in the phone's own browser; the page returns to a listener on
 * 127.0.0.1 that exists only while a setup waits for it (and for at most 15 minutes). The token goes into the vault and
 * nowhere else. `deploy` then uses it to put the packaged relay program in the account, claims the relay with the
 * hub's identity, and connects. No result, message or error of this module carries a credential.
 *
 * Every change of state is told to whoever started the setup as a background message (HUB-MODULES §4); `status` can be
 * asked at any time. The record of a setup (its state and initiator) is a table here.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WordError, type Caller } from "../../../../../sdk/src/message";
import type { Db } from "../../../kernel/ledger";
import type { Router, Vault } from "../../../kernel/types";

export const SETUP_STATES = ["waiting_login", "authorized", "deploying", "claimed", "connected", "failed"] as const;
export type SetupState = (typeof SETUP_STATES)[number];
export interface SetupInfo { setup_id: string; state: SetupState; reason?: string }

/** Where the vault keeps the Cloudflare sign-in (JSON: access token, refresh token, expiry). */
export const CLOUDFLARE_REF = "cloudflare.oauth";

export interface CloudflareEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  apiBase: string;
  clientId: string;
  scopes: string[];
  /** The address the new Worker answers at. Default `https://<script>.<subdomain>.workers.dev`; tests point it at a fake relay. */
  siteUrl?: (script: string, subdomain: string) => string;
}

/**
 * Cloudflare's own sign-in for command-line tools: a public client (no secret) whose registered return address is
 * `http://localhost:8976/oauth/callback`. Ash uses it until it has a client of its own.
 */
export const CLOUDFLARE: CloudflareEndpoints = {
  authorizeUrl: "https://dash.cloudflare.com/oauth2/auth",
  tokenUrl: "https://dash.cloudflare.com/oauth2/token",
  apiBase: "https://api.cloudflare.com/client/v4",
  clientId: "54d11594-84e4-41aa-b438-e81b8fa78ee7",
  scopes: ["account:read", "user:read", "workers:write", "workers_scripts:write", "workers_routes:write", "offline_access"],
};

export interface SetupDeps {
  db: Db;
  router: Router;
  /** Holds the Cloudflare sign-in. */
  vault: Pick<Vault, "set" | "use">;
  /**
   * Makes the relay at [url] this hub's relay: claims it with [claimSecret] if it is unclaimed, remembers it and starts connecting.
   * Throws when the relay cannot be reached or claimed.
   */
  activate(url: string, claimSecret: string, account: { email?: string }): Promise<void>;
  /** True once the hub is connected to the relay, waiting at most [timeoutMs]. */
  connected(timeoutMs: number): Promise<boolean>;
  /** The relay program packaged in this build, as one module (SPEC-03 §8.1 item 5). */
  bundle?(): Promise<string>;
  /** Why the packaged relay program cannot be used right now, or null when it can; asked at every deploy. */
  bundleMissing?(): string | null;
  cloudflare?: Partial<CloudflareEndpoints>;
  /** The listener's port. Default 8976, the one Cloudflare's sign-in was registered with; 0 = any (tests). */
  callbackPort?: number;
  /** The host name in the return address the browser is sent back to. Default `localhost`. */
  callbackHost?: string;
  /** How long a setup waits for the sign-in. Default 15 minutes. */
  loginMs?: number;
  /** How long to wait for a new relay to answer, and how often to ask. Default 60 s / 1.5 s. */
  reachable?: { maxMs: number; everyMs: number };
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

const SERVICE_ID = "service:link";
const SERVICE: Caller = { member: SERVICE_ID, via: "service", local: true };
const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_SCRIPT = "ash-gateway";
const COMPATIBILITY_DATE = "2026-09-01";
const SCHEMA = `CREATE TABLE IF NOT EXISTS link_setups (
  setup_id TEXT PRIMARY KEY, initiator TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`;

const OUTCOME: Record<Exclude<SetupState, "failed">, string> = {
  waiting_login: "is waiting for the owner to sign in to Cloudflare",
  authorized: "has the owner's Cloudflare sign-in; deploy it with service:link/gateway.setup.deploy",
  deploying: "is deploying the relay in the owner's Cloudflare account",
  claimed: "is deployed and claimed; the hub is connecting to it",
  connected: "is done: the hub is connected to the relay",
};

/** A setup step that failed with something the owner can read. Never carries a credential. */
class Failure extends Error {}
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:sans-serif;text-align:center;padding:3em 1em"><h2>${title}</h2><p>${body}</p>`;

interface Login { verifier: string; state: string; used: boolean; server: Server; timer: ReturnType<typeof setTimeout>; redirect: string }

export class RelaySetup {
  private login: (Login & { id: string }) | null = null;
  private readonly cf: CloudflareEndpoints;
  private readonly now: () => number;
  private readonly request: typeof fetch;

  constructor(private readonly d: SetupDeps) {
    d.db.exec(SCHEMA);
    this.cf = { ...CLOUDFLARE, ...d.cloudflare };
    this.now = d.now ?? Date.now;
    this.request = d.fetch ?? fetch;
  }

  // ---- the words ---------------------------------------------------------------------------------------------------------

  /** Opens the listener, asks the owner to sign in, and returns at once. */
  async start(initiator: string): Promise<SetupInfo> {
    for (const row of this.rows()) {
      if (row.state === "waiting_login" || row.state === "deploying") {
        throw new WordError("conflict", `relay setup ${row.setup_id} is still ${row.state}`, { recovery_hint: "Wait for it, or cancel it with gateway.setup.cancel, then start again." });
      }
    }
    for (const row of this.rows()) if (row.state === "authorized") this.move(row.setup_id, "failed", "replaced by a newer setup");
    const id = `rs_${randomBytes(6).toString("base64url")}`;
    const verifier = b64u(randomBytes(32));
    const state = b64u(randomBytes(16));
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.d.callbackPort ?? 8976, "127.0.0.1", resolve);
    }).catch((error: NodeJS.ErrnoException) => {
      throw new WordError("unavailable", error.code === "EADDRINUSE" ? "the sign-in return port is busy" : "cannot listen for the Cloudflare sign-in", {
        recovery_hint: "Another sign-in may be open; cancel it or close the program using the port, then try again.",
      });
    });
    const port = (server.address() as AddressInfo).port;
    const redirect = `http://${this.d.callbackHost ?? "localhost"}:${port}/oauth/callback`;
    const timer = setTimeout(() => this.fail(id, "the sign-in was not finished in time"), this.d.loginMs ?? 15 * 60_000);
    timer.unref();
    this.login = { id, verifier, state, used: false, server, timer, redirect };
    server.on("request", (req, res) => void this.callback(id, req.url ?? "/", res));
    const now = this.now();
    this.d.db.prepare("INSERT INTO link_setups (setup_id, initiator, state, reason, created_at, updated_at) VALUES (?, ?, 'waiting_login', NULL, ?, ?)").run(id, initiator, now, now);

    const url = new URL(this.cf.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: "code", client_id: this.cf.clientId, redirect_uri: redirect, scope: this.cf.scopes.join(" "), state,
      code_challenge: b64u(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    }).toString();
    this.d.router.send({
      to: "person:owner", kind: "request", word: "show",
      body: { card: { type: "link", url: url.toString(), title: "登录 Cloudflare", summary: "授权 Ash 在你的 Cloudflare 账号里搭中转站。授权完成后回到 Ash。" } },
    }, SERVICE).then((reply) => { if (!reply.ok) this.d.log?.(`the Cloudflare sign-in card was not shown: ${reply.error.message}`); }, (error) => this.d.log?.("the Cloudflare sign-in card failed", error));
    this.tell(id, "waiting_login");
    return this.info(id);
  }

  status(id: string): SetupInfo { return this.info(id); }

  /** Starts the deployment of an authorized setup; the result is `deploying` and the rest is told as it happens. */
  deploy(id: string, name?: string): SetupInfo {
    const row = this.row(id);
    if (row.state !== "authorized") {
      throw new WordError("conflict", `relay setup ${id} is ${row.state}, not authorized`, { recovery_hint: row.state === "waiting_login" ? "The owner has not signed in to Cloudflare yet." : "Start a new setup." });
    }
    const script = name ?? DEFAULT_SCRIPT;
    if (!SCRIPT_NAME.test(script)) throw new WordError("bad_request", "name must be lowercase letters, digits and dashes");
    const missing = this.d.bundle ? this.d.bundleMissing?.() ?? null : "this build has no packaged relay program";
    if (missing) throw new WordError("unavailable", missing, { recovery_hint: "Update Ash, or use an existing relay with gateway.use." });
    this.move(id, "deploying");
    void this.runDeploy(id, script).catch((error) => this.fail(id, this.reason(error)));
    return this.info(id);
  }

  cancel(id: string): SetupInfo {
    const row = this.row(id);
    if (row.state !== "connected" && row.state !== "failed") this.fail(id, "cancelled");
    return this.info(id);
  }

  /** A setup that was waiting or deploying when the hub stopped cannot go on. Told to its initiator. */
  recover(): void {
    for (const row of this.rows()) if (row.state === "waiting_login" || row.state === "deploying") this.fail(row.setup_id, "the hub restarted");
  }

  /** Closes the listener. */
  stop(): void { this.closeLogin(); }

  // ---- state -------------------------------------------------------------------------------------------------------------

  private rows(): { setup_id: string; initiator: string; state: SetupState; reason: string | null }[] {
    return this.d.db.prepare("SELECT setup_id, initiator, state, reason FROM link_setups ORDER BY created_at, setup_id").all() as never;
  }
  private row(id: string) {
    const row = this.rows().find((r) => r.setup_id === id);
    if (!row) throw new WordError("not_found", `no relay setup ${id}`);
    return row;
  }
  private info(id: string): SetupInfo {
    const row = this.row(id);
    return { setup_id: row.setup_id, state: row.state, ...(row.reason ? { reason: row.reason } : {}) };
  }
  private move(id: string, state: SetupState, reason?: string): void {
    const row = this.row(id);
    if (row.state === state) return;
    if (row.state === "failed" || row.state === "connected") return;
    this.d.db.prepare("UPDATE link_setups SET state = ?, reason = ?, updated_at = ? WHERE setup_id = ?").run(state, reason ?? null, this.now(), id);
    if (this.login?.id === id && state !== "waiting_login") this.closeLogin();
    this.tell(id, state, reason);
  }
  private fail(id: string, reason: string): void { this.move(id, "failed", reason.slice(0, 300)); }
  private alive(id: string): void {
    const state = this.row(id).state;
    if (state === "failed") throw new Failure(this.row(id).reason ?? "cancelled");
  }

  /** The initiator, when it is an agent, hears of the change (HUB-MODULES §4). The owner sees the card and the page. */
  private tell(id: string, state: SetupState, reason?: string): void {
    const initiator = this.row(id).initiator;
    if (!initiator.startsWith("agent:")) return;
    const what = state === "failed" ? `failed: ${reason ?? "unknown reason"}` : OUTCOME[state];
    void this.d.router.send({ to: initiator, kind: "request", word: "tell", body: { text: `Relay setup ${id} ${what}. Use service:link/gateway.setup.status to look.` } }, SERVICE)
      .catch((error) => this.d.log?.("could not tell the initiator of a relay setup", error));
  }

  private closeLogin(): void {
    const login = this.login;
    if (!login) return;
    this.login = null;
    clearTimeout(login.timer);
    login.server.close();
    // Whatever is still open (a browser keeping its connection alive) would hold the port.
    setTimeout(() => login.server.closeAllConnections(), 250).unref();
  }

  private reason(error: unknown): string {
    if (error instanceof Failure) return error.message;
    this.d.log?.("relay setup failed", error);
    return "something unexpected went wrong";
  }

  // ---- the sign-in -------------------------------------------------------------------------------------------------------

  private async callback(id: string, rawUrl: string, res: import("node:http").ServerResponse): Promise<void> {
    const login = this.login;
    const url = new URL(rawUrl, "http://callback.invalid");
    const html = (status: number, title: string, body: string) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close", "cache-control": "no-store" }).end(page(title, body));
    if (!login || login.id !== id || url.pathname !== "/oauth/callback") return void html(404, "Not found", "");
    if (login.used || url.searchParams.get("state") !== login.state) return void html(400, "无法确认来源", "这个回调不是由 Ash 发起的。回到 Ash 重新开始。");
    // One return per setup: the state cannot be used twice.
    login.used = true;
    const denied = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (denied || !code) {
      html(400, "没有授权", "回到 Ash 重新开始。");
      return this.fail(id, denied ? "the owner did not allow access in Cloudflare" : "Cloudflare returned no code");
    }
    try {
      await this.exchange({ grant_type: "authorization_code", code, redirect_uri: login.redirect, code_verifier: login.verifier });
    } catch (error) {
      html(500, "授权没有完成", "回到 Ash 查看原因。");
      return this.fail(id, this.reason(error));
    }
    html(200, "授权成功，回到 Ash", "可以关掉这个页面了。");
    this.move(id, "authorized");
  }

  /** Trades a code (or a refresh token) for tokens and keeps them in the vault. */
  private async exchange(params: Record<string, string>): Promise<string> {
    let answer: Record<string, unknown>;
    try {
      const res = await this.request(this.cf.tokenUrl, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: this.cf.clientId, ...params }).toString(),
      });
      answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Failure(`Cloudflare did not give a token (${typeof answer.error === "string" ? answer.error : res.status})`);
    } catch (error) {
      throw error instanceof Failure ? error : new Failure("Cloudflare could not be reached for the token");
    }
    const access = answer.access_token, refresh = answer.refresh_token;
    if (typeof access !== "string" || !access) throw new Failure("Cloudflare gave no access token");
    const previous = this.stored();
    const keep = typeof refresh === "string" ? refresh : previous?.refresh_token;
    this.d.vault.set(CLOUDFLARE_REF, JSON.stringify({
      access_token: access, ...(keep ? { refresh_token: keep } : {}),
      expires_at: this.now() + (typeof answer.expires_in === "number" ? answer.expires_in : 3600) * 1000,
    }));
    return access;
  }

  private stored(): { access_token: string; refresh_token?: string; expires_at: number } | null {
    const raw = this.d.vault.use(CLOUDFLARE_REF);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  private async accessToken(): Promise<string> {
    const token = this.stored();
    if (!token) throw new Failure("there is no Cloudflare sign-in; start again");
    if (token.expires_at - 60_000 > this.now()) return token.access_token;
    if (!token.refresh_token) throw new Failure("the Cloudflare sign-in has expired; start again");
    return this.exchange({ grant_type: "refresh_token", refresh_token: token.refresh_token });
  }

  // ---- deploying -----------------------------------------------------------------------------------------------------------

  private async runDeploy(id: string, script: string): Promise<void> {
    const source = await this.d.bundle!();
    this.alive(id);
    let token = await this.accessToken();
    const account = await this.account(token);
    this.alive(id);
    const email = await this.api<{ email?: string }>(token, "GET", "/user").then((u) => u.email, () => undefined);
    const subdomain = await this.subdomain(token, account);
    this.alive(id);
    token = await this.accessToken();
    const scripts = await this.api<{ id?: string }[]>(token, "GET", `/accounts/${account}/workers/scripts`);
    const secret = b64u(randomBytes(32));
    await this.upload(token, account, script, source, secret, !scripts.some((s) => s.id === script));
    this.alive(id);
    await this.api(token, "POST", `/accounts/${account}/workers/scripts/${script}/subdomain`, { enabled: true, previews_enabled: false });
    const url = this.cf.siteUrl?.(script, subdomain) ?? `https://${script}.${subdomain}.workers.dev`;
    await this.reachable(id, url);
    this.alive(id);
    await this.d.activate(url, secret, { email }).catch((error) => { throw new Failure(`the relay was deployed but could not be claimed: ${error instanceof Error ? error.message : "unknown"}`); });
    this.alive(id);
    this.move(id, "claimed");
    if (!await this.d.connected(30_000)) throw new Failure("the relay was deployed and claimed but the hub could not connect to it");
    this.move(id, "connected");
  }

  private async account(token: string): Promise<string> {
    const accounts = await this.api<{ id: string }[]>(token, "GET", "/accounts");
    if (!Array.isArray(accounts) || !accounts[0]?.id) throw new Failure("the Cloudflare account has nothing to build in");
    return accounts[0].id;
  }

  /** The account's workers.dev name; the account has none until one is made. */
  private async subdomain(token: string, account: string): Promise<string> {
    const current = await this.api<{ subdomain?: string }>(token, "GET", `/accounts/${account}/workers/subdomain`).catch(() => null);
    if (current?.subdomain) return current.subdomain;
    for (let attempt = 0; attempt < 3; attempt++) {
      const name = `ash-${randomBytes(4).toString("hex")}`;
      const made = await this.api<{ subdomain?: string }>(token, "PUT", `/accounts/${account}/workers/subdomain`, { subdomain: name }).catch(() => null);
      if (made) return made.subdomain ?? name;
    }
    throw new Failure("could not make a workers.dev address in the account");
  }

  private async upload(token: string, account: string, script: string, source: string, secret: string, first: boolean): Promise<void> {
    const metadata = {
      main_module: "worker.mjs", compatibility_date: COMPATIBILITY_DATE, compatibility_flags: ["enable_request_signal"],
      bindings: [{ type: "durable_object_namespace", name: "HUB", class_name: "GatewayHub" }, { type: "secret_text", name: "BOOTSTRAP_SECRET", text: secret }],
      // A later deploy keeps what the owner set by hand in Cloudflare (for example RESET_EPOCH).
      keep_bindings: ["plain_text"],
      ...(first ? { migrations: { new_tag: "v1", new_sqlite_classes: ["GatewayHub"] } } : {}),
    };
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
    form.set("worker.mjs", new Blob([source], { type: "application/javascript+module" }), "worker.mjs");
    await this.api(token, "PUT", `/accounts/${account}/workers/scripts/${script}`, form);
  }

  /** A new Worker takes a moment to answer. */
  private async reachable(id: string, url: string): Promise<void> {
    const { maxMs, everyMs } = this.d.reachable ?? { maxMs: 60_000, everyMs: 1500 };
    const until = Date.now() + maxMs;
    for (;;) {
      this.alive(id);
      const ok = await this.request(`${url}/v1/health`).then((r) => r.ok, () => false);
      if (ok) return;
      if (Date.now() >= until) throw new Failure("the relay was deployed but does not answer yet");
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }

  /** One call to the Cloudflare API: the unwrapped `result`, or a [Failure] with Cloudflare's own words. */
  private async api<T = unknown>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.request(`${this.cf.apiBase}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
    } catch {
      throw new Failure("Cloudflare could not be reached");
    }
    const answer = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message?: string }[] } | null;
    if (!res.ok || !answer || answer.success === false) {
      const why = answer?.errors?.map((e) => e.message).filter(Boolean).join("; ");
      throw new Failure(`Cloudflare refused ${method} ${path.replace(/\/accounts\/[^/]+/, "/accounts/…")}: ${why || res.status}`);
    }
    return answer.result as T;
  }
}
