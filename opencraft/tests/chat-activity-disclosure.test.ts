import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationKey, createDefaultTimelineProjectorRegistry, createTimelineTurnPresentationPlan,
  groupTimelineFramesByTurn, partitionAgentActivityContentUnits, projectTimeline, resolveAgentActivityDisclosure, resolveAgentActivityLayout,
  type AgentActivityContentUnit, type TimelineSourceItem, type TimelineStatus,
} from "@opencraft/chat-core";
import { originalTaskDisclosure } from "./fixtures/codex-disclosure-oracle";

test("ordinary task disclosure matches the reviewed current Codex oracle (96 cases)", () => {
  let count = 0;
  for (const hasFinalAssistantStarted of [false, true]) for (const isTurnCancelled of [false, true])
    for (const hasRenderableAgentItems of [false, true]) for (const forceExpanded of [false, true])
      for (const preventAutoCollapse of [false, true]) for (const persistedCollapsed of [undefined, false, true]) {
        const state = { hasFinalAssistantStarted, isTurnCancelled, hasRenderableAgentItems,
          forceExpanded, preventAutoCollapse, persistedCollapsed };
        assert.deepEqual(resolveAgentActivityDisclosure(state), originalTaskDisclosure(state));
        count++;
      }
  assert.equal(count, 96);
});

const prose = (id: string, phase: string | null = "commentary", extras = {}): TimelineSourceItem => ({
  id, type: "agentMessage", payload: { text: id, phase, completed: true, ...extras },
});
const input = (id: string): TimelineSourceItem => ({ id, type: "userMessage",
  payload: { clientId: id, content: [{ type: "text", text: id }] } });
const work = (id: string): TimelineSourceItem => ({ id, type: "commandExecution",
  payload: { command: `echo ${id}`, status: "completed", exitCode: 0 } });
function plan(items: readonly TimelineSourceItem[], status: TimelineStatus = "streaming") {
  const timeline = projectTimeline({ key: createConversationKey("fixture", "disclosure"), revision: 1,
    authoritative: true, phase: "live", turns: [{ id: "turn", status, items }] }, createDefaultTimelineProjectorRegistry());
  return createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(timeline)[0]!, undefined, { isMostRecentTurn: true });
}
function activities(p: ReturnType<typeof plan>) { return p.assistant!.slots.filter(s => s.type === "agent-activity"); }

for (const status of ["streaming", "complete", "interrupted", "failed"] as const) {
  test(`Steer closes chronology, never disclosure eligibility (${status})`, () => {
    const items = [prose("first"), work("work1"), input("steer1"), prose("second"), work("work2"), input("steer2")];
    const p = plan(items, status);
    assert.deepEqual(p.assistant!.slots.flatMap(s => s.type === "assistant-content" ? s.block.sourceItemIds
      : s.blocks.flatMap(b => b.sourceItemIds)), items.map(i => i.id));
    for (const unit of activities(p)) for (const choice of [undefined, false, true]) {
      const layout = resolveAgentActivityLayout(unit, choice);
      assert.equal(layout.showToggle, false);
      assert.equal(layout.isCollapsed, false, "even an old stored choice cannot manufacture eligibility");
      assert.deepEqual(layout.visibleUnits, unit.contentUnits);
    }
  });
}

for (const boundary of [
  input("steer"),
  prose("async", "final_answer", { delivery: "async" }),
  prose("question", "final_answer", { delivery: "async", questions: [{ title: "Question", options: ["A", "B"] }] }),
  prose("unphased", null),
  { id: "approval", type: "interaction:approval", payload: { requestId: "approval", title: "Approve", state: "accepted" } },
  { id: "image", type: "imageGeneration", payload: { status: "completed", result: "data:image/png;base64,AA==" } },
] satisfies TimelineSourceItem[]) {
  test(`${boundary.id} is not a qualified final-answer fold grant`, () => {
    const activity = activities(plan([prose("earlier"), work("work"), boundary, prose("answer", "final_answer")], "complete"))[0]!;
    assert.equal(resolveAgentActivityLayout(activity, undefined).isCollapsed, false);
    assert.equal(resolveAgentActivityLayout(activity, true).showToggle, false);
  });
}

