import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import { ACTION_EFFECTS, ACTION_RISKS, BROWSER_ACTIONS, BROWSER_EXTENSIONS, BROWSER_SPACE_PATTERN } from "../src/namespaces";

const ajv = new Ajv2020({ strict: true });
const ERROR_CODES = ["bad_request", "unauthorized", "forbidden", "not_found", "denied", "cancelled", "timeout", "offline",
  "result_unknown", "conflict", "too_large", "unavailable", "failed", "internal"];

test("every browser action has a unique browser.* name and compiled schemas", () => {
  const names = BROWSER_ACTIONS.map((action) => action.name);
  assert.equal(new Set(names).size, names.length);
  for (const action of BROWSER_ACTIONS) {
    assert.match(action.name, /^browser\.[a-z_]+$/);
    assert.ok(action.description.length > 0 && action.label.length > 0, action.name);
    assert.doesNotThrow(() => ajv.compile(action.input_schema), `${action.name} input`);
    assert.doesNotThrow(() => ajv.compile(action.result_schema), `${action.name} result`);
    assert.equal(action.input_schema.type, "object", action.name);
  }
});

test("effect and risk values are valid and read actions are risk none", () => {
  for (const action of BROWSER_ACTIONS) {
    assert.ok(ACTION_EFFECTS.includes(action.effect), `${action.name} effect`);
    assert.ok(ACTION_RISKS.includes(action.risk), `${action.name} risk`);
    if (action.effect === "read") assert.equal(action.risk, "none", action.name);
    assert.equal(typeof action.foreground, "boolean");
    for (const code of action.errors) assert.ok(ERROR_CODES.includes(code), `${action.name} error ${code}`);
  }
});

test("browser actions share one optional space field and reject unknown input", () => {
  const space = new RegExp(BROWSER_SPACE_PATTERN);
  for (const action of BROWSER_ACTIONS) {
    const validate = ajv.compile(action.input_schema);
    if (action.name !== "browser.spaces") {
      assert.ok(action.input_schema.properties?.space, `${action.name} takes space`);
      assert.ok(!(action.input_schema.required ?? []).includes("space"), `${action.name} space is optional`);
    }
    assert.equal(validate({ no_such_field: 1 }), false, action.name);
  }
  assert.ok(space.test("main") && space.test("price-check") && !space.test("Main") && !space.test("a".repeat(25)));
});

test("sample calls validate against the standard input and result schemas", () => {
  const by = Object.fromEntries(BROWSER_ACTIONS.map((action) => [action.name, action]));
  const input = (name: string, value: unknown) => ajv.compile(by[name].input_schema)(value);
  const result = (name: string, value: unknown) => ajv.compile(by[name].result_schema)(value);
  assert.ok(input("browser.open", { url: "https://example.com", space: "trains" }));
  assert.ok(!input("browser.open", { url: "file:///etc/passwd" }));
  assert.ok(!input("browser.open", {}));
  assert.ok(input("browser.click", { ref: 3, site: "example.com", label: "登录" }));
  assert.ok(!input("browser.click", { ref: 3 }));
  assert.ok(input("browser.type", { ref: 1, site: "example.com", label: "搜索", text: "x", submit: true }));
  assert.ok(input("browser.scroll", { direction: "up" }) && !input("browser.scroll", { direction: "left" }));
  assert.ok(input("browser.close", { space: "*" }) && !input("browser.close", { space: "A B" }));
  assert.ok(input("browser.evaluate", { code: "document.title" }));
  assert.ok(input("browser.spaces", {}));
  const page = { space: "main", url: "https://example.com/", title: "Example", text: "hi", elements: [{ ref: 0, tag: "a", text: "More", href: "https://x.test/" }], extra: 1 };
  for (const name of ["browser.open", "browser.read", "browser.click", "browser.type", "browser.scroll", "browser.back"]) assert.ok(result(name, page), name);
  assert.ok(!result("browser.read", { space: "main", url: "u", title: "t", text: "x" }));
  assert.ok(result("browser.screenshot", { space: "main", url: "u", title: "t", mime: "image/jpeg" }));
  assert.ok(result("browser.evaluate", { space: "main", value: { a: [1] } }));
  assert.ok(result("browser.close", { closed: [] }));
  assert.ok(result("browser.spaces", { spaces: [{ space: "main", url: "u", title: "t", last_used: 1 }] }));
});

test("one-sided browser capabilities are x.* and not in the standard", () => {
  const standard = new Set(BROWSER_ACTIONS.map((action) => action.name));
  for (const name of BROWSER_EXTENSIONS) {
    assert.match(name, /^x\.[a-z0-9_-]+\.browser\.[a-z_]+$/);
    assert.ok(!standard.has(name));
  }
});
