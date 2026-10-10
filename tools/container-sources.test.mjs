import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONTAINER_APT_LOCK, CONTAINER_APT_LOCK_PATH, CONTAINER_PACKAGES, CONTAINER_PATCH, CONTAINER_REQUIRED_FILES, containerSourcesDigest, missingContainerFiles } from "./container-sources.mjs";

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

test("the patch loads the control plugin, the cost collector and the skills, from folders the container carries; it names no model", () => {
  assert.match(CONTAINER_PATCH, /- id: acp\n  disabled: true/);
  assert.match(CONTAINER_PATCH, /id: ash-control\n\s+name: '\/opt\/ash\/dsh-ash-control\/index\.mjs'\n\s+inject: \[acpAppStartup\]/);
  assert.match(CONTAINER_PATCH, /id: ash-cost\n\s+name: '\/opt\/ash\/ash-cost\/index\.mjs'/);
  assert.match(CONTAINER_PATCH, /id: ash-skills\n\s+name: '\/opt\/ash\/ash-skills\/index\.mjs'/);
  assert.doesNotMatch(CONTAINER_PATCH, /provider|model/);
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
