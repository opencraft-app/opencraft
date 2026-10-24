import assert from "node:assert/strict";
import test from "node:test";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "../../packages/ui-preferences/src/index.ts";
import { attentionPriority, conversationKey, orderConversations, recentTurnPreviews } from "../../apps/workbench-web/src/features/conversation-overview/model.ts";
import { createConversationOverviewSource, createPreviewReadLimiter } from "../../apps/workbench-web/src/features/conversation-overview/source.ts";
import type { SidebarThread } from "../../apps/workbench-web/src/components/sidebar.tsx";
import type { AppServerProtocolResourcePort } from "@opencraft/workbench-runtime";
import type { Turn } from "@opencraft/appserver-protocol/generated/v2";

const thread = (id: string, patch: Partial<SidebarThread> = {}): SidebarThread => ({ id, title: id, project: "repo", time: "", lineage: "root",
  updatedAt: 100, status: "ready", connectionHostId: "local", connectionHostLabel: "Local",
  serverOrigin: { serverId: "local", label: "Local" }, serverRouteLocality: "local", ...patch });
const turn = (id: string): Turn => ({ id, itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1,
  items: [{ type: "userMessage", id: "u" + id, clientId: null, content: [{ type: "text", text: "question " + id, text_elements: [] }] },
    { type: "agentMessage", id: "a" + id, text: "answer " + id, phase: null, memoryCitation: null, delivery: null, questions: null }] });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test("attention ordering respects review, unread, running/goal, pin and recency without merging Hosts", () => {
  const rows = [thread("new", { updatedAt: 1000 }), thread("pin", { pinned: true }), thread("running", { status: "running" }),
    thread("unread", { unread: true }), thread("review", { status: "review" })];
  assert.deepEqual(orderConversations(rows).map(row => row.id), ["review", "unread", "running", "pin", "new"]);
  assert.equal(orderConversations(rows, true)[0]!.id, "new");
  assert.equal(attentionPriority(thread("goal", { goalActive: true })), 2);
  assert.equal(attentionPriority(thread("error", { status: "error" })), 0);
  assert.notEqual(conversationKey(thread("same")), conversationKey(thread("same", { connectionHostId: "remote" })));
  assert.equal(rows[0]!.id, "new", "projection must not sort the authoritative catalog in place");
});

test("summary previews contain only two recent exchanges in reading order and bound text", () => {
  const last = turn("last");
  last.items.push({ type: "reasoning", id: "private-reasoning", summary: ["do not project"], content: ["do not project"] });
  const agent = last.items[1]!; if (agent.type === "agentMessage") agent.text = "x".repeat(2000);
  const result = recentTurnPreviews([last, turn("previous"), turn("older")]);
  assert.deepEqual(result.map(row => row.id), ["previous", "last"]);
  assert.equal(result[1]!.assistant.length, 600);
  assert.ok(!JSON.stringify(result).includes("do not project"));
});

test("one Host has at most two preview requests and aborted queued cards are never read", async () => {
  const limit = createPreviewReadLimiter(); let active = 0, peak = 0, reads = 0;
  const releases: (() => void)[] = [];
  const read = () => { reads++; active++; peak = Math.max(peak, active); return new Promise<void>(resolve => releases.push(() => { active--; resolve(); })); };
  const aborts = Array.from({ length: 5 }, () => new AbortController());
  const jobs = aborts.map(abort => limit(abort.signal, read));
  const settled = Promise.allSettled(jobs);
  await flush(); assert.equal(active, 2);
  for (const abort of aborts.slice(2)) abort.abort();
  for (const release of releases) release();
  const result = await settled;
  assert.equal(reads, 2); assert.equal(peak, 2);
  assert.deepEqual(result.map(row => row.status), ["fulfilled", "fulfilled", "rejected", "rejected", "rejected"]);
});

test("preview reads use only the bounded readonly protocol and reject revoked or aborted replies", async () => {
  let current = true; const calls: unknown[] = []; let finish: (() => void) | undefined;
  const protocol = { request: async (method: string, params: unknown) => {
    calls.push([method, params]); await new Promise<void>(resolve => { finish = resolve; }); return { data: [turn("last")], nextCursor: null };
  } } as AppServerProtocolResourcePort;
  const source = createConversationOverviewSource({ key: "scope-a", hostId: "local", available: true, supported: true, protocol,
    assertCurrent: () => { if (!current) throw new Error("scope revoked"); } });
  const abort = new AbortController();
  const read = source.read("conversation", abort.signal); const rejected = assert.rejects(read, /scope revoked/);
  await flush(); current = false; finish!(); await rejected;
  assert.deepEqual(calls, [["thread/turns/list", { threadId: "conversation", cursor: null, sortDirection: "desc", limit: 2, itemsView: "summary" }]]);
  current = true;
  const second = source.read("conversation", abort.signal); const cancelled = assert.rejects(second);
  await flush(); abort.abort(); finish!(); await cancelled;
});

test("unavailable or unsupported sources never fall back to full history or resume", async () => {
  let reads = 0;
  const protocol = { request: async () => { reads++; throw new Error("must not read"); } } as AppServerProtocolResourcePort;
  for (const [available, supported] of [[false, true], [true, false]]) {
    const source = createConversationOverviewSource({ key: "scope", hostId: "local", available: available!, supported: supported!, protocol, assertCurrent() {} });
    await assert.rejects(source.read("id", new AbortController().signal), /unavailable/);
  }
  assert.equal(reads, 0);
});

test("overview is opt-in and its installation preference survives runtime recreation", async () => {
  const store = new MemoryUiPreferenceStore();
  const first = await UiPreferencesRuntime.open({ installation: store });
  assert.equal(first.get("sidebar.conversationOverview"), false);
  await first.set("sidebar.conversationOverview", true); await first.close();
  const second = await UiPreferencesRuntime.open({ installation: store });
  assert.equal(second.get("sidebar.conversationOverview"), true);
  await second.close();
});
