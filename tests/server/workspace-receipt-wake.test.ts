import test from "node:test";
import assert from "node:assert/strict";
import { mergedOwnerWake, type OwnerWake } from "@opencraft/owner-wake";
import { WorkspaceLifecycleJobs } from "../../apps/headless-server/src/workspaces/lifecycle-jobs.ts";
import { RECEIPT_RETENTION_MS } from "../../apps/headless-server/src/workspaces/receipt-retention.ts";
import { WorkspaceTerminalTransfers } from "../../apps/headless-server/src/workspaces/terminal-transports.ts";
import { fakeAlarm, fakeOwnerWake, fakeWakeClock, flush, HOUR } from "../support/fake-wake-clock.ts";

/** The owner wake-up over a fake clock, recording every armed time relative to the clock. */
function recordingWake(fake: ReturnType<typeof fakeWakeClock>) {
  const base = fakeOwnerWake(fake);
  const arms: number[] = [];
  const wake: OwnerWake = {
    now: base.now,
    timer(callback) {
      const timer = base.timer(callback);
      return {
        arm(at) {
          arms.push(at - fake.now);
          timer.arm(at);
        },
        cancel: () => timer.cancel(),
      };
    },
  };
  return { wake, arms };
}

const row = (threadId: string) => ({ hostId: "local-codex", threadId, state: "archived", generation: 1 }) as never;

test("lifecycle receipts expire at their due time; nothing wakes while none has finished", async () => {
  const fake = fakeWakeClock(0);
  const { wake, arms } = recordingWake(fake);
  const releases: (() => void)[] = [];
  const jobs = new WorkspaceLifecycleJobs(
    () => new Promise<{ managed: boolean }>((resolve) => releases.push(() => resolve({ managed: true }))),
    wake,
  );
  fake.elapse(HOUR);
  assert.equal(fake.pending, 0, "no receipt: no wake-up (the former 1 s interval ran regardless)");
  const first = jobs.begin(row("t1"));
  const second = jobs.begin(row("t2"));
  await flush();
  assert.equal(fake.pending, 0, "a pending receipt never expires");
  releases[0]!();
  await flush();
  assert.deepEqual(arms, [RECEIPT_RETENTION_MS]);
  fake.elapse(100_000);
  releases[1]!();
  await flush();
  assert.deepEqual(arms, [RECEIPT_RETENTION_MS], "a later expiry keeps the armed earlier one");
  fake.elapse(RECEIPT_RETENTION_MS - 100_000 - 1);
  assert.deepEqual(jobs.status(first), { state: "complete", managed: true });
  fake.elapse(1);
  assert.throws(() => jobs.status(first), /receipt unavailable/u, "forgotten exactly at 300 s (formerly 300-301 s)");
  assert.deepEqual(jobs.status(second), { state: "complete", managed: true });
  assert.equal(fake.pending, 1);
  jobs.forget(second);
  assert.equal(fake.pending, 0, "forgetting the last finished receipt disarms");
  const third = jobs.begin(row("t3"));
  await flush();
  releases[2]!();
  await flush();
  assert.equal(fake.pending, 1);
  await jobs.close();
  assert.equal(fake.pending, 0, "close disarms");
  fake.elapse(HOUR);
  assert.throws(() => jobs.status(third), /receipt unavailable/u);
});

test("lifecycle receipts on a merged alarm share the deployment's single wake-up", async () => {
  const fake = fakeWakeClock(0);
  const alarm = fakeAlarm(fake);
  const jobs = new WorkspaceLifecycleJobs(async () => ({ managed: false }), mergedOwnerWake(alarm.wake));
  const token = jobs.begin(row("t1"));
  await flush();
  assert.equal(alarm.state.armed, RECEIPT_RETENTION_MS);
  fake.jump(RECEIPT_RETENTION_MS);
  assert.equal(alarm.fire(), true);
  assert.throws(() => jobs.status(token), /receipt unavailable/u);
  assert.equal(alarm.state.armed, null);
  await jobs.close();
});

test("terminal watches are re-checked every 500 ms only while open; settled operations expire at their due time", async () => {
  const fake = fakeWakeClock(0);
  const { wake, arms } = recordingWake(fake);
  let bound = true;
  let authorized = true;
  const binding = {
    isCurrent: () => bound,
    executionSelection: async () => ({ kind: "bound", workspaceId: "w", generation: 1 }),
    processes: { dispatch: async () => "started", probe: async () => {}, request: async () => ({}) },
  };
  const access = {
    actorId: "a",
    generation: 1,
    membershipRevision: 1,
    requestPermit: new Int32Array(new SharedArrayBuffer(4)),
  } as never;
  const terminals = new WorkspaceTerminalTransfers({
    current: () => authorized,
    binding: async () => binding as never,
    wake,
  });
  fake.elapse(HOUR);
  assert.equal(fake.pending, 0, "no watch and no receipt: no wake-up (the former 500 ms interval ran regardless)");
  const watch = await terminals.open(access, "thread", { workspaceId: "w", generation: 1 });
  assert.deepEqual(arms, [500]);
  const operation = await terminals.begin(watch, access, "process/spawn", {});
  await flush();
  assert.deepEqual(terminals.status(operation), { state: "complete", result: "started" });
  assert.deepEqual(arms.slice(1), [RECEIPT_RETENTION_MS]);
  fake.elapse(1_000);
  assert.deepEqual(arms.slice(2), [500, 500], "the watch check keeps its 500 ms period while the watch is open");
  bound = false;
  fake.elapse(500);
  await assert.rejects(terminals.probe(watch), /unavailable/u);
  assert.equal(fake.pending, 1, "the dropped watch left only the receipt expiry armed");
  bound = true;
  fake.elapse(RECEIPT_RETENTION_MS - 1_500 - 1);
  assert.deepEqual(terminals.status(operation), { state: "complete", result: "started" });
  fake.elapse(1);
  assert.throws(() => terminals.status(operation), /unavailable/u);
  assert.equal(fake.pending, 0);
  const again = await terminals.open(access, "thread", { workspaceId: "w", generation: 1 });
  assert.equal(fake.pending, 1);
  terminals.unwatch(again);
  assert.equal(fake.pending, 0, "unwatching the last watch disarms its check");
  await terminals.open(access, "thread", { workspaceId: "w", generation: 1 });
  authorized = false;
  fake.elapse(500);
  assert.equal(fake.pending, 0, "a revoked watch is dropped by the next check");
  authorized = true;
  await terminals.open(access, "thread", { workspaceId: "w", generation: 1 });
  await terminals.close();
  assert.equal(fake.pending, 0, "close disarms");
});
