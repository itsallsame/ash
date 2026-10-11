import assert from "node:assert/strict";
import test from "node:test";
import { openHome, openPage, OWNER, withBrowser } from "./support.js";

/** A body with a few files, read and listed through its workspace words. */
function bodyWithFiles(kernel, files) {
  kernel.on("service:bodies", "list", () => ({ bodies: [{ body: "body:main", ownership: "own", online: true }] }));
  const children = (dir) => {
    const prefix = dir ? `${dir}/` : "";
    const seen = new Map();
    for (const [path, data] of files) if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length), name = rest.split("/")[0];
      seen.set(name, rest.includes("/") ? { name, type: "directory", size: null } : { name, type: "file", size: data.length });
    }
    return [...seen.values()];
  };
  kernel.on("body:main", "workspace.ls", ({ path = "" }) => ({ path: path || "/root/work", entries: children(path) }));
  kernel.on("body:main", "workspace.read", ({ path }) => {
    const data = files.get(path);
    if (data === undefined) return { ok: false, error: { code: "not_found", message: "no such file" } };
    if (typeof data !== "string") return { ok: true, result: { data: { path }, content: [{ type: "image", mime: "image/png", b64: Buffer.from(data).toString("base64") }] } };
    return { path, text: data, offset: 1, next_offset: 2, truncated: false };
  });
}

test(...withBrowser("the file area browses a body, opens a Markdown file, follows its link to a page shown inertly, and says when a file is gone", async ({ kernel, browser }) => {
  const files = new Map([
    ["reports/说明 一.md", "# 我的报告\n\n**文件内容**\n\n[网页](./index.html)"],
    ["reports/index.html", '<!doctype html><h1>HTML 报告</h1><script>parent.window.fileEscape=true</script>'],
    ["data.pdf", "%PDF"],
  ]);
  bodyWithFiles(kernel, files);
  const { page } = await openPage(browser, kernel);
  await openHome(page, "files");
  const reader = page.getByRole("dialog", { name: "文件", exact: true });
  await reader.locator(".files-row", { hasText: "reports" }).click();
  await reader.locator(".files-row", { hasText: "说明 一.md" }).click();
  await reader.getByRole("heading", { name: "我的报告" }).waitFor();
  await reader.getByRole("link", { name: "网页" }).click();
  await page.frameLocator(".files-html").locator("h1").waitFor();
  assert.equal(await page.evaluate(() => window.fileEscape), undefined, "a page is shown from its text, without running its script");
  assert.equal(await page.locator(".files-html").getAttribute("sandbox"), "");
  files.delete("reports/index.html");
  await reader.getByRole("button", { name: "关闭", exact: true }).click();
  kernel.append({ from: "agent:main", to: OWNER, kind: "request", word: "say", body: { text: "[页面](<reports/index.html>)", kind: "reply" } });
  await page.getByRole("link", { name: "页面" }).click();
  await reader.getByText(/not_found|no such file|不存在|无法/).waitFor();
}));

test(...withBrowser("a file card opens the reader, an image card shows the image, and download keeps the bytes", async ({ kernel, browser }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  bodyWithFiles(kernel, new Map([["out/dot.png", png], ["out/notes.txt", "第一行\n第二行"]]));
  kernel.append({ from: "agent:main", to: OWNER, kind: "request", word: "show", body: { card: { type: "file", workspace: "main", path: "out/notes.txt", name: "notes.txt", mime_type: "text/plain", size: 20 } } });
  kernel.append({ from: "agent:main", to: OWNER, kind: "request", word: "show", body: { card: { type: "image", workspace: "main", path: "out/dot.png", alt: "点" } } });
  const { page } = await openPage(browser, kernel);
  const reader = page.getByRole("dialog", { name: "文件", exact: true });
  await page.getByRole("button", { name: "notes.txt" }).click();
  await reader.locator(".files-text").getByText("第二行").waitFor();
  const download = page.waitForEvent("download");
  await reader.getByRole("button", { name: "下载", exact: true }).click();
  assert.equal((await import("node:fs")).readFileSync(await (await download).path(), "utf8"), "第一行\n第二行");
  await reader.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "查看图片" }).click();
  await reader.locator("img.files-image").waitFor();
}));
