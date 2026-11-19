import assert from "node:assert/strict";
import test from "node:test";
import { uiPreferenceDefinitions, isConversationTagId, type ConversationTagId } from "@opencraft/ui-preferences";
import { collectExistingConversationTags } from "../../apps/workbench-web/src/components/conversation-tags";
import { SidebarThreadMenuStore } from "../../apps/workbench-web/src/components/sidebar-thread-menu-state";

test("sidebar.conversationTags validates color and minimalist animal tag IDs", () => {
  const def = uiPreferenceDefinitions["sidebar.conversationTags"];
  assert.deepEqual(def.defaultValue, {});
  assert.equal(isConversationTagId("color:blue"), true);
  assert.equal(isConversationTagId("animal:cat"), true);
  assert.equal(isConversationTagId("animal:dragon"), false);
  assert.notEqual(def.parse({ "[\"local\",\"h1\",\"t1\"]": "color:orange", "[\"local\",\"h1\",\"t2\"]": "animal:whale" }), null);
  assert.equal(def.parse({ "[\"local\",\"h1\",\"t1\"]": "invalid" }), null);
  assert.equal(def.parse(["color:red"]), null);
});

test("collectExistingConversationTags preserves recency order and counts unique tags", () => {
  const threads = [{ id: "t1" }, { id: "t2" }, { id: "t3" }, { id: "t4" }];
  const tags: Record<string, ConversationTagId> = {
    t1: "animal:cat",
    t2: "color:blue",
    t3: "animal:cat",
    t4: "animal:fox",
  };
  assert.deepEqual(
    collectExistingConversationTags(threads, tags, item => item.id),
    [
      { id: "animal:cat", count: 2 },
      { id: "color:blue", count: 1 },
      { id: "animal:fox", count: 1 },
    ],
  );
});

test("SidebarThreadMenuStore keeps recent-tags menu mutually exclusive with row and filter menus", () => {
  const store = new SidebarThreadMenuStore();
  store.setRecentTagsOpen(true);
  assert.equal(store.getRecentTagsOpen(), true);
  store.setFiltersOpen(true);
  assert.equal(store.getRecentTagsOpen(), false);
  assert.equal(store.getFiltersOpen(), true);
  store.setRecentTagsOpen(true);
  assert.equal(store.getFiltersOpen(), false);
  store.update({ hostId: "local", threadId: "t1", rowId: "r1", kind: "dropdown" }, true);
  assert.equal(store.getRecentTagsOpen(), false);
});
