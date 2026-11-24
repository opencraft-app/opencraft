import test from "node:test";
import assert from "node:assert/strict";
import { dueOwnerWork, mergedOwnerWake, periodicOwnerWork, timeoutOwnerWake } from "@opencraft/owner-wake";
import { fakeAlarm, fakeMonotonicOwnerWake, fakeOwnerWake, fakeWakeClock, HOUR } from "../support/fake-wake-clock.ts";

test("periodic owner work fires at the same times as setInterval and stops on close", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const interval: number[] = [];
  const periodic: number[] = [];
  const handle = setInterval(() => interval.push(Date.now()), 5_000);
  const work = periodicOwnerWork(timeoutOwnerWake(), 5_000, () => periodic.push(Date.now()));
  for (let i = 0; i < 25; i++) t.mock.timers.tick(1_000);
  assert.deepEqual(periodic, [5_000, 10_000, 15_000, 20_000, 25_000]);
  assert.deepEqual(periodic, interval);
  clearInterval(handle);
  work.close();
  work.close();
  t.mock.timers.tick(60_000);
  assert.deepEqual(periodic, [5_000, 10_000, 15_000, 20_000, 25_000]);
});

test("the default Node wake-up reads the monotonic clock, so wall-clock jumps neither delay nor hasten periods", () => {
  const wake = timeoutOwnerWake();
  assert.ok(Math.abs(wake.now() - performance.now()) < 1_000);
  const fake = fakeWakeClock();
  const fired: number[] = [];
  const work = periodicOwnerWork(fakeMonotonicOwnerWake(fake), 60_000, () => fired.push(fake.monotonic));
  fake.elapse(30_000);
  fake.jump(-HOUR); // a wall clock set back neither delays nor repeats periodic work
  fake.elapse(90_000);
  fake.jump(2 * HOUR); // nor does one set forward hasten it
  fake.elapse(30_000);
  work.close();
  assert.deepEqual(fired, [60_000, 120_000]);
  assert.equal(fake.pending, 0);
});

test("closing from inside the run stops periodic work; a run that throws keeps its next wake-up", () => {
  const fake = fakeWakeClock();
  const wake = fakeOwnerWake(fake);
  let runs = 0;
  const work = periodicOwnerWork(wake, 1_000, () => {
    if (++runs === 2) work.close();
  });
  fake.elapse(10_000);
  assert.equal(runs, 2);
  assert.equal(fake.pending, 0);
  let failures = 0;
  const failing = periodicOwnerWork(wake, 1_000, () => {
    failures++;
    throw new Error("owner pass failed");
  });
  assert.throws(() => fake.elapse(1_000), /owner pass failed/u);
  assert.equal(fake.pending, 1);
  failing.close();
  assert.equal(failures, 1);
  assert.throws(() => periodicOwnerWork(wake, 0, () => {}), RangeError);
});

test("merged wake-ups arm one alarm for the next due time and wake each owner in due order", () => {
  const fake = fakeWakeClock(0);
  const alarm = fakeAlarm(fake);
  const merged = mergedOwnerWake(alarm.wake);
  const woken: string[] = [];
  const a = merged.timer(() => woken.push("a"));
  const b = merged.timer(() => woken.push("b"));
  const c = merged.timer(() => {
    woken.push("c");
    throw new Error("owner c failed");
  });
  b.arm(300);
  a.arm(100);
  c.arm(100);
  assert.equal(alarm.state.armed, 100);
  const sets = alarm.state.sets;
  b.arm(300); // an unchanged earliest time does not re-arm the alarm
  assert.equal(alarm.state.sets, sets);
  fake.jump(100);
  assert.throws(() => alarm.fire(), /owner c failed/u);
  assert.deepEqual(woken, ["a", "c"]);
  assert.equal(alarm.state.armed, 300);
  // An alarm that arrives before any owner is due (its clock ran ahead of the owner clock) only re-arms.
  alarm.state.armed = 200;
  fake.jump(100);
  assert.equal(alarm.fire(), true);
  assert.deepEqual(woken, ["a", "c"]);
  assert.equal(alarm.state.armed, 300);
  b.cancel();
  assert.equal(alarm.state.armed, null);
  b.cancel();
  a.arm(250);
  assert.equal(alarm.state.armed, 250);
  a.cancel();
  assert.equal(alarm.state.armed, null);
  fake.jump(1_000);
  assert.equal(alarm.fire(), false);
  assert.deepEqual(woken, ["a", "c"]);
  assert.throws(() => a.arm(Number.NaN), RangeError);
});

