import { appendMarkdown } from "./markdown.js";
import { bodyOf, listBodies, listDirectory, readBytes } from "./body.js";
import { fileRef } from "./cards.js";

const MAX_READ_BYTES = 20 * 1024 * 1024;
const IMAGES = ["png", "jpg", "jpeg", "gif", "webp"];
const TEXTS = ["md", "markdown", "txt", "json", "csv", "log", "js", "ts", "css", "py", "yaml", "yml", "xml"];

/**
 * Where a link in a message points: a path on a body, resolved against the file the link is in. A path that climbs out of
 * the directory, or anything that is not a plain path (a URL, a script, a fragment), is nothing to open.
 */
export function resolveFileLink(href, base = { workspace: "main", path: "" }) {
  if (typeof href !== "string" || /[\\\x00-\x1f\x7f]/.test(href) || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  let path;
  try { path = decodeURIComponent(href.split("#")[0]); } catch { return null; }
  const absolute = path.startsWith("/");
  if (!absolute) path = `${base.path.includes("/") ? base.path.slice(0, base.path.lastIndexOf("/") + 1) : ""}${path}`;
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (absolute || !parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return fileRef({ workspace: base.workspace, path: `${absolute ? "/" : ""}${parts.join("/")}` });
}

const add = (parent, tag, text, cls) => {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls; parent.append(el); return el;
};
const base64 = (bytes) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  return btoa(binary);
};

/** The file list and the links in the conversation share this one viewer and the same live reads from the bodies. */
export class Files {
  /** [save]: in the app, `({name, mime, b64}) -> {ok, cancelled}` through the system file picker; absent in a browser. */
  constructor(net, { save = null } = {}) {
    this.net = net; this.save = save; this.generation = 0;
    this.root = add(document.body, "dialog", undefined, "files-view");
    this.root.setAttribute("aria-label", "文件");
    this.root.addEventListener("close", () => { this.generation++; this.release(); this.body?.replaceChildren(); });
  }
  release() { if (this.objectUrl) URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
  shell(title) {
    this.release(); this.root.replaceChildren(); this.generation++;
    const bar = add(this.root, "div", undefined, "files-bar");
    const close = add(bar, "button", "关闭", "btn gray"); close.type = "button"; close.onclick = () => this.root.close();
    add(bar, "strong", title);
    this.actions = add(bar, "div", undefined, "files-actions");
    this.note = add(this.root, "div", "", "files-note"); this.note.setAttribute("role", "status");
    this.body = add(this.root, "div", undefined, "files-body");
    if (!this.root.open) this.root.showModal();
    return this.generation;
  }
  async browse(body = null, path = "") {
    const generation = this.shell(path || "文件");
    this.note.textContent = "正在读取…";
    try {
      const bodies = await listBodies(this.net);
      if (generation !== this.generation) return;
      if (!body) body = bodies[0]?.body;
      if (!body) { this.note.textContent = "暂无可浏览的文件"; return; }
      const select = add(this.actions, "select"); select.setAttribute("aria-label", "文件所在的设备");
      for (const item of bodies) { const option = add(select, "option", item.body === "body:main" ? "Ash 的容器" : item.name || item.body); option.value = item.body; }
      select.value = body; select.onchange = () => this.browse(select.value);
      const refresh = add(this.actions, "button", "刷新", "btn gray"); refresh.onclick = () => this.browse(body, path);
      if (path) { const back = add(this.body, "button", "← 上一级", "files-row"); back.onclick = () => this.browse(body, path.split("/").slice(0, -1).join("/")); }
      const listing = await listDirectory(this.net, body, path);
      if (generation !== this.generation) return;
      this.note.textContent = listing.path || path || "/";
      if (!listing.entries.length) add(this.body, "p", "此目录为空", "muted");
      const entries = [...listing.entries].sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
      for (const entry of entries) {
        const child = path ? `${path}/${entry.name}` : entry.name;
        const dir = entry.type === "directory";
        const row = add(this.body, "button", undefined, "files-row"); row.type = "button";
        add(row, "span", `${dir ? "▸ " : ""}${entry.name}`);
        if (!dir && Number.isFinite(entry.size)) add(row, "small", `${Math.ceil(entry.size / 1024)} KB`);
        row.onclick = () => dir ? this.browse(body, child) : this.open({ workspace: body, path: child });
      }
      if (listing.truncated) add(this.body, "p", "只显示了前面一部分", "muted");
    } catch (error) { if (generation === this.generation) this.note.textContent = error.message || "文件无法读取"; }
  }
  async openLink(href, base) {
    const ref = resolveFileLink(href, base);
    if (!ref) { this.shell("打开文件"); this.note.textContent = "这个路径不能打开"; return; }
    await this.open(ref);
  }
  async open(ref) {
    const valid = fileRef(ref);
    const generation = this.shell(ref?.name || ref?.path?.split("/").pop() || "文件");
    if (!valid) { this.note.textContent = "文件路径无效"; return; }
    const body = bodyOf(ref.workspace);
    if (!body) { this.note.textContent = "打不开：不知道这个文件在哪台设备上"; return; }
    this.note.textContent = ref.path;
    const directory = ref.path.split("/").slice(0, -1).join("/");
    const folder = add(this.actions, "button", "所在文件夹", "btn gray"); folder.onclick = () => this.browse(body, directory);
    const download = add(this.actions, "button", "下载", "btn gray");
    const fetchFile = async () => {
      const file = await readBytes(this.net, body, ref.path);
      if (file.data.length > MAX_READ_BYTES) throw new Error("文件超过当前 20 MiB 的限制");
      return file;
    };
    download.onclick = async () => {
      download.disabled = true;
      try {
        const file = await fetchFile();
        const name = ref.path.split("/").pop();
        if (this.save) {
          const result = await this.save({ name, mime: file.mime, b64: base64(file.data) });
          if (!result.ok && !result.cancelled) throw new Error("保存失败");
          if (generation === this.generation) this.note.textContent = result.cancelled ? "已取消保存" : "文件已保存";
        } else {
          const url = URL.createObjectURL(new Blob([file.data], { type: file.mime || "application/octet-stream" })), link = document.createElement("a");
          link.href = url; link.download = name; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
      } catch (error) { if (generation === this.generation) this.note.textContent = error.message || "下载失败"; }
      finally { download.disabled = false; }
    };
    try {
      const ext = ref.path.split(".").pop().toLowerCase();
      if (!["html", "htm", ...TEXTS, ...IMAGES].includes(ext)) { add(this.body, "p", "这种格式暂未接入内置阅读器，请下载后打开。", "muted"); return; }
      const file = await fetchFile();
      if (generation !== this.generation) return;
      if (IMAGES.includes(ext)) {
        this.objectUrl = URL.createObjectURL(new Blob([file.data], { type: file.mime || `image/${ext}` }));
        const img = add(this.body, "img", undefined, "files-image"); img.alt = ref.path; img.src = this.objectUrl;
        return;
      }
      const source = new TextDecoder().decode(file.data);
      if (["html", "htm"].includes(ext)) {
        this.note.textContent = `${ref.path} · HTML 阅读模式（不运行脚本，不加载其中的图片和样式表）`;
        // The page is shown from its text in a frame that may run nothing and reach nothing.
        const frame = add(this.body, "iframe", undefined, "files-html");
        frame.title = ref.path.split("/").pop(); frame.setAttribute("sandbox", ""); frame.referrerPolicy = "no-referrer";
        frame.srcdoc = source;
      } else if (["md", "markdown"].includes(ext)) appendMarkdown(this.body, source, { onFileLink: (href) => this.openLink(href, { workspace: ref.workspace, path: ref.path }) });
      else add(this.body, "pre", source, "files-text");
    } catch (error) { if (generation === this.generation) this.note.textContent = error.message || "文件无法打开"; }
  }
}
