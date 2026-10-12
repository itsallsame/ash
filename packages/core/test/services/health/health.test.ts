import assert from "node:assert/strict";
import test from "node:test";
import { compileSchema } from "../../../../sdk/src/word";
import type { Message } from "../../../../sdk/src/message";
import { createHealthService, type Sample } from "../../../src/services/health";
import { INVARIANTS, type Invariant } from "../../../src/services/health/budgets";
import { openLedger } from "../../kernel/ledger/helpers";
import { agent, call, owner } from "../support";

const MB = 1024 * 1024;

function setup(sample: Sample = { cpu_pct: 1, rss: 50 * MB, heap: 10 * MB, lag_p99_ms: 1 }, invariants?: readonly Invariant[]) {
  const { ledger } = openLedger();
  let t = 1_000_000_000_000;
  let cb: (m: Message) => void = () => {};
  const logs: string[] = [];
  let viewing = false;
  const service = createHealthService({
    ledger, now: () => t, viewing: () => viewing, sampler: { sample: () => sample }, log: (m) => logs.push(m), ...(invariants ? { invariants } : {}),
    router: { subscribe: (_f, fn) => { cb = fn; return () => { cb = () => {}; }; } },
    registry: { find: (_to, word) => ({ contract: { effect: word === "say" ? "write" : "read" } }) as any },
  });
  service.start();
  let seq = 0;
  /** A message at the router's door, and as published when the ledger took it (`seq`) or when it is an event. */
  const feed = (to: string | null, word: string, o: Partial<Message> = {}) => {
    const m: Message = { seq: 0, id: `m_${++seq}`, ts: t, from: "person:owner", to, kind: "request", word, body: {}, ...o };
    service.tap({ phase: "in", kind: m.kind, from: m.from, to: m.to, word: m.word, via: "human" });
    if (m.seq > 0 || m.kind === "event") cb(m);
  };
  /** An answer that left the router with an error. */
  const fail = (to: string, word: string, code: string) => service.tap({ phase: "out", kind: "request", from: "person:owner", to, word, via: "human", error: code });
  /** Moves the clock by `seconds` in ticks of ten, `each` before every tick. */
  const run = (seconds: number, each: () => void = () => {}) => { for (let i = 0; i < seconds / 10; i++) { each(); t += 10_000; service.tick(); } };
  const events = async () => (await call(service, owner, "recent", {})).events as any[];
  return { service, ledger, logs, feed, fail, run, events, watch: (on: boolean) => { viewing = on; }, status: () => call(service, owner, "status", {}), clock: () => t };
}

const spin = (s: ReturnType<typeof setup>) => () => { for (let i = 0; i < 440; i++) s.feed("service:history", "current"); };

test("the busy loop of 10-12 is caught within 40 seconds of the first idle bucket: the word is named, the heartbeat says degraded", async () => {
  const s = setup();
  s.run(60); // nothing asked of Ash for a minute: idle from here
  s.run(10, spin(s));
  assert.equal((await s.status()).invariants.find((i: any) => i.id === "idle.msg_key_rate").ok, false, "seen at once");
  assert.deepEqual(await s.events(), [await s.events().then((e) => e.find((x) => x.type === "start"))], "but only the start is written: it has to last");
  assert.equal(s.service.heartbeat().state, "running");
  s.run(30, spin(s));
  const breach = (await s.events()).find((e) => e.id === "idle.msg_key_rate");
  assert.ok(breach, "the event is written");
  assert.equal(breach.top[0].key, "service:history/current:person");
  assert.ok(breach.value > 2000 && breach.budget === 6 && breach.idle === true);
  assert.match(breach.note, /again and again/);
  assert.ok((await s.events()).some((e) => e.id === "idle.msg_rate"));
  assert.equal(s.service.heartbeat().state, "degraded");
  assert.match(s.service.heartbeat().text, /idle\.msg_key_rate/);
  assert.ok(s.logs.some((l) => l.includes("service:history/current")), "and the log line names it");
});

test("a recorded spin is caught by its ledger growth too", async () => {
  const s = setup();
  s.run(60);
  s.run(40, () => { for (let i = 0; i < 100; i++) s.feed("service:history", "current", { seq: 7 }); });
  const ids = (await s.events()).map((e) => e.id);
  assert.ok(ids.includes("idle.ledger_growth"));
});

test("a quiet hub is not flagged: a heartbeat-like trickle for five minutes writes no event", async () => {
  const s = setup();
  s.run(300, () => { s.feed("service:clock", "list", { from: "service:cost" }); });
  assert.deepEqual((await s.events()).map((e) => e.type), ["start"]);
  assert.equal(s.service.heartbeat().state, "running");
  const status = await s.status();
  assert.ok(status.invariants.every((i: any) => i.ok));
  assert.ok(status.rates.msg_per_min > 0 && status.rates.msg_per_min < 10);
});

