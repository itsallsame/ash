import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeFile, retells, splitAssistantText } from "../src/turn-text";

test("paragraph splitting preserves fenced code, and materialization is atomic and name-independent", () => {
  assert.deepEqual(splitAssistantText("one\n\ntwo\n\n```ts\na()\n\nb()\n```\n\nlast"), ["one", "two", "```ts\na()\n\nb()\n```", "last"]);
  assert.deepEqual(splitAssistantText("one\n\n````md\n```js\na()\n\nb()\n```\n\nstill fenced\n````\n\nlast"),
    ["one", "````md\n```js\na()\n\nb()\n```\n\nstill fenced\n````", "last"]);
  assert.deepEqual(splitAssistantText("~~~text\nline\n\n~~~ not closed\n\nstill fenced\n~~~  \n\nlast"),
    ["~~~text\nline\n\n~~~ not closed\n\nstill fenced\n~~~  ", "last"]);
  assert.deepEqual(splitAssistantText("   ```js\na()\n\n   ```  \n\nlast"), ["   ```js\na()\n\n   ```  ", "last"]);
  assert.deepEqual(splitAssistantText("    ```\n    a()\n\n    b()\n    ```\n\nlast"), ["    ```\n    a()\n\n    b()\n    ```", "last"]);
  const root = mkdtempSync(join(tmpdir(), "runtime-files-"));
  try {
    const directory = join(root, "inbox");
    const bytes = Buffer.from("synthetic", "utf8");
    const first = materializeFile(directory, "m_abc", 0, bytes);
    assert.deepEqual(materializeFile(directory, "m_abc", 0, bytes), first);
    assert.equal(readFileSync(first.path, "utf8"), "synthetic");
    assert.throws(() => materializeFile(directory, "m_abc", 0, Buffer.from("different")), /differs/);
    writeFileSync(first.path, "changed");
    assert.throws(() => materializeFile(directory, "m_abc", 0, bytes), /differs/);
    assert.throws(() => materializeFile(directory, "../escape", 0, bytes), /identity/);
    const alias = join(root, "alias"); symlinkSync(directory, alias);
    assert.throws(() => materializeFile(alias, "m_abc", 1, bytes), /safe directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a closing message that only retells what ash_say already said is recognised; a real continuation is not", () => {
  const said = ["标题：Example Domain。可点的只有一处：「Learn more」链接，指向 iana.org/help/example-domains，它在页面下方（要滚动一点才看得到）。页面已关掉。"];
  assert.equal(retells("标题：Example Domain。可点的只有一处：「Learn more」链接，指向 iana.org/help/example-domains，位置在页面下方（要滚动一点才看得到）。页面已关掉。", said), true);
  assert.equal(retells("页面标题是 Example Domain，只有一个「Learn more」链接，指向 iana.org/help/example-domains。", said), true);
  // A short heads-up followed by the actual answer is not a retelling.
  assert.equal(retells("明天 10:00–12:00 读书会，20:00–21:00 健身，下午整段留给家人，没有别的安排。", ["我先查一下你的日历。"]), false);
  assert.equal(retells("好。", said), false);
  assert.equal(retells("根据日历，周六下午 3 点有读书会，周日上午 10 点还有一场，两场都是两个小时。", said), false);
});
