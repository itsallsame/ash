#!/usr/bin/env node
// The ash packages the agent container carries (tools/build-container-rootfs.mjs copies them into /opt/ash).
// Their digest is recorded next to the built container; building the APK refuses a container whose copy is stale,
// so a change to a skill or the control plugin can never ship inside an older container.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTAINER_PACKAGES = ["dsh-ash-control", "ash-cost", "ash-skills"];

/**
 * The DSH patch the container carries at /opt/ash/patch.yml (`dsh --profile acp --patch /opt/ash/patch.yml`, which the main
 * body starts). DSH refuses a `--patch` file that does not exist, so the image must have it. The official ACP row is replaced by
 * ash's control plugin (ACP plus steer and inject, and the `_ash/*` methods); ash-cost taps every model call for `_ash/usage`;
 * ash-skills is the skills provider. The model is DSH's own setting (not written here). DSH's sandbox is off by environment
 * (DSH_PERMISSION_MODE, set by the body): the container is the sandbox.
 */
export const CONTAINER_PATCH = [
  "- id: acp",
  "  disabled: true",
  "- insert:",
  "    - id: ash-control",
  "      name: '/opt/ash/dsh-ash-control/index.mjs'",
  "      inject: [acpAppStartup]",
  "    - id: ash-cost",
  "      name: '/opt/ash/ash-cost/index.mjs'",
  "    - id: ash-skills",
  "      name: '/opt/ash/ash-skills/index.mjs'",
  "",
].join("\n");

/** apt/dpkg wait for a lock another apt holds (ash's own installation, or DSH's) instead of failing at once. */
export const CONTAINER_APT_LOCK_PATH = "etc/apt/apt.conf.d/99ash-lock";
export const CONTAINER_APT_LOCK = 'DPkg::Lock::Timeout "300";\n';

/** What the finished container must hold, relative to the build's work directory (proot/ and ubuntu/). */
export const CONTAINER_REQUIRED_FILES = [
  "proot/bin/proot",
  "proot/lib/libtalloc.so.2",
  "proot/lib/libandroid-shmem.so",
  "proot/libexec/loader",
  "ubuntu/etc/os-release",
  "ubuntu/usr/bin/env",
  "ubuntu/bin",
  "ubuntu/opt/node/bin/node",
  "ubuntu/opt/node/bin/npm",
  "ubuntu/opt/dsh/node_modules/.bin/dsh",
  "ubuntu/opt/ash/patch.yml",
  "ubuntu/opt/ash/dsh-ash-control/index.mjs",
  "ubuntu/opt/ash/dsh-ash-control/package.json",
  "ubuntu/opt/ash/ash-cost/index.mjs",
  "ubuntu/opt/ash/ash-skills/index.mjs",
  "ubuntu/opt/ash/ash-skills/skills",
  "ubuntu/opt/ash/ash-skills/persona",
  "ubuntu/etc/apt/sources.list.d/ubuntu.sources",
  `ubuntu/${CONTAINER_APT_LOCK_PATH}`,
  "ubuntu/root/.config/pip/pip.conf",
  "ubuntu/root/.npmrc",
  "ubuntu/root/work",
  "ubuntu/root/.dsh",
  "ubuntu/etc/resolv.conf",
];

/** The required files that are missing under `work`; the patch must also be the one this build knows. */
export function missingContainerFiles(work) {
  const missing = CONTAINER_REQUIRED_FILES.filter((p) => {
    try { fs.lstatSync(path.join(work, p)); return false; } catch { return true; }
  });
  const lock = path.join(work, "ubuntu", CONTAINER_APT_LOCK_PATH);
  if (!missing.includes(`ubuntu/${CONTAINER_APT_LOCK_PATH}`) && fs.readFileSync(lock, "utf8") !== CONTAINER_APT_LOCK) missing.push(`ubuntu/${CONTAINER_APT_LOCK_PATH} (not the one of this build)`);
  const patch = path.join(work, "ubuntu/opt/ash/patch.yml");
  if (!missing.includes("ubuntu/opt/ash/patch.yml") && fs.readFileSync(patch, "utf8") !== CONTAINER_PATCH) missing.push("ubuntu/opt/ash/patch.yml (not the patch of this build)");
  return missing;
}

/** One digest over every file of the carried packages (relative path and bytes, in a fixed order). */
export function containerSourcesDigest(root) {
  const h = createHash("sha256");
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === "node_modules" || name === "test" || name.startsWith(".")) continue;
      const abs = path.join(dir, name), r = `${rel}/${name}`;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) { h.update(r + "\0"); h.update(fs.readFileSync(abs)); h.update("\0"); }
    }
  };
  for (const pkg of CONTAINER_PACKAGES) walk(path.join(root, "packages", pkg), pkg);
  h.update("patch.yml\0"); h.update(CONTAINER_PATCH); h.update("\0");
  h.update(`${CONTAINER_APT_LOCK_PATH}\0`); h.update(CONTAINER_APT_LOCK); h.update("\0");
  return h.digest("hex");
}

// `node tools/container-sources.mjs --check build/container`: fail when the built container's copy is stale.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.resolve(root, process.argv[process.argv.indexOf("--check") + 1] ?? "build/container");
  const file = path.join(dir, "SOURCES");
  const want = containerSourcesDigest(root);
  const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
  if (have !== want) {
    console.error(`container: ${have ? "its copy of" : "no record of"} ${CONTAINER_PACKAGES.join(", ")} ${have ? "is older than the source" : "in " + dir}; run \`npm run build:container\``);
    process.exit(1);
  }
  console.log("container: carried packages match the source");
}
