// apps.validate and the check before an install: everything install would trip over, said precisely enough to fix
// without guessing. The static part reads the folder (synchronous, so it can run in the service's `precheck`); the trial
// run starts the server once (ASH_TRIAL=1, no usable credential), lists its tools and reads every page.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import Ajv, { type ErrorObject } from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { APP_SCHEMA, ASH_ON_EVENT_TOOL, type AppJson, type McpTool } from "../../../../sdk/src/app";
import { APP_NAME_PATTERN } from "../../../../sdk/src/ids";
import { compileSchema, WORD_NAME_PATTERN } from "../../../../sdk/src/word";
import { needKey } from "./store";

export interface AppProblem { level: "error" | "warning"; where: string; problem: string; fix?: string }
export interface AppSpawn { command: string; args: string[]; env: Record<string, string>; cwd?: string }
export const UI_MIME = "text/html;profile=mcp-app";
const ID = new RegExp(APP_NAME_PATTERN);

const error = (where: string, problem: string, fix?: string): AppProblem => ({ level: "error", where, problem, ...(fix ? { fix } : {}) });
const warning = (where: string, problem: string, fix?: string): AppProblem => ({ level: "warning", where, problem, ...(fix ? { fix } : {}) });
const short = (value: unknown, max = 300) => String(value instanceof Error ? value.message : value).replace(/\s+/g, " ").trim().slice(0, max);

/** One schema error as a sentence about the field it is on. */
function schemaProblem(item: ErrorObject): AppProblem | null {
  const at = `app.json ${item.instancePath || "/"}`;
  const p = item.params as Record<string, unknown>;
  switch (item.keyword) {
    case "required": return error(at, `缺少必填字段 ${p.missingProperty}`);
    case "additionalProperties": return error(at, `不认识的字段 ${p.additionalProperty}（ash-app/1 不允许多余字段）`, "删掉它，或看 apps.contract 里的字段表");
    case "const": return error(at, `必须是 ${JSON.stringify(p.allowedValue)}`);
    case "type": return error(at, `类型应为 ${p.type}`);
    case "enum": return error(at, `只能是 ${JSON.stringify(p.allowedValues)} 之一`);
    case "pattern": return error(at, `格式不对，要匹配 ${p.pattern}`);
    case "minLength": return error(at, p.limit === 1 ? "不能为空" : `至少 ${p.limit} 个字符`);
    case "maxLength": return error(at, `最多 ${p.limit} 个字符`);
    case "minItems": return error(at, `至少 ${p.limit} 项`);
    case "maxItems": return error(at, `最多 ${p.limit} 项`);
    case "maxProperties": return error(at, `最多 ${p.limit} 个`);
    case "not": return item.schemaPath.includes("propertyNames") || /\/server\/env/.test(item.instancePath)
      ? error(at, "环境变量名不能以 ASH_ 开头（那是 Ash 给的）")
      : item.instancePath === "/data_dir" ? error(at, "data_dir 不能是 ui 或 node_modules：apps.reset 会清空它")
        : error(at, "app.card、app.activity 是 Ash 内置的事件，不用也不能在 events 里声明");
    case "propertyNames": return null;
    case "oneOf":
      if (/^\/needs\/\d+$/.test(item.instancePath)) return error(at, "这一项不是合法的 need", '每项是 {"member":"device:x","words":["…"],"why":"…"}、{"notify":true,"why":"…"}、{"card":true,"why":"…"} 或 {"widgets":true,"why":"…"} 之一，why 必填');
      if (/^\/wake_events\/\d+$/.test(item.instancePath)) return error(at, "这一项不是合法的 wake_events", '写事件名，或 {"event":"x.y","agent":"agent:<name>"}');
      return error(at, item.message ?? "不合规");
    default: return error(at, item.message ?? "不合规");
  }
}

let compiled: ReturnType<Ajv["compile"]> | null = null;

