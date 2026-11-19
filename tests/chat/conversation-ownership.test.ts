import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationKey,
  belongsInOrdinaryConversationCatalog,
  independentConversationOwnership,
  type ConversationOwnership,
} from "@opencraft/chat-core";
import { ordinaryConversationCatalog } from "../../apps/workbench-web/src/runtime/ordinary-conversation-catalog";

test("fork provenance, engine identifiers and titles do not imply side-chat ownership", () => {
  const owner = createConversationKey("host", "codex-main");
  const rows = [
    { connectionHostId: "host", id: "codex-main", title: "Same title" },
    { connectionHostId: "host", id: "codex-fork", title: "Same title", forkedFromId: "codex-main" },
    { connectionHostId: "host", id: "pi-child", title: "Same title", forkedFromId: "codex-main" },
    { connectionHostId: "other-host", id: "pi-child", title: "Same title" },
  ];
  const ownershipOf = (key: ReturnType<typeof createConversationKey>): ConversationOwnership =>
    key.hostId === "host" && key.threadId === "pi-child"
      ? { kind: "side-chat", owner }
      : independentConversationOwnership;
  assert.deepEqual(ordinaryConversationCatalog(rows, ownershipOf), [rows[0], rows[1], rows[3]]);
  assert.equal(rows.length, 4, "Native resources and route lookup are not mutated");
  assert.equal(belongsInOrdinaryConversationCatalog(independentConversationOwnership), true);
  assert.equal(belongsInOrdinaryConversationCatalog({ kind: "side-chat", owner }), false);
});
