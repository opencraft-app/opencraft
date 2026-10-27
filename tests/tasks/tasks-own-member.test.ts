import assert from "node:assert/strict";
import test from "node:test";
import { ownMemberId } from "../../plugins/tasks/src/own-member";

const members = [{ id: "alice", name: "Bob", revision: 1 }, { id: "bob", name: "Alice", revision: 1 }];
const user = (handle: string) => ({ providerId: "test", id: handle, handle });
test("personal tasks match the explicit account handle, never a display name or guessed alias", () => {
  assert.equal(ownMemberId(members, user("alice"), null), "alice");
  assert.equal(ownMemberId(members, user("Alice"), null), null);
  assert.equal(ownMemberId(members, user("missing"), null), null);
  assert.equal(ownMemberId(members, null, null), null);
});
test("a manual viewing selection is explicit, and a removed member cannot remain selected", () => {
  assert.equal(ownMemberId(members, null, "bob"), "bob");
  assert.equal(ownMemberId(members, user("unknown"), "bob"), "bob");
  assert.equal(ownMemberId(members, null, "removed"), null);
  assert.equal(ownMemberId(members, user("alice"), "removed"), "alice");
});

test("an avatar profile identity does not identify the current task owner", () => {
  const directory = [{ id: "local-member", name: "Alice", revision: 1, identity: { kind: "employee", id: "alice" } }];
  assert.equal(ownMemberId(directory, user("alice"), null), null);
  assert.equal(ownMemberId(directory, null, "local-member"), "local-member");
});
