import assert from "node:assert/strict";
import test from "node:test";
import { isPeak, priceOf } from "../../../src/services/cost/price";

const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
const M = 1_000_000;

test("peak hours are 01-04 and 06-10 UTC on weekdays; weekends and the other hours are off-peak", () => {
  const at = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h, m); // 2026-10-12 is a Monday, the 10th a Saturday
  assert.equal(isPeak(at(12, 1)), true);
  assert.equal(isPeak(at(12, 3, 59)), true);
  assert.equal(isPeak(at(12, 4)), false);
  assert.equal(isPeak(at(12, 5, 59)), false);
  assert.equal(isPeak(at(12, 6)), true);
  assert.equal(isPeak(at(12, 9, 59)), true);
  assert.equal(isPeak(at(12, 10)), false);
  assert.equal(isPeak(at(12, 0)), false);
  assert.equal(isPeak(at(10, 7)), false);
  assert.equal(isPeak(at(11, 7)), false);
  assert.equal(isPeak(at(16, 7)), true); // Friday
});

test("Flash and Pro are priced from the published rates, off-peak at half", () => {
  const peak = Date.UTC(2026, 9, 12, 7), off = Date.UTC(2026, 9, 12, 12);
  const flash = { provider: "deepseek-official", model: "deepseek-flash", input_tokens: M, output_tokens: M, cache_read_tokens: M };
  close(priceOf({ ...flash, at: peak }), 0.3 + 1.2 + 0.006);
  close(priceOf({ ...flash, at: off }), 0.15 + 0.6 + 0.003);
  const pro = { provider: "deepseek", model: "deepseek-v4-pro", input_tokens: M, output_tokens: M, cache_read_tokens: M };
  close(priceOf({ ...pro, at: peak }), 1.32 + 3.96 + 0.044);
  close(priceOf({ ...pro, at: off }), 0.66 + 1.98 + 0.022);
});

test("the retired deepseek-v4-flash is billed as Flash, cache reads default to none, and a small call costs a small amount", () => {
  const at = Date.UTC(2026, 9, 12, 12);
  close(priceOf({ provider: "deepseek", model: "deepseek-v4-flash", at, input_tokens: 1000, output_tokens: 500 }), (1000 * 0.15 + 500 * 0.6) / M);
});

test("a model or provider without a published rate has no price (not zero)", () => {
  const base = { at: 0, input_tokens: 1, output_tokens: 1 };
  assert.equal(priceOf({ ...base, provider: "deepseek-official", model: "deepseek-v9" }), undefined);
  assert.equal(priceOf({ ...base, provider: "openrouter", model: "deepseek-flash" }), undefined);
  assert.equal(priceOf({ ...base, provider: "", model: "" }), undefined);
});
