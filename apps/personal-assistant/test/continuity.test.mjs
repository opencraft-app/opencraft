import { legacyMemoryFixture } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CalendarSchedule } from "../src/domain/calendar-schedule.mjs";
import { Store } from "../src/store.mjs";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { DirectoryKnowledgeSource } from "../src/adapters/filesystem/knowledge-source.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { ReceptionDecision } from "../src/domain/conversation.mjs";
import { profileFor, root, until, completed } from "./helpers.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";
import { execFileSync } from "node:child_process";
const ms = Date.parse;
const calendar = (extra = {}) => ({
  kind: "calendar",
  timeZone: "Asia/Shanghai",
  weekdays: [1, 2, 3, 4, 5],
  hours: [9],
  minutes: [0],
  ...extra,
});
const fixture = (t) => {
  const profile = profileFor(t),
    a = join(profile.path, "a"),
    b = join(profile.path, "b");
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, "project.md"), "project A");
  writeFileSync(join(b, "project.md"), "project B");
  const open = (dir) => createLocalDomain(profile, new DirectoryKnowledgeSource(dir));
  return { profile, a, b, open };
};

test("calendar chooses local weekday windows, validates zones and skips DST gaps/repeated local slots", () => {
  assert.equal(CalendarSchedule.next(calendar(), ms("2026-11-06T02:00:00Z")), ms("2026-11-09T01:00:00Z"));
  assert.throws(() => CalendarSchedule.normalize(calendar({ timeZone: "made/up" })), /timezone/);
  const ny = calendar({
    timeZone: "America/New_York",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    hours: [2],
    minutes: [30],
  });
  assert.equal(CalendarSchedule.next(ny, ms("2026-03-08T05:00:00Z")), ms("2026-03-09T06:30:00Z"));
  const repeated = { ...ny, hours: [1] };
  assert.equal(
    CalendarSchedule.next(repeated, ms("2026-11-01T05:31:00Z"), ms("2026-11-01T05:30:00Z")),
    ms("2026-11-02T06:30:00Z"),
  );
});

test("calendar/one-shot definitions survive reopen, coalesce downtime and retain normal work completion", (t) => {
  const profile = profileFor(t);
  let s = new Store(profile);
  t.after(() => s.close());
  const at = Date.now() + 2000;
  const once = s.app.routines.add("once", {
    text: "remind",
    schedule: { kind: "once", at },
    notify: "always",
  });
  s.close();
  s = new Store(profile);
  s.app.routines.tick(at + 1000);
  assert.equal(s.app.status().works.length, 1);
  assert.equal(s.app.status().routines.find((r) => r.id === once.routineId).status, "exhausted");
  s.app.routines.tick(at + 5000);
  assert.equal(s.app.status().works.length, 1);
  assert.equal(s.app.r.routines.get(once.routineId).last_scheduled_at, at);
});

test("routine update uses CAS, retains resources/history and retires old queued instructions", (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const at = Date.now();
  const r = s.app.routines.add("r", {
    text: "old",
    startAt: at,
    intervalMs: 1000,
  });
  s.app.routines.tick(at);
  const work = s.app.status().works[0];
  assert.throws(
    () =>
      s.app.routines.update("bad", {
        routineId: r.routineId,
        definition: { text: "new", startAt: at, intervalMs: 2000 },
      }),
    /revision/,
  );
  s.app.routines.update("update", {
    routineId: r.routineId,
    expectedRevision: 1,
    definition: { text: "new", schedule: calendar() },
  });
  assert.equal(s.app.workRecord(work.id).status, "cancelled");
  const row = s.app.r.routines.get(r.routineId);
  assert.equal(row.revision, 2);
  assert.equal(row.text, "new");
  assert.equal(s.db.prepare("SELECT count(*) n FROM occurrence").get().n, 1);
  assert.throws(
    () =>
      s.app.routines.update("stale", {
        routineId: r.routineId,
        expectedRevision: 1,
        definition: { text: "old", startAt: at, intervalMs: 1000 },
      }),
    /Stale/,
  );
});

