import assert from "node:assert/strict";
import test from "node:test";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { createAnnotation } from "@opencraft/browser-annotation";
import type { BrowserAnnotationAnchor } from "@opencraft/browser-core";
import { createComposerAnnotationSink } from "../../apps/workbench-web/src/browser-annotation/composer-sink-runtime";

const anchor: BrowserAnnotationAnchor = {
  kind: "element", bindingKey: "document:button", url: "https://example.test/", title: "Example",
  revision: 1, ref: "e1", selector: "#button", elementPath: "button", tag: "button", role: "button",
  name: "Save", text: "Save", nearbyText: null, childCount: 0, sensitive: false,
  rect: { x: 10, y: 20, width: 80, height: 30 }, isFixed: false, source: null, frame: "main",
};
const target = (id: string) => ({ type: "existing-thread" as const, key: createConversationKey("local", id) });
function fixture(t: { after(fn: () => void): void }) {
  let id = 0;
  const controller = createComposerController(target("a"), { now: () => 1, createId: () => String(++id) });
  t.after(() => controller.dispose());
  const sink = createComposerAnnotationSink(controller);
  const original = createAnnotation({ id: "annotation-a", tabId: "tab", anchor, comment: "Original", existing: [] });
  assert.equal(sink.prepareAdd()(original), true);
  return { controller, sink, original };
}

test("editing replaces one annotation atomically; cancel and duplicate commits leave original intact", t => {
  const { controller, sink, original } = fixture(t);
  const before = controller.getSnapshot().draft.context;
  assert.equal(sink.prepareEdit!(original.id)(null), false);
  assert.equal(controller.getSnapshot().draft.context, before);
  let changes = 0;
  const release = controller.subscribe(() => changes++);
  const commit = sink.prepareEdit!(original.id);
  assert.equal(commit({ ...original, comment: "Edited" }), true);
  assert.equal(changes, 1);
  assert.equal(sink.list().length, 1);
  assert.equal(sink.list()[0]?.comment, "Edited");
  assert.equal(commit(original), false);
  release();
});

test("stale editors cannot overwrite a newer edit or restore a deleted annotation", t => {
  const { sink, original } = fixture(t);
  const stale = sink.prepareEdit!(original.id), fresh = sink.prepareEdit!(original.id);
  assert.equal(fresh({ ...original, comment: "Newer" }), true);
  assert.equal(stale({ ...original, comment: "Older" }), false);
  assert.equal(sink.list()[0]?.comment, "Newer");
  const deleted = sink.prepareEdit!(original.id);
  sink.remove(original.id);
  assert.equal(deleted(original), false);
  assert.equal(sink.prepareEdit!("missing")({ ...original, id: "missing" }), false);
});

test("edit transactions are fenced across draft switches, including returning to the original draft", t => {
  const { controller, sink, original } = fixture(t);
  const commit = sink.prepareEdit!(original.id);
  controller.dispatch({ type: "switch-target", target: target("b") });
  controller.dispatch({ type: "switch-target", target: target("a") });
  assert.equal(commit({ ...original, comment: "Late" }), false);
});

test("full annotation tray can edit in place without allocating a new number", t => {
  const { sink, original } = fixture(t);
  for (let i = 2; i <= 8; i++) assert.equal(sink.prepareAdd()({ ...original, id: `a${i}`, number: i }), true);
  assert.equal(sink.prepareAdd()({ ...original, id: "overflow", number: 9 }), false);
  assert.equal(sink.prepareEdit!(original.id)({ ...original, comment: "Updated at capacity" }), true);
  assert.equal(sink.list().length, 8);
});

test("aggregate persistence budget refuses addition without mutating the existing draft", t => {
  const { controller, sink, original } = fixture(t);
  controller.dispatch({ type: "add-context", reference: { id: "large", kind: "file", title: "Large", metadata: { content: "x".repeat(4 * 1024 * 1024) } } });
  const before = controller.getSnapshot().draft.context;
  assert.equal(sink.prepareAdd()({ ...original, id: "another", number: 2 }), false);
  assert.equal(controller.getSnapshot().draft.context, before);
});

test("edit can retry a correctable validation failure without losing optimistic fence", t => {
  const { sink, original } = fixture(t);
  const commit = sink.prepareEdit!(original.id);
  assert.equal(commit({ ...original, comment: "x".repeat(100000) }), false);
  assert.equal(sink.list()[0]?.comment, "Original");
  assert.equal(commit({ ...original, comment: "Corrected" }), true);
});