test("while a turn runs, or the owner has just asked for something, the hub is not idle: traffic is expected", async () => {
  const s = setup();
  s.run(120);
  s.feed("agent:main", "turn.started", { kind: "event", from: "agent:main", to: null, body: { turn: "t1", lane: "front" } });
  s.run(120, spin(s));
  assert.equal((await s.status()).idle, false);
  assert.deepEqual((await s.events()).map((e) => e.type), ["start"]);
  s.feed("agent:main", "turn.ended", { kind: "event", from: "agent:main", to: null, body: { turn: "t1", lane: "front", outcome: "completed" } });
  s.run(60);
  s.feed("agent:main", "say"); // the owner saying something is activity too
  s.run(10);
  assert.equal((await s.status()).idle, false);
  s.run(60);
  assert.equal((await s.status()).idle, true);
});

test("a reader that polls the health every second shows: the meter counts its own words like any other", async () => {
  const s = setup();
  s.run(60);
  s.run(40, () => { for (let i = 0; i < 10; i++) s.feed("service:health", "status"); });
  assert.ok((await s.events()).some((e) => e.id === "idle.msg_key_rate" && e.top[0].key === "service:health/status:person"));
});

test("a plain read that the ledger does not take is seen all the same", async () => {
  const s = setup();
  s.run(60);
  s.run(10, () => { for (let i = 0; i < 50; i++) s.feed("service:history", "current"); });
  assert.equal((await s.status()).rates.ledger_rows_per_min, 0);
  assert.ok((await s.status()).rates.msg_per_min > 30);
});

test("a hand that connects again and again is a reconnect storm; errors that a caller caused are not counted", async () => {
  const s = setup();
  s.run(60, () => { for (let i = 0; i < 2; i++) s.service.noteLink("open", "device:phone"); });
  assert.ok((await s.events()).some((e) => e.id === "link.reconnect_storm" && e.top[0].key === "open:device:phone"));
  const errors = (code: string) => s.fail("service:x", "x", code);
  s.run(60, () => { for (let i = 0; i < 100; i++) errors("not_found"); });
  assert.ok(!(await s.events()).some((e) => e.id === "errors.rate"));
  s.run(60, () => { for (let i = 0; i < 100; i++) errors("timeout"); });
  assert.ok((await s.events()).some((e) => e.id === "errors.rate"));
  s.run(40, () => { for (let i = 0; i < 20; i++) s.service.noteError("record"); });
  assert.ok((await s.events()).some((e) => e.id === "errors.internal" && e.top[0].key === "record"));
});

test("once per ten minutes at most: a budget broken all the time writes one event, not one per tick", async () => {
  const s = setup({ cpu_pct: 90, rss: 1, heap: 1, lag_p99_ms: 500 });
  s.run(300);
  const lag = (await s.events()).filter((e) => e.id === "loop.lag");
  assert.equal(lag.length, 1);
});

test("a minute becomes one row; recent reads them newest first; a restart says when the last process was seen", async () => {
  const s = setup();
  s.run(60, () => { s.feed("service:clock", "list", { from: "service:cost" }); });
  s.run(60, () => { s.feed("service:clock", "list", { from: "service:cost" }); });
  const { minutes } = await call(s.service, agent(), "recent", { kind: "minute" });
  assert.ok(minutes.length >= 1);
  assert.ok(minutes[0].at % 60_000 === 0 && minutes[0].msg > 0 && minutes[0].top[0].key.includes("service:clock/list"));
  // The same database, a second process.
  const again = createHealthService({ ledger: s.ledger, now: () => s.clock() + 5 * 60_000, sampler: { sample: () => ({ cpu_pct: 0, rss: 0, heap: 0, lag_p99_ms: 0 }) }, router: { subscribe: () => () => {} }, registry: { find: () => null } });
  again.start();
  const start = (await call(again, owner, "recent", {})).events.find((e: any) => e.type === "start");
  assert.ok(start.last_seen > 0 && start.last_seen % 60_000 === 0);
  again.stop();
});

test("only the newest 2000 events are kept", async () => {
  const s = setup();
  const db = s.ledger.db();
  db.exec("BEGIN");
  for (let i = 1; i < 2100; i++) db.prepare("INSERT INTO health_event (at, json) VALUES (?, '{}')").run(i);
  db.exec("COMMIT");
  (s.service as any).addEvent({ at: 2100, type: "breach", id: "x" });
  const rows = s.ledger.db().prepare("SELECT COUNT(*) AS n, MIN(at) AS first FROM health_event").get() as { n: number; first: number };
  assert.equal(rows.n, 2000);
  assert.equal(rows.first, 101);
});

