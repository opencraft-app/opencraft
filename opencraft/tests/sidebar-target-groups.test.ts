import assert from "node:assert/strict";
import test from "node:test";
import { groupThreadsByTarget } from "../apps/workbench-web/src/sidebar-target-groups";

test("target grouping separates equal display names and preserves per-target order", () => {
  const threads = [
    { id: "1", hostId: "a", hostLabel: "Hermes" },
    { id: "1", hostId: "b", hostLabel: "Hermes" },
    { id: "2", hostId: "a", hostLabel: "Hermes" },
  ];
  const groups = groupThreadsByTarget(threads);
  assert.deepEqual(groups.map(group => group.id), ["a", "b"]);
  assert.deepEqual(groups[0].threads.map(thread => thread.id), ["1", "2"]);
  assert.equal(groups[1].threads[0], threads[1]);
});

test("empty catalog and missing labels are handled without inventing targets", () => {
  assert.deepEqual(groupThreadsByTarget([]), []);
  assert.equal(groupThreadsByTarget([{ hostId: "a", hostLabel: "" }])[0].label, "a");
});
