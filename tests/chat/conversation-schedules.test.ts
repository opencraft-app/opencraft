import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationSchedules, type ScheduleExecutionPort } from "../../apps/opencraft-daemon/src/conversation-schedules";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-schedules-"));
  let now = 1800000000000, busy = false, inspections = 0, sends = 0, changes = 0;
  const accepted = new Set<string>(), seen: string[] = [];
  let result: "running" | "completed" | "failed" | "unknown" = "running";
  const port: ScheduleExecutionPort = {
    validate: async id => { if (id !== "thread") throw new Error("not found"); },
    submit: async run => {
      seen.push(run.id);
      if (busy) return { state: "waiting" };
      if (!accepted.has(run.id)) { sends++; accepted.add(run.id); }
      return { state: result, turnId: "turn" };
    },
    inspect: async () => { inspections++; return { state: result }; },
  };
  let service = new ConversationSchedules(root, port, () => now, undefined, () => { changes++; });
  return {
    get service() { return service; }, port, seen,
    get changes() { return changes; },
    get sends() { return sends; }, get inspections() { return inspections; },
    advance(ms: number) { now += ms; }, setBusy(value: boolean) { busy = value; }, setResult(value: typeof result) { result = value; },
    async save(intervalMinutes: number | null = null) {
      return service.handle("opencraft/schedules/save", { threadId: "thread", prompt: "Check the report", expectedRevision: service.read("thread").schedule?.revision ?? 0,
        nextRunAt: now, intervalMinutes, timeZone: "Asia/Shanghai" }, "fixture-creator");
    },
    async action(action: string, revision = service.read("thread").schedule!.revision) {
      return service.handle("opencraft/schedules/action", { threadId: "thread", expectedRevision: revision, action }, null);
    },
    async restart() { await service.close(); service = new ConversationSchedules(root, port, () => now, undefined, () => { changes++; }); },
    async close() { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}
test("busy conversations wait, restart restores the same occurrence, completion is separate from admission", async () => {
  const f = await fixture(); try {
    await f.save(); f.setBusy(true); await f.service.tick();
    const id = f.service.read("thread").runs[0]!.id;
    assert.equal(f.sends, 0); assert.equal(f.service.read("thread").runs[0]!.state, "waiting");
    await f.restart(); f.setBusy(false); await f.service.tick();
    assert.equal(f.sends, 1); assert.deepEqual(new Set(f.seen), new Set([id]));
    assert.equal(f.service.read("thread").schedule!.status, "active");
    assert.equal(f.service.read("thread").runs[0]!.state, "running");
    await f.restart(); f.setResult("completed"); await f.service.tick();
    assert.equal(f.sends, 1); assert.equal(f.service.read("thread").schedule!.status, "completed");
    assert.equal(f.service.read("thread").runs[0]!.state, "completed");
  } finally { await f.close(); }
});
test("missed intervals coalesce, no overlap, concurrent ticks have a single owner", async () => {
  const f = await fixture(); try {
    const initial = await f.save(1); f.advance(600000);
    await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
    assert.equal(f.sends, 1);
    f.advance(600000); await f.service.tick(); assert.equal(f.sends, 1);
    f.setResult("completed"); f.advance(16000); await f.service.tick();
    const view = f.service.read("thread");
    assert.equal(view.runs.length, 1);
    assert.ok(view.schedule!.nextRunAt > initial.schedule!.nextRunAt + 1200000);
    f.advance(60000); f.setResult("running"); await f.service.tick(); assert.equal(f.sends, 2);
  } finally { await f.close(); }
});
test("unknown delivery is durable and never automatically retried", async () => {
  const f = await fixture(); try {
    await f.save(1); f.setResult("unknown"); await f.service.tick(); await f.restart();
    f.advance(86400000); await f.service.tick(); await f.service.tick();
    assert.equal(f.sends, 1); assert.equal(f.seen.length, 1);
    assert.equal(f.service.read("thread").runs[0]!.state, "unknown");
    await assert.rejects(f.action("run-now"), /unfinished/);
    await assert.rejects(f.save(), /unfinished/);
    await f.action("review");
    assert.equal(f.service.read("thread").schedule!.status, "paused");
    assert.equal(f.service.read("thread").runs[0]!.state, "reviewed");
    await f.service.tick(); assert.equal(f.sends, 1);
  } finally { await f.close(); }
});
test("pause/delete stop waiting work; CAS prevents overwriting another client", async () => {
  const f = await fixture(); try {
    const initial = await f.save(); f.setBusy(true); await f.service.tick();
    await f.action("pause");
    await assert.rejects(f.action("resume", initial.schedule!.revision), /changed/);
    f.setBusy(false); f.advance(60000); await f.service.tick(); assert.equal(f.sends, 0);
    await f.action("resume"); await f.service.tick(); assert.equal(f.sends, 1);
    await f.action("delete");
    f.setResult("completed"); f.advance(60000); await f.service.tick();
    assert.equal(f.service.read("thread").schedule!.status, "deleted"); assert.equal(f.sends, 1);
  } finally { await f.close(); }
});
test("manual run does not move a future scheduled time and failed runs release the next interval", async () => {
  const f = await fixture(); try {
    await f.save(60); f.setResult("completed"); await f.service.tick();
    const next = f.service.read("thread").schedule!.nextRunAt;
    await f.action("run-now"); await f.service.tick();
    assert.equal(f.service.read("thread").schedule!.nextRunAt, next);
    assert.equal(f.service.read("thread").runs.length, 2);
    f.advance(3600000); f.setResult("failed"); await f.service.tick();
    assert.equal(f.service.read("thread").runs[0]!.state, "failed");
    assert.ok(f.service.read("thread").schedule!.nextRunAt > next);
  } finally { await f.close(); }
});
test("validation rejects invalid dates, zones, intervals and nonexistent targets without storing a plan", async () => {
  const f = await fixture(); try {
    for (const value of [{ timeZone: "No/SuchZone" }, { nextRunAt: Infinity }, { intervalMinutes: 0 }, { prompt: " " }, { intervalMinutes: 0.5 }]) {
      await assert.rejects(f.service.handle("opencraft/schedules/save", { threadId: "thread", expectedRevision: 0,
        prompt: "test", nextRunAt: 1800000000000, intervalMinutes: null, timeZone: "UTC", ...value }, null));
    }
    await assert.rejects(f.service.handle("opencraft/schedules/save", { threadId: "missing", expectedRevision: 0 }, null), /not found/);
    assert.equal(f.service.read("thread").schedule, null);
  } finally { await f.close(); }
});
test("pause during asynchronous admission fences a not-yet-submitted occurrence; archive stops future work", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  f.port.submit = async (_run, _prompt, canAdmit) => {
    entered(); await held;
    if (!canAdmit()) return { state: "failed" };
    sends++; return { state: "running" };
  };
  try {
    await f.save(); const tick = f.service.tick(); await ready;
    await f.action("pause"); release(); await tick;
    assert.equal(sends, 0); assert.equal(f.service.read("thread").schedule!.status, "paused");
    await f.action("resume"); f.service.suspend("thread");
    f.advance(60000); await f.service.tick(); assert.equal(sends, 0);
  } finally { release(); await f.close(); }
});

