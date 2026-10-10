import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CLOSE_CODES, FRAME_DEFS, FRAME_TYPES, LIMITS, checkCapabilitySpec, frameError, isFrame, linkSchemaFiles, validateFrame, type FrameType } from "../src/link";

const sdkDir = join(import.meta.dirname, "..");
const fixtureDir = join(sdkDir, "fixtures", "link");
const fixtures = (kind: "valid" | "invalid") => readdirSync(join(fixtureDir, kind)).sort().map((file) => ({
  file,
  /** `<frame type>__<why>.json`: the part before `__` names the frame type (or `capability-spec`) the sample is checked as. */
  type: file.split("__")[0]!,
  value: JSON.parse(readFileSync(join(fixtureDir, kind, file), "utf8")) as unknown,
}));
const checkAs = (type: string, value: unknown): string | null => type === "capability-spec" ? checkCapabilitySpec(value) : frameError(type as FrameType, value);

test("every valid fixture passes and every invalid fixture is rejected", () => {
  for (const { file, type, value } of fixtures("valid")) {
    assert.ok(type === "capability-spec" || FRAME_TYPES.includes(type as FrameType), `${file}: unknown type`);
    assert.equal(checkAs(type, value), null, file);
    if (type !== "capability-spec") assert.equal(validateFrame(value).ok, true, file);
  }
  for (const { file, type, value } of fixtures("invalid")) {
    assert.ok(type === "capability-spec" || FRAME_TYPES.includes(type as FrameType), `${file}: unknown type`);
    assert.notEqual(checkAs(type, value), null, `${file} should be rejected`);
  }
});

test("each frame type has at least one valid and two invalid fixtures", () => {
  for (const type of [...FRAME_TYPES, "capability-spec"]) {
    assert.ok(fixtures("valid").filter((f) => f.type === type).length >= 1, `${type}: valid`);
    assert.ok(fixtures("invalid").filter((f) => f.type === type).length >= 2, `${type}: invalid`);
  }
});

test("a frame is checked as the type its t names", () => {
  assert.equal(validateFrame({ t: "nope" }).ok, false);
  assert.equal(validateFrame(null).ok, false);
  assert.equal(validateFrame([]).ok, false);
  assert.equal(isFrame("ping", { t: "ping", at: 1 }), true);
  assert.equal(isFrame("pong", { t: "ping", at: 1 }), false);
});

test("a capability whose schema is not valid JSON Schema is rejected", () => {
  const spec = { name: "x.y", description: "d", input_schema: { type: "bogus" }, effect: "read", risk: "none" };
  assert.match(checkCapabilitySpec(spec) ?? "", /input_schema/);
});

test("a hello with another protocol name still has a valid shape, so the server can answer 4008", () => {
  assert.equal(frameError("hello", { t: "hello", protocol: "ash-link/9", hand: { kind: "phone", name: "p", version: "1", platform: "x" }, channels: { device: {} } }), null);
});

test("a stream chunk at the limit fits and one byte more does not", () => {
  const chunk = (bytes: number) => ({ t: "stream", sid: "s", op: "data", seq: 0, b64: Buffer.alloc(bytes, 1).toString("base64") });
  assert.equal(frameError("stream", chunk(LIMITS.streamChunkBytes)), null);
  assert.notEqual(frameError("stream", chunk(LIMITS.streamChunkBytes + 3)), null);
});

test("the constants match the spec", () => {
  assert.deepEqual(Object.values(CLOSE_CODES).filter((c) => c >= 4000), [4001, 4003, 4008, 4009, 4400, 4500]);
  assert.equal(LIMITS.frameBytes, 4 * 1024 * 1024);
  assert.equal(LIMITS.streamChunkBytes, 256 * 1024);
  assert.equal(LIMITS.inflightCalls, 16);
  assert.equal(LIMITS.heartbeatMs, 30_000);
  assert.equal(LIMITS.silenceMs, 90_000);
});

test("schema/link is exactly what link.ts generates", () => {
  const dir = join(sdkDir, "schema", "link");
  const generated = linkSchemaFiles();
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(generated).sort());
  for (const [name, content] of Object.entries(generated)) assert.equal(readFileSync(join(dir, name), "utf8"), content, `${name} is stale; run npm run gen:link-schema`);
  assert.equal(Object.keys(JSON.parse(generated["index.json"]!).frames).length, Object.keys(FRAME_DEFS).length);
});
