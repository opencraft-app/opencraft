import assert from "node:assert/strict";
import test from "node:test";
import {
  agentActivityHeaderAccessibleLabel, countAgentActivityContentItems,
  createAssistantTurnPresentationPlan, createConversationKey,
  createDefaultTimelineProjectorRegistry, deriveAgentActivityHeaderPresentation,
  projectTimeline, resolveAgentActivityLayout,
  type AssistantTimelineFrame, type TimelineSourceItem, type TimelineStatus, type ConversationPhase,
} from "@opencraft/chat-core";

function frame(items: readonly TimelineSourceItem[], status: TimelineStatus = "complete", phase: ConversationPhase = "live"): AssistantTimelineFrame {
  const snapshot = projectTimeline({
    key: createConversationKey("fixture", "independent-activity"), revision: 1,
    phase, authoritative: true, turns: [{ id: "turn", status, items }],
  }, createDefaultTimelineProjectorRegistry());
  const result = snapshot.frames.find(frame => frame.type === "assistant");
  assert.ok(result?.type === "assistant");
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const command: TimelineSourceItem = { id: "command", type: "commandExecution", payload: { command: "pwd", status: "completed" } };
const answer: TimelineSourceItem = { id: "answer", type: "agentMessage", payload: { phase: "final_answer", text: "Done", completed: true } };

test("a completed singleton retains the content owner of its running group", () => {
  const content = (value: AssistantTimelineFrame) => {
    const activity = createAssistantTurnPresentationPlan(value).slots.find(slot => slot.type === "agent-activity");
    assert.ok(activity?.type === "agent-activity");
    return activity.contentUnits[0]!;
  };
  const running = content(frame([{ ...command, payload: { command: "pwd", status: "inProgress" } }], "streaming"));
  const completed = content(frame([command]));
  assert.equal(running.type, "group");
  assert.equal(completed.type, "standalone");
  assert.equal(completed.id, running.id);
  assert.ok(completed.type === "standalone" && completed.groupOrigin);
});

test("repeated changes to one path retain a singular completed file summary", () => {
  const value = frame(["first", "second"].map(id => ({
    id, type: "fileChange", payload: { status: "completed", changes: [{ path: "same.ts", kind: "update" }] },
  })));
  const header = deriveAgentActivityHeaderPresentation({ blocks: value.blocks, lifecycle: {
    isLatestVisibleUnit: true, isActivitySliceClosed: true, isExploring: false, inProgress: false,
  } });
  assert.equal(agentActivityHeaderAccessibleLabel(header.summary), "Edited a file");
});

test("a standalone work clock is visible metadata and cannot grant a disclosure by itself", () => {
  const value = frame([{ id: "hidden", type: "reasoning", payload: { summary: [] } }, answer]);
  const plan = createAssistantTurnPresentationPlan({ ...value, workStatus: {
    type: "worked-for", status: "worked", startedAtMs: 100, completedAtMs: 1400,
  } });
  const work = plan.slots[0];
  assert.ok(work?.type === "agent-activity");
  assert.equal(countAgentActivityContentItems(work.contentUnits), 1);
  assert.equal(work.collapsedItemCount, 0);
  const layout = resolveAgentActivityLayout(work, true);
  assert.equal(layout.showToggle, false);
  assert.equal(layout.collapsedItemCount, 1);
  assert.deepEqual(layout.visibleUnits.map(unit => unit.type), ["worked-for"]);
});

test("client cancellation replaces a stale working clock without changing frozen observations", () => {
  const value = freeze({ ...frame([command, answer]), status: "interrupted" as const,
    interruptedByThisClient: true, durationMs: 1300, workStatus: {
      type: "worked-for" as const, status: "working" as const, startedAtMs: 100, completedAtMs: null,
    } });
  const before = structuredClone(value);
  const first = createAssistantTurnPresentationPlan(value);
  assert.deepEqual(createAssistantTurnPresentationPlan(structuredClone(value)), first);
  assert.deepEqual(value, before);
  const work = first.slots[0];
  assert.ok(work?.type === "agent-activity");
  assert.deepEqual(work.contentUnits.find(unit => unit.type === "worked-for")?.item, {
    type: "worked-for", status: "stopped", startedAtMs: 0, completedAtMs: 1300,
  });
  assert.equal(resolveAgentActivityLayout(work, true).isCollapsed, false);
});

test("a patch changing multiple files keeps its group across terminal states", () => {
  for (const status of ["streaming", "complete", "failed", "interrupted"] as const) {
    for (const files of [1, 2]) {
      const item: TimelineSourceItem = { id: "patch", type: "fileChange", payload: {
        status: status === "failed" ? "failed" : "completed",
        changes: Array.from({ length: files }, (_, index) => ({
          path: `file-${index}.ts`, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new",
        })),
      } };
      const plan = createAssistantTurnPresentationPlan(frame([item], status));
      const activity = plan.slots.find(slot => slot.type === "agent-activity");
      assert.ok(activity?.type === "agent-activity");
      assert.equal(activity.contentUnits[0]?.type, files > 1 || status === "streaming" ? "group" : "standalone");
      const historical = createAssistantTurnPresentationPlan(frame([item], status, "painted"));
      assert.equal(historical.slots.find(slot => slot.type === "agent-activity")?.contentUnits[0]?.type,
        activity.contentUnits[0]?.type);
    }
  }
});


test("a single visible compaction stays readable when neighboring Items have no body", () => {
  const hidden: TimelineSourceItem[] = [
    { id: "empty-reasoning", type: "reasoning", payload: { summary: [], content: [] } },
    { id: "empty-patch", type: "fileChange", payload: { status: "completed", changes: [] } },
  ];
  const compaction: TimelineSourceItem = { id: "compaction", type: "contextCompaction", payload: { completed: true } };
  for (const phase of ["live", "painted"] as const) {
    for (const items of [[...hidden, compaction, answer], [compaction, ...hidden, answer]]) {
      const activity = createAssistantTurnPresentationPlan(frame(items, "complete", phase)).slots.find(slot => slot.type === "agent-activity");
      assert.ok(activity?.type === "agent-activity");
      for (const choice of [undefined, true, false]) {
        const layout = resolveAgentActivityLayout(activity, choice);
        assert.equal(layout.showToggle, false);
        assert.equal(layout.isCollapsed, false);
        assert.equal(layout.visibleUnits.filter(unit => unit.type === "standalone" && unit.block.type === "compaction").length, 1);
      }
    }
  }
});

test("compaction accompanied by visible work retains the normal disclosure", () => {
  const compaction: TimelineSourceItem = { id: "compaction", type: "contextCompaction", payload: { completed: true } };
  for (const companion of [command, { ...compaction, id: "second-compaction" }]) {
    const activity = createAssistantTurnPresentationPlan(frame([compaction, companion, answer])).slots.find(slot => slot.type === "agent-activity");
    assert.ok(activity?.type === "agent-activity");
    assert.equal(resolveAgentActivityLayout(activity).showToggle, true);
    assert.equal(resolveAgentActivityLayout(activity, false).isCollapsed, false);
    assert.equal(resolveAgentActivityLayout(activity, true).isCollapsed, true);
  }
});


test("running ordinary commands retain their concrete label when the classifier returns unknown actions", () => {
  for (const commandText of ["printf fixture", "bash -lc 'printf fixture'", "  printf fixture  ", "   "]) {
    for (const commandActions of [[], [{ type: "unknown", command: commandText }], [
      { type: "unknown", command: "printf first" }, { type: "unknown", command: "printf second" },
    ]]) {
      const value = frame([{ id: "running", type: "commandExecution", payload: {
        command: commandText, commandActions, status: "inProgress",
      } }], "streaming");
      const unit = { blocks: value.blocks, lifecycle: {
        isLatestVisibleUnit: true, isActivitySliceClosed: false, isExploring: false, inProgress: true,
      } };
      assert.equal(agentActivityHeaderAccessibleLabel(deriveAgentActivityHeaderPresentation(unit).summary),
        `Running ${(commandActions.length > 1 ? "printf second" : commandText).trim() || "command"}`);
      assert.equal(agentActivityHeaderAccessibleLabel(deriveAgentActivityHeaderPresentation(unit, undefined, "STEPS_PROSE").summary),
        "Running command");
    }
  }
});

test("running classified exploration retains its semantic label at both detail levels", () => {
  for (const [commandText, action, expected] of [
    ["cat fixture.ts", { type: "read", command: "cat fixture.ts", name: "fixture.ts", path: "/fixture/fixture.ts" }, "Reading fixture.ts"],
    ["rg needle fixture.ts", { type: "search", command: "rg needle fixture.ts", query: "needle", path: "fixture.ts" }, "Searching for needle in fixture.ts"],
    ["ls fixture", { type: "listFiles", command: "ls fixture", path: "fixture" }, "Listing files in fixture"],
  ] as const) {
    const value = frame([{ id: "running", type: "commandExecution", payload: {
      command: commandText, commandActions: [action], status: "inProgress",
    } }], "streaming");
    for (const detail of ["STEPS_COMMANDS", "STEPS_PROSE"] as const) {
      const header = deriveAgentActivityHeaderPresentation({ blocks: value.blocks, lifecycle: {
        isLatestVisibleUnit: true, isActivitySliceClosed: false, isExploring: true, inProgress: true,
      } }, undefined, detail);
      assert.equal(agentActivityHeaderAccessibleLabel(header.summary), expected);
    }
  }
});

test("hidden work before an earlier response does not leave an empty activity slot", () => {
  const hidden: TimelineSourceItem = { id: "hidden", type: "reasoning", payload: { summary: [], content: [] } };
  const reasoning: TimelineSourceItem = { id: "visible", type: "reasoning", payload: { content: ["Inspecting mobile"] } };
  for (const earlier of [
    { id: "partial", type: "agentMessage", payload: { phase: "partial_answer", text: "First response.", completed: true } },
    { id: "async", type: "agentMessage", payload: { phase: "commentary", delivery: "async", questions: null, text: "Which constraint matters?", completed: true } },
  ] satisfies TimelineSourceItem[]) {
    for (const status of ["streaming", "complete"] as const) {
      for (const phase of ["live", "painted"] as const) {
        const value = freeze({ ...frame([hidden, earlier, reasoning, answer], status, phase), workStatus: status === "streaming"
          ? { type: "worked-for" as const, status: "working" as const, startedAtMs: 100, completedAtMs: null }
          : { type: "worked-for" as const, status: "worked" as const, startedAtMs: 100, completedAtMs: 1400 } });
        const before = structuredClone(value);
        const plan = createAssistantTurnPresentationPlan(value);
        assert.deepEqual(plan.slots.map(slot => slot.type), ["assistant-content", "agent-activity", "assistant-content"]);
        const activity = plan.slots[1];
        assert.ok(activity?.type === "agent-activity");
        assert.equal(activity.contentUnits.filter(unit => unit.type === "worked-for").length, 1);
        assert.equal(activity.contentUnits.filter(unit => unit.type === "reasoning").length, 1);
        assert.deepEqual(plan.slots.filter(slot => slot.type === "assistant-content").map(slot => slot.block.sourceItemIds[0]), [earlier.id, answer.id]);
        assert.deepEqual(value, before);
        assert.deepEqual(createAssistantTurnPresentationPlan(structuredClone(value)), plan);
      }
    }
  }
});
