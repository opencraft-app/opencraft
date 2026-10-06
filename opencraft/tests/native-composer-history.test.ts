import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerDocument } from "@opencraft/composer-core";
const historyModule = await import("../apps/workbench-expo/src/runtime/native-composer-history.ts");
const { NativeComposerHistory } = historyModule.default ?? historyModule;

const document = (text: string): ComposerDocument => ({
  version: 1,
  blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
});
const caret = (at: number) => ({ start: at, end: at });

test("native history restores rich documents and caret within the initiating Draft", () => {
  const history = new NativeComposerHistory();
  const initial = document("hello");
  const bold: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [
    { type: "text", text: "hello", marks: ["strong"] },
  ] }] };
  history.record("draft-a", initial, bold, caret(0), caret(5));
  assert.equal(history.canUndo("draft-b", bold), false);
  assert.deepEqual(history.undo("draft-a", bold), { document: initial, selection: caret(0) });
  assert.equal(history.canRedo("draft-a", initial), true);
  assert.deepEqual(history.redo("draft-a", initial), { document: bold, selection: caret(5) });
});

test("native history discards redo after a new edit and refuses unrelated document state", () => {
  const history = new NativeComposerHistory();
  const first = document("a");
  const second = document("ab");
  const third = document("abc");
  const replacement = document("a!");
  history.record("draft", first, second, caret(1), caret(2));
  history.record("draft", second, third, caret(2), caret(3));
  assert.equal(history.undo("draft", third)?.document, second);
  history.record("draft", second, replacement, caret(2), caret(2));
  assert.equal(history.canRedo("draft", replacement), false);
  assert.equal(history.undo("draft", replacement)?.document, second);
  assert.equal(history.undo("draft", second)?.document, first);
  assert.equal(history.redo("draft", document("unrelated")), null);
  const external = document("external");
  history.record("draft", external, replacement, caret(0), caret(2));
  assert.equal(history.undo("draft", replacement)?.document, external);
  assert.equal(history.canUndo("draft", first), false);
});