/** The rules a schema cannot say. Null when the manifest passes. */
export function manifestRule(manifest: AppJson): { where: string; problem: string; fix?: string } | null {
  const surfaces = manifest.surfaces ?? [];
  if (new Set(surfaces.map((item) => item.id)).size !== surfaces.length) return { where: "app.json /surfaces", problem: "surfaces 里有重复的 id" };
  if (manifest.data_dir !== undefined && /^\.+$/.test(manifest.data_dir)) return { where: "app.json /data_dir", problem: "data_dir 要是一个文件夹名（如 data）" };
  const script = manifest.server.args?.[0];
  if (manifest.data_dir !== undefined && script && script.replace(/^\.\//, "").startsWith(`${manifest.data_dir}/`))
    return { where: "app.json /data_dir", problem: "data_dir 里不能放服务的文件：apps.reset 会清空它" };
  const cards = manifest.cards ?? [];
  if (new Set(cards.map((item) => item.id)).size !== cards.length) return { where: "app.json /cards", problem: "cards 里有重复的 id" };
  const keys = (manifest.needs ?? []).map(needKey);
  if (new Set(keys).size !== keys.length) return { where: "app.json /needs", problem: "needs 里同一个成员（或 notify/card/widgets）只能出现一次" };
  if ((manifest.needs ?? []).some((need) => "member" in need && need.member === `app:${manifest.id}`)) return { where: "app.json /needs", problem: "needs 里不能写应用自己" };
  const events = manifest.events ?? [];
  if (new Set(events).size !== events.length) return { where: "app.json /events", problem: "events 里有重复的名字" };
  for (const item of manifest.wake_events ?? []) {
    const name = typeof item === "string" ? item : item.event;
    if (!events.includes(name)) return { where: "app.json /wake_events", problem: `${name} 没有写在 events 里`, fix: "wake_events 里的每个事件都要先在 events 里声明" };
  }
  const listens = manifest.listens ?? [];
  if (new Set(listens).size !== listens.length) return { where: "app.json /listens", problem: "listens 里有重复的项" };
  return null;
}

/** app.json as written: parse, schema (every error, by field), and the rules a schema cannot say. */
export function checkManifest(text: string, folder: string): { manifest: AppJson | null; problems: AppProblem[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (cause) { return { manifest: null, problems: [error("app.json", `不是合法的 JSON：${short(cause)}`)] }; }
  compiled ??= new Ajv({ strict: false, allErrors: true }).compile({ ...APP_SCHEMA, $id: undefined });
  const problems: AppProblem[] = [];
  if (!compiled(raw)) {
    const errors = compiled.errors ?? [];
    // Inside an item that matches no variant, the per-variant complaints are noise: the oneOf sentence says it all.
    const variants = new Set(errors.filter((item) => item.keyword === "oneOf" && /^\/(needs|wake_events)\/\d+$/.test(item.instancePath)).map((item) => item.instancePath));
    for (const item of errors) {
      if ([...variants].some((path) => item.instancePath.startsWith(path) && item.keyword !== "oneOf")) continue;
      const problem = schemaProblem(item);
      if (problem && !problems.some((known) => known.where === problem.where && known.problem === problem.problem)) problems.push(problem);
    }
  }
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (typeof record.id === "string" && record.id !== folder) problems.push(error("app.json /id", `id 是 ${record.id}，但文件夹叫 ${folder}`, `两者要相同：把文件夹放在应用文件夹目录下的 ${record.id}/`));
  if (!ID.test(folder)) problems.push(error("文件夹", `文件夹名 ${folder} 不是合法的应用 id（${APP_NAME_PATTERN}）`));
  if (problems.length) return { manifest: null, problems };
  const manifest = raw as AppJson;
  const rule = manifestRule(manifest);
  if (rule) return { manifest: null, problems: [error(rule.where, rule.problem, rule.fix)] };
  for (const surface of manifest.surfaces ?? []) if (!surface.resource.startsWith(`ui://${manifest.id}/`))
    problems.push(warning(`app.json surfaces ${surface.id}`, `resource ${surface.resource} 不在 ui://${manifest.id}/ 下`, `习惯写成 ui://${manifest.id}/${surface.id}`));
  return { manifest, problems };
}

/** The folder's files: app.json, the icon, the server's own file. */
export function checkFolder(dir: string, folder: string): { manifest: AppJson | null; problems: AppProblem[] } {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { manifest: null, problems: [error("文件夹", "这个文件夹不存在", "先用 apps.scaffold 生成，或自己建应用文件夹")] };
  if (!existsSync(join(dir, "app.json"))) return { manifest: null, problems: [error("app.json", "文件夹里没有 app.json", "看 apps.contract 第 1 节，或用 apps.scaffold 生成")] };
  const { manifest, problems } = checkManifest(readFileSync(join(dir, "app.json"), "utf8"), folder);
  if (!manifest) return { manifest, problems };
  if (!manifest.role) problems.push(warning("app.json /role", "没写 role：Ash 只能拿 summary 猜什么时候该用它", "写一句它管什么、什么时候用"));
  if (!manifest.data_dir) problems.push(warning("app.json /data_dir", "没写 data_dir：Ash 不知道哪些文件是主人的数据，apps.reset 清不了，apps.remove 也没法只留数据",
    '把数据放在应用文件夹里的一个子文件夹（如 data/），写 "data_dir": "data"'));
  if (!manifest.icon) problems.push(warning("app.json /icon", "没有图标：会显示默认图标", "放一个正方形 PNG（192×192 或更大）在文件夹里，icon 写它的文件名"));
  else {
    const file = join(dir, manifest.icon);
    if (!existsSync(file)) problems.push(warning("app.json /icon", `图标文件 ${manifest.icon} 不存在：会显示默认图标`));
    else {
      const bytes = readFileSync(file);
      const kind = extname(file).toLowerCase();
      const looks = kind === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : kind === ".webp" ? bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"
          : /<svg[\s>]/i.test(bytes.subarray(0, 2000).toString("utf8"));
      if (!looks) problems.push(warning("app.json /icon", `${manifest.icon} 的内容不是 ${kind.slice(1).toUpperCase()}`));
      if (bytes.length > 512 * 1024) problems.push(warning("app.json /icon", `图标有 ${Math.round(bytes.length / 1024)} KB，太大`, "控制在 512 KB 以内"));
    }
  }
  // `node server.mjs`, `python3 app.py`: the script must be there (relative to the app folder).
  const script = manifest.server.args?.[0];
  if (/^(node|python3?|bun|deno)$/.test(manifest.server.command) && script && !script.startsWith("-") && /\.(m?js|cjs|ts|py)$/.test(script) && !script.startsWith("/") && !existsSync(join(dir, script)))
    problems.push(error("app.json /server", `server 要运行 ${script}，但文件夹里没有这个文件`));
  if (manifest.server.command.startsWith("./") && !existsSync(join(dir, manifest.server.command)))
    problems.push(error("app.json /server/command", `${manifest.server.command} 不存在`));
  return { manifest, problems };
}

/** Why a tool of an app's server cannot become a word, or null. Registration checks only the name and that the schema compiles. */
export function toolProblem(tool: Pick<McpTool, "name" | "inputSchema">): string | null {
  if (typeof tool.name !== "string" || !WORD_NAME_PATTERN.test(tool.name) || tool.name.length > 64) return "名字不合规，不会登记成能力：要匹配 ^[a-z][a-z0-9_-]*(\\.[a-z0-9_-]+)*$，例如 notes.add";
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || (schema as { type?: unknown }).type !== "object")
    return 'inputSchema 必须是 type 为 object 的 JSON Schema，否则不会登记；没有参数就写 {"type":"object","properties":{},"additionalProperties":false}';
  try { compileSchema(schema); } catch (cause) { return `inputSchema 编译不过（Ajv 严格模式），不会登记：${short(cause)}`; }
  return null;
}

/** Start the server once and look at what it offers: tools as the hub would register them, every page as the shell reads it. */
export async function trialRun(manifest: AppJson, spec: AppSpawn, timeoutMs = 30_000): Promise<{ problems: AppProblem[]; tools: string[]; surfaces: string[] }> {
  const problems: AppProblem[] = [];
  const tools: string[] = [], surfaces: string[] = [];
  let stderr = "";
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, ...(spec.cwd ? { cwd: spec.cwd } : {}), stderr: "pipe" });
  transport.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-1500); });
  const output = () => (stderr.trim() ? `；它最后的输出（stderr）：${short(stderr.trim().split("\n").slice(-6).join(" | "), 600)}` : "");
  const client = new Client({ name: "ash-check", version: "1.0.0" });
  try {
    try { await client.connect(transport, { timeout: timeoutMs }); } catch (cause) {
      problems.push(error("server", `服务没有启动起来，或没有按 MCP 回答 initialize：${short(cause)}${output()}`,
        "Ash 在应用文件夹里运行 server.command server.args…，stdin/stdout 上每行一条 JSON-RPC 2.0；stdout 只能写协议消息，日志写 stderr。对照 apps.contract 第 2 节或 apps.scaffold 生成的 server.mjs"));
      return { problems, tools, surfaces };
    }
    const capabilities = client.getServerCapabilities() ?? {};
    let listed: McpTool[] = [];
    try { listed = (await client.listTools(undefined, { timeout: timeoutMs })).tools as McpTool[]; } catch (cause) {
      problems.push(error("server tools/list", `tools/list 失败：${short(cause)}${output()}`, capabilities.tools ? undefined : "initialize 的回答里 capabilities 要有 tools: {}"));
    }
    const seen = new Set<string>();
    let writes = 0;
    for (const tool of listed) {
      const where = `工具 ${short(tool.name, 80)}`;
      if (tool.name === ASH_ON_EVENT_TOOL) continue;
      const bad = toolProblem(tool);
      if (bad) { problems.push(warning(where, bad)); continue; }
      if (seen.has(tool.name)) { problems.push(warning(where, "名字重复，只登记第一个")); continue; }
      seen.add(tool.name);
      tools.push(tool.name);
      if (tool.annotations?.readOnlyHint !== true) writes++;
      if (!tool.title) problems.push(warning(where, "没有 title：审批卡上会直接显示工具名", "写一个中文动宾短语，如「记一笔」"));
      if (!tool.description) problems.push(warning(where, "没有 description：Agent 不知道它做什么"));
      if (!tool.annotations || typeof tool.annotations.readOnlyHint !== "boolean")
        problems.push(warning(where, "没写 annotations.readOnlyHint：会当作「改数据、要审批」", "只读的工具写 annotations: {readOnlyHint: true}；改数据又不影响别人的写 {readOnlyHint: false, destructiveHint: false, openWorldHint: false}"));
    }
    if (!listed.some((tool) => tool.name === ASH_ON_EVENT_TOOL) && (manifest.listens ?? []).length)
      problems.push(error("server tools/list", `app.json 写了 listens，但服务没有保留工具 ${ASH_ON_EVENT_TOOL}：Ash 没法把事件交给它`,
        `加一个工具 ${ASH_ON_EVENT_TOOL}，参数 {word, body, from, at}`));
    // Every app is an organ of ash: what the owner can do with its data on a page, the agent can do through its tools.
    const pages = (manifest.surfaces ?? []).length > 0;
    if (!tools.length && !problems.some((item) => item.where === "server tools/list"))
      problems.push((pages ? error : warning)("server tools/list", pages ? `只有页面、没有可用的工具：Agent 没法通过 app:${manifest.id} 看或改它的数据`
        : `一个工具都没有：Agent 没法通过 app:${manifest.id} 用它`, "每个应用都要有给 Agent 用的工具：读数据的（readOnlyHint: true）和改数据的，页面也通过它们读写"));
    else if (pages && tools.length && !writes)
      problems.push(warning("server tools/list", "只有只读工具：页面上能改的数据，Agent 改不了", "页面上每种改数据的操作都写成一个工具，页面用 app.call 调它，Agent 用同一个"));
    for (const surface of manifest.surfaces ?? []) {
      const where = `页面 ${surface.id}（${surface.resource}）`;
      let read: Awaited<ReturnType<Client["readResource"]>>;
      try { read = await client.readResource({ uri: surface.resource }, { timeout: timeoutMs }); } catch (cause) {
        problems.push(error(where, `resources/read 读不出来：${short(cause)}${output()}`, capabilities.resources ? "服务要对这个 uri 返回 {contents:[{uri, mimeType, text}]}" : "initialize 的回答里 capabilities 要有 resources: {}"));
        continue;
      }
      const content = (read.contents ?? []).find((item) => item.uri === surface.resource) ?? read.contents?.[0];
      const html = !content ? "" : typeof (content as { text?: unknown }).text === "string" ? String((content as { text: string }).text)
        : typeof (content as { blob?: unknown }).blob === "string" ? Buffer.from(String((content as { blob: string }).blob), "base64").toString("utf8") : "";
      if (!content || !html.trim()) { problems.push(error(where, "返回的内容是空的", "contents[0].text 放整页 HTML")); continue; }
      surfaces.push(surface.id);
      if (content.mimeType !== UI_MIME) problems.push(warning(where, `mimeType 是 ${short(content.mimeType ?? "（没写）", 80)}`, `写 ${UI_MIME}`));
      if (/localStorage\.setItem|indexedDB\.open/.test(html)) problems.push(warning(where, "页面把数据存在浏览器里（localStorage / IndexedDB）：Agent 看不到也改不了", "主人的数据放在服务里，页面和 Agent 都通过工具读写"));
    }
  } finally {
    try { await client.close(); } catch { /* already gone */ }
  }
  return { problems, tools, surfaces };
}
