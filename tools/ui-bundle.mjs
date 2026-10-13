import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLinkPlugin } from "./browser-link.mjs";

const ui = join(dirname(fileURLToPath(import.meta.url)), "../packages/web");

/** The page the kernel serves to browsers (the phone app draws its chat natively and packages no page). */
export async function buildUiBundle(target) {
  if (target !== "browser") throw new Error("Unknown UI bundle target");
  const result = await build({
    stdin: { contents: 'import "./js/app.js"; import "./js/home.js";', resolveDir: ui, sourcefile: "page-entry.js", loader: "js" },
    bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true, metafile: true, logLevel: "silent",
    plugins: [browserLinkPlugin()],
  });
  return { code: result.outputFiles[0].text.replaceAll("</script", "<\\/script"), inputs: result.metafile.inputs };
}
