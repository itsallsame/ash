import assert from "node:assert/strict";
import test from "node:test";
import { resolveFileLink } from "../js/files.js";
import { bodyOf } from "../js/body.js";

test("Markdown links resolve against the file they are in, on the same body", () => {
  const base = { workspace: "main", path: "docs/chapter/a.md" };
  assert.deepEqual(resolveFileLink("/root/work/报告%20一.md", base), { workspace: "main", path: "/root/work/报告 一.md" });
  assert.deepEqual(resolveFileLink("../guide.md", base), { workspace: "main", path: "docs/guide.md" });
  assert.deepEqual(resolveFileLink("./report.html#result", base), { workspace: "main", path: "docs/chapter/report.html" });
  assert.deepEqual(resolveFileLink("page.html", { workspace: "body:" + "A".repeat(22), path: "" }), { workspace: "body:" + "A".repeat(22), path: "page.html" });
});

test("file links never climb out of the directory or become arbitrary URLs", () => {
  for (const href of ["../../private", "/root/work/../secret", "file:///etc/passwd", "javascript:alert(1)", "https://example.com/x", "//host/a", "%00.md", "a\\b", "#local", "%GG"])
    assert.equal(resolveFileLink(href, { workspace: "main", path: "a.md" }), null, href);
});

test("a card names its body as main, a computer's id, or the full body id; anything else means the main body", () => {
  assert.equal(bodyOf("main"), "body:main");
  assert.equal(bodyOf("home"), "body:main");
  assert.equal(bodyOf("A".repeat(22)), `body:${"A".repeat(22)}`);
  assert.equal(bodyOf(`body:${"B".repeat(22)}`), `body:${"B".repeat(22)}`);
  assert.equal(bodyOf(undefined), "body:main");
});
