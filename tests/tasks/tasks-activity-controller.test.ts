import assert from "node:assert/strict";
import test from "node:test";
import { TASKS, type TaskEvent, type TasksRequestPort } from "@opencraft/appserver-protocol";
import { TaskActivityController } from "../../plugins/tasks/src/activity-controller";
const event = (eventId: string, text: string, seq = 1): TaskEvent => ({ eventId, text, seq, taskId: "a", type: "progress", taskRevision: 7, actor: null, channel: "api", payload: { text }, createdAt: 100 } as TaskEvent);
test("lost progress acknowledgement uses exact event ID and never replays an accepted report", async () => {
  const calls: string[] = []; let committed: TaskEvent | null = null;
  const controller = new TaskActivityController({ request: async (method, params: any) => {
    calls.push(method);
    if (method === TASKS.progress) { committed = event(params.eventId, params.text); throw new Error("Lost ack"); }
    if (method === TASKS.event) { assert.equal(params.eventId, committed!.eventId); return committed; }
    throw new Error("Not needed");
  } } as TasksRequestPort, "a");
  assert.equal(await controller.append("Ready"), true);
  assert.deepEqual(calls, [TASKS.progress, TASKS.event]);
  assert.equal(controller.getSnapshot().events[0]?.payload.text, "Ready");
  controller.dispose();
});
test("unknown result retains the ID and text through read failure, then reconciles before a retry", async () => {
  let committed: TaskEvent | null = null, readable = false, writes = 0;
  const controller = new TaskActivityController({ request: async (method, params: any) => {
    if (method === TASKS.progress) { writes++; committed = event(params.eventId, params.text); throw new Error("Lost ack"); }
    if (method === TASKS.event) { if (!readable) throw new Error("Offline"); assert.equal(params.eventId, committed!.eventId); return committed; }
    throw new Error("Not needed");
  } } as TasksRequestPort, "a");
  assert.equal(await controller.append("Ready"), false);
  assert.equal(controller.getSnapshot().error, "unknown");
  assert.equal(await controller.append("Different text"), false);
  readable = true;
  assert.equal(await controller.append("Ready"), true); assert.equal(writes, 1);
  controller.dispose();
});
test("pagination merges overlap and disposal fences a late activity result", async () => {
  let resolve: (v: any) => void = () => {};
  const controller = new TaskActivityController({ request: () => new Promise(r => resolve = r) } as TasksRequestPort, "a");
  const first = controller.refresh(); resolve({ events: [event("b", "B", 2)], nextBeforeSeq: 2 }); await first;
  const older = controller.refresh(true); resolve({ events: [event("a", "A", 1), event("b", "B", 2)], nextBeforeSeq: null }); await older;
  assert.deepEqual(controller.getSnapshot().events.map(e => e.seq), [2, 1]);
  const late = controller.refresh(); controller.dispose(); resolve({ events: [event("late", "Late", 3)], nextBeforeSeq: null }); await late;
  assert.deepEqual(controller.getSnapshot().events.map(e => e.seq), [2, 1]);
});

test("posting after a burst retains the unseen middle activity pages", async () => {
  let history = [event("first", "First", 1)];
  const controller = new TaskActivityController({ request: async (method, params: any) => {
    if (method === TASKS.progress) {
      history = Array.from({ length: 100 }, (_, i) => event(i === 0 ? "first" : i === 99 ? params.eventId : `event-${i + 1}`, i === 99 ? params.text : "Update", i + 1));
      return history.at(-1);
    }
    if (method === TASKS.events) {
      const eligible = history.filter(e => params.beforeSeq === undefined || e.seq < params.beforeSeq).toReversed();
      const events = eligible.slice(0, 20);
      return { events, nextBeforeSeq: eligible.length > 20 ? events.at(-1)!.seq : null };
    }
    throw Error("Unexpected request");
  } } as TasksRequestPort, "a");
  await controller.refresh();
  assert.equal(await controller.append("Report after the burst"), true);
  await controller.refresh();
  assert.equal(controller.getSnapshot().nextBeforeSeq, 81, "A local receipt does not prove intervening pages were read");
  while (controller.getSnapshot().nextBeforeSeq !== null) await controller.refresh(true);
  assert.equal(new Set(controller.getSnapshot().events.map(e => e.seq)).size, 100);
  await controller.refresh();
  assert.equal(controller.getSnapshot().nextBeforeSeq, null, "An overlapping head retains exhausted pagination");
  controller.dispose();
});
