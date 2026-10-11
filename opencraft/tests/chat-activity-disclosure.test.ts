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
const reasoning = (id: string, summary: readonly string[] = ["Actual returned reasoning"]): TimelineSourceItem => ({
  id, type: "reasoning", payload: { summary, content: [], completed: true },
});
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

test("a real answer grants collapse to the shared response container for thinking and single/multiple tools", () => {
  const read: TimelineSourceItem = { id: "read", type: "commandExecution", payload: {
    command: "cat src/index.ts", status: "completed", exitCode: 0,
    commandActions: [{ type: "read", command: "cat", name: "index.ts", path: "src/index.ts" }],
  } };
  for (const summary of [[], ["Actual returned reasoning"]])
    for (const tools of [[work("one")], [read], [work("one"), read]])
      for (const status of ["streaming", "complete"] as const) {
        const p = plan([...tools, reasoning("reasoning", summary), prose("answer", "final_answer")], status);
        const toolSlices = activities(p).filter(unit => unit.blocks.some(block => block.type === "command-execution"));
        assert.equal(toolSlices.length, 1);
        const unit = toolSlices[0]!;
        assert.equal(unit.segmentEnd, "final-answer");
        assert.equal(unit.hasFinalAssistantStarted, true);
        assert.equal(resolveAgentActivityLayout(unit, undefined).showToggle, true);
        assert.equal(resolveAgentActivityLayout(unit, undefined).isCollapsed, true);
        assert.equal(resolveAgentActivityLayout(unit, false).isCollapsed, false);
        assert.equal(resolveAgentActivityLayout(unit, true).isCollapsed, true);
        assert.ok(unit.contentUnits.every(content => content.type === "worked-for" || content.type === "reasoning"
          || (content.type === "group" ? content.blocks : [content.block]).every(block => block.type !== "reasoning")));
      }
});

test("independent thinking and tool disclosures share one chronological response work owner", () => {
  const p = plan([
    reasoning("start"), work("first"), reasoning("middle"), work("second"), work("third"),
    reasoning("last"), prose("answer", "final_answer"),
  ], "complete");
  const toolSlices = activities(p).filter(unit => unit.blocks.some(block => block.type === "command-execution"));
  assert.equal(toolSlices.length, 1);
  assert.equal(p.assistant!.slots.filter(slot => slot.type === "reasoning").length, 0);
  const owner = toolSlices[0]!;
  assert.deepEqual(owner.contentUnits.map(unit => unit.type), ["reasoning", "standalone", "reasoning", "group", "reasoning"]);
  assert.equal(owner.contentUnits.filter(unit => unit.type === "reasoning").length, 3);
  assert.equal(owner.hasFinalAssistantStarted, true);
  assert.equal(resolveAgentActivityLayout(owner).showToggle, true);
  assert.equal(resolveAgentActivityLayout(owner).isCollapsed, true);
  assert.equal(resolveAgentActivityLayout(owner, false).isCollapsed, false);
});

test("reasoning itself never grants tool collapse while thinking or without a final answer", () => {
  for (const status of ["streaming", "complete"] as const)
    for (const summary of [[], ["Actual returned reasoning"]]) {
      const p = plan([work("before"), reasoning("thinking", summary), work("after"), reasoning("tail", summary)], status);
      for (const unit of activities(p).filter(unit => unit.blocks.some(block => block.type === "command-execution"))) {
        assert.equal(unit.hasFinalAssistantStarted, false);
        assert.equal(resolveAgentActivityLayout(unit, true).showToggle, false);
        assert.equal(resolveAgentActivityLayout(unit, true).isCollapsed, false);
      }
    }
});

for (const boundary of [
  input("steer"),
  prose("async", "final_answer", { delivery: "async" }),
  prose("question", "final_answer", { delivery: "async", questions: [{ title: "Question", options: ["A", "B"] }] }),
  prose("unphased", null),
  { id: "approval", type: "interaction:approval", payload: { requestId: "approval", title: "Approve", state: "accepted" } },
  { id: "image", type: "imageGeneration", payload: { status: "completed", result: "data:image/png;base64,AA==" } },
] satisfies TimelineSourceItem[]) {
  test(`reasoning cannot carry a later answer grant across ${boundary.id}`, () => {
    const p = plan([
      work("earlier"), reasoning("before-boundary"), boundary,
      reasoning("after-boundary"), work("current"), reasoning("current-reasoning"), prose("answer", "final_answer"),
    ], "complete");
    const toolSlices = activities(p).filter(unit => unit.blocks.some(block => block.type === "command-execution"));
    assert.equal(toolSlices.length, 2);
    assert.equal(toolSlices[0]!.hasFinalAssistantStarted, false);
    assert.equal(resolveAgentActivityLayout(toolSlices[0]!, true).showToggle, false);
    assert.equal(toolSlices[1]!.hasFinalAssistantStarted, true);
    assert.equal(resolveAgentActivityLayout(toolSlices[1]!, true).isCollapsed, true);
  });
}

