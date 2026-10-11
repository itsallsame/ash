// The agent's display name: one field of IDENTITY.md, read from the persona member.
const DEFAULT_NAME = "Ash";

/** The display name is one field of the managed identity file, not a status guess. */
export function nameFromIdentity(content) {
  if (typeof content !== "string" || content.length > 65_536) return null;
  const lines = content.split(/\r?\n/);
  const names = lines.filter((line) => /^\s*[-*]\s*(?:名字|Name)\s*[：:]/iu.test(line));
  if (names.length !== 1) return null;
  const match = /^\s*[-*]\s*(?:名字|Name)\s*[：:]\s*(.*?)\s*$/iu.exec(names[0]);
  const name = match?.[1]?.trim().replace(/（初次见面时可以换成你喜欢的名字）$/u, "").trim();
  if (!name || [...name].length > 32 || /[\u0000-\u001f\u007f<>]/u.test(name)) return null;
  return name;
}

/**
 * Every reader of the name on one connection (the conversation's top bar, her home page) hears a change the moment any of them
 * reads it: rename her on her home page and the bar follows without waiting for a reconnect.
 */
const readers = new Set();

export class IdentityName {
  constructor(net, onName) {
    readers.add(this);
    this.net = net;
    this.onName = onName;
    this.listeners = new Set();
    this.epoch = 0;
    this.name = DEFAULT_NAME;
    this.resolved = null;
    this.announce(this.name);
  }

  /** Calls [listener](name) whenever the name shown changes; returns the function that stops it. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  announce(name) {
    this.onName(name);
    for (const listener of this.listeners) listener(name);
  }

  reset() {
    this.epoch++;
    this.resetName();
  }

  /**
   * Reads the name again: when the page connects, and after the owner saved a new IDENTITY.md. On the connection the name
   * was read on, the name shown stays until the new one is read; on any other connection it falls back at once.
   */
  async refresh() {
    const epoch = ++this.epoch;
    const binding = this.net.binding();
    if (!this.resolved || !this.net.same(this.resolved)) this.resetName();
    if (!this.net.same(binding)) return;
    const current = () => epoch === this.epoch && this.net.same(binding);
    try {
      const data = await this.net.data("service:persona", "get", { file: "IDENTITY.md" });
      if (!current()) return;
      const file = Array.isArray(data.files) ? data.files.find((item) => item?.file === "IDENTITY.md") : undefined;
      if (typeof file?.content !== "string") { this.resetName(); return; }
      this.name = nameFromIdentity(file.content) || DEFAULT_NAME;
      this.resolved = binding;
      this.announce(this.name);
      for (const other of readers) if (other !== this && other.net === this.net) other.adopt(this.name, binding);
    } catch {
      if (current()) this.resetName();
    }
  }

  /** Another reader on the same connection read the name: take it, as if read here. */
  adopt(name, binding) {
    if (!this.net.same(binding)) return;
    this.epoch++;
    this.name = name;
    this.resolved = binding;
    this.announce(name);
  }

  resetName() {
    this.name = DEFAULT_NAME;
    this.resolved = null;
    this.announce(this.name);
  }
}
