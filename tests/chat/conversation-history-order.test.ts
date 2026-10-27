import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerTurn } from "@opencraft/appserver-protocol";
import { mergeTurns, reconcileHistoryTurns, reconcileHydratedTurn } from "@opencraft/appserver-session";

const row = (id: string): AppServerTurn => ({ id, status: "completed", itemsView: "full", items: [
  { id: `${id}:user`, type: "userMessage", content: [{ type: "text", text: id }] },
  { id: `${id}:answer`, type: "agentMessage", text: `Answer ${id}`, phase: "final_answer" },
] });
const ids = (turns: readonly AppServerTurn[]) => turns.map(turn => turn.id);

test("a partial navigation index cannot move unindexed old history behind a live reply", () => {
  const existing = [row("older-unindexed"), row("history-a"), row("history-c"), {
    ...row("live-unindexed"), status: "inProgress",
  }];
  const hydrated = reconcileHydratedTurn(existing, row("history-b"), ["history-a", "history-b", "history-c"]);
  assert.deepEqual(ids(hydrated), ["older-unindexed", "history-a", "history-b", "history-c", "live-unindexed"]);
  assert.strictEqual(hydrated[0], existing[0]);
  assert.strictEqual(hydrated.at(-1), existing.at(-1));
  assert.deepEqual(ids(reconcileHydratedTurn(hydrated, row("history-b"), ["history-a", "history-b", "history-c"])), ids(hydrated));
});

test("hydrating an established Turn does not relocate it or use opaque IDs as chronology", () => {
  const existing = [row("z"), row("b"), row("a")];
  assert.deepEqual(ids(reconcileHydratedTurn(existing, row("b"), ["b"])), ["z", "b", "a"]);
  assert.deepEqual(ids(reconcileHydratedTurn(existing, row("c"), ["b", "c"])), ["z", "b", "c", "a"]);
});

test("a delayed full history page cannot erase new Items or shorten a streamed reply", () => {
  const baseline: readonly AppServerTurn[] = [{
    id: "active", status: "inProgress", itemsView: "full", items: [
      { id: "user", type: "userMessage" },
      { id: "reply", type: "agentMessage", text: "A" },
    ],
  }];
  const observed = mergeTurns(baseline, [{ id: "active", items: [
    { id: "reply", type: "agentMessage", text: "AB" },
    { id: "steer", type: "userMessage", clientId: "steer-1" },
    { id: "next", type: "agentMessage", text: "Working" },
  ] }]);
  const history: readonly AppServerTurn[] = [{ ...baseline[0]!, items: [
    { id: "older", type: "agentMessage", text: "Previously unloaded" },
    ...baseline[0]!.items!,
  ] }];
  const settled = reconcileHistoryTurns(observed, history, "older", { baselineTurns: baseline });
  assert.deepEqual(settled[0]?.items?.map(item => item.id), ["older", "user", "reply", "steer", "next"]);
  assert.equal(settled[0]?.items?.find(item => item.id === "reply")?.text, "AB");
  assert.equal(settled[0]?.items?.find(item => item.id === "next")?.text, "Working");
  const streamed = mergeTurns(settled, [{ id: "active", items: [{ id: "next", type: "agentMessage", text: "Working now" }] }]);
  assert.deepEqual(streamed[0]?.items?.map(item => item.id), settled[0]?.items?.map(item => item.id));
});

test("concurrent observations inside the covered history window keep their slot", () => {
  const baseline = [row("a"), row("c")];
  const observed = [baseline[0]!, row("b"), baseline[1]!];
  const history = [row("a"), row("c")];
  assert.deepEqual(ids(reconcileHistoryTurns(observed, history, "older", { baselineTurns: baseline })), ["a", "b", "c"]);
});

test("history without concurrent observations still owns covered membership and order", () => {
  const baseline = [row("c"), row("removed"), row("a")];
  const history = [row("a"), row("c")];
  assert.deepEqual(ids(reconcileHistoryTurns(baseline, history, "latest", { baselineTurns: baseline })), ["a", "c"]);
});

test("navigation hydration retains updates since its lookup, including a previously unloaded Turn", () => {
  const baseline = { id: "target", status: "inProgress", itemsView: "summary", items: [
    { id: "answer", type: "agentMessage", text: "A" },
  ] } as const;
  const current = mergeTurns([row("older"), baseline, row("newer")], [{ id: "target", items: [
    { id: "answer", type: "agentMessage", text: "AB" },
    { id: "next", type: "agentMessage", text: "New reply" },
  ] }]);
  const history = { ...baseline, itemsView: "full" as const, items: [
    { id: "user", type: "userMessage" }, ...baseline.items,
  ] };
  for (const turn of [baseline, undefined]) {
    const settled = reconcileHydratedTurn(current, history, ["target"], { turn });
    assert.deepEqual(ids(settled), ["older", "target", "newer"]);
    assert.deepEqual(settled[1]?.items?.map(item => item.id), ["user", "answer", "next"]);
    assert.equal(settled[1]?.items?.[1]?.text, "AB");
  }
});

test("a concurrent terminal lifecycle is not reverted by delayed in-progress metadata", () => {
  const baseline = [{ ...row("target"), status: "inProgress", durationMs: null }];
  const completed = mergeTurns(baseline, [{ ...row("target"), status: "completed", durationMs: 100 }]);
  const settled = reconcileHistoryTurns(completed, baseline, "older", { baselineTurns: baseline });
  assert.equal(settled[0]?.status, "completed");
  assert.equal(settled[0]?.durationMs, 100);
});
