import assert from "node:assert/strict";
import test from "node:test";
import { wordsOf } from "../../../../sdk/src/words";
import { HandMember } from "../../../src/edges/link-server/hands/hand-member";
import { DEVICE, failure, fake, flush, hand, world } from "../../kernel/router/world";

/** A real HandMember and the real router: a hand sends the events its manifest declares, and only those. */
function hub(events: string[]) {
  const w = world();
  const phone = new HandMember({ id: DEVICE, kind: "device", name: "Phone", capabilities: [], events, session: () => null, local: true });
  const senses = fake("service:senses", wordsOf("service:senses"));
  w.registry.add(phone); w.registry.add(senses);
  const send = (word: string, body: unknown) => w.router.send({ to: "service:senses", kind: "event", word, body }, hand);
  return { ...w, phone, senses, send };
}
const batch = { batch_id: "b1", items: [{ ts: 1, lat: 1, lon: 2, accuracy_m: 5, provider: "gps" }] };

test("a hand can send an event its manifest declares, with the schema of the service it goes to", async () => {
  const h = hub(["sense.location"]);
  assert.ok(h.phone.words().some((c) => c.kind === "event" && c.word === "sense.location" && c.direction === "out" && c.member === DEVICE));
  assert.ok((await h.send("sense.location", batch)).ok);
  await flush();
  assert.equal(h.senses.calls.length, 1);
  assert.equal(failure(await h.send("sense.location", { batch_id: "b2" })).code, "bad_request", "the service's schema holds");
});

test("an event the manifest does not list is refused with forbidden", async () => {
  const h = hub(["sense.location"]);
  assert.equal(failure(await h.send("sense.battery", { level: 50 })).code, "forbidden");
  assert.equal(h.senses.calls.length, 0);
});

test("an event is not a capability: the hand's call path does not know it", () => {
  const h = hub(["sense.location"]);
  assert.equal(h.registry.find(DEVICE, "sense.location")?.contract.kind, "event");
});
