import assert from "node:assert/strict";
import test from "node:test";
import { uiPreferenceDefinitions, isConversationTagId, type ConversationTagId } from "@opencraft/ui-preferences";
import {
  collectExistingConversationTags,
  matchesConversationTagFilters,
  normalizeConversationTags,
  toggleConversationTag,
} from "../../apps/workbench-web/src/components/conversation-tags";
import { SidebarThreadMenuStore } from "../../apps/workbench-web/src/components/sidebar-thread-menu-state";

test("sidebar.conversationTags validates multi-tag arrays and migrates legacy single strings", () => {
  const def = uiPreferenceDefinitions["sidebar.conversationTags"];
  assert.deepEqual(def.defaultValue, {});
  assert.equal(isConversationTagId("color:blue"), true);
  assert.equal(isConversationTagId("animal:cat"), true);
  assert.equal(isConversationTagId("animal:dragon"), false);
  const parsed = def.parse({
    "[\"local\",\"h1\",\"t1\"]": "color:orange",
    "[\"local\",\"h1\",\"t2\"]": ["animal:whale", "color:blue", "animal:whale"],
    "[\"local\",\"h1\",\"t3\"]": [],
  });
  assert.deepEqual(parsed, {
    "[\"local\",\"h1\",\"t1\"]": ["color:orange"],
    "[\"local\",\"h1\",\"t2\"]": ["animal:whale", "color:blue"],
  });
  assert.equal(def.parse({ "[\"local\",\"h1\",\"t1\"]": ["invalid"] }), null);
  assert.equal(def.parse(["color:red"]), null);
});

test("toggleConversationTag and collectExistingConversationTags handle multiple dimensions per conversation", () => {
  let current = toggleConversationTag([], "animal:cat");
  current = toggleConversationTag(current, "color:orange");
  assert.deepEqual(current, ["color:orange", "animal:cat"], "canonical order places color before animal");
  current = toggleConversationTag(current, "color:orange");
  assert.deepEqual(current, ["animal:cat"]);
  assert.deepEqual(normalizeConversationTags("color:green"), ["color:green"]);

  const threads = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
  const tags: Record<string, readonly ConversationTagId[]> = {
    t1: ["color:orange", "animal:cat"],
    t2: ["color:blue"],
    t3: ["animal:cat", "animal:fox"],
  };
  assert.deepEqual(
    collectExistingConversationTags(threads, tags, item => item.id),
    [
      { id: "color:orange", count: 1 },
      { id: "animal:cat", count: 2 },
      { id: "color:blue", count: 1 },
      { id: "animal:fox", count: 1 },
    ],
  );
  assert.equal(matchesConversationTagFilters(["color:orange", "animal:cat"], ["color:orange", "animal:cat"]), true);
  assert.equal(matchesConversationTagFilters(["color:orange"], ["color:orange", "animal:cat"]), false, "must satisfy all selected tags (AND)");
  assert.equal(matchesConversationTagFilters(["animal:cat"], []), true);
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
