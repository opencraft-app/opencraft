import test from "node:test";
import assert from "node:assert/strict";
import { createPresentation } from "../../scripts/remote-browser/presentation.cjs";
import { readPresentation } from "@opencraft/browser-core/presentation";
const image = (text = "frame") => ({
  isEmpty: () => false,
  getSize: () => ({ width: 800, height: 1200 }),
  crop() {
    return this;
  },
  resize() {
    return this;
  },
  toJPEG: () => Buffer.from(text),
  toPNG: () => Buffer.from(text),
});
function fixture(overrides = {}) {
  let time = 0,
    document = "first",
    captures = 0;
  const events = [];
  const api = createPresentation({
    capture: async () => {
      captures++;
      return image();
    },
    fetchIcon: async () => new Response(Buffer.from("icon")),
    decode: () => image("icon"),
    document: () => document,
    notify: (e) => events.push(e),
    now: () => time,
    ...overrides,
  });
  return {
    api,
    events,
    get captures() {
      return captures;
    },
    tick() {
      time += 5001;
    },
    navigate() {
      document = "next";
      api.reset();
    },
  };
}
test("cached reads never capture; frame updates are bounded and notifications contain no image bytes", async () => {
  const f = fixture();
  assert.equal(f.api.read().thumbnail, null);
  assert.equal(f.captures, 0);
  await f.api.thumbnail();
  const first = f.api.read();
  assert.ok(readPresentation(first)?.thumbnail);
  for (let i = 0; i < 10; i++) {
    f.api.read();
    await f.api.thumbnail();
  }
  assert.equal(f.captures, 1);
  await f.api.favicon(["https://example.test/favicon.ico"]);
  assert.ok(f.api.read().favicon);
  assert.ok(f.events.every((e) => !("thumbnail" in e) && !("favicon" in e)));
  f.navigate();
  assert.equal(f.api.read().thumbnail, null);
  assert.equal(f.api.read().favicon, null);
  f.api.close();
  f.tick();
  await f.api.thumbnail();
  assert.equal(f.captures, 1);
});
test("navigation rejects an old thumbnail finishing after document replacement", async () => {
  let finish;
  let calls = 0;
  const f = fixture({
    capture: () => (++calls === 1 ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(image("new"))),
  });
  const pending = f.api.thumbnail();
  f.navigate();
  finish(image("old"));
  await pending;
  await new Promise((r) => setImmediate(r));
  assert.equal(f.api.read().document, "next");
  assert.equal(f.api.read().thumbnail, "data:image/jpeg;base64," + Buffer.from("new").toString("base64"));
});
test("icon reads reject oversized bodies and late results from a replaced document", async () => {
  let finish;
  const f = fixture({ fetchIcon: () => new Promise((resolve) => (finish = resolve)) });
  const pending = f.api.favicon(["https://example.test/favicon.ico"]);
  f.navigate();
  finish(new Response(Buffer.from("old")));
  await pending;
  assert.equal(f.api.read().favicon, null);
  const g = fixture({ fetchIcon: async () => new Response(Buffer.alloc(262145)) });
  await g.api.favicon(["https://example.test/icon"]);
  assert.equal(g.api.read().favicon, null);
  assert.equal(
    readPresentation({
      version: 1,
      document: "x",
      revision: "r",
      thumbnail: "https://example.test/private.png",
      favicon: "data:image/svg+xml;base64,AAAA",
    }).thumbnail,
    null,
  );
});
test("navigation and replacement reject an asynchronous icon decode", async () => {
  let finish;
  const f = fixture({ decode: () => new Promise((resolve) => (finish = resolve)) });
  const pending = f.api.favicon(["https://example.test/icon.ico"]);
  await new Promise((r) => setImmediate(r));
  f.navigate();
  finish(image("old"));
  await pending;
  assert.equal(f.api.read().favicon, null);
});
