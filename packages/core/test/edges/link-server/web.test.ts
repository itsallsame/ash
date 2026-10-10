import assert from "node:assert/strict";
import test from "node:test";
import { AVATARS, UI_HTML } from "../../../src/ui";
import { startHub } from "./harness";

test("the web client: the page, its manifest, icon and faces are served at /, and nothing else is, to GET only", async (t) => {
  const { staticWeb } = await import("../../../src/edges/link-server/web");
  const hub = await startHub(); t.after(() => hub.stop());
  hub.server.mount("/", staticWeb(), { relay: true });
  const get = (path: string, method = "GET") => fetch(`http://127.0.0.1:${hub.port}${path}`, { method });

  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /^text\/html/);
  assert.equal(await page.text(), UI_HTML);
  assert.equal((await get("/manifest.webmanifest")).status, 200);
  assert.equal((await get("/icon.svg")).headers.get("content-type"), "image/svg+xml");
  const face = await get("/avatars/default.webp");
  assert.equal(face.headers.get("content-type"), "image/webp");
  assert.equal(Buffer.from(await face.arrayBuffer()).toString("base64"), AVATARS.default);
  assert.equal((await get("/avatars/nobody.webp")).status, 404);
  assert.equal((await get("/avatars/__proto__.webp")).status, 404);
  assert.equal((await get("/etc/passwd")).status, 404);
  assert.equal((await get("/", "POST")).status, 405);
  assert.equal((await get("/", "HEAD")).status, 200);
});
