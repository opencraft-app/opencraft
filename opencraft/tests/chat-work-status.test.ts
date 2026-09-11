import assert from "node:assert/strict";
import test from "node:test";
import {
  asTurnId,
  createConversationKey,
  createDefaultTimelineProjectorRegistry,
  projectTimeline,
  deriveTurnWorkStatus,
  deriveWorkStatusLabel,
  formatWorkDuration,
  createAssistantTurnPresentationPlan,
  resolveAgentActivityLayout,
  type TimelineSourceTurn,
} from "@opencraft/chat-core";

const base: TimelineSourceTurn = {
  id: "work-turn",
  status: "streaming",
  startedAtMs: 1_000,
  firstTurnWorkItemStartedAtMs: 1_200,
  finalAssistantStartedAtMs: null,
  items: [
    {
      id: "user",
      type: "userMessage",
      payload: { content: [{ type: "text", text: "Help" }] },
    },
    { id: "reason", type: "reasoning", payload: { summary: [] } },
    {
      id: "command",
      type: "commandExecution",
      payload: { command: "pwd", status: "completed" },
    },
  ],
};
function answer(text: string, completed = false) {
  return {
    id: "final",
    type: "agentMessage",
    payload: { text, phase: "final_answer", completed },
  };
}
function activity(turn: TimelineSourceTurn) {
  const timeline = projectTimeline(
    {
      key: createConversationKey("host", "thread"),
      revision: 1,
      phase: "live",
      authoritative: true,
      turns: [turn],
    },
    createDefaultTimelineProjectorRegistry(),
  );
  const frame = timeline.frames.find((frame) => frame.type === "assistant");
  assert.ok(frame?.type === "assistant");
  return createAssistantTurnPresentationPlan(frame).slots;
}

test("work starts only after observed work; Turn start is the preferred interval origin", () => {
  assert.equal(
    deriveTurnWorkStatus({ ...base, firstTurnWorkItemStartedAtMs: null }),
    null,
  );
  assert.equal(
    deriveTurnWorkStatus({ ...base, items: base.items.slice(0, 1) }),
    null,
  );
  assert.deepEqual(deriveTurnWorkStatus(base), {
    type: "worked-for",
    status: "working",
    startedAtMs: 1_000,
    completedAtMs: null,
  });
  assert.equal(
    deriveTurnWorkStatus({ ...base, startedAtMs: null })?.startedAtMs,
    1_200,
  );
});

test("an empty final placeholder does not stop the clock; renderable final freezes it at start, not Turn completion", () => {
  const turn = {
    ...base,
    finalAssistantStartedAtMs: 3_500,
    items: [...base.items, answer(" ")],
  };
  assert.equal(deriveTurnWorkStatus(turn)?.status, "working");
  const worked = {
    type: "worked-for",
    status: "worked",
    startedAtMs: 1_000,
    completedAtMs: 3_500,
  };
  assert.deepEqual(
    deriveTurnWorkStatus({ ...turn, items: [...base.items, answer("Answer")] }),
    worked,
  );
  assert.deepEqual(
    deriveTurnWorkStatus({ ...turn, items: [...base.items, answer("", true)] }),
    worked,
  );
  assert.deepEqual(
    deriveTurnWorkStatus({
      ...turn,
      status: "complete",
      completedAtMs: 19_000,
      durationMs: 18_000,
    }),
    worked,
  );
});

test("history can use retained Item clocks, but cannot invent clocks from a total duration", () => {
  const turn: TimelineSourceTurn = {
    ...base,
    status: "complete",
    firstTurnWorkItemStartedAtMs: null,
    items: [
      { ...base.items[1]!, payload: { startedAtMs: 1_200 } },
      {
        ...answer("Answer", true),
        payload: {
          text: "Answer",
          phase: "final_answer",
          completed: true,
          startedAtMs: 3_500,
        },
      },
    ],
  };
  assert.equal(deriveTurnWorkStatus(turn)?.completedAtMs, 3_500);
  assert.equal(
    deriveTurnWorkStatus({
      ...base,
      status: "complete",
      durationMs: 9_000,
      items: [...base.items, answer("Answer", true)],
    }),
    null,
  );
});

test("sleep, canceled, no final, and final-only Turns follow original work-item eligibility", () => {
  assert.equal(
    deriveTurnWorkStatus({
      ...base,
      items: [...base.items, { id: "sleep", type: "sleep", payload: {} }],
    }),
    null,
  );
  assert.equal(deriveTurnWorkStatus({ ...base, status: "interrupted" }), null);
  assert.equal(deriveTurnWorkStatus({ ...base, status: "failed" }), null);
  assert.equal(
    deriveTurnWorkStatus({ ...base, items: [answer("Answer")] }),
    null,
  );
});

test("work metadata has one display owner and never enters the expanded work body or its count", () => {
  const slots = activity({
    ...base,
    finalAssistantStartedAtMs: 3_500,
    items: [...base.items, answer("Answer")],
  });
  assert.deepEqual(
    slots.map((slot) => slot.type),
    ["agent-activity", "assistant-content"],
  );
  const unit = slots[0];
  assert.ok(unit?.type === "agent-activity");
  assert.equal(resolveAgentActivityLayout(unit, undefined).isCollapsed, true);
  const layout = resolveAgentActivityLayout(unit, false);
  assert.equal(layout.showToggle, true);
  assert.equal(layout.collapsedItemCount, 1);
  assert.equal(layout.workedForItem?.completedAtMs, 3_500);
  assert.ok(!layout.visibleUnits.some((unit) => unit.type === "worked-for"));
  assert.deepEqual(
    unit.blocks.map((block) => block.type),
    ["reasoning", "command-execution"],
  );
});

