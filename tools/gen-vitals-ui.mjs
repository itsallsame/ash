#!/usr/bin/env node
// 「她的状态」的两个应用页面（packages/apps/vitals/ui/home.html、alert.html）：每个页面是自己带齐一切的一个文件
// （沙箱 WebView 里引不到主页面的任何东西）：令牌（亮 / 暗，主题跟 hostContext.theme）+ ash-ui.css + vitals.css + 页面自己的 extra.css
// + 图标精灵 + 她的头像 + 页面代码（ui/src，连同 design/vitals/copy.json 和 chart/chart.mjs 一起打成一个脚本）。
//   node tools/gen-vitals-ui.mjs          生成（改了 ui/src、design/vitals 或 packages/web 的样式以后跑；产物要提交）
//   node tools/gen-vitals-ui.mjs --check  不写文件，产物和源对不上就以 1 退出
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { ICON_SHAPES } from "../packages/web/js/ash-icons.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const ui = "packages/apps/vitals/ui";

/** ash-tokens.css 的亮色块 + 暗色：跟系统走，主机给了 hostContext.theme 时按主机的（<html data-theme>）。 */
export function tokensCss(text = read("packages/web/ash-tokens.css")) {
  const marker = "@media (prefers-color-scheme:dark){";
  const at = text.indexOf(marker);
  if (at < 0) throw new Error("ash-tokens.css: dark block not found");
  const light = text.slice(0, at).trim();
  const inner = text.slice(at + marker.length).trim();
  const dark = inner.slice(inner.indexOf("{") + 1, inner.lastIndexOf("}", inner.lastIndexOf("}") - 1)).trim();
  return `${light}\n@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${dark}}}\n:root[data-theme=dark]{${dark}}\n:root[data-theme=light]{color-scheme:light}`;
}

const sprite = () => `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(ICON_SHAPES).map(([name, shapes]) =>
  `<symbol id="i-${name}" viewBox="0 0 24 24">${shapes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("")}</symbol>`).join("")}</svg>`;

const avatarUri = () => `data:image/webp;base64,${readFileSync(join(root, "packages/web/avatars/default.webp")).toString("base64")}`;

async function script(entry) {
  const result = await build({
    entryPoints: [join(root, ui, "src", entry)], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true,
    define: { __AVATAR__: JSON.stringify(avatarUri()) }, logLevel: "silent",
  });
  return result.outputFiles[0].text.replaceAll("</script", "<\\/script");
}

export async function pages() {
  const css = [tokensCss(), read("packages/web/ash-ui.css"), read("design/vitals/vitals.css"), read(`${ui}/src/extra.css`)].map((s) => s.trim()).join("\n");
  const page = async (entry, title) => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${css}
</style>
<script>
${await script(entry)}
</script>
</head>
<body>
${sprite()}
<div id="app"></div>
</body>
</html>
`;
  const name = JSON.parse(read("design/vitals/copy.json")).name;
  return { "home.html": await page("home-entry.mjs", name), "alert.html": await page("alert-entry.mjs", name) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await pages();
  const check = process.argv.includes("--check");
  let stale = false;
  for (const [file, text] of Object.entries(out)) {
    const path = join(root, ui, file);
    if (check) { if (!existsSync(path) || readFileSync(path, "utf8") !== text) { console.error(`${ui}/${file} is not what gen-vitals-ui produces`); stale = true; } }
    else writeFileSync(path, text);
  }
  if (stale) process.exit(1);
}
