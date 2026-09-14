import test from "node:test";
import assert from "node:assert/strict";
import { DshAppServerAdapter } from "../apps/local-agent-host/src/dsh-appserver-adapter.js";
import type { DshClient } from "../apps/local-agent-host/src/dsh-client.js";

function fixture() {
  const all: any[] = [];
  for (let turn = 1; turn <= 3; turn++) {
    const push = (type: string, data: any) => all.push({ event: { type, data, seq: all.length + 1, time: (all.length + 1) * 1000 } });
    push("turn/start", { turn });
    push("user/message", { source: { kind: "user", rpcId: "user-" + turn }, content: [{ type: "text", text: "hello" }] });
    push("assistant/message", { turn, message: { content: [{ type: "text", text: "reply-" + turn }] } });
    push("turn/end", { turn, reason: { kind: "completed" } });
  }
  const calls: number[] = [];
  const adapter = new DshAppServerAdapter({ call: async (method: string, params: any) => {
    assert.equal(method, "session.history");
    const candidates = all.filter(entry => params.beforeSeq === undefined || entry.event.seq < params.beforeSeq);
    calls.push(params.beforeSeq ?? 0);
    return { events: candidates.slice(-3), hasMore: candidates.length > 3 };
  } } as unknown as DshClient);
  (adapter as any).summaries.set("s", { sessionId: "s", running: false, blank: false, cwd: "/", updatedAt: 1 });
  return { adapter, calls };
}

test("history reads assemble native pages before projecting full Turns and Items", async () => {
  const { adapter, calls } = fixture();
  try {
    const read: any = await adapter.dispatch("thread/read", { threadId: "s", includeTurns: true });
    assert.equal(read.thread.turns.length, 3);
    assert.ok(read.thread.turns.every((turn: any) => turn.items.length === 2 && turn.status === "completed"));
    assert.deepEqual(calls, [0, 10, 7, 4]);
    const first: any = await adapter.dispatch("thread/items/list", { threadId: "s", limit: 2 });
    assert.equal(first.data.length, 2);
    assert.ok(first.data.every((entry: any) => entry.turnId === "dsh-turn-s-1"));
    const second: any = await adapter.dispatch("thread/items/list", { threadId: "s", limit: 2, cursor: first.nextCursor });
    assert.ok(second.data.every((entry: any) => entry.turnId === "dsh-turn-s-2"));
    const filtered: any = await adapter.dispatch("thread/items/list", { threadId: "s", turnId: "dsh-turn-s-3", sortDirection: "desc" });
    assert.deepEqual(filtered.data.map((entry: any) => entry.item.type), ["agentMessage", "userMessage"]);
    const turns: any = await adapter.dispatch("thread/turns/list", { threadId: "s", limit: 1, itemsView: "notLoaded" });
    assert.equal(turns.data[0].id, "dsh-turn-s-3");
    assert.deepEqual(turns.data[0].items, []);
    assert.equal(turns.data[0].itemsView, "notLoaded");
    await assert.rejects(adapter.dispatch("thread/items/list", { threadId: "s", cursor: turns.nextCursor }), /cursor/);
    await assert.rejects(adapter.dispatch("thread/items/list", { threadId: "s", cursor: "garbage" }), /cursor/);
    const missing: any = await adapter.dispatch("thread/items/list", { threadId: "s", turnId: "missing" });
    assert.deepEqual(missing.data, [], "reference returns an empty filtered page for unknown Turn");
  } finally { adapter.close(); }
});

test("non-advancing native history is rejected rather than looping", async () => {
  const adapter = new DshAppServerAdapter({ call: async () => ({ events: [], hasMore: true }) } as unknown as DshClient);
  (adapter as any).summaries.set("s", { sessionId: "s", running: false, blank: false, cwd: "/", updatedAt: 1 });
  try { await assert.rejects(adapter.dispatch("thread/items/list", { threadId: "s" }), /no progress/); }
  finally { adapter.close(); }
});