test("empty completed final content closes the same disclosure boundary as the work clock", () => {
  const slots = activity({
    ...base,
    finalAssistantStartedAtMs: 3_500,
    items: [...base.items, answer("", true)],
  });
  const unit = slots[0];
  assert.ok(unit?.type === "agent-activity");
  assert.equal(unit.hasFinalAssistantStarted, true);
  assert.equal(resolveAgentActivityLayout(unit, undefined).isCollapsed, true);
  assert.equal(
    resolveAgentActivityLayout(unit, true).workedForItem?.status,
    "worked",
  );
});

test("unpartitioned work divider keeps the live/settled position and a stable identity", () => {
  const live = activity(base)[0];
  const done = activity({
    ...base,
    status: "complete",
    finalAssistantStartedAtMs: 3_500,
    items: [...base.items, answer("Answer", true)],
  })[0];
  assert.ok(live?.type === "agent-activity" && done?.type === "agent-activity");
  assert.equal(live.contentUnits[0]?.type, "worked-for");
  assert.equal(done.contentUnits.at(-1)?.type, "worked-for");
  assert.equal(live.contentUnits[0]?.id, done.contentUnits.at(-1)?.id);
  assert.equal(resolveAgentActivityLayout(live, false).workedForItem, null);
});

test("displayable unphased text does not acquire final-answer collapse authority", () => {
  const slots = activity({ ...base, items: [...base.items, {
    id: "answer", type: "agentMessage", payload: { text: "A visible answer", completed: false },
  }] });
  const unit = slots.find(slot => slot.type === "agent-activity");
  assert.ok(unit?.type === "agent-activity");
  assert.equal(unit.hasFinalAssistantStarted, false);
  assert.equal(resolveAgentActivityLayout(unit, undefined).showToggle, false);
  assert.ok(slots.some(slot => slot.type === "assistant-content"));
});

test("a completed single-item group keeps its Unit identity when demoted", () => {
  const before = activity(base)[0];
  const after = activity({ ...base, items: [...base.items, answer("Answer")] })[0];
  assert.ok(before?.type === "agent-activity" && after?.type === "agent-activity");
  const group = before.contentUnits.find(unit => unit.type === "group");
  const row = after.contentUnits.find(unit => unit.type === "standalone");
  assert.ok(group && row);
  assert.equal(group.id, row.id);
});

test("a hidden work row before a transcript still places the live divider before the transcript", () => {
  const unit = createAssistantTurnPresentationPlan({
    type: "assistant",
    id: "frame",
    turnId: asTurnId("turn"),
    status: "streaming",
    durationMs: null,
    hookStats: null,
    anchors: [],
    workStatus: deriveTurnWorkStatus(base),
    blocks: [
      {
        type: "reasoning",
        id: "reason",
        sourceItemIds: [],
        summary: "",
        detail: null,
        streaming: true,
      },
      {
        type: "realtime-transcript",
        id: "handoff",
        sourceItemIds: [],
        handoffId: "handoff",
        entries: [{ role: "user", text: "Continue" }],
      },
      {
        type: "text",
        id: "progress",
        sourceItemIds: [],
        text: "Inspecting",
        phase: "commentary",
        streaming: true,
      },
    ],
  }).slots[0];
  assert.ok(unit?.type === "agent-activity");
  assert.equal(unit.contentUnits[0]?.type, "worked-for");
  const transcript = unit.contentUnits[1];
  assert.ok(
    transcript?.type === "standalone" &&
      transcript.block.type === "realtime-transcript",
  );
});

test("duration-only hidden work cannot manufacture a header; known interval still renders standalone", () => {
  const turn: TimelineSourceTurn = {
    ...base,
    status: "complete",
    durationMs: 8_000,
    items: [base.items[1]!, answer("Answer", true)],
  };
  assert.deepEqual(
    activity(turn).map((slot) => slot.type),
    ["assistant-content"],
  );
  const known = activity({ ...turn, finalAssistantStartedAtMs: 3_500 })[0];
  assert.ok(known?.type === "agent-activity");
  const layout = resolveAgentActivityLayout(known, false);
  assert.equal(layout.showToggle, false);
  assert.deepEqual(
    layout.visibleUnits.map((unit) => unit.type),
    ["worked-for"],
  );
});

test("You stopped is client-owned, not a synonym for every interrupted Turn", () => {
  const remote = activity({
    ...base,
    status: "interrupted",
    durationMs: 4_000,
  })[0];
  const local = activity({
    ...base,
    status: "interrupted",
    durationMs: 4_000,
    interruptedByThisClient: true,
  })[0];
  assert.ok(
    remote?.type === "agent-activity" && local?.type === "agent-activity",
  );
  assert.ok(!remote.contentUnits.some((unit) => unit.type === "worked-for"));
  assert.equal(
    local.contentUnits.find((unit) => unit.type === "worked-for")?.item.status,
    "stopped",
  );
});

test("formatting and label thresholds reproduce Codex without rounding or losing seconds", () => {
  assert.equal(formatWorkDuration(900), "0s");
  assert.equal(formatWorkDuration(1_600), "1s");
  assert.equal(formatWorkDuration(60_000), "1m");
  assert.equal(formatWorkDuration(3_601_000), "1h 1s");
  assert.equal(formatWorkDuration(86_401_000), "1d 1s");
  const item = {
    type: "worked-for" as const,
    status: "working" as const,
    startedAtMs: 1_000,
    completedAtMs: null,
  };
  assert.equal(deriveWorkStatusLabel(item, 1_999).messageId, "working");
  assert.equal(deriveWorkStatusLabel(item, 2_000).messageId, "workingFor");
  assert.equal(
    deriveWorkStatusLabel(
      { ...item, status: "worked", completedAtMs: 2_600 },
      99_000,
    ).time,
    "1s",
  );
});
