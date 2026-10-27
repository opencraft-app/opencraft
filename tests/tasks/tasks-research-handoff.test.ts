import assert from "node:assert/strict";
import { test } from "node:test";
import { TASKS, type TaskDetail, type TaskEvent, type TasksRequestPort } from "@opencraft/appserver-protocol";
import { HUMAN_WAIT_THRESHOLD_MS, RESEARCH_HANDOFF_PREFIX, isMorningResearchTask, isOverdueHandoff, parseResearchHandoff, readResearchHandoff, researchHandoff } from "../../plugins/tasks/src/research-handoff";
const body = { output: "Report with evidence", decision: "Approve scope A?", nextStep: "Design A after decision" };
const report = RESEARCH_HANDOFF_PREFIX + JSON.stringify(body);
function event(seq: number, type: TaskEvent["type"], payload: TaskEvent["payload"], createdAt = seq * 1000): TaskEvent {
  return { seq, eventId: `event-${seq}`, taskId: "task", type, payload, createdAt, taskRevision: seq, actor: null, channel: "agent" };
}
const start = event(1, "status_changed", { from: "backlog", to: "in_progress" });
const ready = event(2, "progress", { text: report });
const review = event(3, "status_changed", { from: "in_progress", to: "in_review" });
test("triage, ordinary reports, and review status alone never establish readiness", () => {
  for (const text of ["Done; please review", RESEARCH_HANDOFF_PREFIX + "{}", RESEARCH_HANDOFF_PREFIX + JSON.stringify({ ...body, decision: " " }), RESEARCH_HANDOFF_PREFIX + JSON.stringify({ ...body, readyAt: 123 })]) assert.equal(parseResearchHandoff(text), null);
  assert.equal(researchHandoff([start, review, event(4, "progress", { text: "Done" })]), null);
  assert.equal(researchHandoff([start, ready]), null);
});
test("ready time requires output AND entry into visible review; edits/repeated reports cannot reset it", () => {
  assert.deepEqual(researchHandoff([review, ready, start, event(4, "updated", { title: "Reworded" }), event(5, "progress", { text: report })]), { ...body, eventId: ready.eventId, readyAt: review.createdAt });
  assert.equal(researchHandoff([start, review, event(4, "progress", { text: report })])!.readyAt, 4000);
});
test("leaving review closes the round; re-entry needs a fresh handoff", () => {
  const exit = event(4, "status_changed", { from: "in_review", to: "in_progress" });
  const next = event(6, "status_changed", { from: "in_progress", to: "in_review" });
  assert.equal(researchHandoff([start, ready, review, exit, next]), null);
  assert.equal(researchHandoff([start, ready, review, exit, event(5, "progress", { text: report }), next])!.readyAt, 6000);
  assert.equal(researchHandoff([start, ready, review, event(4, "deleted", {}), event(5, "restored", {}), next]), null);
});
test("72 hours is strict, and future handoffs cannot be overdue", () => {
  const handoff = researchHandoff([start, ready, review])!;
  assert.equal(isOverdueHandoff(handoff, handoff.readyAt - 1), false);
  assert.equal(isOverdueHandoff(handoff, handoff.readyAt + HUMAN_WAIT_THRESHOLD_MS), false);
  assert.equal(isOverdueHandoff(handoff, handoff.readyAt + HUMAN_WAIT_THRESHOLD_MS + 1), true);
});
test("context, unassessed, completed, deleted and archived items stay off the morning queue", () => {
  const task = { status: "backlog", aiResearch: "proactive", deletedAt: null } as TaskDetail;
  assert.equal(isMorningResearchTask(task), true);
  for (const change of [{ aiResearch: "needs_context" }, { aiResearch: "unassessed" }, { aiResearch: "needs_decision" }, { status: "done" }, { status: "canceled" }, { deletedAt: 1 }, { archivedAt: 1 }]) assert.equal(isMorningResearchTask({ ...task, ...change } as TaskDetail), false);
  assert.equal(isMorningResearchTask({ ...task, aiResearch: "needs_decision", status: "in_review" }), true);
});
test("paged history finds the first handoff rather than the most recent report", async () => {
  const calls: unknown[] = [];
  const port: TasksRequestPort = { request: (async (method: string, params: unknown) => {
    assert.equal(method, TASKS.events); calls.push(params);
    return calls.length === 1 ? { events: [event(5, "progress", { text: report }), review], nextBeforeSeq: 3 } : { events: [ready, start], nextBeforeSeq: 1 };
  }) as TasksRequestPort["request"] };
  assert.equal((await readResearchHandoff(port, "task"))!.readyAt, 3000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { taskId: "task", limit: 100, beforeSeq: 3 });
});
test("unreadable or incomplete history is unknown, never a guessed clock", async () => {
  const failed: TasksRequestPort = { request: async () => { throw new Error("offline"); } };
  await assert.rejects(readResearchHandoff(failed, "task"), /offline/);
  const truncated: TasksRequestPort = { request: (async () => ({ events: [review], nextBeforeSeq: 3 })) as TasksRequestPort["request"] };
  await assert.rejects(readResearchHandoff(truncated, "task"), /cursor/);
});

