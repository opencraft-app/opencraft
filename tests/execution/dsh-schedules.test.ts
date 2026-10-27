import test from "node:test";
import assert from "node:assert/strict";
import { dshScheduleExecutionPort } from "../../apps/local-agent-host/src/dsh-schedules.js";
const run = { id: "schedule:one:1", threadId: "s", scheduleId: "one", scheduledAt: 1, permissions: "opencraft:permission-mode:full", state: "submitting" as const, turnId: null, updatedAt: 1 };
function fixture() {
  let sent = 0, prepared = 0, prior: any = null, goal: any = null, busy = false, archived = false, temporary = false;
  const adapter: any = { dispatch: async (method: string) => method === "thread/goal/get" ? { goal } : { thread: { id: "s", status: { type: busy ? "active" : "idle" } } },
    dispatchOwned: async (method: string, params: any, owner: any) => {
      sent++; assert.equal(params.permissions, "opencraft:permission-mode:full"); assert.equal(method, "turn/start"); assert.equal(params.clientUserMessageId, run.id); assert.equal(owner.identity.id, "opencraft-scheduler");
      prior = { turnId: "t", state: "running" }; return { turn: { id: "t" } };
    } };
  const authority: any = { scheduleInput: () => prior, table: { get: () => busy ? { turnId: "human" } : prior?.state === "running" ? { turnId: "t" } : null },
    leases: { get: () => null }, queueStore: { pending: () => [] } };
  const lifecycle: any = { assertOpen: () => {}, catalog: { get: () => ({ ephemeral: temporary }), isArchived: () => archived }, enqueue: (_: string, fn: () => any) => fn(), acceptedTurn: () => {} };
  const port = dshScheduleExecutionPort(adapter, authority, lifecycle, async () => { prepared++; });
  return { port, get sent() { return sent; }, get prepared() { return prepared; }, busy: (v: boolean) => busy = v, prior: (v: any) => prior = v,
    goal: (v: any) => goal = v, archived: () => archived = true, temporary: () => temporary = true };
}
test("DSH waits for human/Goal work and dispatches one durable occurrence without steering", async () => {
  const f = fixture(); f.busy(true); assert.equal((await f.port.submit(run, "task", () => true)).state, "waiting");
  f.busy(false); f.goal({ status: "active", execution: { activation: "armed" } });
  assert.equal((await f.port.submit(run, "task", () => true)).state, "waiting");
  f.goal(null); assert.equal((await f.port.submit(run, "task", () => false)).state, "waiting"); assert.equal(f.sent, 0);
  assert.equal((await f.port.submit(run, "task", () => true)).state, "running");
  assert.equal((await f.port.submit(run, "task", () => true)).state, "running"); assert.equal(f.sent, 1);
  f.prior({ turnId: "t", state: "completed" }); assert.equal((await f.port.inspect(run)).state, "completed");
});
test("unknown acceptance/recovered orphan is not resubmitted; archived/temporary targets rejected", async () => {
  const f = fixture(); f.prior({ state: "failed" }); assert.equal((await f.port.submit(run, "task", () => true)).state, "unknown"); assert.equal(f.sent, 0);
  f.prior({ state: "orphaned", turnId: "old" }); assert.equal((await f.port.submit(run, "task", () => true)).state, "unknown");
  for (const mutate of ["archived", "temporary"] as const) { const other = fixture(); other[mutate](); await assert.rejects(other.port.validate("s"), /durable thread/); }
});

test("DSH schedule observations use terminal native events without transcript fields", () => {
  let callback!: (method: string, params: any) => void, detached = false;
  const adapter: any = { subscribe: (listener: typeof callback) => { callback = listener; return () => { detached = true; }; } };
  const port = dshScheduleExecutionPort(adapter, {} as any, {} as any, async () => {}), events: any[] = [];
  const stop = port.subscribe!(event => events.push(event));
  callback("item/completed", { threadId: "s", turn: { id: "t", status: "completed" } });
  callback("turn/completed", { threadId: "s", turn: { id: "t", status: "completed", items: [{ text: "private content" }] } });
  callback("turn/completed", { threadId: "s", turn: { id: "u", status: "interrupted" } });
  assert.deepEqual(events, [{ threadId: "s", turnId: "t", state: "completed" }, { threadId: "s", turnId: "u", state: "failed" }]);
  stop(); assert(detached);
});