test("the answers fit their contracts, for the owner and for an agent", async () => {
  const s = setup();
  s.run(60, () => { s.feed("service:clock", "list", { from: "service:cost" }); });
  for (const who of [owner, agent()]) {
    for (const [word, input] of [["status", { window_s: 300 }], ["recent", {}], ["recent", { kind: "minute", limit: 5 }]] as const) {
      const contract = s.service.words().find((w) => w.word === word)!;
      const data = await call(s.service, who, word, input);
      const ok = compileSchema(contract.result_schema!);
      assert.ok(ok(data), `${word}: ${JSON.stringify(ok.errors)}`);
    }
  }
});

test("the invariants are plain data: they survive JSON, and a record added to the list is evaluated by the same engine", async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(INVARIANTS)), INVARIANTS);
  const extra: Invariant = { id: "clock.calls", metric: "msg", agg: "rate", match: "^service:clock/", budget: 10, idle: false, window_s: 60, persist_s: 10, note: "The clock is asked too often." };
  const s = setup(undefined, [extra]);
  s.run(40, () => { for (let i = 0; i < 20; i++) s.feed("service:clock", "list"); s.feed("service:cost", "usage.get"); });
  const found = (await s.events()).find((e) => e.id === "clock.calls");
  assert.ok(found && found.note === "The clock is asked too often." && found.top.length === 1 && found.top[0].key.startsWith("service:clock/"));
  assert.deepEqual((await s.status()).invariants.map((i: any) => i.id), ["clock.calls"]);
});

// Typing is the owner's activity even before a message is sent.
test("continuous owner typing is active; a plain read still counts as an idle loop", async () => {
  const s = setup();
  s.run(60);
  s.run(180, () => {
    s.feed(null, "typing", { kind: "event", from: "person:owner" });
    spin(s)();
  });
  assert.equal((await s.status()).idle, false);
  assert.deepEqual((await s.events()).map((e) => e.type), ["start"]);
  s.run(60);
  assert.equal((await s.status()).idle, true);
  s.run(40, spin(s));
  assert.ok((await s.events()).some((e) => e.id === "idle.msg_key_rate" && e.top[0].key === "service:history/current:person"));
});

test("a breach that was written gets its end (ok), with when it began and its worst value; one that was never written gets none", async () => {
  let lag = 500;
  const { ledger } = openLedger();
  let t = 1_000_000_000_000;
  const { createHealthService: make } = await import("../../../src/services/health");
  const service = make({ ledger, now: () => t, sampler: { sample: () => ({ cpu_pct: 1, rss: MB, heap: MB, lag_p99_ms: lag }) }, router: { subscribe: () => () => {} }, registry: { find: () => null },
    invariants: [{ id: "loop.lag", metric: "lag", agg: "value", window_s: 10, idle: false, budget: 200, persist_s: 30, note: "late" }] });
  service.start();
  const step = (n: number) => { for (let i = 0; i < n; i++) { t += 10_000; service.tick(); } };
  step(2); lag = 100; step(8); // broken for twenty seconds, never long enough to be written
  assert.deepEqual((await call(service, owner, "recent", {})).events.map((e: any) => e.type), ["start"]);
  lag = 300; step(4); lag = 900; step(2); lag = 100; step(8); // long enough; the worst was 900
  const events = (await call(service, owner, "recent", {})).events as any[];
  const breach = events.find((e) => e.type === "breach")!, ok = events.find((e) => e.type === "ok")!;
  assert.equal(ok.id, "loop.lag");
  assert.equal(ok.since, breach.since);
  assert.equal(ok.peak, 900);
  assert.ok(ok.at > breach.at);
});

test("the minute rows say how many times a hand connected", async () => {
  const s = setup();
  s.run(30, () => { s.service.noteLink("open", "AAA"); });
  s.run(60);
  const { minutes } = await call(s.service, owner, "recent", { kind: "minute" });
  assert.ok(minutes.some((m: any) => m.link_opens >= 1), JSON.stringify(minutes));
});

test("while the owner watches a live view (the virtual screen's preview) the hub is in use, not idle; when she stops it idles again", async () => {
  const s = setup();
  s.watch(true);
  s.run(180);
  assert.equal((await s.status()).idle, false);
  s.watch(false);
  s.run(60);
  assert.equal((await s.status()).idle, true);
});