test("only the activity adjacent to a real answer receives fold eligibility", () => {
  const items = [prose("first"), input("steer"), prose("second"), work("work"), prose("answer", "final_answer")];
  const before = plan(items.slice(0, -1));
  const after = plan(items, "complete");
  assert.deepEqual(activities(before).map(s => s.id), activities(after).map(s => s.id));
  const [earlier, adjacent] = activities(after);
  assert.equal(resolveAgentActivityLayout(earlier!, true).showToggle, false);
  assert.equal(resolveAgentActivityLayout(adjacent!, undefined).isCollapsed, true);
  assert.equal(resolveAgentActivityLayout(adjacent!, false).isCollapsed, false);
  assert.equal(resolveAgentActivityLayout(adjacent!, true).isCollapsed, true);
  assert.ok(after.assistant!.slots.some(s => s.type === "assistant-content" && s.block.sourceItemIds.includes("answer")));
  assert.equal(earlier!.segmentEnd, "user-input");
  assert.equal(adjacent!.segmentEnd, "final-answer");
});

test("a new async interaction cannot inherit an earlier response's final eligibility", () => {
  const items = [work("first"), prose("answer1", "final_answer"),
    prose("ask", "final_answer", { delivery: "async" }), prose("new work"), input("steer")];
  const p = plan(items, "complete");
  const [first, later] = activities(p);
  assert.equal(resolveAgentActivityLayout(first!, undefined).isCollapsed, true);
  assert.equal(later!.hasFinalAssistantStarted, false);
  assert.equal(resolveAgentActivityLayout(later!, true).showToggle, false);
});

test("Steer cannot fold work resumed after an earlier final answer", () => {
  const items = [work("first"), prose("answer1", "final_answer"), prose("resumed"), work("resumed work")];
  const before = activities(plan(items));
  const after = activities(plan([...items, input("steer"), prose("new response")], "complete"));
  assert.equal(before[1]!.id, after[1]!.id);
  assert.equal(after[1]!.phase, "after-final-answer", "phase is chronology, not authority");
  assert.equal(after[1]!.hasFinalAssistantStarted, false);
  assert.equal(resolveAgentActivityLayout(after[1]!, true).isCollapsed, false);
  assert.equal(resolveAgentActivityLayout(after[0]!, undefined).isCollapsed, true);
});

test("cancellation retains work preceding a started final answer", () => {
  const unit = activities(plan([prose("partial work"), prose("partial answer", "final_answer", { completed: false })], "interrupted"))[0]!;
  assert.equal(resolveAgentActivityLayout(unit, true).isCollapsed, false);
  assert.equal(resolveAgentActivityLayout(unit, true).showToggle, false);
});

test("no-toggle presentation shows the full ordered partition, without dropping persistent items", () => {
  const unit = activities(plan([prose("comment"), work("work"), prose("answer", "final_answer")], "complete"))[0]!;
  const steer = plan([prose("intro"), input("steer")]).assistant!.slots.find(s => s.type === "assistant-content")!;
  assert.equal(steer.type, "assistant-content");
  if (steer.type !== "assistant-content") throw new Error("expected user slot");
  const contentUnits: AgentActivityContentUnit[] = [...unit.contentUnits, { type: "standalone", id: "steer", block: {
    ...steer.block, steeringStatus: "accepted",
  } as Extract<typeof steer.block, { type: "user-message" }> }];
  const model = { ...unit, contentUnits, partitions: partitionAgentActivityContentUnits(contentUnits), disableCollapse: true };
  const layout = resolveAgentActivityLayout(model, true);
  assert.equal(layout.showToggle, false);
  assert.equal(layout.isCollapsed, false);
  assert.deepEqual(layout.visibleUnits, model.partitions.expandedUnits);
  assert.deepEqual(layout.persistentUnits, [], "persistent items must not also appear outside an expanded body");
  const forced = resolveAgentActivityLayout({ ...model, disableCollapse: false, forceExpanded: true }, true);
  assert.deepEqual(forced.visibleUnits, contentUnits);
  assert.equal(forced.isCollapsed, false);
  assert.equal(resolveAgentActivityLayout({ ...model, disableCollapse: false }, true).isCollapsed, true,
    "a temporary override must not overwrite the explicit choice");
});

test("final answers remain persistent even if passed to the inner partition", () => {
  const p = plan([prose("final", "final_answer"), prose("async", "final_answer", { delivery: "async" })]);
  const units = p.assistant!.slots.map(s => {
    assert.equal(s.type, "assistant-content");
    if (s.type !== "assistant-content") throw new Error("expected text slot");
    return { type: "standalone" as const, id: s.id, block: s.block };
  });
  const partition = partitionAgentActivityContentUnits(units);
  assert.deepEqual(partition.persistentUnits.map(u => u.id), [units[0]!.id]);
  assert.deepEqual(partition.collapsibleUnits.map(u => u.id), [units[1]!.id]);
  assert.deepEqual(partition.expandedUnits, units);
});