import { AI_FOLLOW_UP_PREFIX, activeFollowUpTask, followUpDwellStart, followUpProjection, parseFollowUpReport, readFollowUpEvents } from "../../plugins/tasks/src/ai-follow-up-model";
const task = { id: "task", status: "in_review", deletedAt: null, updatedAt: 0 } as TaskDetail;
const fact = (seq: number, patch: Record<string, unknown> = {}) => event(seq, "progress", { text: AI_FOLLOW_UP_PREFIX + JSON.stringify({ lane: "needs", summary: "Material ready", artifact: "Scope v2", decision: "Approve A?", roundId: "round-1", judgeId: "judge-a", ...patch }) });
test("five-lane projection preserves old tasks without inventing execution or ready delivery", () => {
  for (const [status, lane] of [["backlog", "todo"], ["todo", "todo"], ["in_progress", "working"], ["in_review", "review"]]) {
    const projected = followUpProjection({ ...task, status } as TaskDetail);
    assert.equal(projected.lane, lane); assert.equal(projected.report, null); assert.equal(projected.readyAt, null);
  }
  assert.equal(followUpProjection(task, [start, ready, review]).lane, "needs");
  assert.equal(followUpProjection(task, [start, ready, review]).readyAt, 3000);
  assert.equal(activeFollowUpTask({ ...task, aiResearch: "unassessed" }), true);
  for (const patch of [{ status: "done" }, { status: "canceled" }, { archivedAt: 4 }, { deletedAt: 2 }]) assert.equal(activeFollowUpTask({ ...task, ...patch } as TaskDetail), false);
});
test("explicit reports validate material, round, judge and prohibit backdated client clocks", () => {
  for (const patch of [{ artifact: "" }, { decision: "" }, { roundId: "" }, { judgeId: 123 }, { readyAt: 42 }, { lane: "fake" }]) assert.equal(parseFollowUpReport(fact(4, patch).payload.text), null);
  assert.equal(parseFollowUpReport("AI_FOLLOW_UP_V1\n[]"), null);
  assert.equal(followUpProjection(task, [review, fact(4)]).readyAt, 4000);
  assert.equal(followUpProjection(task, [review, fact(4, { judgeId: null })]).report?.judgeId, null);
});
test("same-round updates and comments preserve waiting while a new round or response ends it", () => {
  const events = [review, fact(4), event(5, "updated", { assigneeId: "different-owner" }), event(6, "progress", { text: "Ordinary comment" }), fact(7, { judgeId: "judge-b" })];
  assert.equal(followUpProjection(task, events).readyAt, 4000);
  assert.equal(followUpProjection(task, events).report?.judgeId, "judge-b");
  assert.equal(followUpProjection(task, [...events, fact(8, { roundId: "round-2" })]).readyAt, 8000);
  assert.equal(followUpProjection(task, [...events, fact(8, { lane: "review" })]).readyAt, null);
  const exit = event(8, "status_changed", { to: "todo" });
  assert.equal(followUpProjection({ ...task, status: "todo" }, [...events, exit]).lane, "todo");
  assert.equal(followUpProjection(task, [...events, exit, event(9, "status_changed", { to: "in_review" })]).readyAt, null);
});
test("readiness needs a compatible explicit report; comments do not overwrite a recorded fact", () => {
  const events = [review, fact(4, { lane: "ready" }), event(5, "progress", { text: "A comment" })];
  assert.equal(followUpProjection(task, events).lane, "ready");
  assert.equal(followUpProjection({ ...task, status: "in_progress" }, events).lane, "working");
  assert.equal(followUpProjection(task, [...events, event(6, "restored", {})]).report, null);
});
test("follow-up bounded pagination rejects incomplete history without inventing a clock", async () => {
  const failed: TasksRequestPort = { request: async () => { throw new Error("offline"); } };
  await assert.rejects(readFollowUpEvents(failed, "task"), /offline/);
  const truncated: TasksRequestPort = { request: (async () => ({ events: [review], nextBeforeSeq: 3 })) as TasksRequestPort["request"] };
  await assert.rejects(readFollowUpEvents(truncated, "task"), /cursor/);
});

