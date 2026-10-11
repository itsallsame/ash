import { fill } from "./home-dom.js";
// 她记得你 (USER.md and MEMORY.md in her work directory) and 她是谁 (SOUL.md and IDENTITY.md, through the persona member).
import { HomeEditor, editButton, readable } from "./home-editor.js";
import { groupMemory, memoryCount, urgentGroup } from "./home-model.js";
import { btn, group, h, list, row } from "./home-ui.js";
import { workspaceStore } from "./home-stores.js";
import { personaStore } from "./home-stores.js";

/** A page of two files with a switch between them and an "编辑" button on the bar. */
function twoFiles(ctx, screen, { title, files, store, view, foot, onSaved, count = () => undefined }) {
  const seg = h("div", { class: "seg", role: "tablist" });
  const slot = h("div", { class: "hm-stack" });
  const right = btn("编辑", "a-btn btn-ghost btn-sm hm-bar-btn", null, { hidden: true });
  const state = { active: null, editor: null, counts: {} };
  const sync = () => {
    const button = editButton(state.editor);
    right.hidden = !button;
    if (button) { right.textContent = button.label; right.disabled = button.disabled; right.onclick = button.run; }
    fill(seg, ...files.map((file) => {
      const count = state.counts[file.path];
      return btn(count === undefined ? file.label : `${file.label} · ${count}`, file.path === state.active ? "on" : "", () => void open(file.path), { role: "tab", "aria-selected": String(file.path === state.active), disabled: state.editor?.editing || Boolean(state.editor?.pending) }, );
    }));
  };
  async function open(path) {
    if (state.editor?.pending || (state.editor?.loaded && state.editor.draft !== state.editor.content)) return;
    state.editor?.dispose();
    state.active = path;
    const panel = h("div");
    fill(slot, panel, h("p", { class: "group-foot hm-foot" }, foot(path)));
    const editor = new HomeEditor(panel, { path, store: store(screen.binding), view: (content, parent) => view(path, content, parent, ctx), onChange: (e) => { if (state.editor === e) { state.counts[path] = count(path, e.content); sync(); } }, onSaved: () => onSaved?.(path) });
    state.editor = editor;
    sync();
    try { await editor.load(); } catch (error) { if (screen.alive() && state.editor === editor) { editor.status = error instanceof Error ? error.message : "没能读取，请再试一次。"; editor.render(); } }
    if (screen.alive()) sync();
  }
  const refresh = async () => {
    if (state.editor) { if (!state.editor.editing && !state.editor.pending) { try { await state.editor.load(); } catch { /* the card keeps what it had */ } } return; }
    await open(files[0].path);
    // the other file's count, for its tab
    for (const file of files.slice(1)) {
      try { const found = await store(screen.binding).read(file.path); if (screen.alive()) { state.counts[file.path] = count(file.path, found?.content ?? ""); sync(); } } catch { /* the tab has no count */ }
    }
  };
  return { title, right, body: h("div", { class: "hm-stack" }, seg, slot), refresh, dispose: () => state.editor?.dispose() };
}

export function memoryPage(ctx, screen) {
  const files = [{ path: "USER.md", label: "关于你" }, { path: "MEMORY.md", label: "她的笔记" }];
  const view = (path, content, parent) => {
    const groups = groupMemory(content);
    if (!groups.length) { parent.append(list(row({ icon: "pen", title: path === "USER.md" ? "她还没记下关于你的事" : "她还没有笔记", sub: "聊得多了，她会自己整理在这里；也可以点「编辑」自己写。" }))); return; }
    parent.append(h("div", { class: "hm-stack" }, groups.map((g) => group(g.title, h("div", { class: "list noic" }, g.items.map((text) => h("div", { class: "li noic li-row" }, h("span", { class: "lt" }, h("span", { class: `t${urgentGroup(g.title) ? " c-err" : ""}` }, text)))))))));
  };
  const page = twoFiles(ctx, screen, { title: "她记得你", files, store: (binding) => workspaceStore(ctx.net, binding), view, count: (path, content) => memoryCount(groupMemory(content)),
    foot: (path) => path === "USER.md" ? "她会自己整理，按话题分好。记错了，点「编辑」直接改。" : "这是她给自己记的笔记。她会自己整理；记错了，点「编辑」直接改。" });
  return page;
}

export function identityPage(ctx, screen) {
  const files = [{ path: "SOUL.md", label: "她的性格" }, { path: "IDENTITY.md", label: "名片" }];
  const header = h("div", { class: "hm-idcard" }, h("span", { class: "hm-idring", "aria-hidden": "true" }),
    h("span", { class: "av av-56" }, h("img", { src: `${globalThis.location?.origin === "https://appassets.androidplatform.net" ? "/assets/ash-ui/avatars" : "/avatars"}/default.webp`, alt: "" })),
    h("span", { class: "hm-id-t" }, h("span", { class: "hm-id-name" }, ctx.name), h("span", { class: "hm-id-sub" })));
  const view = (path, content, parent) => { parent.append(h("div", { class: "list hm-doc-card" }, (() => { const box = h("div", { class: "hm-doc-body" }); readable(box, content, { empty: "还没有写下什么。点「编辑」写几句。", skipTitle: true }); if (path === "SOUL.md" && content.trim()) box.append(h("span", { class: "hm-doc-sig" }, `— ${ctx.name}`)); return box; })())); };
  const page = twoFiles(ctx, screen, { title: "她是谁", files, store: (binding) => personaStore(ctx.net, binding), view,
    foot: () => "这些决定了她是谁、怎样和你相处，改完她下一句话就照新的来。想给她换个名字？直接跟她说。",
    onSaved: (path) => { if (path === "IDENTITY.md") ctx.refreshName(); } });
  screen.every(() => { header.querySelector(".hm-id-name").textContent = ctx.name; }, 500);
  const original = page.body;
  page.body = h("div", { class: "hm-stack" }, header, original);
  const refresh = page.refresh;
  page.refresh = async () => {
    void screen.ask("service:persona", "get", { file: "IDENTITY.md" }).then((data) => {
      const file = Array.isArray(data.files) ? data.files.find((item) => item?.file === "IDENTITY.md") : null;
      const sub = String(file?.content ?? "").split(/\r?\n/).map((line) => /^\s*[-*]\s*([^：:]{1,12})[：:]\s*(.+?)\s*$/.exec(line)).filter((m) => m && !/^(名字|Name)$/i.test(m[1].trim())).map((m) => m[1] === "称呼主人" ? `叫你「${m[2]}」` : m[2]).join(" · ");
      header.querySelector(".hm-id-sub").textContent = [...sub].slice(0, 44).join("");
    }).catch(() => {});
    return refresh();
  };
  return page;
}
