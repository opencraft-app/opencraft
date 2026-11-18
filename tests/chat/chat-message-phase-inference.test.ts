import assert from "node:assert/strict";
import test from "node:test";
import { inferSettledMessagePhases, type TimelineSourceTurn } from "../../packages/chat-core/src/index";

const item = (id: string, type: string, payload: Record<string, unknown> = {}) => ({ id, type, payload });
const turn = (status: TimelineSourceTurn["status"], items: TimelineSourceTurn["items"]): TimelineSourceTurn => ({
  id: "t",
  status,
  items,
});
const phases = (value: TimelineSourceTurn) =>
  value.items.filter((i) => i.type === "agentMessage").map((i) => (i.payload as any).phase ?? null);

test("settled turns derive missing phases from structure", () => {
  const result = inferSettledMessagePhases(
    turn("complete", [
      item("u", "userMessage"),
      item("m1", "agentMessage", { text: "looking" }),
      item("c1", "commandExecution"),
      item("m2", "agentMessage", { text: "still" }),
      item("r", "reasoning"),
      item("m3", "agentMessage", { text: "done" }),
    ]),
  );
  assert.deepEqual(phases(result), ["commentary", "commentary", "final_answer"]);
});

test("explicit phases, async deliveries and running turns are left untouched", () => {
  const items = [
    item("u", "userMessage"),
    item("m1", "agentMessage", { phase: "commentary" }),
    item("c", "commandExecution"),
    item("q", "agentMessage", { delivery: "async" }),
    item("m2", "agentMessage", { phase: "final_answer" }),
  ];
  const settled = turn("complete", items);
  assert.equal(inferSettledMessagePhases(settled), settled, "nothing unknown: same object");
  const running = turn("streaming", [item("u", "userMessage"), item("m", "agentMessage", { text: "interim" })]);
  assert.equal(inferSettledMessagePhases(running), running, "a live answer may still be followed by work");
  assert.equal(
    phases(inferSettledMessagePhases(turn("complete", [item("q", "agentMessage", { delivery: "async" })])))[0],
    null,
  );
});

test("each request segment of a steered turn has its own answer", () => {
  const result = inferSettledMessagePhases(
    turn("complete", [
      item("u", "userMessage"),
      item("c", "commandExecution"),
      item("a1", "agentMessage"),
      item("s", "steeringUserMessage"),
      item("c2", "commandExecution"),
      item("a2", "agentMessage"),
      item("x", "turnDiff"),
    ]),
  );
  assert.deepEqual(phases(result), ["final_answer", "final_answer"]);
});

test("phase-aware providers retain deliberate unqualified boundaries", () => {
  const result = inferSettledMessagePhases(
    turn("failed", [
      item("u", "userMessage"),
      item("m", "agentMessage"),
      item("f", "agentMessage", { phase: "final_answer" }),
    ]),
  );
  assert.deepEqual(phases(result), [null, "final_answer"]);
});

test("failed and interrupted phase-less turns retain structural work boundaries", () => {
  for (const status of ["failed", "interrupted"] as const) {
    assert.deepEqual(
      phases(
        inferSettledMessagePhases(
          turn(status, [item("a", "agentMessage"), item("tool", "commandExecution"), item("b", "agentMessage")]),
        ),
      ),
      ["commentary", "final_answer"],
    );
  }
});

test("timeline projection applies inferred phases without mutating persisted items", async () => {
  const { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } = await import(
    "../../packages/chat-core/src/index"
  );
  const input = turn("complete", [
    item("u", "userMessage", { text: "hello" }),
    item("a", "agentMessage", { text: "working", completed: true }),
    item("c", "commandExecution", { command: "pwd", status: "completed" }),
    item("b", "agentMessage", { text: "answer", completed: true }),
  ]);
  const before = JSON.stringify(input);
  const snapshot = projectTimeline(
    { key: createConversationKey("fixture", "phase"), revision: 1, phase: "live", authoritative: true, turns: [input] },
    createDefaultTimelineProjectorRegistry(),
  );
  const assistant = snapshot.frames.find((frame) => frame.type === "assistant");
  assert.ok(assistant && assistant.type === "assistant");
  assert.deepEqual(
    assistant.blocks.filter((block) => block.type === "text").map((block) => block.phase),
    ["commentary", "final_answer"],
  );
  assert.equal(JSON.stringify(input), before);
});
