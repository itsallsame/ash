import { readFileSync } from "node:fs";
import Ajv from "ajv";
import {
  HOST_CONTRACT, HOST_ENV, HOST_EXIT_CONFIG, HOST_REQUIRED_CAPABILITIES, HOST_SPEC_SCHEMA,
  type HostSpec,
} from "../../../../sdk/src/host";

/** What the kernel needs to run on this host: the launch description plus the two secrets that were in the environment. */
export interface HostBoot {
  spec: HostSpec;
  /** Absolute path of host.json. */
  specPath: string;
  /** Hidden from enumeration (JSON, spread, logging of the whole object) so a stray log line cannot leak them. */
  readonly secrets: { readonly sealKey: Buffer; readonly token: string };
}

/** The kernel cannot run with what the host gave it: exit with `exitCode` (78) after logging `reason`. */
export interface HostBootFailure { ok: false; exitCode: typeof HOST_EXIT_CONFIG; reason: string }
export type HostBootResult = { ok: true; boot: HostBoot } | HostBootFailure;

export interface LoadHostBootOptions {
  /** Defaults to process.env. The seal key and the token are deleted from whatever object is given. */
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

const fail = (reason: string): HostBootFailure => ({ ok: false, exitCode: HOST_EXIT_CONFIG, reason });

let validator: ReturnType<Ajv["compile"]> | null = null;
function validate(value: unknown): string[] {
  validator ??= new Ajv({ strict: false, allErrors: true }).compile(HOST_SPEC_SCHEMA);
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`);
}

/**
 * Reads the launch description named by ASH_HOST_SPEC and checks the contract version, the required capabilities and
 * secure storage. The seal key and the token are taken out of the environment first of all (even when the rest fails),
 * so they only live in the returned object. Never exits: the caller exits with `exitCode` (see hostFatal).
 */
export function loadHostBoot(options: LoadHostBootOptions = {}): HostBootResult {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const specPath = env[HOST_ENV.spec];
  const sealText = env[HOST_ENV.sealKey];
  const token = env[HOST_ENV.token];
  delete env[HOST_ENV.sealKey];
  delete env[HOST_ENV.token];

  if (!specPath) return fail(`${HOST_ENV.spec} is not set`);
  let raw: unknown;
  try { raw = JSON.parse(readFile(specPath)); } catch (error) { return fail(`cannot read host spec ${specPath}: ${(error as Error).message}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("host spec is not a JSON object");

  const contract = (raw as { contract?: unknown }).contract;
  if (contract !== HOST_CONTRACT) return fail(`host contract ${JSON.stringify(contract)} is not ${HOST_CONTRACT}`);
  const problems = validate(raw);
  if (problems.length) return fail(`host spec is invalid: ${problems.join("; ")}`);
  const spec = raw as HostSpec;

  const missing = HOST_REQUIRED_CAPABILITIES.filter((name) => !spec.capabilities.includes(name));
  if (missing.length) return fail(`host lacks required capabilities: ${missing.join(", ")}`);
  if (spec.secure_storage === "none" && spec.dev?.owner_token !== true) return fail("host has no secure storage and this is not a development run");

  if (!sealText) return fail(`${HOST_ENV.sealKey} is not set`);
  const sealKey = /^[A-Za-z0-9_-]+$/.test(sealText) ? Buffer.from(sealText, "base64url") : Buffer.alloc(0);
  if (sealKey.length !== 32) return fail(`${HOST_ENV.sealKey} is not 32 bytes of base64url`);
  if (!token) return fail(`${HOST_ENV.token} is not set`);

  const boot = { spec, specPath } as HostBoot;
  Object.defineProperty(boot, "secrets", { value: Object.freeze({ sealKey, token }), enumerable: false });
  return { ok: true, boot };
}

/** Logs the reason and exits with the failure's code. `exit` and `log` are injectable for tests. */
export function hostFatal(
  failure: HostBootFailure,
  io: { log?: (line: string) => void; exit?: (code: number) => never } = {},
): never {
  (io.log ?? ((line: string) => console.error(line)))(`[host] cannot start: ${failure.reason}`);
  return (io.exit ?? ((code: number) => process.exit(code)))(failure.exitCode);
}