test("periodic owners merged onto one alarm fire at the times their own timers would", () => {
  const fake = fakeWakeClock(0);
  const alarm = fakeAlarm(fake);
  const merged = mergedOwnerWake(alarm.wake);
  const separate = fakeWakeClock(0);
  const own = fakeOwnerWake(separate);
  const onAlarm: string[] = [];
  const onTimers: string[] = [];
  const periods = { retry: 5_000, observe: 30_000, reconcile: 60_000 } as const;
  const works = Object.entries(periods).flatMap(([name, period]) => [
    periodicOwnerWork(merged, period, () => onAlarm.push(`${fake.now}:${name}`)),
    periodicOwnerWork(own, period, () => onTimers.push(`${separate.now}:${name}`)),
  ]);
  // The runtime fires the alarm when its time comes; nothing else drives the merged owners.
  for (let at = 0; at <= 120_000; at += 1_000) {
    fake.jump(at - fake.now);
    while (alarm.fire());
  }
  separate.elapse(120_000);
  assert.equal(onAlarm.filter((entry) => entry.endsWith(":retry")).length, 24);
  assert.deepEqual(onAlarm.filter((entry) => !entry.endsWith(":retry")).sort(), [
    "120000:observe",
    "120000:reconcile",
    "30000:observe",
    "60000:observe",
    "60000:reconcile",
    "90000:observe",
  ]);
  // Owners due at the same instant wake in an unspecified order.
  assert.deepEqual([...onAlarm].sort(), [...onTimers].sort());
  for (const work of works) work.close();
  assert.equal(alarm.state.armed, null);
  assert.equal(separate.pending, 0);
});

/** A minimal due-time owner: items expire at their due time, as the workspace receipt owners do. */
function dueItems(wake: Parameters<typeof dueOwnerWork>[0]) {
  const due = new Map<string, number>();
  const expired: string[] = [];
  const work = dueOwnerWork(
    wake,
    () => (due.size ? Math.min(...due.values()) : null),
    (now) => {
      for (const [name, at] of due)
        if (at <= now) {
          due.delete(name);
          expired.push(`${now}:${name}`);
        }
    },
  );
  return {
    expired,
    work,
    add(name: string, at: number) {
      due.set(name, at);
      work.reschedule();
    },
    remove(name: string) {
      due.delete(name);
      work.reschedule();
    },
  };
}

test("due owner work wakes only at the next due time and never while nothing is due", () => {
  const fake = fakeWakeClock(0);
  const arms: number[] = [];
  const base = fakeOwnerWake(fake);
  const wake = { now: base.now, timer: (callback: () => void) => {
    const timer = base.timer(callback);
    return { arm(at: number) { arms.push(at); timer.arm(at); }, cancel: () => timer.cancel() };
  } };
  const owner = dueItems(wake);
  assert.equal(fake.pending, 0, "an owner with nothing due arms no wake-up");
  fake.elapse(HOUR);
  assert.deepEqual(owner.expired, []);
  owner.add("a", fake.now + 300_000);
  owner.add("b", fake.now + 600_000);
  assert.deepEqual(arms, [HOUR + 300_000], "a later item does not re-arm");
  fake.elapse(299_999);
  assert.deepEqual(owner.expired, []);
  fake.elapse(1);
  assert.deepEqual(owner.expired, [`${HOUR + 300_000}:a`]);
  assert.equal(fake.pending, 1);
  owner.remove("b");
  assert.equal(fake.pending, 0, "cancelling the last due item disarms");
  fake.elapse(HOUR);
  assert.deepEqual(owner.expired, [`${HOUR + 300_000}:a`]);
  assert.deepEqual(arms, [HOUR + 300_000, HOUR + 600_000]);
});

