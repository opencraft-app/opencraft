import test from "node:test";
import assert from "node:assert/strict";
import { mergedOwnerWake, periodicOwnerWork, timeoutOwnerWake } from "@opencraft/owner-wake";
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
