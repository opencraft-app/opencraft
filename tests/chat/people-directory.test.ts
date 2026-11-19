import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelSummary } from "../../packages/appserver-protocol/src/channels";
import { inboxGroups, recentGroups } from "../../plugins/im/src/people-directory";
const group = (id: string, at?: number, kind = "group") =>
  ({
    id,
    title: id,
    kind,
    latestMessage: at === undefined ? null : { id: "m" + id, sequence: "1", authorId: "human", text: "hello", at },
  }) as ChannelSummary;
test("recent groups are limited to three populated groups, sorted without mutating input", () => {
  const input = [
    group("old", 1),
    group("empty"),
    group("dm", 100, "direct"),
    group("third", 2),
    group("latest", 4),
    group("second", 3),
  ];
  const before = [...input];
  assert.deepEqual(
    recentGroups(input).map((g) => g.id),
    ["latest", "second", "third"],
  );
  assert.deepEqual(input, before);
});
test("equal timestamps are stable, unavailable and invalid projections are excluded", () => {
  assert.deepEqual(
    recentGroups([group("b", 4), group("a", 4), group("bad", NaN), group("none")]).map((g) => g.id),
    ["a", "b"],
  );
  assert.deepEqual(recentGroups([]), []);
});
test("inbox stream keeps every populated group newest first and excludes the pinned channel", () => {
  const input = [
    group("a", 1),
    group("b", 5),
    group("c", 3),
    group("d", 4),
    group("e", 2),
    group("empty"),
    group("dm", 9, "direct"),
  ];
  assert.deepEqual(
    inboxGroups(input).map((g) => g.id),
    ["b", "d", "c", "e", "a"],
  );
  assert.deepEqual(
    inboxGroups(input, "d").map((g) => g.id),
    ["b", "c", "e", "a"],
  );
});