const rollout = Date.parse("2026-10-23T00:00:00+08:00");
const assigned = { ...task, assigneeId: "owner", createdAt: rollout - 86400000 };
test("assigned Todo/Needs/Ready use fixed rollout floor; working/review/unassigned never count", () => {
  for (const status of ["backlog", "todo"] as const) {
    const row = { ...assigned, status };
    assert.equal(followUpDwellStart(row, followUpProjection(row), rollout), rollout);
  }
  for (const lane of ["needs", "ready"] as const) {
    const p = followUpProjection(assigned, [review, fact(4, { lane })]);
    assert.equal(followUpDwellStart(assigned, p, rollout), rollout);
    assert.equal(followUpDwellStart({ ...assigned, assigneeId: null }, p, rollout), null);
    assert.equal(followUpDwellStart({ ...assigned, archivedAt: 1 }, p, rollout), null);
  }
  for (const status of ["in_progress", "in_review"] as const) {
    const row = { ...assigned, status };
    assert.equal(followUpDwellStart(row, followUpProjection(row), rollout), null);
  }
  assert.equal(rollout, Date.UTC(2026, 9, 22, 16));
});
test("lane dwell survives comments, owner/judge changes, and a fresh decision round in the SAME lane", () => {
  const t = rollout + 3600000;
  const enter = { ...fact(4), createdAt: t };
  const next = { ...fact(7, { roundId: "round-2", judgeId: "judge-b" }), createdAt: t + 30000 };
  const p = followUpProjection(assigned, [review, enter, event(5, "updated", { fields: ["assigneeId"] }, t + 1000), event(6, "progress", { text: "Comment" }, t + 2000), next]);
  assert.equal(p.readyAt, next.createdAt, "original decision round truth remains intact");
  assert.equal(p.enteredAt, t, "state dwell is independent of decision rounds");
  assert.equal(followUpDwellStart(assigned, p, rollout), t);
});
test("new state entry and re-entry start a fresh clock, repeating Ready does not", () => {
  const needs = { ...fact(4), createdAt: rollout + 1000 };
  const ready = { ...fact(5, { lane: "ready" }), createdAt: rollout + 2000 };
  const repeated = { ...fact(6, { lane: "ready", summary: "Reworded" }), createdAt: rollout + 3000 };
  assert.equal(followUpDwellStart(assigned, followUpProjection(assigned, [review, needs, ready, repeated]), rollout), ready.createdAt);
  const again = { ...fact(7), createdAt: rollout + 4000 };
  assert.equal(followUpDwellStart(assigned, followUpProjection(assigned, [review, needs, ready, repeated, again]), rollout), again.createdAt);
  const todo = { ...assigned, status: "todo" as const };
  const moved = event(8, "status_changed", { from: "in_review", to: "todo" }, rollout + 5000);
  assert.equal(followUpDwellStart(todo, followUpProjection(todo, [review, needs, moved]), rollout), moved.createdAt);
  const fresh = { ...todo, createdAt: rollout + 6000 };
  assert.equal(followUpDwellStart(fresh, followUpProjection(fresh), rollout), fresh.createdAt);
  const unknown = { ...followUpProjection(fresh), enteredAt: null };
  assert.equal(followUpDwellStart(fresh, unknown, rollout), null);
});
test("backlog/todo are the same visible lane; restores end the previous state interval", () => {
  const row = { ...assigned, status: "todo" as const };
  const events = [event(1, "created", { status: "backlog" }, rollout - 1000), event(2, "status_changed", { from: "backlog", to: "todo" }, rollout + 1000)];
  assert.equal(followUpDwellStart(row, followUpProjection(row, events), rollout), rollout);
  const restored = event(4, "restored", {}, rollout + 3000);
  assert.equal(followUpDwellStart(row, followUpProjection(row, [...events, event(3, "deleted", {}, rollout + 2000), restored]), rollout), restored.createdAt);
});
test("pagination crosses workflow boundaries to recover visible state entry", async () => {
  let calls = 0;
  const port = { request: async () => ++calls === 1 ? { events: [event(2, "status_changed", { from: "backlog", to: "todo" })], nextBeforeSeq: 2 }
    : { events: [event(1, "created", { status: "backlog" })], nextBeforeSeq: null } } as TasksRequestPort;
  const events = await readFollowUpEvents(port, "task");
  assert.equal(calls, 2);
  assert.equal(followUpProjection({ ...assigned, status: "todo" }, events).enteredAt, 1000);
});
