import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { GatewayError } from "ash-gateway/client/client";
import { eventually } from "../../core/test/fixtures/wait";
import { Relay, RelayError, relayErrorInfo } from "../src/gateway";

const PAGE = `<!DOCTYPE html><html><head><title>Worker not found | Cloudflare</title></head><body><h1>Error 1042</h1><p>There is nothing here, ray 8f2c</p></body></html>`;
const owner = { id: "owner-id-for-the-test-1", publicKey: "x", sign: async () => "x" };

/** Nothing the relay or the network said may reach the words: no markup, no page text, no English error codes. */
function plain(text: string) {
  assert.ok(!/[<>]/.test(text), text);
  assert.ok(!/Cloudflare|DOCTYPE|html|ray 8f2c|http_error|ECONN|ENOTFOUND|fetch failed/i.test(text), text);
  assert.ok(/[一-鿿]/.test(text), text);
}

async function serve(t: test.TestContext, status: number, body: string): Promise<string> {
  const server: Server = createServer((_req, res) => { res.writeHead(status, { "content-type": "text/html" }); res.end(body); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function failing(t: test.TestContext, url: string): Promise<Relay> {
  const relay = new Relay({ url, owner, backoff: { initialMs: 10, maxMs: 50 }, timeoutMs: 2000 });
  t.after(() => relay.stop());
  relay.start();
  await eventually(() => relay.lastError !== null, "the relay says why it failed");
  return relay;
}

test("a relay that answers 404 with a web page is told as the address not being found, without the page", async (t) => {
  const relay = await failing(t, await serve(t, 404, PAGE));
  const text = relay.lastError!;
  plain(text);
  assert.match(text, /找不到（404）/);
  assert.match(text, /重新部署|换/);
  assert.equal(relay.lastStatus, 404);
});

test("a 5xx page is told as the relay having trouble, keeping the status beside it", async (t) => {
  for (const status of [500, 502, 522]) {
    const relay = await failing(t, await serve(t, status, PAGE));
    plain(relay.lastError!);
    assert.match(relay.lastError!, /出了问题/);
    assert.equal(relay.lastStatus, status);
  }
});

test("other statuses and a 403 are told in their own words, and none carries the body", async (t) => {
  const forbidden = await failing(t, await serve(t, 403, PAGE));
  plain(forbidden.lastError!);
  assert.match(forbidden.lastError!, /不让这台手机进/);
  const limited = await failing(t, await serve(t, 429, PAGE));
  plain(limited.lastError!);
  assert.match(limited.lastError!, /太多/);
  const odd = await failing(t, await serve(t, 418, PAGE));
  plain(odd.lastError!);
  assert.equal(odd.lastStatus, 418);
});

test("a network that cannot be reached is told as such, with no status", async (t) => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const relay = await failing(t, url);
  plain(relay.lastError!);
  assert.match(relay.lastError!, /连不上/);
  assert.equal(relay.lastStatus, null);
});

test("a 200 that is not the relay's health, and an unknown failure, get the general words", async (t) => {
  const relay = await failing(t, await serve(t, 200, PAGE));
  plain(relay.lastError!);
  plain(relayErrorInfo({ weird: PAGE }).text);
  plain(relayErrorInfo(new Error(`boom ${PAGE}`)).text);
  plain(relayErrorInfo(undefined).text);
});

test("an error the relay client raised keeps its status however it was wrapped", () => {
  const raw = new GatewayError(404, "http_error", PAGE);
  assert.equal(relayErrorInfo(raw).status, 404);
  assert.equal(relayErrorInfo(new RelayError("unreachable", raw.message, raw)).status, 404);
  plain(relayErrorInfo(new RelayError("unreachable", raw.message, raw)).text);
  for (const problem of ["claimed_by_other", "bad_secret", "missing_secret", "unsupported"] as const) plain(relayErrorInfo(new RelayError(problem, `english ${PAGE}`)).text);
});