test("conditional watches must be bounded and parent finishing disarms future fires without losing delivery", async (t) => {
  assert.throws(
    () =>
      ReceptionDecision.parse({
        kind: "routine.create",
        params: {
          text: "watch",
          startAt: 1,
          intervalMs: 1000,
          stopWhen: "done",
        },
      }),
    /expiresAt or maxRuns/,
  );
  const profile = profileFor(t);
  const runner = await LocalRunner.open(profile, {
    receptionModel: {
      decide: async (input) =>
        input.source
          ? { kind: "deliver", finishRoutine: true, text: "已观察到指定条件" }
          : { kind: "reply", text: "ok" },
    },
  });
  t.after(() => runner.close());
  const call = (op, params = {}, id = crypto.randomUUID()) => request(profile, { op, params, id });
  const r = await call("routine.add", {
    text: "check",
    intervalMs: 1000,
    startAt: Date.now(),
    maxRuns: 5,
    stopWhen: "指定条件已出现",
    notify: "always",
  });
  const w = await until(() => runner.app.status().works.find((w) => w.routine_id === r.routineId));
  await completed(profile, w.id);
  assert.equal(runner.app.r.routines.get(r.routineId).status, "exhausted");
  assert.equal(runner.app.detail(w.id).deliveries[0].status, "accepted");
  assert.ok(
    runner.app
      .events()
      .some((e) => e.kind === "routine.condition-observed" && e.data.verification === "model-reported"),
  );
});

test("project/user memories coexist; changed source cannot recall, modify or learn another project's facts", (t) => {
  const f = fixture(t);
  let d = f.open(f.a);
  const binding = d.app.memory.projectFor();
  d.app.memory.change("user", "memory.set", {
    key: "goal",
    value: "personal",
    expectedRevision: 0,
  });
  const saved = d.app.memory.change("project", "memory.set", {
    key: "goal",
    scope: "project",
    kind: "log",
    value: "A milestone",
    expectedRevision: 0,
  });
  assert.equal(d.app.memory.list().length, 2);
  assert.ok(saved.key.startsWith("@project/"));
  const old = d.app.memory.learningSnapshot();
  d.uow.close();
  d = f.open(f.b);
  t.after(() => d.uow.close());
  assert.equal(d.app.memory.list().length, 1);
  assert.equal(d.app.memory.recall({ query: "A milestone" }).items.length, 0);
  assert.throws(
    () =>
      d.app.memory.change("attack", "memory.forget", {
        key: saved.key,
        expectedRevision: 1,
      }),
    /another project/,
  );
  assert.throws(() => d.app.memory.learningSnapshot(binding), /binding changed/);
  const read = d.app.receptionQueries;
  const accepted = d.app.reception.accept("query", { text: "find A" });
  assert.equal(
    read.open(d.app.reception.turn(accepted.inputId)).execute({
      kind: "query",
      name: "memory.get",
      params: { key: saved.key },
    }).response.data.exists,
    false,
  );
  assert.equal(old.projectId, binding);
});

test("profile/recent recall is bounded; literal search cites original evidence and forget removes recall", (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  for (let i = 0; i < 16; i++)
    s.app.memory.change(`m${i}`, "memory.set", {
      key: `p${i}`,
      value: `profile ${i}`,
      expectedRevision: 0,
    });
  s.app.memory.change("log", "memory.set", {
    key: "recent",
    kind: "log",
    value: "今日完成接口",
    expectedRevision: 0,
  });
  const view = s.app.memory.recall({ limit: 6 });
  assert.equal(view.items.length, 6);
  assert.ok(view.items.some((m) => m.kind === "log"));
  assert.equal(view.next, null);
  assert.equal(view.semanticSearch, false);
  assert.equal(s.app.memory.recall({ query: "接口" }).items[0].key, "recent");
  s.app.memory.change("forget", "memory.forget", {
    key: "recent",
    expectedRevision: 1,
  });
  assert.equal(s.app.memory.recall({ query: "接口" }).items.length, 0);
  assert.equal(s.app.memory.catalog().find((m) => m.key === "recent").revision, 2);
});

