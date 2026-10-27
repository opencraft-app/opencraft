import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadParticipationContribution } from "@opencraft/extension-react";
import type { AppServerClient } from "@opencraft/appserver-client";
import type { Thread, Turn } from "@opencraft/appserver-protocol/generated/v2";
import { overviewState, createConversationOverviewPort } from "../../apps/workbench-web/src/runtime/conversation-overview";
import { periodBounds, projectOverview, type OverviewConversation } from "../../plugins/tasks/src/conversation-overview-model";

const thread = (id: string, type = "idle") => ({ id, name: id, cwd: "/project", createdAt: 100, updatedAt: 200, status: { type, activeFlags: [] }, turns: [] }) as unknown as Thread;
const turn = (status = "completed") => ({ id: "latest", status, completedAt: 200 }) as Turn;
const client = (request: (method: string, params: any) => Promise<unknown>) => ({ connectionGeneration: 1, initializeResult: {}, request }) as unknown as AppServerClient;
const row = (value: Partial<OverviewConversation> = {}): OverviewConversation => ({ hostId: "one", id: "one", title: "One", project: "/project", createdAt: 100, updatedAt: 200, completedAt: 200, state: "completed", archived: false, pinned: false, participants: ["a", "b"], creator: "c", ...value });

test("success requires latest successful turn and no native active run", () => {
  assert.equal(overviewState(thread("a"), turn()), "completed");
  assert.equal(overviewState(thread("a", "notLoaded"), turn()), "completed", "notLoaded has no active native runtime; latest result is still required");
  assert.equal(overviewState(thread("a", "active"), turn()), "running");
  const waiting = thread("a", "active"); waiting.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  assert.equal(overviewState(waiting, turn()), "waiting");
  assert.equal(overviewState(thread("a"), turn("failed")), "failed");
  assert.equal(overviewState(thread("a"), turn("interrupted")), "interrupted");
  assert.equal(overviewState(thread("a"), turn("inProgress")), "unknown");
  assert.equal(overviewState(thread("a"), undefined), "unknown");
  assert.equal(overviewState(thread("a"), null), "empty");
});

test("calendar ranges include end date, handle today and invalid dates", () => {
  const now = new Date(2026, 9, 18, 10).getTime();
  assert.deepEqual(periodBounds("today", now), [new Date(2026,9,18).getTime(), new Date(2026,9,19).getTime()]);
  assert.deepEqual(periodBounds("7d", now), [new Date(2026,9,12).getTime(), new Date(2026,9,19).getTime()]);
  assert.deepEqual(periodBounds("custom", now, "2026-10-01", "2026-10-02"), [new Date(2026,9,1).getTime(), new Date(2026,9,3).getTime()]);
  assert.ok(Number.isNaN(periodBounds("custom", now)[0]));
});

test("completion dates are real latest-turn dates, current active runs never count completed", () => {
  const result = projectOverview([row(), row({ id: "run", state: "running" }), row({ id: "old", completedAt: 99 }), row({ id: "end", completedAt: 300 }), row({ id: "missing", completedAt: null })], 100000, 300000);
  assert.equal(result.completed, 1);
  assert.equal(result.states.completed, 4);
  assert.equal(result.trend.reduce((sum, value) => sum + value.completed, 0), 1);
});

test("people are unique per conversation, creator is separate, unknown evidence stays unknown", () => {
  const result = projectOverview([row({ participants: ["a", "a", "b"] }), row({ id: "unknown", participants: null, creator: null })], 0, 300000);
  assert.equal(result.people.find(person => person.id === "a")?.conversations, 1);
  assert.equal(result.people.find(person => person.id === "c")?.conversations, 0);
  assert.equal(result.people.find(person => person.id === "c")?.created, 1);
  assert.equal(result.knownPeople, 1);
  assert.equal(result.collaborative, 1);
});

test("complete paging merges pins outside recent, archives, duplicate pages and batches people", async () => {
  let active = 0, maxActive = 0;
  const calls: string[] = [];
  const value = client(async (method, params) => {
    calls.push(method);
    if (method === "thread/list") return params.archived ? { data: [thread("archive")], nextCursor: null } : params.cursor ? { data: [thread("duplicate"), thread("tail")], nextCursor: null } : { data: [thread("duplicate"), ...Array.from({length: 102}, (_, i) => thread(`t${i}`))], nextCursor: "second" };
    if (method === "opencraft/thread-pins/list") return { supported: true, data: [thread("onlyPin")] };
    assert.equal(params.itemsView, "notLoaded"); assert.equal(params.limit, 1);
    active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { data: [turn()] };
  });
  const sizes: number[] = [];
  const people: ThreadParticipationContribution = { id: "people", async read(_host, ids) { sizes.push(ids.length); return ids.map(threadId => ({ threadId, participants: ["a"], creator: "b", pending: false })); } };
  const port = createConversationOverviewPort({ getClient: () => value, participation: () => people });
  const snapshot = await port.read([{id:"one",label:"One"},{id:"one",label:"One"}], new AbortController().signal, () => {});
  assert.equal(snapshot.conversations.length, 106); assert.equal(new Set(snapshot.conversations.map(row => row.id)).size, 106);
  assert.equal(snapshot.conversations.find(row => row.id === "onlyPin")?.pinned, true);
  assert.equal(snapshot.conversations.find(row => row.id === "archive")?.archived, true);
  assert.deepEqual(sizes, [100, 6]); assert.ok(maxActive <= 4);
  assert.equal(snapshot.sources[0]?.catalog, "complete"); assert.equal(snapshot.sources[0]?.people, true);
  assert.equal(calls.filter(method => method === "thread/list").length, 3);
});

test("partial pages and absent turns/pins/people never manufacture completion or coverage", async () => {
  const value = client(async (method, params) => {
    if (method === "thread/list") {
      if (params.archived) throw new Error("offline archive");
      return { data: [thread("partial")], nextCursor: "cycle" };
    }
    throw new Error("unsupported");
  });
  const snapshot = await createConversationOverviewPort({ getClient: () => value, participation: () => null }).read([{id:"one",label:"One"},{id:"missing",label:"Missing"}], new AbortController().signal, () => {});
  assert.equal(snapshot.sources[0]?.catalog, "partial");
  assert.equal(snapshot.conversations[0]?.state, "unknown"); assert.equal(snapshot.conversations[0]?.pinned, null); assert.equal(snapshot.conversations[0]?.participants, null);
});

test("source replacement revokes in-flight source data", async () => {
  const value = client(async method => {
    if (method === "thread/list") return { data: [thread("a")], nextCursor: null };
    if (method === "opencraft/thread-pins/list") return { supported: true, data: [] };
    (value as { connectionGeneration: number }).connectionGeneration++; return { data: [turn()] };
  });
  const result = await createConversationOverviewPort({getClient:()=>value,participation:()=>null}).read([{id:"one",label:"One"}], new AbortController().signal,()=>{});
  assert.equal(result.conversations.length,0); assert.equal(result.sources[0]?.catalog,"error");
});

test("aborted read rejects even if transport returns a late page", async () => {
  const abort = new AbortController();
  const value = client(async () => { abort.abort(); return { data: [thread("a")], nextCursor: null }; });
  await assert.rejects(createConversationOverviewPort({getClient:()=>value,participation:()=>null}).read([{id:"one",label:"One"}],abort.signal,()=>{}), {name:"AbortError"});
});
