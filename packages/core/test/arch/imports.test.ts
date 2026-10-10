/**
 * The import rules of ASH-HUB §7.1, checked on the real tree (type-only imports count: the direction of the dependency
 * is the design, not the emitted code).
 *
 *   kernel    imports only itself and sdk
 *   edges     import kernel, sdk and their own folder; not each other (exceptions below)
 *   services  import kernel, sdk and their own folder; not edges, not each other
 *   next.ts   (and main.ts) is the one place that imports everything
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";

const SRC = resolve(import.meta.dirname, "../../src");
const SDK = resolve(SRC, "../../sdk/src");

/** `from` -> `to` pairs between two edges that are allowed: they hang on the link server, or the DSH driver starts its process in the body. */
const EDGE_EXCEPTIONS = [
  ["agents/remote", "link-server"], // the remote driver is a channel on the link
  ["agents/dsh", "body"],           // the DSH driver starts its process in the main body
];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec?.startsWith(".")) out.push(resolve(dirname(file), spec));
  }
  return out;
}

const layerOf = (path: string): { layer: string; unit: string } | null => {
  const rel = relative(SRC, path).split(sep);
  if (rel[0] === ".." ) return null;
  return { layer: rel[0]!, unit: rel[1]?.replace(/\.ts$/, "") ?? "" };
};
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

test("the tree has the three layers and the assembly, nothing else", () => {
  const top = readdirSync(SRC).sort();
  assert.deepEqual(top, ["edges", "kernel", "main.ts", "next.ts", "prompts", "services"]);
});

test("kernel imports only kernel and sdk", () => {
  const bad: string[] = [];
  for (const file of files(join(SRC, "kernel"))) for (const target of importsOf(file)) {
    if (!inside(target, join(SRC, "kernel")) && !inside(target, SDK)) bad.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
  }
  assert.deepEqual(bad, []);
});

test("edges import kernel, sdk, other packages and their own folder only", () => {
  const bad: string[] = [];
  for (const file of files(join(SRC, "edges"))) {
    const own = layerOf(file)!;
    const rel = relative(join(SRC, "edges"), file).split(sep);
    for (const target of importsOf(file)) {
      if (inside(target, join(SRC, "kernel")) || inside(target, SDK) || !inside(target, SRC)) continue;
      const there = layerOf(target)!;
      if (there.layer === "edges" && there.unit === own.unit) continue;
      const to = relative(join(SRC, "edges"), target).split(sep);
      const allowed = there.layer === "edges" && EDGE_EXCEPTIONS.some(([from, dest]) =>
        rel.join("/").startsWith(from) && to.join("/").startsWith(dest));
      if (!allowed) bad.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("services import kernel, sdk and their own folder only", () => {
  const bad: string[] = [];
  for (const file of files(join(SRC, "services"))) {
    const own = layerOf(file)!;
    for (const target of importsOf(file)) {
      if (inside(target, join(SRC, "kernel")) || inside(target, SDK) || !inside(target, SRC)) continue;
      const there = layerOf(target)!;
      if (there.layer === "services" && there.unit === own.unit) continue;
      bad.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("nothing below the assembly imports the assembly or the generated prompts", () => {
  const bad: string[] = [];
  for (const layer of ["kernel", "edges", "services"]) for (const file of files(join(SRC, layer))) for (const target of importsOf(file)) {
    if (target === join(SRC, "next") || target === join(SRC, "main") || inside(target, join(SRC, "prompts"))) bad.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
  }
  assert.deepEqual(bad, []);
});
