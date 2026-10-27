import assert from "node:assert/strict";
import test from "node:test";
import { ConversationActivityReader, type ConversationActivityTarget } from "../../plugins/tasks/src/conversation-activity-reader";
import type { TaskConversationActivity } from "../../plugins/tasks/src/index";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const targets = (count: number): ConversationActivityTarget[] => Array.from({ length: count }, (_, i) => ({ key: String(i), hostId: "host", threadId: String(i) }));
const activity = (title: string): TaskConversationActivity => ({ title, state: "running" });

test("refresh bursts coalesce across rounds and share one four-read budget", async () => {
  const held: Array<() => void> = [];
  let active = 0, peak = 0, calls = 0, publications = 0;
  const reader = new ConversationActivityReader(target => {
    calls++; active++; peak = Math.max(peak, active);
    return new Promise(resolve => held.push(() => { active--; resolve(activity(target.threadId)); }));
  }, () => { publications++; });
  try {
    reader.refresh(targets(8));
    for (let i = 0; i < 30; i++) reader.refresh(targets(8));
    assert.equal(calls, 4);
    for (let round = 0; round < 4; round++) { for (const release of held.splice(0)) release(); await flush(); }
    assert.equal(calls, 16, "one initial round plus one coalesced refresh");
    assert.equal(peak, 4); assert.equal(active, 0); assert.equal(publications, 2);
  } finally { reader.dispose(); }
});

test("disposing a View aborts pending reads, stops old workers and suppresses their late results", async () => {
  const held: Array<() => void> = [], signals: AbortSignal[] = [];
  let calls = 0, publications = 0;
  const reader = new ConversationActivityReader((target, signal) => {
    calls++; signals.push(signal);
    return new Promise(resolve => held.push(() => resolve(activity(target.threadId))));
  }, () => { publications++; });
  reader.refresh(targets(12)); reader.refresh(targets(12)); reader.dispose();
  assert(signals.every(signal => signal.aborted));
  for (const release of held) release(); await flush();
  assert.equal(calls, 4); assert.equal(publications, 0);
});

test("a failed refresh retains known activity, and removed links receive no more old reads", async () => {
  const snapshots: ReadonlyMap<string, TaskConversationActivity>[] = [];
  let fail = false;
  const reader = new ConversationActivityReader(async target => {
    if (fail) throw new Error("unavailable");
    return activity(target.threadId);
  }, snapshot => snapshots.push(snapshot));
  try {
    reader.refresh(targets(2)); await flush();
    fail = true; reader.refresh(targets(1)); await flush();
    assert.deepEqual([...snapshots.at(-1)!], [["0", activity("0")]]);
    reader.refresh([]); await flush(); assert.equal(snapshots.at(-1)!.size, 0);
  } finally { reader.dispose(); }
});
