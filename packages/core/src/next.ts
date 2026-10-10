/**
 * The new hub's assembly point (ASH-HUB §7.1 rule 4: the one place that imports every module and only creates and wires
 * them). Every scenario in `test/scenarios/` reaches the hub through `startHub` and the one port it opens (`/link`, `/mcp`).
 *
 * Order: host boot, ledger, vault, kernel (registry, redact, gate, router), services, edges, then everybody into the
 * registry, then start (the port first, because the agents are given the tool address on it).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { complete as piComplete } from "@mariozechner/pi-ai";
import type { AgentDriverFactory } from "../../sdk/src/driver";
import type { HostEvent } from "../../sdk/src/host";
import { MAIN_BODY_ID } from "../../sdk/src/ids";
import { WordError, type Caller, type Message, type WordResult } from "../../sdk/src/message";
import type { Member } from "../../sdk/src/word";
import { wordsOf } from "../../sdk/src/words";
import { createAgents, bodyFileWriter, fileTemplates } from "./edges/agents";
import { createDshDriver, type DriverProcess, type SpawnFn } from "./edges/agents/dsh";
import { createApps, hostLauncher, type AppLauncher } from "./edges/apps";
import { createLocalBody, mainBodyKind } from "./edges/body/local";
import { prootCommand, runInProot } from "./edges/body/proot";
import { HostClient, loadHostBoot, readHostEvents, type HostOptional } from "./edges/host";
import { createLlm, type Complete } from "./edges/llm";
import { createLlmService } from "./edges/llm/service";
import { createLinkServer } from "./edges/link-server";
import { Devices } from "./edges/link-server/hands/devices";
import { createBodies, splitBodyCapabilities } from "./edges/link-server/hands/bodies";
import { HandRegistry } from "./edges/link-server/hands/registry";
import { createHuman, summaryRequest } from "./edges/link-server/human";
import { createToolsEdge, toolWords } from "./edges/tools";
import { createGate, GateStore } from "./kernel/gate";
import { Ledger } from "./kernel/ledger";
import { createRedact } from "./kernel/redact";
import { createRegistry } from "./kernel/registry";
import { createRouter } from "./kernel/router";
import { openVault, parseSealKey } from "./kernel/vault";
import type { Vault } from "./kernel/types";
import { createAdminService } from "./services/admin";
import { createBlobsService } from "./services/blobs";
import { createClockService } from "./services/clock";
import { createCostService } from "./services/cost";
import { createDirectoryService } from "./services/directory";
import { createGateService } from "./services/gate";
import { createHistoryService } from "./services/history";
import { createJev, createReflexService } from "./services/reflex";
import { createSensesService } from "./services/senses";
import { createVaultService } from "./services/vault";
import { createWidgetsService } from "./services/widgets";

export type {
  AgentDriver, AgentDriverFactory, AgentEvent, AgentStartSpec, DriverMessage,
} from "../../sdk/src/driver";

export interface HubOptions {
  /** The hub's state directory (ledger, blobs, vault file). The caller owns it; starting again on the same one is a restart. */
  dataDir: string;
  /** The one port the hub opens on 127.0.0.1. 0 or absent: any free port. */
  port?: number;
  /** The environment the host started the hub with (SPEC-07: `ASH_HOST_SPEC`, `ASH_VAULT_SEAL_KEY`, `ASH_HOST_TOKEN`). Absent: `process.env`. The hub reads host.json itself. */
  env?: NodeJS.ProcessEnv;
  /**
   * Where the host's events arrive, one JSON line each (`wake.fired`, `env.changed`, `lifecycle.stop`). Absent: `process.stdin`.
   * One stream per start; after `stop()` the hub no longer reads it.
   */
  stdin?: Readable;
  /** Where the hub's small model lives; overrides the providers' own addresses (BUILD-PROGRESS §7, decision 1). Absent: the real ones. */
  llm?: { baseUrl: string };
  /** Drivers by runtime kind (`dsh`, `codex`, ...). Absent: the real ones. */
  drivers?: Record<string, AgentDriverFactory>;
  /** The clock of everything that waits for a time (timers, approval expiry, pulse). Absent: the system clock. */
  now?: () => number;
}

