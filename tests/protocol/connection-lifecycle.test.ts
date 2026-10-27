import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionLifecycleOwner } from "../../packages/workbench-runtime/src/connection-lifecycle";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(changed = () => {}) {
  let now = 0, seq = 0, invalidations = 0;
  const timers = new Map<number, { run(): void; delay: number }>();
  const runs: { resolve(binding: object): void; signal: AbortSignal }[] = [];
  const backoffs: number[] = [];
  const owner = new ConnectionLifecycleOwner<object>({
    clock: { now: () => now, setTimeout(run, delay) { const id = ++seq; timers.set(id, { run, delay }); return id; },
      clearTimeout(id) { timers.delete(id as number); } },
    delaysMs: [500, 1_000, 2_000, 5_000, 15_000, 30_000, 60_000],
    run: attempt => new Promise(resolve => runs.push({ resolve, signal: attempt.signal })),
    valid: () => true, invalidate: () => { invalidations++; }, changed,
    usable: () => {}, manual: () => false, backoff: (_, ms) => backoffs.push(ms),
  });
  const fire = async (delay: number) => {
    const entry = [...timers].find(([, t]) => t.delay === delay);
    assert.ok(entry, `missing ${delay}ms timer`);
    timers.delete(entry[0]); now += delay; entry[1].run(); await tick();
  };
  return { owner, timers, runs, backoffs, fire, get invalidations() { return invalidations; } };
}

test("revoked cold initialization cannot commit ready or cancel its retry", async () => {
  const f = fixture();
  const first = f.owner.connect(); await tick();
  f.owner.lost(new Error("lost after initialize"));
  await assert.rejects(first, /lost after initialize/);
  f.runs[0]!.resolve({}); await tick();
  assert.equal(f.owner.snapshot.phase, "backoff");
  assert.deepEqual([...f.timers.values()].map(t => t.delay), [500]);
  await f.fire(500);
  const second = f.owner.connect(); f.runs[1]!.resolve({}); await second;
  assert.equal(f.owner.snapshot.phase, "usable");
  assert.equal(f.invalidations, 1);
  f.owner.dispose();
});

test("synchronous connecting observers join the registered operation before I/O", async () => {
  let reentrant: Promise<void> | undefined;
  const f = fixture(() => { if (f.owner.snapshot.phase === "attempting") reentrant = f.owner.connect(); });
  const first = f.owner.connect();
  assert.equal(reentrant, first); assert.equal(f.runs.length, 0);
  await tick(); assert.equal(f.runs.length, 1);
  f.runs[0]!.resolve({}); await first; f.owner.dispose();
});

test("manual recovery is sticky across later close events and foreground hints", async () => {
  const f = fixture(); const start = f.owner.connect(); await tick();
  f.owner.lost(new Error("authentication"), true); await assert.rejects(start);
  f.owner.lost(new Error("later close"));
  assert.equal(f.owner.snapshot.phase, "blocked");
  assert.equal(f.owner.admitRecoveryHint(), false); assert.equal(f.timers.size, 0);
  const explicit = f.owner.connect(true); await tick(); f.runs[1]!.resolve({}); await explicit;
  assert.equal(f.owner.snapshot.phase, "usable"); f.owner.dispose();
});

test("old stability callbacks cannot reset a successor outage's backoff", async () => {
  const f = fixture(); const start = f.owner.connect(); await tick(); f.runs[0]!.resolve({}); await start;
  const stale = [...f.timers.values()][0]!.run;
  f.owner.lost(new Error("first")); stale(); await f.fire(500);
  f.owner.lost(new Error("second")); stale();
  assert.deepEqual(f.backoffs, [500, 1000]);
  f.owner.dispose();
});

test("deadline settles callers and revokes hung I/O; dispose remains terminal", async () => {
  const f = fixture(); const start = f.owner.connect(); await tick();
  const rejected = assert.rejects(start, /timed out/);
  await f.fire(30_000); await rejected;
  assert.equal(f.runs[0]!.signal.aborted, true);
  f.owner.dispose(); f.runs[0]!.resolve({}); await tick();
  assert.equal(f.owner.snapshot.phase, "disposed"); assert.equal(f.timers.size, 0);
});

test("default reconnect backoff adds bounded jitter while explicit test schedules stay exact", async () => {
  const scheduled: number[] = [];
  const delays: number[] = [];
  let sequence = 0;
  const owner = new ConnectionLifecycleOwner<object>({
    clock: { setTimeout(run, delay) { scheduled.push(delay); return ++sequence; }, clearTimeout() {} },
    run: async () => { throw new Error("synthetic loss"); },
    valid: () => true, invalidate() {}, changed() {}, usable() {}, manual: () => false,
    backoff: (_, delay) => delays.push(delay),
    jitter: true, random: () => 0,
  });
  try {
    await assert.rejects(owner.connect(), /synthetic loss/);
    assert.deepEqual(scheduled.filter(delay => delay < 1_000), [400]);
    assert.deepEqual(delays, [400]);
  } finally { owner.dispose(); }
  const upper = new ConnectionLifecycleOwner<object>({
    clock: { setTimeout(run, delay) { scheduled.push(delay); return ++sequence; }, clearTimeout() {} },
    run: async () => { throw new Error("synthetic loss"); },
    valid: () => true, invalidate() {}, changed() {}, usable() {}, manual: () => false,
    backoff() {}, jitter: true, random: () => 1,
  });
  try {
    await assert.rejects(upper.connect(), /synthetic loss/);
    assert.equal(scheduled.filter(delay => delay < 1_000).at(-1), 600);
  } finally { upper.dispose(); }
});
