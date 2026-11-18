import assert from "node:assert/strict";
import test from "node:test";
import {
  asTurnId,
  userMessageCompareKey,
  type TimelineSourceItem,
  type TimelineSourceTurn,
} from "@opencraft/chat-core";
import { createSteeringAcknowledgementResolver } from "../../packages/chat-runtime/src/steering-acknowledgement-index";

const turn = (items: readonly TimelineSourceItem[]): TimelineSourceTurn => ({
  id: asTurnId("turn"),
  status: "streaming",
  items,
});
const text = (text: string) => [{ type: "text", text }];
const item = (type: string, payload: unknown = {}): TimelineSourceItem =>
  ({ id: "item", type, payload }) as TimelineSourceItem;
function original(source: TimelineSourceTurn, state: { clientMessageId: string; input: unknown }): number {
  return source.items.findIndex((candidate, index) => {
    if (
      (candidate.type !== "userMessage" && candidate.type !== "steeringUserMessage") ||
      typeof candidate.payload !== "object" ||
      candidate.payload === null ||
      Array.isArray(candidate.payload)
    )
      return false;
    const payload = candidate.payload;
    const clientId =
      typeof payload.clientId === "string"
        ? payload.clientId
        : typeof payload.clientUserMessageId === "string"
          ? payload.clientUserMessageId
          : null;
    if (clientId !== null) return clientId === state.clientMessageId;
    const follows = source.items
      .slice(0, index)
      .some((item) => item.type !== "userMessage" && item.type !== "steeringUserMessage" && item.type !== "hookPrompt");
    const left = userMessageCompareKey(payload.content ?? payload.input),
      right = userMessageCompareKey(state.input);
    return follows && left.rawText === right.rawText && left.imageCount === right.imageCount;
  });
}

test("indexed acknowledgement preserves every original first-match rule", () => {
  const candidates = [
    item("userMessage", { content: text("same") }),
    item("steeringUserMessage", { content: text("same") }),
    item("hookPrompt"),
    item("agentMessage"),
    item("commandExecution"),
    item("unknown"),
    item("userMessage", { clientId: "match", content: text("different") }),
    item("userMessage", { clientId: "different", content: text("same") }),
    item("userMessage", { clientId: "", clientUserMessageId: "match", content: text("same") }),
    item("userMessage", { clientId: 0, clientUserMessageId: "match", content: text("same") }),
    item("steeringUserMessage", { input: text("same") }),
    item("userMessage", { content: null, input: text("same") }),
    item("userMessage", { content: [{ type: "image", url: "a" }] }),
    item("userMessage", null),
    item("userMessage", []),
    item("userMessage", "bad"),
  ];
  const identities = ["match", "different", ""].flatMap((clientMessageId) =>
    [text("same"), text("different"), [], [{ type: "image", url: "b" }]].map((input) => ({ clientMessageId, input })),
  );
  const resolve = createSteeringAcknowledgementResolver();
  for (const left of candidates)
    for (const middle of candidates)
      for (const right of candidates) {
        const source = turn([left, middle, right]);
        for (const state of identities) assert.equal(resolve(source, state), original(source, state));
      }
});

test("unchanged immutable Item arrays reuse one derived index across states and Turn status", () => {
  let reads = 0;
  const payload = {
    get content() {
      reads++;
      return text("same");
    },
  };
  const items = Object.freeze([
    item("userMessage", { content: text("same") }),
    item("agentMessage"),
    item("steeringUserMessage", payload),
  ]);
  const resolve = createSteeringAcknowledgementResolver(),
    source = turn(items);
  assert.equal(resolve(source, { clientMessageId: "a", input: text("same") }), 2);
  const indexedReads = reads;
  for (const clientMessageId of ["b", "c", "d"])
    assert.equal(resolve({ ...source, status: "complete" }, { clientMessageId, input: text("same") }), 2);
  assert.equal(reads, indexedReads, "a new lookup must not re-read immutable candidate content");
  assert.equal(
    resolve(turn([...items.slice(0, 2), item("steeringUserMessage", { content: text("changed") })]), {
      clientMessageId: "a",
      input: text("same"),
    }),
    -1,
  );
  assert.equal(
    resolve(turn([...items, item("steeringUserMessage", { clientId: "new" })]), { clientMessageId: "new", input: [] }),
    3,
  );
  const another = createSteeringAcknowledgementResolver();
  another(source, { clientMessageId: "a", input: text("same") });
  assert.ok(reads > indexedReads, "a runtime does not inherit another runtime's index");
});

test("explicit identity, duplicate ordering and image-count distinctions are retained", () => {
  const resolve = createSteeringAcknowledgementResolver();
  assert.equal(
    resolve(turn([item("hookPrompt"), item("userMessage", { content: text("same") })]), {
      clientMessageId: "x",
      input: text("same"),
    }),
    -1,
  );
  assert.equal(resolve(turn([item("userMessage", { clientId: "x" })]), { clientMessageId: "x", input: [] }), 0);
  const source = turn([
    item("agentMessage"),
    item("steeringUserMessage", { content: text("same") }),
    item("userMessage", { clientId: "x" }),
    item("steeringUserMessage", { content: text("same") }),
  ]);
  assert.equal(resolve(source, { clientMessageId: "x", input: text("same") }), 1);
  assert.equal(
    resolve(turn([item("agentMessage"), item("userMessage", { clientId: "other", content: text("same") })]), {
      clientMessageId: "x",
      input: text("same"),
    }),
    -1,
  );
  assert.equal(
    resolve(
      turn([item("agentMessage"), item("userMessage", { content: [...text("same"), { type: "image", url: "a" }] })]),
      { clientMessageId: "x", input: text("same") },
    ),
    -1,
  );
});
