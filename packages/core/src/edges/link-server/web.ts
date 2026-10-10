/**
 * The web client as static files (HUB-MODULES §2.1): the page, its manifest and icon, and the faces of the agent. The page
 * talks to the hub only over `/link`; nothing here is data. Mount it at `/` with `relay: true`, so a browser can also get
 * it through the relay.
 */
import { AVATARS, ICON_SVG, UI_HTML, WEB_MANIFEST } from "../../ui";
import type { HttpHandler } from "./index";

const FACE = /^\/avatars\/([a-z]+)\.webp$/;

export function staticWeb(): HttpHandler {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
    const path = new URL(req.url ?? "/", "http://web.invalid").pathname;
    const face = FACE.exec(path);
    let type: string, body: string | Buffer;
    if (path === "/") { type = "text/html; charset=utf-8"; body = UI_HTML; }
    else if (path === "/manifest.webmanifest") { type = "application/manifest+json"; body = WEB_MANIFEST; }
    else if (path === "/icon.svg") { type = "image/svg+xml"; body = ICON_SVG; }
    else if (face && Object.hasOwn(AVATARS, face[1]!)) { type = "image/webp"; body = Buffer.from(AVATARS[face[1]!]!, "base64"); }
    else { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": type, "content-length": Buffer.byteLength(body) }).end(req.method === "HEAD" ? undefined : body);
  };
}
