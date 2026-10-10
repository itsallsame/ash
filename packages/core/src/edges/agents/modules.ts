/**
 * The prompt modules (SPEC-08 §2.3): what the hub writes into an agent's session, as named, versioned pieces.
 *
 *   static    identity (the approved persona), rules       -> the start of a session; changed only by a reload
 *   dynamic   user (USER.md, MEMORY.md), skills (index), environment, lane (the lane's guide)
 *                                                          -> injected into the session when the content changed
 *
 * Content comes from other members through `router.send` (persona, the body's files) and from the registry. Which
 * modules an agent loads is its declaration (`modules`; absent = all).
 */
import { createHash } from "node:crypto";
import type { ModuleId, PromptModule } from "../../../../sdk/src/driver";
import type { Caller } from "../../../../sdk/src/message";
import type { Registry, Router } from "../../kernel/types";
import { lanesOf, type AgentDecl } from "./runs";
import { allows, sees, MAX_DEPTH } from "./policy";

/** A member that dropped out of the registry less than this ago is still in the environment. */
export const ENV_GRACE_MS = 60_000;
const SKILLS_TTL_MS = 30_000;

export const SERVICE_CALLER: Caller = { member: "service:agents", via: "service", local: true };

export interface ModulesDeps {
  router: Router;
  registry: Registry;
  now(): number;
  /** The rules text for an agent (ash's rules, the first layer of the two-layer guidance). */
  rules?(decl: AgentDecl): string | Promise<string>;
  /** Where the owner is, one short line per channel (「手机 App（本机，正在看）」). */
  channels?(): string[];
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function make(id: ModuleId, title: string, body: string): PromptModule {
  const version = sha(body).slice(0, 12);
  return { id, version, content: `[Ash ${title} · v ${version.slice(0, 6)}]\n${body}` };
}
const wants = (decl: AgentDecl, id: ModuleId) => decl.modules === undefined || decl.modules.includes(id);

interface Known { id: string; kind: string; name: string; words: string[] }

export class Modules {
  private readonly known = new Map<string, Known>();
  private readonly gone = new Map<string, { at: number; member: Known }>();
  private skills: { at: number; text: string } | null = null;

  constructor(private readonly deps: ModulesDeps) {
    const remember = (id: string) => {
      const d = deps.registry.describe(id);
      if (d) this.known.set(id, { id, kind: d.info.kind, name: d.info.name, words: [...new Set(d.words.map((w) => w.word))] });
    };
    for (const info of deps.registry.list()) remember(info.id);
    deps.registry.onChange((id, change) => {
      if (change === "added") { this.gone.delete(id); remember(id); return; }
      const member = this.known.get(id);
      if (member) this.gone.set(id, { at: deps.now(), member });
      this.known.delete(id);
    });
  }

  private async text(path: string): Promise<string | null> {
    const reply = await this.deps.router.send({ to: "body:main", kind: "request", word: "workspace.read", body: { path, limit: 20000 } }, SERVICE_CALLER);
    if (!reply.ok) return null;
    const text = (reply.result?.data as { text?: unknown } | undefined)?.text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  }

  // -- static ------------------------------------------------------------------------------------------------------

  async static(decl: AgentDecl): Promise<PromptModule[]> {
    const out: PromptModule[] = [];
    if (wants(decl, "identity")) {
      const reply = await this.deps.router.send({ to: "service:persona", kind: "request", word: "get", body: {} }, SERVICE_CALLER);
      const files = reply.ok ? (reply.result?.data as { files?: { file: string; content: string }[] } | undefined)?.files ?? [] : [];
      const body = files.filter((f) => f.content?.trim()).map((f) => `## ${f.file}\n${f.content.trim()}`).join("\n\n");
      if (body) out.push(make("identity", "identity", body));
    }
    if (wants(decl, "rules")) {
      const rules = (await this.deps.rules?.(decl))?.trim() ?? "";
      const body = [rules, decl.brief.trim() ? `## Your role\n${decl.brief.trim()}` : ""].filter(Boolean).join("\n\n");
      if (body) out.push(make("rules", "rules", body));
    }
    return out;
  }

  // -- dynamic -----------------------------------------------------------------------------------------------------

