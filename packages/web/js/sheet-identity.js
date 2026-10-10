import { ManagedFilesSheet, named } from "./editor.js";
import { WordFailure } from "./link.js";

const STALE_CONNECTION = "连接已经换过，这次的结果没有采用。";
const REASON = "主人在人物页修改";

/**
 * SOUL.md and IDENTITY.md are the persona member's approved files: read with `get`, changed with `propose` (the owner's own
 * change takes effect at once). [binding] is the connection the sheet opened on.
 */
export function personaStore(net, binding) {
  const live = () => {
    if (!net.same(binding)) throw new WordFailure({ code: "offline", message: STALE_CONNECTION });
  };
  return {
    async read(path) {
      live();
      let data;
      try { data = await net.data("service:persona", "get", { file: path }); }
      catch (error) {
        live();
        if (error?.code === "not_found") return null;
        throw error;
      }
      live();
      const file = Array.isArray(data.files) ? data.files.find((item) => item?.file === path) : undefined;
      return file && typeof file.content === "string" ? { content: file.content } : null;
    },
    async write(path, content, clientId) {
      live();
      const refuse = (code, message) => Object.assign(new WordFailure({ code, message }), { userMessage: message });
      if (!net.local) throw refuse("forbidden", "只有在她所在的手机上才能修改。");
      if (!content.trim()) throw refuse("bad_request", "这份内容不能是空的。");
      const result = await net.data("service:persona", "propose", { file: path, content, reason: REASON }, { clientId });
      live();
      if (result.applied === false) throw refuse("failed", "这次改动没有马上生效，什么都没改。");
    },
  };
}

/** Identity files are read and changed only through the persona member. */
export class IdentitySheet extends ManagedFilesSheet {
  constructor(root, options) {
    const name = options?.name || "Ash";
    super(root, options, { files: ["SOUL.md", "IDENTITY.md"],
      intro: `这些决定了${named(name)}是谁、怎样和你相处。改之前想一想；改完她下一句话就会照新的来。`,
      extra: options?.extra });
  }

  async open(path = "SOUL.md") {
    if (path !== "SOUL.md" && path !== "IDENTITY.md") throw new TypeError("unknown identity file");
    return super.open(path);
  }
}
