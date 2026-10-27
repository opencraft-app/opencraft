import assert from "node:assert/strict";
import test from "node:test";
import { conversationSearchShortcut } from "../../apps/workbench-web/src/components/conversation-search-shortcut";
const key = { key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false };
test("conversation search follows the platform primary modifier and leaves other commands / IME alone", () => {
  assert.equal(conversationSearchShortcut({ ...key, metaKey: true }, "MacIntel"), true);
  for (const platform of ["Win32", "Linux x86_64"]) {
    assert.equal(conversationSearchShortcut({ ...key, ctrlKey: true, key: "K" }, platform), true);
    assert.equal(conversationSearchShortcut({ ...key, metaKey: true }, platform), false);
  }
  assert.equal(conversationSearchShortcut({ ...key, ctrlKey: true }, "MacIntel"), false);
  for (const extra of [{ altKey: true }, { shiftKey: true }, { isComposing: true }, { key: "b" }, { ctrlKey: true }]) {
    assert.equal(conversationSearchShortcut({ ...key, metaKey: true, ...extra }, "MacIntel"), false);
  }
});
