import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantMessageActions, createConversationKey, createDefaultTimelineProjectorRegistry,
  createTimelineTurnPresentationPlan, groupTimelineFramesByTurn, projectTimeline,
  deriveTimelineLatestTurnPhase, deriveTurnWorkStatus, type TimelineSourceItem, type TimelineStatus,
} from "@opencraft/chat-core";
import { orderedResponseItems } from "./fixtures/ordered-response-items";

function turn(items: readonly TimelineSourceItem[], status: TimelineStatus = "complete") {
  const snapshot = projectTimeline({ key: createConversationKey("fixture", "ordered"), revision: 1,
    authoritative: true, phase: "live", turns: [{ id: "turn", status, durationMs: 1000,
      startedAtMs: 1000, firstTurnWorkItemStartedAtMs: 1100, finalAssistantStartedAtMs: 2000, items }] },
  createDefaultTimelineProjectorRegistry());
  return groupTimelineFramesByTurn(snapshot)[0]!;
}
function plan(items: readonly TimelineSourceItem[], status: TimelineStatus = "complete") {
  return createTimelineTurnPresentationPlan(turn(items, status), undefined, { isMostRecentTurn: true });
}
function ids(p: ReturnType<typeof plan>) {
  return [...p.userFrames.flatMap(f => f.blocks), ...p.assistant!.slots.flatMap(s =>
    s.type === "assistant-content" ? [s.block] : s.blocks), ...p.auxiliaryFrames.flatMap(f => f.blocks)]
    .flatMap(b => b.sourceItemIds);
}

for (const streaming of [false, true]) {
  test(`async question, steering and multiple answers retain chronological slots (${streaming ? "streaming" : "settled"})`, () => {
    const items = orderedResponseItems(streaming);
    const p = plan(items, streaming ? "streaming" : "complete");
    assert.deepEqual(ids(p), items.map(i => i.id));
    const activities = p.assistant!.slots.filter(s => s.type === "agent-activity");
    assert.equal(new Set(activities.map(s => s.id)).size, activities.length);
    assert.ok(activities.every(s => s.blocks.every(b => b.type !== "user-message")));
    assert.equal(activities.flatMap(s => s.contentUnits).filter(u => u.type === "worked-for").length, 1);
    assert.equal(p.thinkingOwner.type, "none", "streamed answer, not historical work, owns the current response");
    assert.equal(assistantMessageActions(p.assistantFrame!)?.copyText, "Newest answer");
  });
}

test("new work after an old answer has one live owner; earlier slices stay settled", () => {
  const p = plan(orderedResponseItems().slice(0, -1), "streaming");
  const activities = p.assistant!.slots.filter(s => s.type === "agent-activity");
  assert.equal(activities.filter(s => s.status === "streaming").length, 1);
  assert.equal(p.thinkingOwner.type, "activity");
  if (p.thinkingOwner.type === "activity") assert.equal(p.thinkingOwner.activityId, activities.at(-1)!.id);
  assert.equal(assistantMessageActions(p.assistantFrame!), null, "old answers cannot own actions for a new follow-up");
});

test("a follow-up waiting for its first work item gets only the tail Thinking placeholder", () => {
  const p = plan(orderedResponseItems().slice(0, -2), "streaming");
  assert.equal(p.thinkingOwner.type, "turn");
  assert.equal(p.assistant!.slots.filter(s => s.type === "agent-activity" && s.status === "streaming").length, 0);
});

test("an async delivery with no parsed questions still cannot close the answer slice", () => {
  const p = plan([{ id: "ask", type: "agentMessage", payload: { text: "Async message", delivery: "async", phase: "final_answer", completed: true } }]);
  assert.equal(assistantMessageActions(p.assistantFrame!), null);
});

test("stream completion and history prepend do not change established row/segment identities", () => {
  const before = plan(orderedResponseItems(true), "streaming");
  const after = plan(orderedResponseItems());
  assert.deepEqual(after.assistant!.slots.map(s => s.id), before.assistant!.slots.map(s => s.id));
  const withEarlier = plan([orderedResponseItems()[0]!, { id: "earlier", type: "commandExecution", payload: { command: "echo earlier", status: "completed" } }, ...orderedResponseItems().slice(1)]);
  assert.deepEqual(withEarlier.assistant!.slots.map(s => s.id), after.assistant!.slots.map(s => s.id));
});

test("auxiliary interactions and later primary user frames cannot be globally moved to the ends", () => {
  const items: TimelineSourceItem[] = [{ id: "before", type: "agentMessage", payload: { text: "Before", phase: "commentary" } },
    { id: "approval", type: "interaction:approval", payload: { requestId: "approval", title: "Approve", state: "accepted" } },
    { id: "after", type: "agentMessage", payload: { text: "After", phase: "final_answer", completed: true } }];
  assert.deepEqual(ids(plan(items)), items.map(i => i.id));
  const original = turn(orderedResponseItems());
  const intro = original.frames.find(f => f.type === "user")!;
  const assistant = original.frames.find(f => f.type === "assistant")!;
  const block = (id: string) => assistant.blocks.find(b => b.sourceItemIds.some(sourceId => String(sourceId) === id))!;
  const p = createTimelineTurnPresentationPlan({ ...original, frames: [
    { ...assistant, blocks: [block("old")] },
    { ...intro, blocks: [block("steer1")] },
    { ...assistant, blocks: [block("answer3")] },
  ] });
  assert.deepEqual(ids(p), ["old", "steer1", "answer3"]);
  assert.deepEqual(p.userFrames, [], "a later primary user frame is not an intro");
});

test("latest response phase excludes async questions and resets after steering or resumed work", () => {
  const items = orderedResponseItems(true);
  assert.equal(deriveTimelineLatestTurnPhase(turn(items.slice(0, 3), "streaming")), "prework");
  assert.equal(deriveTimelineLatestTurnPhase(turn(items, "streaming")), "final_answer");
  assert.equal(deriveTimelineLatestTurnPhase(turn(items.slice(0, -2), "streaming")), "prework");
  assert.equal(deriveTimelineLatestTurnPhase(turn([...items, { id: "resumed", type: "commandExecution", payload: { command: "pwd", status: "completed" } }], "streaming")), "prework");
});

test("the Turn clock ignores an async final and historical answers during a later response", () => {
  const items = orderedResponseItems(true);
  const clock = (items: readonly TimelineSourceItem[]) => deriveTurnWorkStatus({
    id: "turn", status: "streaming", startedAtMs: 1000, firstTurnWorkItemStartedAtMs: 1100,
    finalAssistantStartedAtMs: 1200, items,
  });
  assert.equal(clock(items.slice(0, 3))?.status, "working");
  assert.equal(clock(items.slice(0, -1))?.status, "working");
  assert.deepEqual(clock(items), { type: "worked-for", status: "worked", startedAtMs: 1000, completedAtMs: 2200 });
});

test("an unphased streamed answer acquires final eligibility without changing its row identity", () => {
  const items = orderedResponseItems(true);
  const p = plan(items.map(i => i.id === "answer3" ? { ...i, payload: { ...(i.payload as object), phase: null } } : i), "streaming");
  assert.deepEqual(p.assistant!.slots.map(s => s.id), plan(items, "streaming").assistant!.slots.map(s => s.id));
});
