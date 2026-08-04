import assert from "node:assert/strict";
import test from "node:test";

import {mergeMessages, type Message} from "./model.js";

function message(overrides: Partial<Message>): Message {
  return {
    content: {kind: "text", text: "hello"},
    conversationId: "GROUPtopic-1",
    createdAt: "2026-07-30T17:00:00.000Z",
    delivery: {state: "sent"},
    direction: "outgoing",
    id: "remote-1",
    kind: "text",
    mentions: [],
    rawType: "TIMTextElem",
    reactions: [],
    read: {state: "unknown"},
    senderId: "human-1",
    senderName: "Skip",
    text: "hello",
    ...overrides,
  };
}

test("remote echo replaces a pending message with the same clientRequestId", () => {
  const pending = message({
    clientRequestId: "request-1",
    delivery: {state: "sending"},
    id: "local:request-1",
  });
  const remote = message({
    clientRequestId: "request-1",
    delivery: {state: "sent"},
    id: "remote-1",
  });

  const merged = mergeMessages([pending], [remote]);

  assert.deepEqual(merged, [remote]);
});

test("messages deduplicate by remote ID and remain chronological", () => {
  const later = message({
    createdAt: "2026-07-30T17:02:00.000Z",
    id: "remote-2",
  });
  const earlier = message({
    createdAt: "2026-07-30T17:01:00.000Z",
    id: "remote-1",
  });

  const merged = mergeMessages([later], [earlier, {...later, text: "confirmed"}]);

  assert.deepEqual(merged.map((item) => item.id), ["remote-1", "remote-2"]);
  assert.equal(merged[1]?.text, "confirmed");
});

test("a reaction update replaces the original message without losing its position", () => {
  const original = message({id: "remote-1", text: "before"});
  const reacted = message({
    id: "remote-1",
    reactions: [
      {
        count: 2,
        reactedByMe: true,
        reactionId: "👍",
      },
    ],
  });

  assert.deepEqual(mergeMessages([original], [reacted]), [reacted]);
});
