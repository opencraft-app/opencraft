import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationSchedules, type ScheduleExecutionPort } from "../../apps/opencraft-daemon/src/conversation-schedules";
import { boundedWakeTimer, MAX_WAKE_DELAY_MS, type OwnerWakeTimerFactory, type WakeClock } from "@opencraft/workspace-host";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

/** Wall clock that can jump independently of the monotonic time pending delays run on. */
function fakeClock(start = 1800000000000) {
  let wall = start, monotonic = 0, sequence = 0;
  const pending = new Map<number, { due: number; callback: () => void }>();
  const delays: number[] = [];
  const clock: WakeClock = {
    now: () => wall,
    after(delayMs, callback) {
      delays.push(delayMs);
      const id = ++sequence;
      pending.set(id, { due: monotonic + delayMs, callback });
      return () => { pending.delete(id); };
    },
  };
  return {
    clock, delays,
    get now() { return wall; },
    get pending() { return pending.size; },
    /** Lets `ms` pass on both clocks, running delays that come due in order. */
    elapse(ms: number) {
      const end = monotonic + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, entry]) => entry.due <= end).sort((x, y) => x[1].due - y[1].due)[0];
        if (!next) break;
        pending.delete(next[0]);
        wall += next[1].due - monotonic; monotonic = next[1].due;
        next[1].callback();
      }
      wall += end - monotonic; monotonic = end;
    },
    /** Sets the wall clock without any monotonic time passing. */
    jump(delta: number) { wall += delta; },
  };
}