test("automatic project log keeps evidence and cannot overwrite an explicit project fact", (t) => {
  const f = fixture(t),
    d = f.open(f.a);
  t.after(() => d.uow.close());
  d.app.reception.accept("fact", { text: "本项目今日完成接口" });
  d.app.reception.apply(d.app.reception.turn("fact"), {
    kind: "reply",
    text: "知道了",
  });
  const job = d.app.memoryLearning.get("learning:fact");
  const proposal = {
    changes: [
      {
        key: "milestone",
        scope: "project",
        kind: "log",
        value: "今日完成接口",
        evidenceIds: [job.evidence[0].id],
      },
    ],
  };
  d.app.memoryLearning.proposed(job.id, proposal);
  d.app.memoryLearning.finish(job.id, { approved: true });
  const entry = d.app.memory.recall({ query: "接口" }).items[0];
  assert.equal(entry.scope, "project");
  assert.equal(entry.kind, "log");
  assert.equal(entry.origin, "automatic");
  assert.deepEqual(entry.evidenceIds, [job.evidence[0].id]);
  d.app.memory.change("correct", "memory.set", {
    key: entry.key,
    value: "尚未完成",
    expectedRevision: 1,
  });
  d.app.reception.accept("next", { text: "完成接口" });
  d.app.reception.apply(d.app.reception.turn("next"), {
    kind: "reply",
    text: "ok",
  });
  const next = d.app.memoryLearning.get("learning:next");
  assert.throws(
    () =>
      d.app.memoryLearning.proposed(next.id, {
        changes: [
          {
            ...proposal.changes[0],
            key: entry.key,
            evidenceIds: [next.evidence[0].id],
          },
        ],
      }),
    /protected/,
  );
});

test("history search recovers canonical older messages, is read-only and never opens another conversation", (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  s.app.reception.accept("old", { text: "青松接口上次约定周五交付" });
  for (let i = 0; i < 30; i++) s.app.history.append(s.app.history.main.id, `later${i}`, "user", `later ${i}`);
  s.app.reception.accept("new", { text: "找上次约定" });
  const session = s.app.receptionQueries.open(s.app.reception.turn("new"));
  const before = s.db.prepare("SELECT total_changes() n").get().n;
  const data = session.execute({
    kind: "query",
    name: "history.search",
    params: { query: "青松接口" },
  }).response.data;
  assert.equal(data.items.length, 1);
  assert.match(data.items[0].text, /周五/);
  assert.ok(data.items[0].id);
  assert.equal(s.db.prepare("SELECT total_changes() n").get().n, before);
  assert.equal(
    session.execute({
      kind: "query",
      name: "history.search",
      params: { query: "x", conversationId: "other" },
    }).response.ok,
    false,
  );
});

test("schema12 upgrade preserves old snapshot and memory without fabricating dates or project scope", (t) => {
  const p = profileFor(t);
  let s = new Store(p);
  s.app.memory.change("old", "memory.set", {
    key: "city",
    value: "Shanghai",
    expectedRevision: 0,
  });
  const w = s.app.workRecord(s.app.works.submit("oldwork", { text: "work" }).workId);
  const snapshot = s.app.executions.snapshot(w);
  legacyMemoryFixture(p, s.db);
  s.db.exec(
    "DROP TABLE IF EXISTS execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; DROP TABLE memory_tombstone; DROP TABLE memory_refresh; DROP TABLE memory_learning_control; ALTER TABLE memory_learning DROP COLUMN batch_ids_json; ALTER TABLE memory_learning DROP COLUMN temporal; ALTER TABLE memory_learning DROP COLUMN today; DROP TABLE memory_detail; ALTER TABLE routine DROP COLUMN schedule_json; ALTER TABLE routine DROP COLUMN last_scheduled_at; ALTER TABLE routine DROP COLUMN stop_when; PRAGMA user_version=12;",
  );
  s.close();
  s = new Store(p);
  t.after(() => s.close());
  assert.deepEqual(s.app.executions.snapshot(w), snapshot);
  const m = s.app.memory.list()[0];
  assert.equal(m.scope, "user");
  assert.equal(m.updatedAt, 0);
  assert.equal(m.projectId, null);
  assert.equal(s.db.prepare("PRAGMA user_version").get().user_version, 21);
});

