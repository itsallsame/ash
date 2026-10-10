import { BODY_MAIN, readText, writeText } from "./body.js";
import { ManagedFilesSheet, named } from "./editor.js";
import { WordFailure } from "./link.js";

const STALE_CONNECTION = "连接已经换过，这次的结果没有采用。";

/**
 * USER.md and MEMORY.md are plain files in the main body's work directory: read and written like any file. [binding] is the
 * connection the sheet opened on; once the page has another one, nothing read or written is adopted.
 */
export function workspaceStore(net, binding) {
  const live = () => {
    if (!net.same(binding)) throw new WordFailure({ code: "offline", message: STALE_CONNECTION });
  };
  return {
    async read(path) {
      live();
      let file;
      try { file = await readText(net, BODY_MAIN, path); }
      catch (error) {
        live();
        if (error?.code === "not_found") return null;
        throw error;
      }
      live();
      return { content: file.text, truncated: file.truncated };
    },
    async write(path, content, clientId) {
      live();
      await writeText(net, BODY_MAIN, path, content, { clientId });
      live();
    },
  };
}

/** The memory sheet: what she knows about the owner, and the notes she keeps for herself. */
export class MemorySheet extends ManagedFilesSheet {
  constructor(root, options) {
    const name = options?.name || "Ash";
    super(root, options, { files: ["USER.md", "MEMORY.md"],
      intro: `${named(name, false)}记得的关于你的事，以及她自己记下的笔记。她会自己整理；记错了，你可以直接改。` });
  }

  async open(path = "USER.md") {
    if (path !== "USER.md" && path !== "MEMORY.md") throw new TypeError("unknown memory file");
    return super.open(path);
  }
}