export interface Hub {
  /** `http://127.0.0.1:<port>`. `/link` (WebSocket, `ash-link/1`) and `/mcp` hang off it. */
  url: string;
  stop(): Promise<void>;
}

const log = (...args: unknown[]): void => console.error("[hub]", ...args.map((a) => (a instanceof Error ? a.message : a)));
const service = (member: string): Caller => ({ member, via: "service", local: true });
const SKILLS_AGENTS = fileURLToPath(new URL("../../ash-skills/agents", import.meta.url));

function hubVersion(): string {
  try { return String((JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "dev"); } catch { return "dev"; }
}

/** `service:host`: the host client's calls as words (HUB-MODULES §2.8). The host module has no member of its own yet. */
function hostMember(host: HostClient): Member {
  const done = <R>(r: HostOptional<R>): WordResult => {
    if (!r.supported) throw new WordError("unavailable", "the host does not offer this");
    return { data: (r.result ?? {}) as object };
  };
  return {
    id: "service:host", kind: "service", name: "host",
    words: () => wordsOf("service:host"),
    async handle(msg: Message): Promise<WordResult> {
      const b = (msg.body ?? {}) as Record<string, any>;
      switch (msg.word) {
        case "wake.at": return done(await host.wakeAt(b.at));
        case "wake.clear": return done(await host.wakeClear());
        case "power.hold": return done(await host.powerHold(b.ms, b.reason));
        case "power.release": return done(await host.powerRelease());
        case "hands.handoff": return done(await host.handsHandoff(b.port, b.token));
        case "update.install": return done(await host.updateInstall(b.version, b.url, b.sha256));
        default: throw new WordError("not_found", `service:host has no word ${msg.word}`);
      }
    },
  };
}

export async function startHub(opts: HubOptions): Promise<Hub> {
  const now = opts.now ?? Date.now;
  const startedAt = now();

  // 1. host boot (the seal key and the token leave the environment here)
  const booted = loadHostBoot({ env: opts.env ?? process.env });
  if (!booted.ok) throw Object.assign(new Error(`cannot start: ${booted.reason}`), { exitCode: booted.exitCode });
  const { spec, secrets } = booted.boot;
  const host = new HostClient({ endpoint: spec.endpoint, token: secrets.token, capabilities: spec.capabilities });

  // 2. ledger  3. vault (no seal key, no vault: nothing is stored unsealed)
  mkdirSync(opts.dataDir, { recursive: true });
  const ledger = Ledger.open(join(opts.dataDir, "ash.db"));
  let vault: Vault | null = null;
  try { vault = openVault({ file: join(opts.dataDir, "vault.json"), sealKey: parseSealKey(secrets.sealKey.toString("base64url")), now }); } catch (error) { ledger.close(); throw error; }

  // 4. kernel
  const registry = createRegistry();
  const redact = createRedact();
  const store = new GateStore(ledger, now);
  const late: { hands?: HandRegistry; body?: ReturnType<typeof createLocalBody>; gateService?: ReturnType<typeof createGateService>; apps?: ReturnType<typeof createApps>; agents?: ReturnType<typeof createAgents> } = {};
  const gate = createGate({
    tier: (target) => late.hands!.tier(target),
    mode: () => store.mode(),
    assess: (req) => (req.to === MAIN_BODY_ID ? late.body!.assess(req) : late.hands!.assess(req)),
    // The review model is not wired yet (no module holds its prompt): every judgement goes to the owner.
    review: async () => "ask",
  }, store, { now });
  const agentPolicy = (id: string) => {
    const decl = late.agents?.manager.runs.get(id)?.spec.decl;
    return decl ? { tools: decl.tools ?? null, words: decl.words ?? null } : null;
  };
  const router = createRouter({
    ledger, registry, gate, redact, store, now,
    onParked: (pending) => late.gateService!.issueCard(pending),
    onError: (where, error) => log(where, error),
    agentPolicy, toolWords,
    appGranted: (app, to, word) => late.apps!.runtime.granted(app, to, word),
  });

  // 5. services
  const llmBase = opts.llm?.baseUrl.replace(/\/+$/, "");
  const llm = createLlm({
    key: (ref) => vault?.use(ref) ?? null,
    report: (usage) => void router.send({ to: "service:cost", kind: "event", word: "usage.recorded", body: usage }, service("service:cost"))
      .then((reply) => { if (!reply.ok) log(`usage.recorded: ${reply.error.code}`); }, (error) => log("usage.recorded failed", error)),
    ...(llmBase ? {
      complete: ((model, context, options) => (piComplete as unknown as Complete)({ ...model, baseUrl: llmBase }, context, options)) as Complete,
      fetch: ((url: URL, init?: RequestInit) => fetch(new URL(`${url.pathname}${url.search}`, llmBase), init)) as typeof fetch,
    } : {}),
  });
  const blobs = createBlobsService(ledger);
  const gateService = late.gateService = createGateService({
    store, gate, send: (msg, caller, o) => router.send(msg, caller, o), redeem: (id, caller, o) => router.redeem(id, caller, o),
    contractOf: (member, word) => registry.find(member, word)?.contract ?? null, onError: (where, error) => log(where, error),
  });
  const clock = createClockService({ ledger, router, now });
  const senses = createSensesService({ dataDir: opts.dataDir, now });
  const cost = createCostService({ ledger, now });
  const reflex = createReflexService({ ledger, router, jev: createJev({ post: (req) => llm.post("service:reflex", req) }) });
  const history = createHistoryService({ ledger });
  const admin = createAdminService({ ledger, router, registry, version: hubVersion(), now, startedAt });
  const widgets = createWidgetsService({ ledger, router, now });
  const directory = createDirectoryService({ registry, agentPolicy, toolWords, appGranted: (app, member, word) => late.apps!.runtime.granted(app, member, word) });
  const vaultService = vault ? createVaultService({ vault, ledger, router }) : null;

  // 6. edges
  const isolation = spec.isolation;
  const body = late.body = createLocalBody({ isolation });
  const hands = late.hands = new HandRegistry({
    db: ledger.db(), registry, router, now, splitBodyCapabilities,
    bodies: { isBound: (id) => bodies.isBound(id), forget: (id) => bodies.forget(id) },
  });
  const bodies = createBodies({
    db: ledger.db(), hands: { get: (id) => hands.view(id) }, rebind: (id) => hands.rebind(id), now, mainKind: mainBodyKind(isolation),
    call: async (to, word, input) => {
      const reply = await router.send({ to, kind: "request", word, body: input }, service("service:bodies"));
      if (!reply.ok) throw new WordError(reply.error.code, reply.error.message);
      return reply.result;
    },
  });
  const devices = new Devices({ hands, router, bodies, now });
  const link = createLinkServer({ hands, hostClient: host, ...(opts.port ? { port: opts.port } : {}), log });

  let url = "";
  const tools = createToolsEdge({
    router, registry, ledger, now, log,
    agentPolicy,
    currentTurn: (id) => { for (const lane of late.agents?.manager.liveOf(id)?.lanes.values() ?? []) if (lane.turn) return lane.turn; return null; },
  });
  const spawn: SpawnFn = (argv, o) => {
    const stdio = ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"];
    if (isolation.kind === "proot") return runInProot(isolation.proot, argv, { ...(o.cwd ? { workdir: o.cwd } : {}), ...(o.env ? { env: o.env } : {}), stdio }) as unknown as DriverProcess;
    if (isolation.kind === "native") {
      const cwd = join(isolation.native.workspace, o.cwd ?? "");
      mkdirSync(cwd, { recursive: true });
      return nodeSpawn(isolation.native.dsh_bin, argv.slice(1), { cwd, env: { ...process.env, DSH_HOME: isolation.native.dsh_home, ...o.env }, stdio }) as unknown as DriverProcess;
    }
    throw new WordError("unavailable", `the ${isolation.kind} main body cannot run an agent yet`);
  };
  const drivers: Record<string, AgentDriverFactory> = {
    dsh: (report) => createDshDriver({ report, spawn, writeFile: bodyFileWriter(router), readBlob: (ref) => ledger.blob.get(ref) }),
    ...opts.drivers,
  };
  const agents = late.agents = createAgents({
    router, registry, ledger, vault: { use: (ref) => vault?.use(ref) ?? null }, drivers, now, log,
    templates: fileTemplates(SKILLS_AGENTS),
    tools: (agent, allowed) => ({ mcp_url: `${url}/mcp`, token: tools.issueToken(agent), allowed: allowed ?? [] }),
  });
  const launcher: AppLauncher = isolation.kind === "native" ? hostLauncher(join(isolation.native.workspace, "apps")) : isolation.kind === "proot" ? {
    root: join(isolation.proot.rootfs, "root", "apps"), agentRoot: "/root/apps",
    spawn: (app, dir, env) => {
      const run = prootCommand(isolation.proot, [app.server.command, ...(app.server.args ?? [])], { workdir: `/root/apps/${dir.split("/").pop()}`, env: { ...(app.server.env ?? {}), ...env } });
      return { command: run.command, args: run.args, env: run.env };
    },
  } : null as never;
  const apps = late.apps = createApps({ router, registry, ledger, primaryAgent: () => agents.primary() ?? "", launcher, clock: { now }, log });
  const llmService = createLlmService(llm);
  const settings = (): Record<string, unknown> => Object.fromEntries(
    (ledger.db().prepare("SELECT key, value FROM kv WHERE key LIKE 'setting.%'").all() as { key: string; value: string }[]).map((r) => [r.key.slice("setting.".length), JSON.parse(r.value)]));
  const human = createHuman({
    router, ledger, settings, primary: () => agents.primary(), now, log,
    summarize: async (steps) => { try { return (await llm.complete("person:owner", summaryRequest(steps))).text.trim() || null; } catch { return null; } },
  });
  link.onChannel("human", human.attach);
  link.mount("/mcp", tools.handler);

  // 7. everybody into the registry
  for (const member of [
    blobs, gateService, clock, senses, cost, reflex, history, admin, widgets, directory, ...(vaultService ? [vaultService] : []),
    body, devices, bodies, human.member, agents.service, apps.service, llmService, hostMember(host),
  ]) registry.add(member);

  // 8. start. The agents are told the tool address, so the port opens first; the registry already holds the services
  // and the main body, which an agent needs from its first turn.
  let stopping: Promise<void> | null = null;
  let stopHeartbeat: () => void = () => {};
  let events: { close(): void } | null = null;
  const stop = (deadline = now() + 5000): Promise<void> => stopping ??= (async () => {
    events?.close();
    stopHeartbeat();
    await link.stop();
    await agents.stopAll();
    await apps.stopAll(deadline);
    clock.stop();
    gateService.stop();
    human.close();
    tools.close();
    await body.close();
    ledger.close();
  })();

  try {
    const { port } = await link.start();
    url = `http://127.0.0.1:${port}`;
    await agents.startAll();
    router.recover();
    gateService.start();
    clock.start();
    widgets.start();
    await apps.start();
    await host.lifecycleReady(hubVersion(), port);
    stopHeartbeat = host.startHeartbeat(() => ({ text: "running", state: "running" }));
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }

  events = readHostEvents(opts.stdin ?? process.stdin, async (event: HostEvent) => {
    const send = (to: string, word: string, body: object) => router.send({ to, kind: "event", word, body }, service(to));
    switch (event.event) {
      case "wake.fired": await send("service:clock", "wake.fired", { at: event.at }); return;
      case "env.changed": { const { event: _name, ...rest } = event; await send("service:agents", "env.changed", rest); return; }
      case "lifecycle.stop": await stop(event.deadline); return;
    }
  }, log);

  return { url, stop: () => stop() };
}
