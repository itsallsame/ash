import { readFileSync } from "node:fs";
import Ajv from "ajv";
import {
  HOST_CONTRACT, HOST_ENV, HOST_EXIT_CONFIG, HOST_REQUIRED_CAPABILITIES, HOST_SPEC_SCHEMA,
  type HostSpec,
} from "../../../../sdk/src/host";

/** What the kernel needs to know about this host: the launch description. The secrets come over the pipe (pipe.ts). */
export interface HostBoot {
  spec: HostSpec;
  /** Absolute path of host.json. */
  specPath: string;
}

/** The kernel cannot run with what the host gave it: exit with `exitCode` (78) after logging `reason`. */
export interface HostBootFailure { ok: false; exitCode: typeof HOST_EXIT_CONFIG; reason: string }
export type HostBootResult = { ok: true; boot: HostBoot } | HostBootFailure;

export interface LoadHostBootOptions {
  /** Defaults to process.env. */
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
 * secure storage. Never exits: the caller exits with `exitCode` (main.ts).
 */
export function loadHostBoot(options: LoadHostBootOptions = {}): HostBootResult {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const specPath = env[HOST_ENV.spec];

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
  return { ok: true, boot: { spec, specPath } };
}
