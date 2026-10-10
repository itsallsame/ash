import assert from "node:assert/strict";
import test from "node:test";
import { API_VERSION, APP_CONTRACT, ASH_SDK, HOST_CONTRACT, LINK_PROTOCOL, MCP_SERVER_NAME, MCP_SERVER_VERSION, WORD_CONTRACT_VERSION } from "../src/versions";
import {
  DEFAULT_RECOVERY_HINTS, ERROR_CODES, ERROR_MEANINGS, LEGACY_ERROR_CODES, errorBody, fromLegacyErrorCode, isErrorCode, type Caller, type HandleContext, type Message, type Reply,
} from "../src/message";

test("the versions are the ones the spec names", () => {
  assert.equal(API_VERSION, "ash-api/3");
  assert.equal(WORD_CONTRACT_VERSION, 4);
  assert.equal(ASH_SDK, 4);
  assert.equal(LINK_PROTOCOL, "ash-link/1");
  assert.equal(HOST_CONTRACT, "ash-host/1");
  assert.equal(APP_CONTRACT, "ash-app/1");
  assert.equal(MCP_SERVER_NAME, "ash");
  assert.equal(MCP_SERVER_VERSION, "4.0.0");
});

test("all fourteen error codes, each with a meaning and a recovery hint", () => {
  assert.deepEqual([...ERROR_CODES].sort(), [
    "bad_request", "cancelled", "conflict", "denied", "failed", "forbidden", "internal", "not_found",
    "offline", "result_unknown", "timeout", "too_large", "unauthorized", "unavailable",
  ]);
  assert.equal(ERROR_CODES.length, 14);
  for (const code of ERROR_CODES) {
    assert.ok(isErrorCode(code));
    assert.ok(ERROR_MEANINGS[code].length > 0, code);
    assert.ok(DEFAULT_RECOVERY_HINTS[code].length > 10, code);
    assert.equal(errorBody(code, "x").recovery_hint, DEFAULT_RECOVERY_HINTS[code]);
  }
  assert.ok(!isErrorCode("payload_invalid") && !isErrorCode(undefined));
  assert.equal(errorBody("failed", "m", { recovery_hint: "do this", detail: { a: 1 } }).recovery_hint, "do this");
  assert.deepEqual(errorBody("failed", "m", { detail: { a: 1 } }).detail, { a: 1 });
});

test("every old error code maps to a new one, and the renames of SPEC-02 §7 hold", () => {
  const old = ["payload_invalid", "bad_json", "unreachable", "vault_unavailable", "capability_error", "internal_error", "unauthorized",
    "bad_request", "not_found", "forbidden", "denied", "cancelled", "timeout", "offline", "failed", "too_large", "result_unknown",
    "bad_args", "bad_path", "method_not_allowed", "unknown_capability", "unknown_process", "app_failed", "busy"];
  for (const code of old) assert.ok(isErrorCode(fromLegacyErrorCode(code)), `${code} is mapped`);
  assert.equal(fromLegacyErrorCode("nonsense"), undefined);
  for (const code of ERROR_CODES) assert.equal(fromLegacyErrorCode(code), code, `${code} stays`);
  for (const code of Object.keys(LEGACY_ERROR_CODES)) assert.ok(!isErrorCode(code), `${code} is only listed because it changed`);
  for (const [from, to] of Object.entries(LEGACY_ERROR_CODES)) assert.ok(isErrorCode(to), `${from} -> ${to}`);
  assert.equal(LEGACY_ERROR_CODES.payload_invalid, "bad_request");
  assert.equal(LEGACY_ERROR_CODES.bad_json, "bad_request");
  assert.equal(LEGACY_ERROR_CODES.unreachable, "offline");
  assert.equal(LEGACY_ERROR_CODES.vault_unavailable, "unavailable");
  assert.equal(LEGACY_ERROR_CODES.capability_error, "failed");
  assert.equal(LEGACY_ERROR_CODES.internal_error, "internal");
  for (const gone of ["payload_invalid", "bad_json", "unreachable", "vault_unavailable", "capability_error", "internal_error"]) assert.ok(!(ERROR_CODES as readonly string[]).includes(gone));
});

test("the shared types fit together", () => {
  const caller: Caller = { member: "agent:main", via: "agent", local: true, turn: "t1" };
  const ctx: HandleContext = { signal: new AbortController().signal, caller, raw: {} };
  const message: Message = { seq: 1, id: "m1", ts: 0, from: caller.member, to: "service:clock", kind: "request", word: "list", body: {} };
  const ok: Reply = { ok: true, result: { data: { timers: [] } } };
  const failed: Reply = { ok: false, error: errorBody("offline", "gone") };
  assert.ok(ctx.signal && message.word === "list" && ok.ok && !failed.ok);
});
