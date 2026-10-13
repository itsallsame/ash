// Her files as the home pages read and write them: USER.md and MEMORY.md are plain files in the main body's work directory, SOUL.md and
// IDENTITY.md belong to the persona member. A store is bound to the connection the page opened on: once the page has another one,
// nothing read or written is adopted.
import { BODY_MAIN, readText, writeText } from "./body.js";
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

const REASON = "主人在她的主页修改";

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
      if (!content.trim()) throw refuse("bad_request", "这份内容不能是空的。");
      const result = await net.data("service:persona", "propose", { file: path, content, reason: REASON }, { clientId });
      live();
      if (result.applied === false) throw refuse("failed", "这次改动没有马上生效，什么都没改。");
    },
  };
}