test("summary is content-free, keeps paused/unknown plans and only notifies semantic changes", async () => {
  const f = await fixture(); try {
    assert.deepEqual(f.service.list(), { schedules: [] });
    await f.save(); assert.equal(f.changes, 1);
    let summary = f.service.list().schedules[0]!;
    assert.deepEqual(Object.keys(summary).sort(), ["needsReview", "nextRunAt", "status", "threadId"]);
    assert.equal(summary.needsReview, false);
    f.setBusy(true); await f.service.tick(); assert.equal(f.changes, 1, "busy polling cannot churn the summary");
    await f.action("pause"); assert.equal(f.changes, 2);
    assert.equal(f.service.list().schedules[0]!.status, "paused");
    await f.action("resume"); f.setBusy(false); f.setResult("unknown"); f.advance(6000); await f.service.tick();
    assert.equal(f.service.list().schedules[0]!.needsReview, true);
    await f.action("delete"); assert.equal(f.service.list().schedules[0]!.needsReview, true, "deleting a plan cannot hide ambiguous execution");
    await f.action("review"); assert.deepEqual(f.service.list(), { schedules: [] });
    await f.save(); f.setResult("completed"); await f.service.tick();
    assert.deepEqual(f.service.list(), { schedules: [] }, "a settled one-shot no longer has a timer badge");
    await f.restart(); assert.deepEqual(f.service.list(), { schedules: [] });
  } finally { await f.close(); }
});


