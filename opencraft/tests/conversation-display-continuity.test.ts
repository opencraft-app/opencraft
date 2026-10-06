import assert from "node:assert/strict";
import test from "node:test";

import { asTurnId, createConversationKey, groupTimelineFramesByTurn, type TimelineSnapshot } from "@opencraft/chat-core";
import {
  createConversationDisplayContinuity,
  type ConversationDisplayStorage,
} from "@opencraft/workbench-runtime";

function storage(): ConversationDisplayStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    load: async key => data.get(key) ?? null,
    save: async (key, value) => { data.set(key, value); },
    remove: async key => { data.delete(key); },
  };
}

function timeline(authoritative: boolean): TimelineSnapshot {
  const common = { status: "complete" as const, durationMs: null, hookStats: null, anchors: [] };
  return {
    key: createConversationKey("host", "thread"), revision: 4, phase: "live", authoritative,
    anchorFrameIds: new Map(),
    frames: [
      {
        ...common, id: "user-frame", turnId: asTurnId("turn"), type: "user",
        blocks: [{
          type: "user-message", id: "user", sourceItemIds: [], message: "Hello",
          content: [], attachments: [], messageKind: "user", clientId: null,
          steeringStatus: null, sentAtMs: null, deliveryStatus: "sent",
          referencesPriorConversation: false, reviewMode: false, pullRequestFixMode: false,
          autoResolveSync: false, goal: false, hookFeedback: false,
          commentCount: 0, hasExternalAttachments: false,
        }],
      },
      {
        ...common, id: "assistant-frame", turnId: asTurnId("turn"), type: "assistant",
        blocks: [{ type: "text", id: "answer", sourceItemIds: [], text: "Hi", streaming: false, phase: "final_answer" }],
      },
    ],
  };
}

test("only authoritative completed text becomes a paint-only cached timeline", async () => {
  const local = storage();
  const cache = createConversationDisplayContinuity({ namespace: "account.bot", storage: local, now: () => 1_000 });
  await cache.observe(timeline(false));
  assert.equal(local.data.size, 0);
  await cache.observe(timeline(true));
  const result = await cache.load("host", "thread");
  assert.equal(result?.phase, "painted");
  assert.equal(result?.authoritative, false);
  assert.equal(result?.frames.length, 2);
  assert.equal(groupTimelineFramesByTurn(result!).length, 1);
  assert.deepEqual(result?.frames.flatMap(frame => frame.blocks.map(block => block.type)), ["user-message", "text"]);
  assert.equal(await cache.load("host", "another-thread"), null);
});

test("expired display data is not reused", async () => {
  const local = storage();
  const old = createConversationDisplayContinuity({ namespace: "account", storage: local, now: () => 1_000 });
  await old.observe(timeline(true));
  const later = createConversationDisplayContinuity({ namespace: "account", storage: local,
    now: () => 1_000 + 8 * 24 * 60 * 60 * 1_000 });
  assert.equal(await later.load("host", "thread"), null);
});