async function fixture(options: { admission?: () => boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "oc-schedule-wake-"));
  const time = fakeClock();
  const sends = new Map<string, number>();
  let result: "running" | "completed" | "failed" | "unknown" = "completed";
  let hold: Promise<void> | null = null;
  let armed: number | null = null, factories = 0;
  const port: ScheduleExecutionPort = {
    validate: async () => {},
    submit: async run => {
      sends.set(run.id, (sends.get(run.id) ?? 0) + 1);
      await new Promise(resolve => setImmediate(resolve));
      if (hold) await hold;
      return { state: result, turnId: `turn:${run.id}` };
    },
    inspect: async () => ({ state: result }),
  };
  const wakeTimer: OwnerWakeTimerFactory = wake => {
    factories++;
    const timer = boundedWakeTimer(time.clock, wake);
    return { arm(at) { armed = at; timer.arm(at); }, cancel() { armed = null; timer.cancel(); } };
  };
  const open = () => new ConversationSchedules(root, port, time.clock.now, undefined, undefined, options.admission, wakeTimer);
  let service = open();
  return {
    time, port,
    get service() { return service; },
    get armed() { return armed; },
    get factories() { return factories; },
    get sends() { return [...sends.values()].reduce((sum, count) => sum + count, 0); },
    get duplicates() { return [...sends.values()].some(count => count > 1); },
    setResult(value: typeof result) { result = value; },
    holdSubmits() { let release!: () => void; hold = new Promise(resolve => { release = resolve; }); return () => { hold = null; release(); }; },
    async save(nextRunAt: number, intervalMinutes: number | null = null) {
      return service.handle("opencraft/schedules/save", { threadId: "thread", prompt: "Check the report",
        expectedRevision: service.read("thread").schedule?.revision ?? 0, nextRunAt, intervalMinutes, timeZone: "UTC" }, "creator");
    },
    async action(action: string) {
      return service.handle("opencraft/schedules/action", { threadId: "thread", expectedRevision: service.read("thread").schedule!.revision, action }, null);
    },
    async restart(start = true) { await service.close(); service = open(); if (start) service.start(); await flush(); },
    async close() { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("bounded wake-up never runs early, notices clock jumps and honours replace and cancel", () => {
  const time = fakeClock();
  let wakes = 0;
  const timer = boundedWakeTimer(time.clock, () => { wakes++; });
  timer.arm(time.now + 3 * DAY);
  assert.ok(time.delays.every(delay => delay <= MAX_WAKE_DELAY_MS));
  time.elapse(3 * DAY - MINUTE); assert.equal(wakes, 0, "a target beyond the bound waits in bounded steps");
  time.elapse(MINUTE); assert.equal(wakes, 1);
  assert.ok(time.delays.length > 3 * DAY / MAX_WAKE_DELAY_MS - 2 && time.delays.every(delay => delay <= MAX_WAKE_DELAY_MS));

  timer.arm(time.now + 10 * MINUTE);
  time.jump(-HOUR); time.elapse(30 * MINUTE); assert.equal(wakes, 1, "a clock set back re-arms for the remainder");
  time.elapse(40 * MINUTE); assert.equal(wakes, 2, "and wakes once the clock reaches the target");

  timer.arm(time.now + DAY);
  time.jump(2 * DAY); time.elapse(MAX_WAKE_DELAY_MS); assert.equal(wakes, 3, "a clock set forward is noticed within one bound");

  timer.arm(time.now + MINUTE); timer.arm(time.now + 2 * MINUTE);
  time.elapse(MINUTE); assert.equal(wakes, 3, "arm replaces the earlier target");
  time.elapse(MINUTE); assert.equal(wakes, 4);
  timer.arm(time.now + MINUTE); timer.cancel();
  time.elapse(HOUR); assert.equal(wakes, 4); assert.equal(time.pending, 0);
  assert.throws(() => timer.arm(Number.NaN), RangeError);
});

test("restart catches up an overdue schedule from durable state before relying on the wake-up", async () => {
  const f = await fixture();
  try {
    const due = f.time.now;
    await f.save(due, 60);
    assert.equal(f.armed, null, "an owner that has not started arms nothing");
    await f.service.close();
    f.time.jump(3 * HOUR + 5 * MINUTE);
    await f.restart();
    assert.equal(f.sends, 1, "the missed occurrence runs once, without replaying every missed interval");
    const view = f.service.read("thread");
    assert.equal(view.runs[0].scheduledAt, due);
    assert.equal(view.runs[0].state, "completed");
    assert.ok(view.schedule!.nextRunAt > f.time.now);
    assert.equal(f.armed, view.schedule!.nextRunAt, "the wake-up is armed for the next durable occurrence");
    f.time.elapse(view.schedule!.nextRunAt - f.time.now - 1); await flush();
    assert.equal(f.sends, 1);
    f.time.elapse(1); await flush();
    assert.equal(f.sends, 2);
  } finally { await f.close(); }
});

test("an unfinished occurrence is resumed on start with its durable identity", async () => {
  const f = await fixture();
  try {
    f.setResult("running");
    f.service.start();
    await f.save(f.time.now, 60);
    assert.equal(f.armed, f.time.now, "a plan due now arms an immediate wake-up");
    f.time.elapse(0); await flush();
    assert.equal(f.sends, 1);
    assert.equal(f.armed, f.time.now + 15000, "a running occurrence is re-inspected on the existing back-off");
    f.setResult("completed");
    await f.restart();
    const view = f.service.read("thread");
    assert.equal(view.runs.length, 1); assert.equal(view.runs[0].state, "completed");
    assert.equal(f.armed, view.schedule!.nextRunAt);
  } finally { await f.close(); }
});

test("edits, pause, resume and delete re-arm from the committed plan", async () => {
  const f = await fixture();
  try {
    f.service.start(); await flush();
    assert.equal(f.armed, null);
    const start = f.time.now;
    await f.save(start + 10 * MINUTE, 60);
    assert.equal(f.armed, start + 10 * MINUTE);
    await f.save(start + 5 * MINUTE, 60);
    assert.equal(f.armed, start + 5 * MINUTE, "an edit moves the wake-up earlier");
    await f.save(start + 20 * MINUTE, 60);
    assert.equal(f.armed, start + 20 * MINUTE, "and later");
    f.time.elapse(10 * MINUTE); await flush();
    assert.equal(f.sends, 0, "the replaced target does not fire");
    await f.action("pause");
    assert.equal(f.armed, null);
    f.time.elapse(HOUR); await flush();
    assert.equal(f.sends, 0);
    await f.action("resume");
    const resumed = f.service.read("thread").schedule!.nextRunAt;
    assert.ok(resumed > f.time.now); assert.equal(f.armed, resumed);
    f.time.elapse(resumed - f.time.now); await flush();
    assert.equal(f.sends, 1);
    assert.equal(f.armed, f.service.read("thread").schedule!.nextRunAt, "a settled run arms the next occurrence");
    await f.action("delete");
    assert.equal(f.armed, null);
    f.time.elapse(DAY); await flush();
    assert.equal(f.sends, 1);
    assert.equal(f.time.pending, 0);
  } finally { await f.close(); }
});

test("clock jumps: a stale wake-up never dispatches early and a forward jump loses no run", async () => {
  const f = await fixture();
  try {
    f.service.start();
    const target = f.time.now + 10 * MINUTE;
    await f.save(target, 60);
    f.time.jump(-HOUR);
    f.time.elapse(20 * MINUTE); await flush();
    assert.equal(f.sends, 0, "the clock was set back: the plan is not due yet");
    await f.service.tick();
    assert.equal(f.sends, 0, "an explicit pass still decides from durable state");
    f.time.elapse(target - f.time.now); await flush();
    assert.equal(f.sends, 1);
    const next = f.service.read("thread").schedule!.nextRunAt;
    assert.equal(next, target + HOUR);
    f.time.jump(DAY);
    f.time.elapse(MAX_WAKE_DELAY_MS); await flush();
    assert.equal(f.sends, 2, "the occurrence passed by the jump runs once");
    assert.equal(f.service.read("thread").runs[0].scheduledAt, next);
    assert.ok(f.armed! > f.time.now);
    assert.equal(f.duplicates, false);
  } finally { await f.close(); }
});

test("a schedule days away waits through bounded delays and fires once", async () => {
  const f = await fixture();
  try {
    f.service.start();
    const target = f.time.now + 3 * DAY;
    await f.save(target);
    f.time.elapse(3 * DAY - 1); await flush();
    assert.equal(f.sends, 0);
    assert.ok(f.time.delays.every(delay => delay <= MAX_WAKE_DELAY_MS));
    f.time.elapse(1); await flush();
    assert.equal(f.sends, 1);
    assert.equal(f.service.read("thread").schedule!.status, "completed");
    assert.equal(f.armed, null); assert.equal(f.time.pending, 0);
  } finally { await f.close(); }
});

test("close cancels the wake-up and drains the in-flight run", async () => {
  const f = await fixture();
  try {
    f.service.start();
    const release = f.holdSubmits();
    await f.save(f.time.now, 60); f.time.elapse(0); await flush();
    assert.equal(f.sends, 1);
    let closed = false;
    const closing = f.service.close().then(() => { closed = true; });
    await flush();
    assert.equal(closed, false, "close waits for the run crossing the engine boundary");
    assert.equal(f.time.pending, 0, "no wake-up remains armed");
    release(); await closing;
    f.time.elapse(DAY); await flush();
    assert.equal(f.sends, 1);
    await f.restart(false);
    assert.equal(f.service.read("thread").runs[0].state, "completed", "the drained run settled before close returned");
  } finally { await f.close(); }
});

test("concurrent changes and wake-ups dispatch each occurrence once", async () => {
  const f = await fixture();
  try {
    f.service.start();
    const release = f.holdSubmits();
    await f.save(f.time.now, 60);
    const passes = [f.service.tick(), f.service.tick(), f.service.tick()];
    f.service.start(); f.time.elapse(0);
    await flush();
    assert.equal(f.sends, 1);
    await assert.rejects(f.save(f.time.now + MINUTE, 60), /unfinished/u);
    await assert.rejects(f.action("run-now"), /unfinished/u);
    release(); await Promise.all(passes); await flush();
    assert.equal(f.sends, 1);
    await f.action("run-now");
    await Promise.all([f.service.tick(), f.service.tick()]); f.time.elapse(0); await flush();
    assert.equal(f.sends, 2);
    f.time.elapse(HOUR); await Promise.all([f.service.tick(), f.service.tick()]); await flush();
    assert.equal(f.sends, 3);
    assert.equal(f.duplicates, false);
    assert.equal(f.factories, 1, "one owner holds one wake-up");
  } finally { await f.close(); }
});

test("a fenced owner re-checks due work without dispatching and catches up when started again", async () => {
  let open = false;
  const f = await fixture({ admission: () => open });
  try {
    f.service.start();
    await f.save(f.time.now + MINUTE);
    assert.equal(f.armed, f.time.now + MINUTE, "nothing is due yet, so nothing re-checks before the plan");
    f.time.elapse(MINUTE); await flush();
    assert.equal(f.sends, 0);
    assert.ok(f.armed! > f.time.now && f.armed! <= f.time.now + 2000);
    open = true; f.service.start(); await flush();
    assert.equal(f.sends, 1);
    assert.equal(f.armed, null);
  } finally { await f.close(); }
});
