// Compile the browser transport's frame checks at build time from the generated protocol schemas.
// Node clients keep the SDK implementation; the native page does not include the browser transport.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const schemas = join(root, "packages/sdk/schema/link");
const read = (file) => JSON.parse(readFileSync(join(schemas, file), "utf8"));

export function browserLinkPlugin() {
  return { name: "browser-link-checks", setup(b) {
    b.onLoad({ filter: /\/packages\/sdk\/src\/link\.ts$/ }, () => {
      const index = read("index.json");
      const types = Object.keys(index.frames);
      const ajv = new Ajv({ strict: false, code: { source: true, esm: true } });
      const refs = {};
      const defs = {};
      for (const [i, t] of types.entries()) {
        const { file, channel, from } = index.frames[t];
        const schema = read(file);
        ajv.addSchema(schema, `frame/${t}`);
        refs[`v${i}`] = `frame/${t}`;
        // Retain the SDK definition's shape, without the generated file's annotation fields.
        const { $schema, title, ...json } = schema;
        defs[t] = { schema: { json }, channel, from };
      }
      const checks = types.map((t, i) => `${JSON.stringify(t)}:v${i}`).join(",");
      const contents = `${standaloneCode(ajv, refs)}
export const LINK_PROTOCOL = ${JSON.stringify(index.protocol)};
export const LIMITS = ${JSON.stringify(index.limits)};
export const CLOSE_CODES = ${JSON.stringify(index.close_codes)};
export const NO_RECONNECT_CODES = ${JSON.stringify(index.no_reconnect)};
export const FRAME_DEFS = ${JSON.stringify(defs)};
export const FRAME_TYPES = Object.keys(FRAME_DEFS);
const validators = {${checks}};
export function frameError(t, value) {
  const check = validators[t];
  if (check(value)) return null;
  const first = check.errors?.[0];
  return first ? \`\${first.instancePath || "/"} \${first.message ?? "is invalid"}\` : "is invalid";
}
export function isFrame(t, value) { return validators[t](value) === true; }
export function frameType(value) {
  const t = value && typeof value === "object" ? value.t : undefined;
  return typeof t === "string" && Object.hasOwn(FRAME_DEFS, t) ? t : null;
}
export function validateFrame(value) {
  const t = frameType(value);
  if (!t) return { ok: false, t: null, error: "unknown or missing frame type" };
  const error = frameError(t, value);
  return error ? { ok: false, t, error } : { ok: true, frame: value };
}
`;
      return { contents, loader: "js", resolveDir: root };
    });
  } };
}