  async dynamic(decl: AgentDecl, lane: string): Promise<PromptModule[]> {
    const out: PromptModule[] = [];
    if (wants(decl, "user")) {
      const [user, memory] = await Promise.all([this.text("USER.md"), this.text("MEMORY.md")]);
      const body = [user ? `## USER.md\n${user}` : "", memory ? `## MEMORY.md\n${memory}` : ""].filter(Boolean).join("\n\n");
      if (body) out.push(make("user", "user", body));
    }
    if (wants(decl, "skills")) {
      const body = await this.skillIndex();
      if (body) out.push(make("skills", "skills", body));
    }
    if (wants(decl, "environment")) out.push(this.environment(decl, lane));
    if (wants(decl, "lane")) {
      const guide = lanesOf(decl)[lane]?.guide;
      const text = guide ? await this.text(guide) : null;
      if (text) out.push(make("lane", `lane ${lane}`, `## Lane ${lane}\n${text}`));
    }
    return out;
  }

  /** One line per skill: its name, what it is for, where it is. Read from the SKILL.md files of the body, a little while cached. */
  private async skillIndex(): Promise<string> {
    if (this.skills && this.deps.now() - this.skills.at < SKILLS_TTL_MS) return this.skills.text;
    const reply = await this.deps.router.send({ to: "body:main", kind: "request", word: "workspace.grep",
      body: { path: "skills", pattern: "^(name|description):", glob: "**/SKILL.md", limit: 600 } }, SERVICE_CALLER);
    const matches = reply.ok ? (reply.result?.data as { matches?: { path: string; text: string }[] } | undefined)?.matches ?? [] : [];
    const files = new Map<string, { name?: string; description?: string }>();
    for (const m of matches) {
      const entry = files.get(m.path) ?? {};
      const hit = /^(name|description):\s*(.*)$/.exec(m.text.trim());
      if (hit) entry[hit[1] as "name" | "description"] ??= hit[2]!.trim();
      files.set(m.path, entry);
    }
    const lines = [...files].filter(([, f]) => f.name).sort(([a], [b]) => a.localeCompare(b)).map(([path, f]) => `- ${f.name}: ${f.description ?? ""} (${path})`);
    const text = lines.join("\n");
    this.skills = { at: this.deps.now(), text };
    return text;
  }

  // -- environment -------------------------------------------------------------------------------------------------

  /** Coarse facts about who is here, as this agent may see them. The same facts give the same content, so the same version. */
  environment(decl: AgentDecl, lane: string): PromptModule {
    const now = this.deps.now();
    for (const [id, g] of this.gone) if (now - g.at >= ENV_GRACE_MS) this.gone.delete(id);
    const members = new Map<string, Known>(this.known);
    for (const [id, g] of this.gone) if (!members.has(id)) members.set(id, g.member);
    const visible = (kind: string) => [...members.values()].filter((m) => m.kind === kind && sees(decl.words, m.id)).sort((a, b) => a.id.localeCompare(b.id));
    const namespaces = (m: Known) => [...new Set(m.words.filter((w) => allows(decl.words, `${m.id}/${w}`)).map((w) => w.split(".")[0]!))].sort();

    const lines: string[] = [];
    const canSpawn = decl.depth < MAX_DEPTH && allows(decl.words, "service:agents/spawn");
    lines.push(`你：${decl.id}${decl.primary ? "（primary）" : ""} · 这一路：${lane} · 委托深度 ${decl.depth}/${MAX_DEPTH} · ${canSpawn ? "可以派子 agent" : "不能派子 agent"}`);
    const channels = this.deps.channels?.() ?? [];
    if (channels.length) lines.push(`主人在哪：${channels.join("；")}`);
    const hands = visible("device");
    if (hands.length) lines.push(`手：${hands.map((m) => `${m.id} ${m.name}${namespaces(m).length ? ` · ${namespaces(m).join("、")}` : ""}`).join("\n    ")}`);
    const bodies = visible("body");
    if (bodies.length) lines.push(`身体：${bodies.map((m) => `${m.id}（${m.name}）`).join("；")}`);
    const apps = visible("app");
    if (apps.length) lines.push(`器官：${apps.map((m) => m.id).join("、")}`);
    const others = visible("agent").filter((m) => m.id !== decl.id);
    if (others.length) lines.push(`其他 agent：${others.map((m) => m.id).join("、")}`);
    lines.push("查完整能力：capability_list / capability_describe；怎么用好看技能索引。");
    return make("environment", "environment", lines.join("\n"));
  }
}
