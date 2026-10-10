// A body's files, as the page reads and writes them: the standard `workspace.*` actions of SPEC-09, called on the body
// like any other word (`body:main/workspace.read`). The owner and an agent use the same words.
import { unwrap, WordFailure } from "./link.js";

export const BODY_MAIN = "body:main";
const BODY_ID = /^body:(main|[A-Za-z0-9_-]{22})$/;

/**
 * The body a file card or attachment means. Cards name it as `workspace`: `main`, the id of a computer body, or the full
 * `body:` id; anything else means the main body.
 */
export function bodyOf(workspace) {
  if (typeof workspace !== "string") return BODY_MAIN;
  if (BODY_ID.test(workspace)) return workspace;
  return BODY_ID.test(`body:${workspace}`) ? `body:${workspace}` : BODY_MAIN;
}

const failed = (message) => new WordFailure({ code: "failed", message });

/** The text of a file (all of it, up to [maxLines] lines). `truncated` says the file went on. */
export async function readText(net, body, path, { maxLines = 100_000 } = {}) {
  const reply = await net.call(body, "workspace.read", { path, limit: maxLines });
  if (!reply.ok) throw new WordFailure(reply.error);
  const data = reply.result?.data ?? {};
  if (typeof data.text === "string") return { text: data.text, truncated: data.truncated === true };
  // A binary or large file comes back as a stream reference in the content, not as text.
  throw failed("这不是一个文本文件，或者太大了");
}

/** The bytes and type of a file: text as it is, an image from its part, a large or binary file from its stream. */
export async function readBytes(net, body, path) {
  const reply = await net.call(body, "workspace.read", { path, limit: 100_000 });
  if (!reply.ok) throw new WordFailure(reply.error);
  const content = reply.result?.content ?? [];
  const resource = content.find((part) => part.type === "resource");
  if (resource) { const stream = await net.stream(resource.stream); return { data: stream.data, mime: stream.mime || resource.mime }; }
  const image = content.find((part) => part.type === "image");
  if (image) return { data: Uint8Array.from(atob(image.b64), (char) => char.charCodeAt(0)), mime: image.mime };
  const text = reply.result?.data?.text;
  if (typeof text === "string") return { data: new TextEncoder().encode(text), mime: "text/plain" };
  throw failed("文件无法读取");
}

/** The entries of a directory: `{name, type, size}`. */
export async function listDirectory(net, body, path = "") {
  const data = unwrap(await net.call(body, "workspace.ls", path ? { path } : {}));
  return { path: data.path ?? path, entries: Array.isArray(data.entries) ? data.entries : [], truncated: data.truncated === true };
}

export async function writeText(net, body, path, content, options) {
  return unwrap(await net.call(body, "workspace.write", { path, content }, options));
}

/** The bodies the hub has: `[{body, name, ownership, online}]`, the main one first. */
export async function listBodies(net) {
  const { bodies } = unwrap(await net.call("service:bodies", "list"));
  return Array.isArray(bodies) ? [...bodies].sort((a, b) => (a.body === BODY_MAIN ? -1 : b.body === BODY_MAIN ? 1 : 0)) : [];
}
