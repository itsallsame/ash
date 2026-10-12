import { fill } from "./home-dom.js";
// 她的文件: the files of her work directory (or of a computer she uses), browsed as a list; a file opens in the reader.
import { Files } from "./files.js";
import { listBodies, listDirectory } from "./body.js";
import { btn, group, h, list, note, row, skeleton } from "./home-ui.js";
import { isSystemEntry } from "./home-text.js";

let reader = null;
/** The one file reader of the page (a dialog); the conversation's links use their own instance of the same class. */
const readerFor = (net) => { if (!reader || reader.net !== net) reader = new Files(net); return reader; };

const sizeText = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

export function filesPage(ctx, screen, arg) {
  const box = h("div", { class: "hm-stack" }, skeleton(4));
  const state = { bodies: [], body: null, path: "", listing: null, failed: "" };
  const files = readerFor(ctx.net);
  const draw = () => {
    if (state.failed) { fill(box, note(state.failed, "warn"), btn("重试", "a-btn btn-neutral btn-sm", () => void load())); return; }
    if (!state.listing) return;
    const where = state.bodies.length > 1 ? h("div", { class: "seg", role: "tablist" }, state.bodies.map((body) => btn(body.body === "body:main" ? "她的容器" : body.name || body.body, state.body === body.body ? "on" : "", () => { state.body = body.body; state.path = ""; void load(); }, { role: "tab", "aria-selected": String(state.body === body.body) }))) : null;
    const entries = [...state.listing.entries].filter((entry) => state.path || !isSystemEntry(entry)).sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
    const rows = entries.map((entry) => {
      const dir = entry.type === "directory";
      const child = state.path ? `${state.path}/${entry.name}` : entry.name;
      return row({ icon: dir ? "folder" : "file", tone: dir ? "" : "you", title: entry.name, sub: dir ? null : Number.isFinite(entry.size) ? sizeText(entry.size) : null, onClick: () => { if (dir) { state.path = child; void load(); } else void files.open({ workspace: state.body, path: child }); } });
    });
    const up = state.path ? row({ icon: "back", title: "上一级", sub: null, onClick: () => { state.path = state.path.split("/").slice(0, -1).join("/"); void load(); } }) : null;
    fill(box, where, group(state.path.split("/").pop() || "", list(...(up ? [up] : []), ...(rows.length ? rows : [row({ title: "此目录为空" })]))),
      state.listing.truncated ? note("只显示了前面一部分") : null);
  };
  async function load() {
    try {
      if (!state.bodies.length) state.bodies = await listBodies(ctx.net);
      if (!state.body) state.body = state.bodies[0]?.body;
      if (!state.body) { state.failed = "暂无可浏览的文件"; if (screen.alive()) draw(); return; }
      const listing = await listDirectory(ctx.net, state.body, state.path);
      if (!screen.alive()) return;
      state.listing = listing; state.failed = "";
    } catch (error) { if (!screen.alive()) return; state.failed = error?.message || "文件无法读取"; }
    draw();
  }
  const refresh = async () => { await load(); if (typeof arg === "string" && screen.alive() && state.body) { const name = arg; arg = null; void files.open({ workspace: state.body, path: name }); } };
  return { title: "她的文件", body: box, refresh };
}
