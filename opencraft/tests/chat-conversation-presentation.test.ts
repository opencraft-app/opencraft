import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantMessageActions,
  compactionLabel,
  createAssistantTurnPresentationPlan,
  createTimelineTurnPresentationPlan,
  createConversationKey,
  createDefaultTimelineProjectorRegistry,
  createAgentActivityContentUnits,
  deriveAgentActivityHeaderPresentation,
  groupTimelineFramesByTurn,
  projectTimeline,
  skillReadPresentation,
  shouldRenderAgentThinkingPlaceholder,
  type TimelineSourceTurn,
} from "@opencraft/chat-core";
import {
  createEmptyThreadView,
  registerBuiltinThreadProjectors,
  type ThreadNotificationProjector,
} from "@opencraft/appserver-session";

test("a historical unfinished todo cannot retain current Activity ownership", () => {
  const todo = (id: string, status: string) => ({ id, type: "todo-list", payload: { plan: [{ step: "Inspect", status }] } });
  assert.equal(shouldRenderAgentThinkingPlaceholder(frame([todo("a", "inProgress")])), false);
  assert.equal(shouldRenderAgentThinkingPlaceholder(frame([todo("a", "inProgress"), todo("b", "completed")])), true);
  assert.equal(shouldRenderAgentThinkingPlaceholder(frame([{ id: "c", type: "contextCompaction", payload: { completed: false } }])), false);
});

function frame(
  items: TimelineSourceTurn["items"],
  status: TimelineSourceTurn["status"] = "streaming",
) {
  const timeline = projectTimeline(
    {
      key: createConversationKey("fixture", "thread"),
      revision: 1,
      phase: "live",
      authoritative: true,
      turns: [{ id: "turn", status, items }],
    },
    createDefaultTimelineProjectorRegistry(),
  );
  const result = timeline.frames.find((frame) => frame.type === "assistant");
  if (result?.type !== "assistant") throw new Error("Missing assistant frame");
  return result;
}

test("plan observations retain separate identities and use the original todo ABI", () => {
  const projectors: ThreadNotificationProjector[] = [];
  registerBuiltinThreadProjectors({
    threadResumeProjectors: { register: () => () => {} },
    threadNotificationProjectors: {
      register: (projector: ThreadNotificationProjector) => {
        projectors.push(projector);
        return () => {};
      },
    },
  } as never);
  let view = createEmptyThreadView("fixture", "thread");
  for (const status of ["pending", "inProgress", "completed"]) {
    for (const projector of projectors.sort(
      (a, b) => a.priority - b.priority,
    )) {
      view = projector.project(view, {
        method: "turn/plan/updated",
        params: {
          threadId: "thread",
          turnId: "turn",
          explanation: "Do this first",
          plan: [{ step: "Inspect source", status }],
        },
      } as never);
    }
  }
  const items = view.turns[0]!.items!;
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map((item) => item.id)).size, 3);
  assert.equal(view.turns[0]!.plan, undefined);
  const result = frame(
    items.map((item) => ({ id: item.id, type: item.type, payload: item })),
    "complete",
  );
  assert.deepEqual(
    result.blocks.map((block) =>
      block.type === "todo"
        ? [block.explanation, block.entries[0]?.text, block.entries[0]?.status]
        : null,
    ),
    [
      ["Do this first", "Inspect source", "pending"],
      ["Do this first", "Inspect source", "in-progress"],
      ["Do this first", "Inspect source", "complete"],
    ],
  );
  const activity = createAssistantTurnPresentationPlan(result).slots[0];
  assert.equal(activity, undefined, "todo observations never become transcript Activity rows");

  const timeline = projectTimeline({
    key: createConversationKey("fixture", "thread"),
    revision: 2,
    phase: "live",
    authoritative: true,
    turns: [{ id: "turn", status: "streaming", items: items.map((item) => ({ id: item.id, type: item.type, payload: item })) }],
  }, createDefaultTimelineProjectorRegistry());
  const turn = groupTimelineFramesByTurn(timeline)[0];
  if (turn === undefined) throw new Error("Missing Turn");
  const live = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
  assert.equal(live.activeTodo?.entries[0]?.status, "complete");
  assert.equal(live.activeTodo?.id, `todo:${items.at(-1)?.id}`);
  assert.equal(live.assistant?.slots.some((slot) => slot.type === "assistant-content" && slot.block.type === "todo"), false);
  assert.equal(createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: false }).activeTodo, null);
});

