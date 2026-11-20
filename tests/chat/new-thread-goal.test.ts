import assert from "node:assert/strict";
import { SubmissionOutcomeUnknownError } from "@opencraft/chat-runtime";
import test from "node:test";
import type { SubmitIntent, SubmissionReceipt } from "@opencraft/composer-core";
import type { ThreadGoal } from "@opencraft/appserver-protocol/generated/v2";
import { ThreadGoalResource } from "../../packages/workbench-runtime/src/thread-goal-resource";
import { createNewThreadGoalFlow } from "../../apps/workbench-web/src/runtime/new-thread-goal";

const intent = (): SubmitIntent => ({
  commandId: "command", clientMessageId: "message", createdAt: 1,
  target: { type: "new-thread", draftId: "draft", execution: { hostId: "local", workspace: { cwd: "/project", runtimeWorkspaceRoots: ["/project"] } } },
  document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "objective" }] }] },
  attachments: [], context: [], selections: { model: "model" }, options: { autoContext: true },
});
const receipt: SubmissionReceipt = { commandId: "command", clientMessageId: "message", hostId: "local", threadId: "new", turnId: null, acceptedAt: 1, replayed: false };
function fixture() {
  let goal: ThreadGoal | null = null;
  const calls: string[] = [];
  const state = { current: true, readonly: false, failWrite: false, rejectWrite: false, lostAck: false, failReadAfterSet: false, failRead: false, failOpen: false };
  const goals = new ThreadGoalResource({
    capability: () => ({ version: 1, read: true, write: !state.readonly }),
    get: async () => { calls.push("get"); if (state.failRead) throw new Error("confirmation failed"); return { goal }; },
    set: async (threadId, change) => {
      calls.push("set"); if (state.rejectWrite) throw { code: -32009, data: { reason: "goal_version_conflict" } }; if (state.failWrite) throw new Error("write failed");
      goal = { threadId, objective: change.objective!, status: change.status!, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
      if (state.lostAck) throw new Error("lost acknowledgement");
      if (state.failReadAfterSet) state.failRead = true;
      return { goal };
    },
    clear: async () => ({ cleared: true }),
  });
  const flow = createNewThreadGoalFlow({
    createThread: async value => { calls.push("create"); assert.equal(value.target.type, "new-thread"); return receipt; },
    goals: () => goals,
    openThread: async () => { calls.push("open"); if (state.failOpen) throw new Error("navigation failed"); },
  });
  return { flow, calls, state, goals, complete: () => { goal = { ...goal!, status: "complete" }; }, isCurrent: () => state.current };
}

test("a new conversation starts a native Goal without sending a user Turn", async () => {
  const f = fixture();
  assert.equal(await f.flow(intent(), "objective", f.isCurrent), receipt);
  assert.deepEqual(f.calls, ["create", "get", "set", "open"]);
  assert.equal(f.goals.getSnapshot("new").goal?.status, "active");
});
test("concurrent confirmation is single-flight", async () => {
  const f = fixture(), command = intent();
  const first = f.flow(command, "objective", f.isCurrent);
  const second = f.flow(command, "objective", f.isCurrent);
  assert.equal(first, second);
  await first;
  assert.equal(f.calls.filter(call => call === "create").length, 1);
  assert.equal(f.calls.filter(call => call === "set").length, 1);
});
test("a rejected Goal write retries against the same newly created Thread", async () => {
  const f = fixture(), command = intent();
  f.state.rejectWrite = true;
  await assert.rejects(f.flow(command, "objective", f.isCurrent), { code: "conflict" });
  f.state.rejectWrite = false;
  await f.flow({ ...command, commandId: "retry" }, "objective", f.isCurrent);
  assert.equal(f.calls.filter(call => call === "create").length, 1);
});
test("an acknowledged Goal does not require a readback before navigation", async () => {
  const f = fixture(), command = intent();
  f.state.failReadAfterSet = true;
  await f.flow(command, "objective", f.isCurrent);
  assert.equal(f.goals.getSnapshot("new").goal?.objective, "objective");
  assert.deepEqual(f.calls, ["create", "get", "set", "open"]);
});
test("unknown Goal writes cannot be confirmed by objective text or blindly replayed", async () => {
  const f = fixture(), command = intent();
  f.state.lostAck = true;
  await assert.rejects(f.flow(command, "objective", f.isCurrent), { code: "outcomeUnknown" });
  f.complete(); f.state.lostAck = false;
  const calls = [...f.calls];
  await assert.rejects(f.flow({ ...command, commandId: "retry" }, "objective", f.isCurrent), { code: "outcomeUnknown" });
  assert.deepEqual(f.calls, calls);
  assert.equal(f.calls.includes("open"), false);
});
test("navigation failure retries neither Thread creation nor Goal activation", async () => {
  const f = fixture(), command = intent();
  f.state.failOpen = true;
  await assert.rejects(f.flow(command, "objective", f.isCurrent), /navigation failed/);
  f.state.failOpen = false;
  await f.flow(command, "objective", f.isCurrent);
  assert.equal(f.calls.filter(call => call === "create").length, 1);
  assert.equal(f.calls.filter(call => call === "set").length, 1);
});
test("leaving a Draft while thread/start is pending cannot start its Goal or steal navigation", async () => {
  const f = fixture(), command = intent();
  const pending = f.flow(command, "objective", f.isCurrent);
  f.state.current = false;
  await assert.rejects(pending, /changed before/);
  assert.deepEqual(f.calls, ["create"]);
});
test("late Goal confirmation cannot steal a new navigation intent", async () => {
  const f = fixture();
  const stop = f.goals.subscribe("new", () => { if (f.goals.getSnapshot("new").goal) f.state.current = false; });
  await f.flow(intent(), "objective", f.isCurrent);
  assert.equal(f.calls.includes("open"), false);
  stop();
});
test("read-only, stale, and empty submissions allocate no Thread", async () => {
  const f = fixture();
  f.state.readonly = true;
  await assert.rejects(f.flow(intent(), "objective", f.isCurrent), /cannot create goals/);
  f.state.readonly = false; f.state.current = false;
  await assert.rejects(f.flow(intent(), "objective", f.isCurrent), /no longer active/);
  f.state.current = true;
  await assert.rejects(f.flow(intent(), "  ", f.isCurrent));
  assert.deepEqual(f.calls, []);
});

test("an unknown thread/start outcome is never blindly replayed", async () => {
  const f = fixture();
  let creates = 0;
  const flow = createNewThreadGoalFlow({
    createThread: async () => { creates++; throw new SubmissionOutcomeUnknownError({ cause: new Error("lost response") }); },
    goals: () => f.goals,
    openThread: async () => { throw new Error("must not navigate"); },
  });
  const command = intent();
  await assert.rejects(flow(command, "objective", f.isCurrent), /结果尚未确认/);
  await assert.rejects(flow(command, "objective", f.isCurrent), /结果尚未确认/);
  assert.equal(creates, 1);
});

test("leaving a draft during Goal preflight cannot dispatch its mutation", async () => {
  let current = true, sets = 0, opens = 0;
  let resolve!: (value: { goal: ThreadGoal | null; version: string }) => void;
  const read = new Promise<{ goal: ThreadGoal | null; version: string }>(done => { resolve = done; });
  const goals = new ThreadGoalResource({ capability: () => ({ version: 1, read: true, write: true }), get: () => read, set: async () => { sets++; throw new Error("must not write"); }, clear: async () => ({ cleared: true }) });
  const flow = createNewThreadGoalFlow({ createThread: async () => receipt, goals: () => goals, openThread: async () => { opens++; } });
  const pending = flow(intent(), "objective", () => current);
  await new Promise(done => setImmediate(done));
  current = false; resolve({ goal: null, version: "0" });
  await assert.rejects(pending, /changed before/);
  assert.equal(sets, 0); assert.equal(opens, 0);
});