test("explicit permissions survive restart, snapshot each occurrence and reject unapproved profiles", async () => {
  const f = await fixture();
  f.port.permissionProfiles = async () => [{ id: "opencraft:permission-mode:full", description: null, allowed: true }, { id: "disabled", description: null, allowed: false }];
  const save = (permissions: string | null | undefined) => f.service.handle("opencraft/schedules/save", {
    threadId: "thread", expectedRevision: f.service.read("thread").schedule?.revision ?? 0,
    prompt: "task", nextRunAt: 1800000000000, intervalMinutes: 60, timeZone: "UTC", permissions,
  }, null);
  try {
    await f.save(); assert.equal(f.service.read("thread").schedule!.permissions, null);
    for (const value of ["disabled", "made-up"]) await assert.rejects(save(value), /Invalid schedule/);
    await save("opencraft:permission-mode:full"); await f.restart();
    assert.equal(f.service.read("thread").schedule!.permissions, "opencraft:permission-mode:full");
    f.setBusy(true); await f.service.tick();
    const run = f.service.read("thread").runs[0]!;
    assert.equal(run.permissions, "opencraft:permission-mode:full");
    await f.action("pause"); await save(null);
    assert.equal(f.service.executionPermissions("thread", run.id), "opencraft:permission-mode:full");
    assert.equal(f.service.executionPermissions("other", run.id), null);
    await f.restart();
    assert.equal(f.service.executionPermissions("thread", run.id), "opencraft:permission-mode:full");
    assert.equal(f.service.read("thread").schedule!.permissions, null);
  } finally { await f.close(); }
});

// Native Host owns timing; client interactions do not introduce a second scheduler.
import { nextCalendarRun, nextIntervalRun } from "@opencraft/appserver-protocol";
test("calendar rules respect zone, multiple times and selected dates", () => {
  assert.equal(nextCalendarRun({ period: "daily", times: ["18:00", "09:00"], days: [] }, "Asia/Shanghai", Date.parse("2026-10-21T02:00Z")), Date.parse("2026-10-21T10:00Z"));
  assert.equal(nextCalendarRun({ period: "weekly", times: ["09:00"], days: [1, 5] }, "Asia/Shanghai", Date.parse("2026-10-21T02:00Z")), Date.parse("2026-10-23T01:00Z"));
  assert.equal(nextCalendarRun({ period: "monthly", times: ["09:00"], days: [31] }, "UTC", Date.parse("2026-04-01T00:00Z")), Date.parse("2026-05-31T09:00Z"));
});
test("DST gap is skipped and ambiguous wall time executes once", () => {
  assert.equal(nextCalendarRun({ period: "daily", times: ["02:30"], days: [] }, "America/New_York", Date.parse("2026-03-08T00:00Z")), Date.parse("2026-03-09T06:30Z"));
  const calendar = { period: "daily" as const, times: ["01:30"], days: [] };
  assert.equal(nextCalendarRun(calendar, "America/New_York", Date.parse("2026-11-01T00:00Z")), Date.parse("2026-11-01T05:30Z"));
  assert.equal(nextCalendarRun(calendar, "America/New_York", Date.parse("2026-11-01T05:31Z")), Date.parse("2026-11-02T06:30Z"));
});
test("effective windows and interval weekdays preserve interval phase", () => {
  const window = { startAt: null, endAt: null, weekdays: [1] };
  assert.equal(nextIntervalRun(Date.parse("2026-10-25T09:15Z"), 60, "UTC", Date.parse("2026-10-25T09:15Z"), window), Date.parse("2026-10-26T00:15Z"));
  assert.equal(nextCalendarRun({ period: "daily", times: ["09:00"], days: [] }, "UTC", Date.parse("2026-10-21T10:00Z"), { ...window, weekdays: [0,1,2,3,4,5,6], endAt: Date.parse("2026-10-22T08:00Z") }), null);
});
test("calendar plan persists, executes through native port with skill instruction, and advances", async () => {
  const f = await fixture();
  let instructions = "";
  f.port.submit = async (_run, prompt) => { instructions = prompt; return { state: "completed" }; };
  try {
    const now = 1800000000000;
    const date = new Date(now + 60000).toISOString().slice(11,16);
    const value = await f.service.handle("opencraft/schedules/save", { threadId: "thread", expectedRevision: 0, prompt: "Check report", nextRunAt: now, intervalMinutes: null, timeZone: "UTC", calendar: { period: "daily", times: [date], days: [] }, skills: ["reporting"] }, null);
    assert.ok(value.schedule!.calendar);
    f.advance(120000); await f.service.tick();
    assert.match(instructions, /reporting/);
    assert.equal(f.service.read("thread").schedule!.status, "active");
    assert.ok(f.service.read("thread").schedule!.nextRunAt > now + 120000);
    await assert.rejects(f.service.handle("opencraft/schedules/save", { threadId: "thread", expectedRevision: f.service.read("thread").schedule!.revision, prompt: "bad", nextRunAt: now+180000, intervalMinutes: null, timeZone: "UTC", calendar: { period: "weekly", times: ["25:00"], days: [] } }, null));
  } finally { await f.close(); }
});