test("implementation records cannot claim completion or replace the proposal", () => {
  const result = frame([
    {
      id: "plan",
      type: "plan",
      payload: { text: "# A\n- inspect", completed: true },
    },
    {
      id: "implementation",
      type: "planImplementation",
      payload: {
        turnId: "origin",
        planContent: "# A\n- inspect",
        isCompleted: false,
      },
    },
  ]);
  const record = result.blocks.find(
    (block) => block.type === "plan-implementation",
  );
  assert.deepEqual(
    record && {
      turnId: record.turnId,
      text: record.planContent,
      completed: record.isCompleted,
    },
    { turnId: "origin", text: "# A\n- inspect", completed: false },
  );
  const slots = createAssistantTurnPresentationPlan(result).slots;
  assert.equal(slots.length, 1);
  assert.equal(
    slots[0]?.type === "assistant-content" && slots[0].block.type,
    "plan",
  );
});

test("the latest proposal owns one stable slot, with explicit writing/completed states", () => {
  const items = [
    { id: "a", type: "plan", payload: { text: "old" } },
    { id: "b", type: "plan", payload: { text: "new" } },
  ];
  const live = createAssistantTurnPresentationPlan(frame(items)).slots[0];
  const done = createAssistantTurnPresentationPlan(frame(items, "complete"))
    .slots[0];
  assert.equal(live?.id, done?.id);
  assert.equal(
    live?.type === "assistant-content" &&
      live.block.type === "plan" &&
      live.block.completed,
    false,
  );
  assert.equal(
    done?.type === "assistant-content" &&
      done.block.type === "plan" &&
      done.block.completed,
    true,
  );
});

test("compaction keeps source and completion through live and historical projections", () => {
  for (const source of ["manual", "automatic"]) {
    const item = {
      id: "c",
      type: "contextCompaction",
      payload: { source, completed: false },
    };
    const live = frame([item]).blocks[0];
    const done = frame([item], "complete").blocks[0];
    if (live.type !== "compaction" || done.type !== "compaction")
      throw new Error("Wrong block");
    assert.equal(live.completed, false);
    assert.equal(done.completed, true);
    assert.equal(
      compactionLabel(live),
      source === "manual"
        ? "Compacting context"
        : "Context automatically compacting",
    );
    assert.equal(
      compactionLabel(done),
      source === "manual"
        ? "Context compacted"
        : "Context automatically compacted",
    );
    assert.equal(
      compactionLabel(live, true),
      source === "manual"
        ? "Compacting context"
        : "Optimizing the conversation",
    );
  }
  const historical = frame([
    { id: "c", type: "contextCompaction", payload: {} },
  ]).blocks[0];
  assert.equal(historical.type === "compaction" && historical.completed, true);
  assert.equal(
    historical.type === "compaction" && historical.source,
    "automatic",
  );
});

test("completed message keeps actions when its Turn later fails; streaming cannot copy", () => {
  const item = {
    id: "answer",
    type: "agentMessage",
    payload: { text: "**Answer**", phase: "final_answer", startedAtMs: 1234 },
  };
  assert.equal(assistantMessageActions(frame([item]))?.completed, false);
  const actions = assistantMessageActions(frame([item], "failed"));
  assert.equal(actions?.completed, true);
  assert.equal(actions?.sentAtMs, 1234);
  assert.equal(actions?.copyText, "**Answer**");
  assert.equal(
    assistantMessageActions(
      frame([{ ...item, payload: { ...item.payload, phase: "commentary" } }]),
    ),
    null,
  );
});

test("detail mode controls command summaries without changing execution facts", () => {
  const result = frame([
    {
      id: "cmd",
      type: "commandExecution",
      payload: { command: "npm test", status: "inProgress" },
    },
  ]);
  const group = createAgentActivityContentUnits(
    result.blocks,
    "streaming",
  ).find((unit) => unit.type === "group")!;
  assert.deepEqual(
    deriveAgentActivityHeaderPresentation(group, undefined, "STEPS_PROSE")
      .summary,
    { kind: "text", text: "Running command" },
  );
  assert.notDeepEqual(
    deriveAgentActivityHeaderPresentation(group, undefined, "STEPS_COMMANDS")
      .summary,
    { kind: "text", text: "Running command" },
  );
  const skill = frame([
    {
      id: "read",
      type: "commandExecution",
      payload: {
        command: "cat /root/.codex/skills/review/SKILL.md",
        status: "inProgress",
        commandActions: [
          {
            type: "read",
            name: "SKILL.md",
            path: "/root/.codex/skills/review/SKILL.md",
          },
        ],
      },
    },
  ]).blocks[0];
  if (skill.type !== "command-execution") throw new Error("Wrong block");
  assert.equal(skillReadPresentation(skill, "STEPS_PROSE")?.visible, true);
  assert.equal(skillReadPresentation(skill, "STEPS_COMMANDS")?.visible, false);
});
