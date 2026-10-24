import assert from "node:assert/strict";
import test from "node:test";
import { DshAppServerAdapter } from "../../apps/local-agent-host/src/dsh-appserver-adapter.js";

function fixture() {
  const events: any[] = [];
  const push = (type: string, data: unknown) => events.push({ event: { seq: events.length, time: 1000, type, data } });
  push("turn/start", { turn: 1 });
  push("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "fixture" }] });
  push("assistant/message", { turn: 1, message: { content: [{ type: "text", text: "answer" }] } });
  push("turn/end", { turn: 1, reason: { kind: "completed" } });
  let reads = 0;
  const adapter = new DshAppServerAdapter({ call: async (method: string, payload: any) => {
    assert.equal(method, "session.history"); reads++;
    return { events: events.filter(e => payload.beforeSeq === undefined || e.event.seq < payload.beforeSeq), hasMore: false };
  } } as any);
  (adapter as any).summaries.set("s", { sessionId: "s", running: false, blank: false, cwd: "/", updatedAt: 1 });
  let head: unknown = { nextSeq: events.length };
  let describe = async () => ({ loaded: false, historyHead: head, selection: { provider: "p", model: "m" }, permissions: { approval: "ask", sandbox: { mode: "workspace-write", workspaceRoot: "/" }, preset: "custom" } });
  adapter.setThreadEngine({ describe: () => describe(), resume: async () => { throw Error("Unexpected activation"); }, create: async () => {}, fork: async () => {}, inject: async () => {}, release: async () => {} });
  const resume = (checkpoint?: unknown): Promise<any> => adapter.dispatch("thread/resume", { threadId: "s", excludeTurns: true, initialTurnsPage: { limit: 5, sortDirection: "desc", itemsView: "full" }, ...(checkpoint === undefined ? {} : { historyCheckpoint: checkpoint }) });
  return { adapter, events, resume, reads: () => reads, head: (value: unknown) => { head = value; }, describe: (fn: typeof describe) => { describe = fn; } };
}

test("unchanged current head skips native history, invalid/old heads and rewinds retain recovery", async () => {
  const f = fixture();
  try {
    const initial = await f.resume(); const cursor = initial.historyRecovery.checkpoint;
    assert.equal(f.reads(), 1);
    const same = await f.resume(cursor);
    assert.equal(same.historyRecovery.mode, "unchanged"); assert.equal(f.reads(), 1);
    assert.equal(same.historyMetrics.nativeEvents, 0); assert.equal(same.historyMetrics.nativeReads, 0);
    for (const head of [undefined, {}, { nextSeq: "4" }, { nextSeq: -1 }, { nextSeq: Number.MAX_SAFE_INTEGER + 1 }]) {
      f.head(head); const before = f.reads(); await f.resume(cursor); assert.equal(f.reads(), before + 1);
    }
    f.events.pop(); f.head({ nextSeq: f.events.length });
    const rewind = await f.resume(cursor); assert.equal(rewind.historyRecovery.mode, "replace");
    f.head({ nextSeq: cursor.nextSeq });
    const foreign = await f.resume({ ...cursor, epoch: "foreign" }); assert.equal(foreign.historyRecovery.mode, "replace");
  } finally { f.adapter.close(); }
});

test("native restart during describe cannot acknowledge an unchanged old checkpoint", async () => {
  const f = fixture();
  try {
    const initial = await f.resume();
    let release!: () => void;
    f.describe(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { historyHead: { nextSeq: 4 } } as any;
    });
    const pending = f.resume(initial.historyRecovery.checkpoint);
    await new Promise(resolve => setImmediate(resolve));
    f.adapter.engineUnavailable(new Error("fixture restart")); f.adapter.engineRecovered(); release();
    await assert.rejects(pending, /restarted during resume/);
  } finally { f.adapter.close(); }
});