test("real CLI accepts calendar definitions and scoped recall through the local runner", async (t) => {
  const p = profileFor(t),
    runner = await LocalRunner.open(p);
  t.after(() => runner.close());
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const cli = async (args) =>
    JSON.parse(
      (await exec(process.execPath, ["bin/assistant.mjs", ...args, "--profile", p.path], { cwd: root })).stdout,
    ).result;
  await cli(["routine-add", "--text", "weekday digest", "--schedule", JSON.stringify(calendar()), "--max-runs", "2"]);
  await cli(["memory-set", "--key", "project-progress", "--value", "接口待验收", "--memory-kind", "log"]);
  const data = await cli(["memory-search", "--query", "接口"]);
  assert.equal(data.items[0].kind, "log");
  assert.equal(runner.app.status().routines[0].interval_ms, 0);
});

test("Pi worker actually invokes scoped memory and linked canonical-history tools", async (t) => {
  const { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
  const { PiExecutionAdapter } = await import("../src/adapters/pi/pi-execution-adapter.mjs");
  const { createExecutionPorts } = await import("../src/runtime/execution-ports.mjs");
  const { LocalArtifactStore } = await import("../src/adapters/filesystem/artifact-store.mjs");
  const profile = profileFor(t),
    s = new Store(profile);
  t.after(() => s.close());
  s.app.memory.change("m", "memory.set", {
    key: "milestone",
    value: "接口周五验收",
    expectedRevision: 0,
  });
  s.app.reception.accept("old", { text: "历史约定是周五验收" });
  s.app.reception.apply(s.app.reception.turn("old"), {
    kind: "reply",
    text: "已记录",
  });
  s.app.reception.accept("task", { text: "整理原约定" });
  const accepted = s.app.reception.apply(s.app.reception.turn("task"), {
    kind: "delegate",
    goal: "整理原约定",
  });
  const work = s.app.workRecord(accepted.work_id);
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("recall_memory", { query: "接口" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxToolCall("search_history", { query: "历史约定" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("publish_note", { body: "原约定：接口周五验收。" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  models.setProvider(faux.provider);
  const ports = createExecutionPorts(s.app),
    observed = [];
  const adapter = new PiExecutionAdapter({
    profile,
    ...ports,
    toolsFor: (work, snapshot) => {
      const tools = ports.toolsFor(work, snapshot);
      return {
        ...tools,
        recallMemory: (args) => {
          const r = tools.recallMemory(args);
          observed.push(r);
          return r;
        },
        searchHistory: (args) => {
          const r = tools.searchHistory(args);
          observed.push(r);
          return r;
        },
      };
    },
    catalog: {
      forExecution: () => ({
        models,
        model: { provider: "faux", modelId: "faux-1" },
      }),
    },
    artifactStore: new LocalArtifactStore(join(profile.path, "artifacts")),
    knowledgeSource: null,
  });
  s.app.executions.started(work);
  assert.equal(await adapter.run(work, new AbortController().signal), "done");
  assert.equal(observed[0].items[0].key, "milestone");
  assert.equal(observed[1].items[0].role, "user");
  assert.match(observed[1].items[0].text, /历史约定/);
  const unlinked = s.app.workRecord(s.app.works.submit("other", { text: "other" }).workId);
  assert.throws(
    () => ports.toolsFor(unlinked, s.app.executions.snapshot(unlinked)).searchHistory({ query: "历史" }),
    /grant/,
  );
});
