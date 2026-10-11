/**
 * Cloudflare for tests: the sign-in (authorize page is the test, token endpoint is here, with PKCE checked) and the part of
 * the REST API that building the relay uses. Uploading the Worker "deploys" it: the claim secret in the upload becomes the
 * secret of the fake relay, as it does on the real one. Nothing leaves the machine.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeGateway } from "../../../../link/test/fixtures/fake-gateway";

export interface Upload { account: string; script: string; metadata: Record<string, any>; source: string }

export class FakeCloudflare {
  readonly base: string;
  readonly email = "owner@example.com";
  readonly accessTokens = new Set<string>();
  readonly refreshTokens = new Set<string>();
  /** Every secret this fake ever handed out, for tests that look for leaks. */
  readonly issued: string[] = [];
  readonly uploads: Upload[] = [];
  readonly enabled: string[] = [];
  readonly calls: string[] = [];
  refreshes = 0;
  subdomain: string | null = null;
  /** The accounts the sign-in can see (the first, `acc1`, is where the single-account tests build). */
  accounts: { id: string; name: string }[] = [{ id: "acc1", name: "Owner's account" }];
  /** The Workers each account already has. */
  readonly scriptsBy = new Map<string, string[]>([["acc1", []]]);
  get scripts(): string[] { return this.scriptsBy.get("acc1")!; }
  set scripts(value: string[]) { this.scriptsBy.set("acc1", value); }
  /** Seconds a token lives. */
  expiresIn = 3600;
  /** `METHOD /path` (without the base) → a failure to answer with once. */
  readonly failures = new Map<string, { status: number; message: string }>();
  private readonly codes = new Map<string, { challenge: string; redirect: string }>();

  private constructor(private readonly server: Server, port: number, private readonly relay: FakeGateway) {
    this.base = `http://127.0.0.1:${port}`;
  }

  static async start(relay: FakeGateway): Promise<FakeCloudflare> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const fake = new FakeCloudflare(server, (server.address() as AddressInfo).port, relay);
    server.on("request", (req, res) => void fake.route(req, res));
    return fake;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get endpoints() {
    return {
      authorizeUrl: `${this.base}/oauth2/auth`, tokenUrl: `${this.base}/oauth2/token`, apiBase: `${this.base}/client/v4`,
      siteUrl: () => this.relay.url,
    };
  }

  /** The owner's browser: opens the authorize page's link, signs in, and is sent back to the return address with a code. */
  async signIn(authorizeUrl: string, o: { state?: string; deny?: boolean } = {}): Promise<{ status: number; body: string; redirect: string }> {
    const url = new URL(authorizeUrl);
    const redirect = url.searchParams.get("redirect_uri")!;
    const back = new URL(redirect);
    if (o.deny) back.searchParams.set("error", "access_denied");
    else {
      const code = randomBytes(8).toString("hex");
      this.codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
      back.searchParams.set("code", code);
    }
    back.searchParams.set("state", o.state ?? url.searchParams.get("state")!);
    const res = await fetch(back);
    return { status: res.status, body: await res.text(), redirect };
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, this.base);
    const key = `${req.method} ${url.pathname}`;
    const json = (status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
    const ok = (result: unknown): void => json(200, { success: true, errors: [], result });
    const fail = (status: number, message: string): void => json(status, { success: false, errors: [{ code: 1000, message }], result: null });
    this.calls.push(key);

    if (key === "POST /oauth2/token") {
      const form = new URLSearchParams(raw.toString("utf8"));
      const issue = () => {
        const access = `at_${randomBytes(12).toString("hex")}`, refresh = `rt_${randomBytes(12).toString("hex")}`;
        this.accessTokens.add(access); this.refreshTokens.add(refresh); this.issued.push(access, refresh);
        return { access_token: access, refresh_token: refresh, token_type: "bearer", expires_in: this.expiresIn };
      };
      if (form.get("grant_type") === "authorization_code") {
        const entry = this.codes.get(form.get("code") ?? "");
        if (!entry) return json(400, { error: "invalid_grant" });
        this.codes.delete(form.get("code")!);
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (challenge !== entry.challenge || form.get("redirect_uri") !== entry.redirect) return json(400, { error: "invalid_grant" });
        return json(200, issue());
      }
      if (form.get("grant_type") === "refresh_token" && this.refreshTokens.has(form.get("refresh_token") ?? "")) {
        this.refreshes++;
        return json(200, issue());
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!url.pathname.startsWith("/client/v4/") || !this.accessTokens.has(bearer)) return fail(401, "Authentication error");
    const path = url.pathname.slice("/client/v4".length);
    const failure = this.failures.get(`${req.method} ${path}`);
    if (failure) { this.failures.delete(`${req.method} ${path}`); return fail(failure.status, failure.message); }

    if (key === "GET /client/v4/user") return ok({ email: this.email });
    if (key === "GET /client/v4/accounts") return ok(this.accounts);
    const inAccount = /^(GET|PUT|POST) \/client\/v4\/accounts\/([^/]+)\/workers\/(.+)$/.exec(key);
    if (inAccount) {
      const [, method, account, rest] = inAccount as unknown as [string, string, string, string];
      if (!this.accounts.some((a) => a.id === account)) return fail(403, "account not found");
      const scripts = this.scriptsBy.get(account) ?? (this.scriptsBy.set(account, []), this.scriptsBy.get(account)!);
      if (method === "GET" && rest === "subdomain") return this.subdomain ? ok({ subdomain: this.subdomain }) : fail(404, "subdomain not found");
      if (method === "PUT" && rest === "subdomain") { this.subdomain = JSON.parse(raw.toString("utf8")).subdomain; return ok({ subdomain: this.subdomain }); }
      if (method === "GET" && rest === "scripts") return ok(scripts.map((id) => ({ id })));
      const upload = method === "PUT" ? /^scripts\/([a-z0-9-]+)$/.exec(rest) : null;
      if (upload) {
        const form = await new Response(raw, { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
        const metadata = JSON.parse(await (form.get("metadata") as File).text());
        const source = await (form.get(metadata.main_module) as File).text();
        this.uploads.push({ account, script: upload[1]!, metadata, source });
        if (!scripts.includes(upload[1]!)) scripts.push(upload[1]!);
        this.relay.secret = metadata.bindings.find((b: any) => b.name === "BOOTSTRAP_SECRET")?.text ?? null;
        return ok({ id: upload[1] });
      }
      const subdomainOn = method === "POST" ? /^scripts\/([a-z0-9-]+)\/subdomain$/.exec(rest) : null;
      if (subdomainOn) { this.enabled.push(subdomainOn[1]!); return ok({ enabled: true }); }
    }
    return fail(404, `no such route ${key}`);
  }
}
