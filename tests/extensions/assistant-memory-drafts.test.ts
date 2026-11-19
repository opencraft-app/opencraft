import test from "node:test";
import assert from "node:assert/strict";
import { memoryDraft, clearMemoryDrafts } from "../../plugins/im/src/assistant-memory-drafts";
import type { ChannelRpc } from "../../plugins/im/src/channel-client";
import type { PersonalAssistantBinding } from "@opencraft/appserver-protocol";
test("private drafts are session-only, owner/binding/transport scoped, bounded and expiring", () => {
  let disconnected = () => {};
  const rpc = {
      onDisconnect: (f: () => void) => {
        disconnected = f;
        return () => {};
      },
    } as ChannelRpc,
    other = { onDisconnect: () => () => {} } as unknown as ChannelRpc,
    b: PersonalAssistantBinding = {
      serverId: "s",
      botId: "bot",
      assignmentId: "a",
      owner: { kind: "human", id: "alice" },
    },
    draft = {
      base: {
        key: "k",
        value: "before",
        revision: 1,
        kind: "profile" as const,
        updatedAt: 1,
        origin: "automatic",
        evidenceIds: [],
        document: null,
      },
      value: "unsaved",
      pending: { signature: "same", requestId: "stable-retry-01" },
    };
  memoryDraft(rpc, b, draft);
  draft.value = "outside mutation";
  assert.equal(memoryDraft(rpc, b)?.value, "unsaved");
  assert.equal(memoryDraft(other, b), null);
  assert.equal(memoryDraft(rpc, { ...b, owner: { kind: "human", id: "bob" } }), null);
  assert.equal(memoryDraft(rpc, { ...b, assignmentId: "new" }), null);
  assert.equal(memoryDraft(rpc, b)?.pending?.requestId, "stable-retry-01");
  disconnected();
  assert.equal(memoryDraft(rpc, b), null);
  memoryDraft(rpc, b, draft);
  memoryDraft(rpc, b, null);
  assert.equal(memoryDraft(rpc, b), null);
  memoryDraft(rpc, b, draft);
  clearMemoryDrafts(rpc);
  assert.equal(memoryDraft(rpc, b), null);
  for (let i = 0; i < 10; i++) memoryDraft(rpc, { ...b, botId: "bot" + i }, draft);
  assert.equal(memoryDraft(rpc, { ...b, botId: "bot0" }), null);
  assert.ok(memoryDraft(rpc, { ...b, botId: "bot9" }));
  const now = Date.now;
  try {
    const expired = now() + 600001;
    Date.now = () => expired;
    assert.equal(memoryDraft(rpc, { ...b, botId: "bot9" }), null);
  } finally {
    Date.now = now;
    clearMemoryDrafts(rpc);
  }
});
