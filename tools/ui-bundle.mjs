import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLinkPlugin } from "./browser-link.mjs";

const ui = join(dirname(fileURLToPath(import.meta.url)), "../packages/web");
// NativePort uses AshNative. Exclude only the browser transport import, keeping the shared page modules/entry intact.
const nativeTransport = { name: "native-transport", setup(builder) {
  builder.onResolve({ filter: /link-browser\.js$/ }, () => ({ path: "link-browser", namespace: "native-page" }));
  builder.onLoad({ filter: /.*/, namespace: "native-page" }, () => ({ contents: "export const HandClient = undefined; export const browserConnector = undefined;", loader: "js" }));
} };

export async function buildUiBundle(target) {
  if (target !== "browser" && target !== "native") throw new Error("Unknown UI bundle target");
  const result = await build({
    stdin: { contents: 'import "./js/app.js"; import "./js/home.js";', resolveDir: ui, sourcefile: "page-entry.js", loader: "js" },
    bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true, metafile: true, logLevel: "silent",
    plugins: target === "native" ? [nativeTransport] : [browserLinkPlugin()],
  });
  return { code: result.outputFiles[0].text.replaceAll("</script", "<\\/script"), inputs: result.metafile.inputs };
}
