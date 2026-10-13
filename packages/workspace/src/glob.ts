/**
 * Glob patterns over "/"-separated relative paths: `*` and `?` (not across "/"), `**` (any number of folders),
 * `[abc]` / `[!abc]`, and `{a,b}`. Case-sensitive.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) { out += "\\["; continue; }
      let set = pattern.slice(i + 1, end);
      if (set.startsWith("!")) set = "^" + set.slice(1);
      out += "[" + set.replace(/\\/g, "\\\\") + "]";
      i = end;
    } else if (c === "{") { braces++; out += "(?:"; }
    else if (c === "}" && braces > 0) { braces--; out += ")"; }
    else if (c === "," && braces > 0) out += "|";
    else if (c === "\\" && i + 1 < pattern.length) out += "\\" + pattern[++i];
    else out += /[.+^$()|\\\]]/.test(c) ? "\\" + c : c;
  }
  while (braces-- > 0) out += ")";
  return new RegExp("^" + out + "$");
}