test("empty reasoning is transparent; actual first text may split work but retains its source identities", () => {
  const build = (summary: readonly string[]) => plan([
    work("first"), reasoning("middle", summary), work("second"), reasoning("last", summary), prose("answer", "final_answer"),
  ], "complete");
  const tools = (p: ReturnType<typeof plan>) => activities(p).filter(unit => unit.blocks.some(block => block.type === "command-execution"));
  const before = tools(build([]));
  const after = tools(build(["Actual returned reasoning"]));
  assert.equal(before.length, 1);
  assert.equal(after.length, 1, "actual thinking splits inner groups, never the response work owner");
  assert.equal(after[0]!.contentUnits.filter(unit => unit.type === "reasoning").length, 2);
  const contentFor = (units: ReturnType<typeof tools>, sourceId: string) => units.flatMap(unit => unit.contentUnits)
    .find(content => content.type !== "worked-for" && (content.type === "group" ? content.blocks : [content.block])
      .some(block => block.sourceItemIds.includes(sourceId)));
  assert.equal(contentFor(before, "first")?.id, contentFor(after, "first")?.id, "the existing first-source tool disclosure key survives");
  assert.deepEqual(before.flatMap(unit => unit.blocks.filter(block => block.type === "command-execution").flatMap(block => block.sourceItemIds)),
    after.flatMap(unit => unit.blocks.filter(block => block.type === "command-execution").flatMap(block => block.sourceItemIds)));
  assert.equal(before[0]!.id, after[0]!.id);
  for (const units of [before, after]) {
    const foldable = units.filter(unit => resolveAgentActivityLayout(unit, true).showToggle);
    assert.equal(foldable.length, 1);
    assert.equal(resolveAgentActivityLayout(foldable[0]!, true).isCollapsed, true);
    assert.equal(resolveAgentActivityLayout(foldable[0]!, false).isCollapsed, false);
  }
});

test("reasoning-separated final grants keep exactly one completed Turn work interval", () => {
  for (const summary of [[], ["Actual returned reasoning"]]) {
    const timeline = projectTimeline({ key: createConversationKey("fixture", "work-clock"), revision: 1,
      authoritative: true, phase: "live", turns: [{
        id: "turn", status: "complete", startedAtMs: 1_000, firstTurnWorkItemStartedAtMs: 1_050,
        finalAssistantStartedAtMs: 4_000, completedAtMs: 4_100,
        items: [work("first"), reasoning("middle", summary), work("second"), reasoning("last", summary), prose("answer", "final_answer")],
      }] }, createDefaultTimelineProjectorRegistry());
    const p = createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(timeline)[0]!, undefined, { isMostRecentTurn: true });
    const clocks = activities(p).flatMap(unit => unit.contentUnits.filter(content => content.type === "worked-for"));
    assert.equal(clocks.length, 1);
    assert.deepEqual(clocks[0]!.item, { type: "worked-for", status: "worked", startedAtMs: 1_000, completedAtMs: 4_000 });
    const owner = activities(p).find(unit => unit.contentUnits.some(content => content.type === "worked-for"));
    assert.ok(owner!.blocks.some(block => block.type === "command-execution" && block.sourceItemIds.includes("second")),
      "hidden-only trailing reasoning cannot steal the Turn clock from actual current-response work");
  }
});

test("thirteen empty reasoning observations between sixty tools never fragment outer or inner work", () => {
  for (const withClocks of [false, true]) for (const status of ["streaming", "complete"] as const) {
    const items: TimelineSourceItem[] = [];
    for (let index = 0; index < 60; index++) {
      items.push(work(`tool-${index}`));
      if (index % 5 === 0) items.push(reasoning(`empty-${index}`, []));
    }
    items.push(reasoning("empty-tail", []));
    if (status === "complete") items.push(prose("answer", "final_answer"));
    const timeline = projectTimeline({ key: createConversationKey("fixture", "long-empty-reasoning"), revision: 1,
      authoritative: true, phase: "live", turns: [{ id: "turn", status, items,
        ...(withClocks ? { startedAtMs: 1_000, firstTurnWorkItemStartedAtMs: 1_050,
          finalAssistantStartedAtMs: status === "complete" ? 4_000 : null, completedAtMs: status === "complete" ? 4_100 : null } : {}),
      }] }, createDefaultTimelineProjectorRegistry());
    const p = createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(timeline)[0]!, undefined, { isMostRecentTurn: true });
    const units = activities(p);
    assert.equal(units.length, 1, "empty source observations cannot manufacture repeated Activity cards");
    assert.equal(p.assistant!.slots.filter(slot => slot.type === "reasoning").length, 0);
    assert.equal(units[0]!.blocks.filter(block => block.type === "reasoning").length, 13);
    assert.equal(units[0]!.blocks.filter(block => block.type === "command-execution").length, 60);
    const groups = units[0]!.contentUnits.filter(content => content.type === "group");
    assert.equal(groups.length, 1, "empty reasoning also cannot force a hidden inner grouping boundary");
    assert.equal(groups[0]!.blocks.length, 60);
    assert.equal(groups[0]!.id, "agent-activity-group:command-execution:tool-0");
    const clocks = units[0]!.contentUnits.filter(content => content.type === "worked-for");
    assert.equal(clocks.length, withClocks ? 1 : 0);
    assert.equal(resolveAgentActivityLayout(units[0]!, true).showToggle, status === "complete");
    assert.equal(resolveAgentActivityLayout(units[0]!, true).isCollapsed, status === "complete");
  }
});

