// Bundles tools/e2e/owner.ts and the link client it uses into one file without dependencies: tools/e2e/owner.mjs.
// Run: node tools/e2e/build-owner.mjs [--out FILE]
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildOwner(outfile = join(here, "owner.mjs")) {
  await build({
    entryPoints: [join(here, "owner.ts")],
    bundle: true, platform: "node", target: "node22", format: "esm", outfile,
    banner: { js: "#!/usr/bin/env node\nimport{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
    legalComments: "none", logLevel: "warning",
    // Paths in the bundle's comments as seen from here: a node_modules that is a link (a worktree sharing one install)
    // must give the same file as a real one, or the committed bundle differs from what CI builds.
    preserveSymlinks: true,
  });
  return outfile;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--out");
  console.log(await buildOwner(i >= 0 ? process.argv[i + 1] : undefined));
}
