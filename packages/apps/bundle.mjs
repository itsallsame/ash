// A first-party app (packages/apps/<id>) as the single-file app the hub installs: app.json, one bundled server.mjs, the icon.
// payload/assemble.mjs writes these into the payload (ash-apps/<id>/); the hub copies the ones not installed yet into the apps
// folder as built-in apps (edges/apps installBuiltinOrgans). The tests build the same way.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

/** The files of one app folder: `{ "app.json": text, "server.mjs": text, "<icon>": text }`. */
export async function bundleApp(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
  const bundled = await build({
    entryPoints: [join(dir, "src/server.mjs")], bundle: true, write: false, platform: "node", format: "esm", target: "node20",
    minify: true, legalComments: "none", loader: { ".html": "text" }, logLevel: "silent",
    banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  });
  const files = { "app.json": `${JSON.stringify(manifest, null, 2)}\n`, "server.mjs": bundled.outputFiles[0].text };
  if (manifest.icon) files[manifest.icon] = readFileSync(join(dir, manifest.icon), "utf8");
  return files;
}

/** Every app folder under `appsDir` (the ones with an app.json), bundled: `{ health: { ...files } }`. */
export async function bundleApps(appsDir) {
  const out = {};
  for (const id of readdirSync(appsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    if (existsSync(join(appsDir, id, "app.json"))) out[id] = await bundleApp(join(appsDir, id));
  }
  return out;
}

/** Writes `bundleApps(appsDir)` as `<outDir>/<id>/<file>`; returns the ids. */
export async function writeBundledApps(appsDir, outDir) {
  const apps = await bundleApps(appsDir);
  for (const [id, files] of Object.entries(apps)) for (const [name, text] of Object.entries(files)) {
    const file = join(outDir, id, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return Object.keys(apps);
}
