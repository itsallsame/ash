/**
 * The import rules of ASH-HUB §7.1 and §8.1, checked on the real tree (type-only imports count: the direction of the
 * dependency is the design, not the emitted code).
 *
 *   kernel    imports only itself and sdk (and Node's own modules, no npm package); inside it: router -> registry, gate, redact, ledger; gate -> ledger; the rest alone
 *   edges     import kernel, sdk, their own folder, and of the other packages only `link` and `workspace`; not each other
 *   services  import kernel, sdk and their own folder; no other package, not edges, not each other
 *   core      never imports `ash-gateway` (only `link` does)
 *   next.ts   (and main.ts) is the one place that imports everything
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";

const SRC = resolve(import.meta.dirname, "../../src");
const PACKAGES = resolve(SRC, "../..");
const SDK = join(PACKAGES, "sdk/src");
const LINK = join(PACKAGES, "link/src");
const WORKSPACE = join(PACKAGES, "workspace/src");

/** `from` -> `to` pairs between two edges that are allowed: they hang on the link server, or the DSH driver starts its process in the body. */
const EDGE_EXCEPTIONS = [
  ["agents/remote", "link-server"], // the remote driver is a channel on the link
  ["agents/dsh", "body"],           // the DSH driver starts its process in the main body
];

/** Which other kernel units a kernel unit may import (`types.ts` is the shared vocabulary every unit may use). */
const KERNEL_DIRECTION: Record<string, string[]> = {
  types: [],
  ledger: ["types"],
  registry: ["types"],
  redact: ["types"],
  vault: ["types"],
  gate: ["types", "ledger"],
  router: ["types", "registry", "gate", "redact", "ledger"],
};

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

/** The module specifiers a file imports or re-exports (static, side-effect and dynamic). */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}
const importsOf = (file: string): string[] => specifiersOf(file).filter((spec) => spec.startsWith(".")).map((spec) => resolve(dirname(file), spec));

const unitOf = (dir: string, path: string): string => relative(dir, path).split(sep)[0]!.replace(/\.ts$/, "");
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** Every violation of one layer: `check(file, target)` returns true when the import is allowed. */
function violations(layer: string, check: (file: string, target: string) => boolean): string[] {
  const bad: string[] = [];
  for (const file of files(join(SRC, layer))) for (const target of importsOf(file)) {
    if (!check(file, target)) bad.push(`${relative(SRC, file)} -> ${relative(PACKAGES, target)}`);
  }
  return bad;
}

test("the tree has the three layers and the assembly, nothing else", () => {
  assert.deepEqual(readdirSync(SRC).sort(), ["edges", "kernel", "main.ts", "next.ts", "prompts", "services"]);
});

test("kernel imports only kernel and sdk, and inside it only in the direction of the design", () => {
  const KERNEL = join(SRC, "kernel");
  const bad = violations("kernel", (file, target) => {
    if (inside(target, SDK)) return true;
    if (!inside(target, KERNEL)) return false;
    const from = unitOf(KERNEL, file), to = unitOf(KERNEL, target);
    return from === to || (KERNEL_DIRECTION[from] ?? []).includes(to);
  });
  assert.deepEqual(bad, []);
  assert.deepEqual(Object.keys(KERNEL_DIRECTION).sort(), readdirSync(KERNEL).filter((name) => !name.startsWith(".")).map((name) => name.replace(/\.ts$/, "")).sort(), "every kernel unit has a row");
});

test("kernel imports no package: of the non-relative specifiers only Node's own modules are allowed", () => {
  const builtin = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
  const bad: string[] = [];
  for (const file of files(join(SRC, "kernel"))) for (const spec of specifiersOf(file)) {
    if (spec.startsWith(".")) continue;
    // `node:sqlite` and the like exist only under the `node:` scheme, so that prefix is enough.
    if (!spec.startsWith("node:") && !builtin.has(spec)) bad.push(`${relative(SRC, file)} -> ${spec}`);
  }
  assert.deepEqual(bad, []);
});

test("edges import kernel, sdk, link, workspace and their own folder only", () => {
  const EDGES = join(SRC, "edges");
  const bad = violations("edges", (file, target) => {
    if (inside(target, join(SRC, "kernel")) || inside(target, SDK) || inside(target, LINK) || inside(target, WORKSPACE)) return true;
    if (!inside(target, EDGES)) return false;
    if (unitOf(EDGES, file) === unitOf(EDGES, target)) return true;
    const from = relative(EDGES, file).split(sep).join("/"), to = relative(EDGES, target).split(sep).join("/");
    return EDGE_EXCEPTIONS.some(([a, b]) => from.startsWith(a!) && to.startsWith(b!));
  });
  assert.deepEqual(bad, []);
});

test("services import kernel, sdk and their own folder only", () => {
  const SERVICES = join(SRC, "services");
  const bad = violations("services", (file, target) =>
    inside(target, join(SRC, "kernel")) || inside(target, SDK) || (inside(target, SERVICES) && unitOf(SERVICES, file) === unitOf(SERVICES, target)));
  assert.deepEqual(bad, []);
});

test("nothing below the assembly imports the assembly or the generated prompts", () => {
  const bad: string[] = [];
  for (const layer of ["kernel", "edges", "services"]) {
    bad.push(...violations(layer, (_file, target) => target !== join(SRC, "next") && target !== join(SRC, "main") && !inside(target, join(SRC, "prompts"))));
  }
  assert.deepEqual(bad, []);
});

test("core never imports the gateway: only the link package does", () => {
  const bad: string[] = [];
  for (const file of files(SRC)) for (const spec of specifiersOf(file)) {
    if (/(^|\/)ash-gateway(\/|$)/.test(spec)) bad.push(`${relative(SRC, file)} -> ${spec}`);
  }
  assert.deepEqual(bad, []);
});
