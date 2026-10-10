import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationKey, createDefaultTimelineProjectorRegistry,
  createTimelineTurnPresentationPlan, deriveTimelineLatestTurnPhase,
  groupTimelineFramesByTurn, projectTimeline, resolveAgentActivityLayout,
  type TimelineSourceItem, type TimelineSourceTurn,
} from "@opencraft/chat-core";

const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra";
const items: readonly TimelineSourceItem[] = [
  { id: "input", type: "userMessage", payload: { text: "Update files" } },
  { id: "progress", type: "agentMessage", payload: { text: "Progress", phase: "commentary", completed: true } },
  { id: "command", type: "commandExecution", payload: { command: "test", status: "inProgress", completed: false } },
];
function present(source: Partial<TimelineSourceTurn> = {}) {
  const timeline = projectTimeline({ key: createConversationKey("fixture", "resources"), revision: 1,
    authoritative: true, phase: "live", turns: [{ id: "turn", status: "streaming", durationMs: null,
      startedAtMs: 1000, firstTurnWorkItemStartedAtMs: 1100, items, ...source }] },
  createDefaultTimelineProjectorRegistry());
  const turn = groupTimelineFramesByTurn(timeline)[0]!;
  return { timeline, turn, plan: createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true }) };
}

test("a legacy aggregate diff cannot close or automatically fold active work", () => {
  const before = present();
  const after = present({ items: [...items, { id: "turn:turn-diff", type: "turnDiff", payload: { diff } }] });
  const activity = after.plan.assistant!.slots.find(s => s.type === "agent-activity")!;
  assert.equal(activity.type, "agent-activity");
  if (activity.type !== "agent-activity") return;
  assert.equal(activity.status, "streaming");
  assert.equal(activity.segmentEnd, "open");
  assert.equal(activity.hasFinalAssistantStarted, false);
  assert.equal(resolveAgentActivityLayout(activity, true).isCollapsed, false, "old preference cannot fold an open response");
  assert.deepEqual(after.plan.assistant!.slots, before.plan.assistant!.slots, "resource arrival changes no transcript or clock");
  assert.deepEqual(after.plan.thinkingOwner, before.plan.thinkingOwner);
  assert.equal(after.plan.assistant!.changeSummary?.status, "running");
  assert.equal(after.plan.assistant!.changeSummary?.additions, 2);
});

test("Turn-owned diff updates and restored snapshots retain one independent resource", () => {
  const first = present({ unifiedDiff: diff });
  const updated = present({ unifiedDiff: diff.replace("+extra", "+extra\n+more"),
    items: [...items, { id: "later", type: "reasoning", payload: { summary: "Continuing", completed: false } }] });
  assert.equal(first.plan.assistant!.changeSummary?.id, updated.plan.assistant!.changeSummary?.id);
  assert.equal(updated.plan.assistant!.changeSummary?.additions, 3);
  assert.equal(updated.timeline.frames.flatMap(f => f.blocks).some(b => b.type === "turn-diff"), false);
  assert.equal(updated.plan.assistant!.slots.filter(s => s.type === "agent-activity").length, 1);
  const activity = updated.plan.assistant!.slots.find(s => s.type === "agent-activity")!;
  if (activity.type === "agent-activity") assert.equal(resolveAgentActivityLayout(activity).isCollapsed, false);
  assert.deepEqual(present({ unifiedDiff: diff }).plan, first.plan, "reload has the same semantic plan");
});

test("a diff never changes final-answer placement, work clock, or settled Review eligibility", () => {
  const answeredItems = [...items.slice(0, -1), { ...items[2]!, payload: { command: "test", status: "completed", completed: true } },
    { id: "answer", type: "agentMessage", payload: { text: "Done", phase: "final_answer", completed: true, startedAtMs: 2500 } }];
  const before = present({ status: "complete", durationMs: 1500, items: answeredItems });
  const after = present({ status: "complete", durationMs: 1500, items: answeredItems, unifiedDiff: diff });
  assert.deepEqual(after.plan.assistant!.slots, before.plan.assistant!.slots);
  assert.equal(after.plan.assistant!.changeSummary?.status, "complete");
  const live = present({ items: answeredItems, unifiedDiff: diff });
  assert.equal(deriveTimelineLatestTurnPhase(live.turn), "final_answer");
  assert.deepEqual(live.plan.assistant!.slots, present({ items: answeredItems }).plan.assistant!.slots);
});

test("resource-only Turns materialize a resource without inventing a transcript message", () => {
  const { timeline, plan } = present({ items: [], unifiedDiff: diff, status: "complete" });
  assert.equal(timeline.frames.flatMap(f => f.blocks).length, 0);
  assert.equal(plan.assistant!.slots.length, 0);
  assert.equal(plan.assistant!.changeSummary?.files.length, 1);
  assert.equal(plan.topLevelSlotCount, 1);
});

test("authoritative Turn diff wins over legacy summary Items without duplicate resources", () => {
  const { plan } = present({ unifiedDiff: diff, items: [...items,
    { id: "legacy", type: "turnDiff", payload: { diff: diff.replace("+extra", "+extra\n+stale") } }] });
  assert.equal(plan.assistant!.changeSummary?.additions, 2);
  assert.equal(plan.assistant!.changeSummary?.id, "turn:turn-diff");
  assert.equal(plan.assistant!.slots.some(s => s.type === "assistant-content" && s.block.type === "turn-diff"), false);
});

test("legacy handoff keeps the Turn resource identity and explicit null clears it", () => {
  const legacyItems = [...items, { id: "legacy", type: "turnDiff", payload: { diff } }];
  const legacy = present({ items: legacyItems });
  const canonical = present({ unifiedDiff: diff });
  assert.deepEqual(legacy.plan.assistant!.changeSummary, canonical.plan.assistant!.changeSummary);
  const cleared = present({ unifiedDiff: null, items: legacyItems });
  assert.equal(cleared.plan.assistant!.changeSummary, null);
  assert.deepEqual(cleared.plan.assistant!.slots, present().plan.assistant!.slots);
});
