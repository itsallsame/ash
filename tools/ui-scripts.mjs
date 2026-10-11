import { decodeHTMLAttribute } from "entities";

/** Packaged pages may execute external same-origin scripts only, including event/link attributes. */
export function assertNoInlineScripts(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const [, tag, attributes = ""] of source.matchAll(/<([a-z][\w:-]*)(\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>/gi)) {
    let src;
    for (const [, name, raw = ""] of attributes.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)) {
      const key = name.toLowerCase();
      const value = decodeHTMLAttribute(raw.replace(/^(["'])([\s\S]*)\1$/, "$2"));
      if (/^on[a-z]/.test(key)) throw new Error("Packaged UI has an inline event handler");
      if (["href", "src", "action", "formaction", "xlink:href"].includes(key) && /^javascript:/i.test(value.replace(/[\u0000-\u0020]/g, "")))
        throw new Error("Packaged UI has a JavaScript URL");
      if (key === "src") src = value;
    }
    if (tag.toLowerCase() === "script" && !src) throw new Error("Packaged UI has an inline script");
  }
  for (const [, body] of source.matchAll(/<script\b(?:[^"'>]|"[^"]*"|'[^']*')*>\s*([\s\S]*?)<\/script\s*>/gi))
    if (body.trim()) throw new Error("Packaged UI has inline script contents");
}
