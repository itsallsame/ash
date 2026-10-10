import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { CONTAINER_APT_LOCK, CONTAINER_DEFAULT_MODEL, CONTAINER_APT_LOCK_PATH, CONTAINER_PACKAGES, CONTAINER_PATCH, CONTAINER_REQUIRED_FILES, containerSourcesDigest, missingContainerFiles } from "./container-sources.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A work directory with everything the container build must produce (empty files). */
function layout(patch = CONTAINER_PATCH) {
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "container-layout-"));
  for (const rel of CONTAINER_REQUIRED_FILES) {
    const abs = path.join(work, rel);
    if (/\.[a-z0-9]+$/.test(rel) || rel.endsWith("/dsh") || rel.endsWith("/proot") || rel.endsWith("/loader") || rel.endsWith("/node")) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "");
    } else fs.mkdirSync(abs, { recursive: true });
  }
  fs.writeFileSync(path.join(work, "ubuntu/opt/ash/patch.yml"), patch);
  fs.rmSync(path.join(work, "ubuntu", CONTAINER_APT_LOCK_PATH), { recursive: true, force: true });
  fs.writeFileSync(path.join(work, "ubuntu", CONTAINER_APT_LOCK_PATH), CONTAINER_APT_LOCK);
  return work;
}

test("the patch loads the control plugin, the cost collector and the skills, from folders the container carries; it carries the default model", () => {
  assert.match(CONTAINER_PATCH, /- id: acp\n  disabled: true/);
  assert.match(CONTAINER_PATCH, /id: ash-control\n\s+name: '\/opt\/ash\/dsh-ash-control\/index\.mjs'\n\s+inject: \[acpAppStartup\]/);
  assert.match(CONTAINER_PATCH, /id: ash-cost\n\s+name: '\/opt\/ash\/ash-cost\/index\.mjs'/);
  assert.match(CONTAINER_PATCH, /id: ash-skills\n\s+name: '\/opt\/ash\/ash-skills\/index\.mjs'/);
  // The default model sits in ash-control's config, which DSH's ACP plugin reads as the model of a new session.
  assert.deepEqual(CONTAINER_DEFAULT_MODEL, { provider: "deepseek-official", model: "deepseek-flash" });
  assert.match(CONTAINER_PATCH, /inject: \[acpAppStartup\]\n      config:\n        provider: 'deepseek-official'\n        model: 'deepseek-flash'\n    - id: ash-cost/);
  for (const [, pkg] of CONTAINER_PATCH.matchAll(/'\/opt\/ash\/([^/]+)\/index\.mjs'/g)) {
    assert.ok(CONTAINER_PACKAGES.includes(pkg), `${pkg} is copied into the container`);
    assert.ok(fs.existsSync(path.join(ROOT, "packages", pkg, "index.mjs")), `${pkg} has its index.mjs`);
  }
});

test("the layout check wants the patch at /opt/ash/patch.yml, and the same patch this build knows", () => {
  const work = layout();
  try {
    assert.deepEqual(missingContainerFiles(work), []);
    fs.writeFileSync(path.join(work, "ubuntu/opt/ash/patch.yml"), "- id: acp\n");
    assert.deepEqual(missingContainerFiles(work), ["ubuntu/opt/ash/patch.yml (not the patch of this build)"]);
    fs.rmSync(path.join(work, "ubuntu/opt/ash/patch.yml"));
    assert.deepEqual(missingContainerFiles(work), ["ubuntu/opt/ash/patch.yml"]);
    fs.writeFileSync(path.join(work, "ubuntu/opt/ash/patch.yml"), CONTAINER_PATCH);
    fs.rmSync(path.join(work, "ubuntu/opt/ash/ash-cost"), { recursive: true });
    assert.deepEqual(missingContainerFiles(work), ["ubuntu/opt/ash/ash-cost/index.mjs"], "ash-cost must be in the image too");
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test("the container carries the cost collector, and the sources digest is one hash", () => {
  assert.match(containerSourcesDigest(ROOT), /^[0-9a-f]{64}$/);
  assert.ok(CONTAINER_PACKAGES.includes("ash-cost"));
});

test("the image makes apt and dpkg wait for a held lock, and the layout check and the digest know the file", () => {
  assert.equal(CONTAINER_APT_LOCK_PATH, "etc/apt/apt.conf.d/99ash-lock");
  assert.equal(CONTAINER_APT_LOCK, 'DPkg::Lock::Timeout "300";\n');
  assert.ok(CONTAINER_REQUIRED_FILES.includes(`ubuntu/${CONTAINER_APT_LOCK_PATH}`));
  const work = layout();
  try {
    assert.deepEqual(missingContainerFiles(work), []);
    fs.writeFileSync(path.join(work, "ubuntu", CONTAINER_APT_LOCK_PATH), "");
    assert.deepEqual(missingContainerFiles(work), [`ubuntu/${CONTAINER_APT_LOCK_PATH} (not the one of this build)`]);
    fs.rmSync(path.join(work, "ubuntu", CONTAINER_APT_LOCK_PATH));
    assert.deepEqual(missingContainerFiles(work), [`ubuntu/${CONTAINER_APT_LOCK_PATH}`]);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

/** An installed DSH (the one the container carries), when this machine has one: ASH_TEST_DSH_ROOT, or the usual place. */
function installedDsh() {
  const candidates = [process.env.ASH_TEST_DSH_ROOT, path.join(os.homedir(), "ashwork/dsh020/linux/lib/node_modules/@deepseek-ai/dsh")].filter(Boolean);
  return candidates.find((root) => fs.existsSync(path.join(root, "lib/bin.js")));
}

/** Start DSH with `patch` as the real container does, open an ACP session, and return what `session/new` answers. */
async function newSessionWith(dshRoot, patchText) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "dsh-session-"));
  fs.mkdirSync(path.join(dir, "home")); fs.mkdirSync(path.join(dir, "work"));
  fs.writeFileSync(path.join(dir, "patch.yml"), patchText.replaceAll("/opt/ash/", `${ROOT}/packages/`));
  const child = spawn(process.execPath, [path.join(dshRoot, "lib/bin.js"), "--profile", "acp", "--patch", path.join(dir, "patch.yml")], {
    cwd: path.join(dir, "work"),
    env: { PATH: process.env.PATH, HOME: path.join(dir, "home"), DSH_HOME: path.join(dir, "home", ".dsh"), DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "placeholder" },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const waiting = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); } catch { /* not a reply */ }
    }
  });
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out; dsh said: ${stderr.slice(0, 500)}`)), 20_000);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await call(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    return (await call(2, "session/new", { cwd: path.join(dir, "work"), mcpServers: [] })).result;
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("a fresh session started with the container's patch has a model selected, and without the default it has none", { skip: installedDsh() ? false : "no installed DSH (set ASH_TEST_DSH_ROOT)", timeout: 60_000 }, async () => {
  const dsh = installedDsh();
  const current = (result) => result.configOptions.find((o) => o.id === "model")?.currentValue;
  const withDefault = await newSessionWith(dsh, CONTAINER_PATCH);
  assert.equal(current(withDefault), JSON.stringify([CONTAINER_DEFAULT_MODEL.provider, CONTAINER_DEFAULT_MODEL.model]));
  // The failure a fresh install had: no config in the patch, so the session has no model selection and every turn fails.
  const bare = await newSessionWith(dsh, CONTAINER_PATCH.replace(/      config:\n.*\n.*\n/, ""));
  assert.equal(current(bare), undefined);
});