test("an earlier due item re-arms earlier; close disarms and no run follows", () => {
  const fake = fakeWakeClock(0);
  const owner = dueItems(fakeOwnerWake(fake));
  owner.add("late", 60_000);
  owner.add("early", 10_000);
  fake.elapse(10_000);
  assert.deepEqual(owner.expired, ["10000:early"]);
  owner.add("sooner", 20_000);
  owner.add("same", 20_000);
  fake.elapse(10_000);
  assert.deepEqual(owner.expired, ["10000:early", "20000:sooner", "20000:same"]);
  owner.work.close();
  owner.work.close();
  assert.equal(fake.pending, 0);
  owner.add("after-close", 30_000);
  assert.equal(fake.pending, 0, "reschedule after close arms nothing");
  fake.elapse(HOUR);
  assert.deepEqual(owner.expired, ["10000:early", "20000:sooner", "20000:same"]);
  assert.throws(() => dueOwnerWork(fakeOwnerWake(fake), () => Number.NaN, () => {}), RangeError);
});

test("a run that throws still re-reads the next due time; a run is never told a time before the armed one", () => {
  const fake = fakeWakeClock(0);
  const wake = fakeOwnerWake(fake);
  let due: number | null = 1_000;
  const seen: number[] = [];
  const work = dueOwnerWork(wake, () => due, (now) => {
    seen.push(now);
    due = now + 1_000;
    if (seen.length === 1) throw new Error("owner pass failed");
  });
  assert.throws(() => fake.elapse(1_000), /owner pass failed/u);
  assert.equal(fake.pending, 1);
  fake.elapse(1_000);
  assert.deepEqual(seen, [1_000, 2_000]);
  work.close();
  // Timer granularity can leave the owner clock just short of an elapsed timeout; the run still sees the armed time.
  let clock = 0;
  let fire: (() => void) | null = null;
  let arms = 0;
  const short = { now: () => clock, timer: (callback: () => void) => ({ arm() { arms++; fire = callback; }, cancel() { fire = null; } }) };
  const reached: number[] = [];
  const items = new Set([5_000]);
  dueOwnerWork(short, () => (items.size ? Math.min(...items) : null), (now) => {
    reached.push(now);
    for (const at of items) if (at <= now) items.delete(at);
  });
  clock = 4_999.4;
  const elapsed = fire as unknown as () => void;
  fire = null; // a one-shot wake-up is spent once it fires
  elapsed();
  assert.deepEqual(reached, [5_000]);
  assert.equal(items.size, 0);
  assert.equal(arms, 1, "nothing left due: not re-armed");
});

test("due owners merged onto one alarm wake at their due times alongside periodic owners", () => {
  const fake = fakeWakeClock(0);
  const alarm = fakeAlarm(fake);
  const merged = mergedOwnerWake(alarm.wake);
  const owner = dueItems(merged);
  const periodic: number[] = [];
  const observe = periodicOwnerWork(merged, 30_000, () => periodic.push(fake.now));
  owner.add("receipt", 45_000);
  assert.equal(alarm.state.armed, 30_000);
  const drive = (until: number) => {
    for (let at = fake.now + 1_000; at <= until; at += 1_000) {
      fake.jump(at - fake.now);
      while (alarm.fire());
    }
  };
  drive(40_000);
  assert.equal(alarm.state.armed, 45_000);
  owner.add("earlier", 42_000);
  assert.equal(alarm.state.armed, 42_000);
  drive(60_000);
  assert.deepEqual(owner.expired, ["42000:earlier", "45000:receipt"]);
  assert.deepEqual(periodic, [30_000, 60_000]);
  observe.close();
  assert.equal(alarm.state.armed, null, "nothing due and no periodic owner: the alarm is disarmed");
  owner.work.close();
});

test("due owner work on the default Node wake-up fires at the due instant", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const wake = timeoutOwnerWake();
  const fired: number[] = [];
  let due: number | null = wake.now() + 300_000;
  const work = dueOwnerWork(wake, () => due, () => {
    fired.push(Date.now());
    due = null;
  });
  t.mock.timers.tick(299_999);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fired, [300_000]);
  t.mock.timers.tick(HOUR);
  assert.deepEqual(fired, [300_000]);
  work.close();
});