test("each completed response retains its one legitimate fold after subsequent steering", () => {
  const responses: TimelineSourceItem[][] = [
    [work("one-early"), reasoning("one-middle"), work("one-nearest"), reasoning("one-tail"), prose("answer-one", "final_answer")],
    [input("steer-one"), work("two-early"), reasoning("two-middle"), work("two-nearest"), reasoning("two-tail"), prose("answer-two", "final_answer")],
    [input("steer-two"), work("three-open"), reasoning("three-thinking")],
  ];
  const first = activities(plan(responses[0]!, "streaming"));
  const later = activities(plan(responses.flat(), "streaming"));
  const granted = later.filter(unit => resolveAgentActivityLayout(unit, true).showToggle);
  assert.equal(granted.length, 2, "one grant belongs to each completed response, not one global Turn bucket");
  assert.ok(granted[0]!.blocks.some(block => block.sourceItemIds.includes("one-nearest")));
  assert.ok(granted[1]!.blocks.some(block => block.sourceItemIds.includes("two-nearest")));
  assert.deepEqual(granted[0]!.blocks.flatMap(block => block.sourceItemIds),
    ["one-early", "one-middle", "one-nearest", "one-tail"], "the whole first response folds, not only its tail");
  assert.deepEqual(granted[1]!.blocks.flatMap(block => block.sourceItemIds),
    ["two-early", "two-middle", "two-nearest", "two-tail"], "the next input stays outside the response work fold");
  assert.deepEqual(later.slice(0, first.length).map(unit => unit.id), first.map(unit => unit.id));
  const open = later.find(unit => unit.blocks.some(block => block.sourceItemIds.includes("three-open")))!;
  assert.equal(resolveAgentActivityLayout(open, true).showToggle, false);
});

test("current reasoning-only work cannot move its Turn clock backwards across a completed response or real boundary", () => {
  for (const boundary of [input("steer"), prose("async", "final_answer", { delivery: "async" }),
    { id: "approval", type: "interaction:approval", payload: { requestId: "approval", state: "accepted" } }]) {
    const timeline = projectTimeline({ key: createConversationKey("fixture", "clock-boundaries"), revision: 1,
      authoritative: true, phase: "live", turns: [{ id: "turn", status: "complete",
        startedAtMs: 1_000, firstTurnWorkItemStartedAtMs: 1_050, finalAssistantStartedAtMs: 4_000, completedAtMs: 4_100,
        items: [work("old-work"), prose("old-answer", "final_answer", { startedAtMs: 4_000 }), boundary, reasoning("new-reasoning-only")],
      }] }, createDefaultTimelineProjectorRegistry());
    const p = createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(timeline)[0]!, undefined, { isMostRecentTurn: true });
    const owners = activities(p).filter(unit => unit.contentUnits.some(content => content.type === "worked-for"));
    assert.equal(owners.length, 1);
    assert.equal(owners[0]!.blocks.some(block => block.sourceItemIds.includes("old-work")), false,
      "finding meaningful work cannot cross a completed answer/input/content boundary");
  }
});

test("cancelled or answerless reasoning chains cannot expose any completed-work fold", () => {
  const sequence = [work("early"), reasoning("middle"), work("nearest"), reasoning("tail")];
  for (const status of ["streaming", "complete", "failed", "interrupted"] as const) {
    const items = status === "interrupted" ? [...sequence, prose("partial-answer", "final_answer", { completed: false })] : sequence;
    const p = plan(items, status);
    for (const unit of activities(p)) {
      assert.equal(resolveAgentActivityLayout(unit, true).showToggle, false);
      assert.equal(resolveAgentActivityLayout(unit, true).isCollapsed, false);
    }
  }
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
