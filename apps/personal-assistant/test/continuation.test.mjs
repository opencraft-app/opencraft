import { legacyMemoryFixture } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { ReceptionCoordinator } from "../src/runtime/reception-coordinator.mjs";
import { Runner, request } from "../src/runner.mjs";
import { CompletionContract } from "../src/domain/completion-contract.mjs";
import { DirectoryKnowledgeSource } from "../src/adapters/filesystem/knowledge-source.mjs";
import {
  profileFor,
  until,
  completed,
  childRunner,
  files,
  nativeEntries,
  publishTestNote,
} from "./helpers.mjs";

function domain(t) {
  const profile = profileFor(t),
    value = createLocalDomain(profile);
  t.after(() => value.uow.close());
  return { ...value, profile };
}
function delegate(app, id = "user", completion = { output: "text" }) {
  app.reception.accept(id, { text: "原话：比较方案，并保留关键限制" });
  const turn = app.reception.turn(id);
  app.reception.apply(turn, {
    kind: "delegate",
    goal: "compare options",
    completion,
  });
  return app.workRecord(app.reception.turn(id).work_id);
}
function reportTurn(app, work, text = "worker report", error = null) {
  const receipt = app.executions.report(work, text, error);
  const turn = app.reception
    .pending()
    .find((t) => t.source_json && t.work_id === work.id);
  return { receipt, turn };
}
const systemTurns = (uow) =>
  uow.db
    .prepare(
      "SELECT * FROM reception WHERE source_json IS NOT NULL ORDER BY rowid",
    )
    .all();

// These exercise real owners and SQLite; the model decisions remain controlled inputs.
test("a report is durable before parent decision; text results need no note, and delivery is still owed", (t) => {
  const { app, uow } = domain(t),
    work = delegate(app);
  const activity = app.attention.status();
  const { receipt, turn } = reportTurn(app, work, "raw evidence summary");
  assert.equal(receipt.routed, true);
  assert.equal(app.workRecord(work.id).status, "awaiting_review");
  assert.equal(app.detail(work.id).reports[0].text, "raw evidence summary");
  assert.equal(app.detail(work.id).results.length, 0);
  assert.equal(app.detail(work.id).deliveries.length, 0);
  assert.equal(app.detail(work.id).completion.executions[0].evidence.length, 0);
  assert.deepEqual(app.attention.status(), activity);
  const input = app.reception.context(turn);
  assert.equal(input.source.kind, "execution-report");
  assert.equal(input.request.original.text, "原话：比较方案，并保留关键限制");
  assert.equal(input.report.assessment.passed, true);
  assert.equal(input.report.assessment.semanticReview, "unverified");
  app.reception.apply(turn, { kind: "deliver", text: "主助理整理后的回应" });
  assert.equal(app.workRecord(work.id).status, "awaiting_delivery");
  assert.equal(app.detail(work.id).results[0].text, "raw evidence summary");
  assert.equal(app.outcomes.pending()[0].text, "主助理整理后的回应");
  const delivery = app.outcomes.pending()[0];
  app.outcomes.accepted(delivery);
  app.outcomes.accepted(delivery);
  assert.equal(app.workRecord(work.id).status, "completed");
  assert.equal(
    app.history.view().messages.filter((m) => m.data.kind === "result").length,
    1,
  );
  assert.equal(systemTurns(uow).length, 1);
});

test("default note contracts remain enforced; an incomplete report can continue the same work", (t) => {
  const { app } = domain(t),
    work = delegate(app, "note", {});
  const { turn } = reportTurn(app, work, "I claim it is done");
  assert.equal(app.reception.context(turn).report.assessment.passed, false);
  assert.throws(
    () => app.reception.apply(turn, { kind: "deliver" }),
    /completion contract/,
  );
  assert.equal(app.detail(work.id).results.length, 0);
  app.reception.apply(turn, {
    kind: "continue",
    goal: "publish the missing useful note",
  });
  const current = app.workRecord(work.id),
    snapshot = app.executions.snapshot(current);
  assert.equal(current.id, work.id);
  assert.equal(current.revision, 1);
  assert.notEqual(current.active_execution_id, work.active_execution_id);
  assert.equal(current.status, "queued");
  assert.equal(snapshot.request.previousReport.text, "I claim it is done");
  assert.equal(snapshot.request.original.inputId, "note");
  assert.equal(
    snapshot.completion.checks.some((c) => c.kind === "note_published"),
    true,
  );
  assert.equal(app.executions.execution(work).status, "reported");
  assert.equal(app.status().works.length, 1);
  assert.equal(app.detail(work.id).reports.length, 1);
});

test("delegate and user amendment retain original wording, bounded context and original scope", (t) => {
  const { app } = domain(t),
    work = delegate(app);
  app.reception.accept("correction", { text: "补充：只比较本周范围" });
  app.reception.apply(app.reception.turn("correction"), {
    kind: "amend",
    completion: { output: "text", requirements: [], checks: [] },
    workId: work.id,
    expectedRevision: 1,
    goal: "only this week",
  });
  const snapshot = app.executions.snapshot(app.workRecord(work.id));
  assert.equal(snapshot.request.original.inputId, "user");
  assert.equal(snapshot.request.latest.inputId, "correction");
  assert.equal(
    snapshot.request.messages.some((m) => m.text === "补充：只比较本周范围"),
    true,
  );
  assert.deepEqual(snapshot.delegation.resources, []);
  assert.ok(snapshot.request.messages.length <= 20);
});

test("system reports cannot use user commands or silently discard an awaited result", (t) => {
  const { app } = domain(t),
    work = delegate(app),
    { turn } = reportTurn(app, work);
  for (const raw of [
    {
      kind: "remember",
      key: "injected",
      value: "worker asserted",
      expectedRevision: 0,
    },
    { kind: "routine.create", params: {} },
    { kind: "reply", text: "done" },
    { kind: "delegate", goal: "unrelated new job" },
    { kind: "silent" },
  ])
    assert.throws(() => app.reception.apply(turn, raw));
  assert.equal(app.memory.list().length, 0);
  assert.equal(app.status().routines.length, 0);
  assert.equal(app.reception.turn(turn.id).status, "queued");
  assert.equal(app.detail(work.id).deliveries.length, 0);
});

test("duplicate report and repeated parent settlement preserve one event, revision and effect", (t) => {
  const { app, uow } = domain(t),
    work = delegate(app);
  const first = reportTurn(app, work);
  app.executions.report(work, "worker report");
  assert.equal(systemTurns(uow).length, 1);
  assert.equal(
    app.events().filter((e) => e.kind === "execution.reported").length,
    1,
  );
  const proposal = {
    kind: "continue",
    goal: "finish the remaining comparison",
  };
  app.reception.apply(first.turn, proposal);
  app.reception.apply(first.turn, proposal);
  assert.equal(app.workRecord(work.id).revision, 1);
  assert.equal(app.executions.report(work, "worker report").stale, true);
  assert.throws(
    () => app.executions.report(work, "different report"),
    /Immutable/,
  );
  assert.equal(app.status().works.length, 1);
});

test("cancelled or amended work retires old wakes before calling a model; late reports remain audit evidence", (t) => {
  const { app, uow } = domain(t),
    work = delegate(app);
  const { turn } = reportTurn(app, work);
  app.works.amend("new-goal", {
    workId: work.id,
    expectedRevision: 1,
    text: "new goal",
  });
  assert.equal(app.reception.started(turn.id), false);
  assert.equal(
    JSON.parse(app.reception.turn(turn.id).decision_json).kind,
    "retired",
  );
  const current = app.workRecord(work.id);
  app.works.cancel("cancel", { workId: work.id, expectedRevision: 2 });
  const late = app.executions.report(current, "late answer");
  assert.equal(late.stale, true);
  assert.equal(app.detail(work.id).reports.length, 2);
  assert.equal(systemTurns(uow).length, 1);
  assert.equal(app.detail(work.id).deliveries.length, 0);
});

test("a direction changed during the model call cannot be overwritten by a stale deliver decision", (t) => {
  const { app } = domain(t),
    work = delegate(app),
    { turn } = reportTurn(app, work);
  app.reception.started(turn.id);
  const input = app.reception.context(turn);
  assert.equal(input.source.revision, 1);
  app.works.amend("r2", {
    workId: work.id,
    expectedRevision: 1,
    text: "new explicit direction",
  });
  app.reception.apply(turn, { kind: "deliver", text: "stale response" });
  assert.equal(app.workRecord(work.id).text, "new explicit direction");
  assert.equal(app.detail(work.id).deliveries.length, 0);
});

test("quiet work may be silent without treating silence as channel acceptance or user activity", async (t) => {
  const { app, profile } = domain(t);
  app.routines.add("r", {
    text: "watch a project",
    startAt: Date.now(),
    intervalMs: 1000,
    maxRuns: 1,
    notify: "always",
  });
  app.routines.tick();
  const work = app.status().works[0];
  await publishTestNote({ app, profile }, work, "No change");
  const before = app.attention.status(),
    { turn } = reportTurn(app, work, "No change");
  assert.equal(app.reception.context(turn).source.waitingForResult, false);
  app.reception.apply(turn, { kind: "silent" });
  assert.equal(app.workRecord(work.id).status, "awaiting_delivery");
  const delivery = app.outcomes.pending()[0];
  assert.equal(delivery.suppress_notification, 1);
  assert.equal(app.history.view().messages.length, 0);
  app.outcomes.accepted(delivery);
  assert.equal(app.workRecord(work.id).status, "completed");
  assert.equal(app.history.view().messages.length, 0);
  assert.deepEqual(app.attention.status(), before);
});

test("unlinked routines retain their own mailbox flow and never borrow the main conversation", (t) => {
  const { app, uow } = domain(t);
  app.routines.add("private-routine", {
    text: "quiet check",
    startAt: Date.now(),
    intervalMs: 1000,
    maxRuns: 1,
  });
  app.routines.tick();
  const work = app.status().works[0];
  assert.equal(app.executions.report(work, "background answer").routed, false);
  assert.equal(systemTurns(uow).length, 0);
  assert.equal(app.history.view().messages.length, 0);
});

test("parent failure retries a saved report without rerunning work, then stops after a bounded number", (t) => {
  const { app, uow } = domain(t),
    work = delegate(app),
    { turn } = reportTurn(app, work);
  let at = Date.now();
  app.reception.now = () => at;
  for (let i = 0; i < 3; i++) {
    app.reception.failed(
      app.reception.turn(turn.id),
      new Error("parent unavailable"),
    );
    assert.equal(app.reception.turn(turn.id).attempts, i + 1);
    at += 1000;
  }
  assert.equal(app.reception.turn(turn.id).status, "blocked");
  assert.equal(app.pendingWorks().length, 0);
  assert.equal(app.detail(work.id).reports.length, 1);
  assert.equal(app.detail(work.id).results.length, 0);
  assert.equal(systemTurns(uow).length, 1);
});

test("automatic continuation is bounded across revisions and survives reopen", (t) => {
  const { app } = domain(t);
  let work = delegate(app);
  for (let i = 0; i < 3; i++) {
    const { turn } = reportTurn(app, work, `partial ${i}`);
    app.reception.apply(turn, { kind: "continue", goal: `next ${i}` });
    work = app.workRecord(work.id);
  }
  const { turn } = reportTurn(app, work, "still partial");
  assert.throws(
    () => app.reception.apply(turn, { kind: "continue", goal: "forever" }),
    /limit/,
  );
  app.reception.apply(turn, {
    kind: "blocked",
    text: "需要补充范围后才能继续。",
  });
  assert.equal(app.workRecord(work.id).status, "blocked");
  assert.equal(
    app.history
      .view()
      .messages.filter((m) => m.data.kind === "continuation-blocked").length,
    1,
  );
});

test("parent decision, result and turn settlement roll back together", (t) => {
  const { app } = domain(t),
    work = delegate(app),
    { turn } = reportTurn(app, work);
  const settled = app.r.reception.settled.bind(app.r.reception);
  app.r.reception.settled = () => {
    throw new Error("commit fault");
  };
  assert.throws(
    () => app.reception.apply(turn, { kind: "deliver" }),
    /commit fault/,
  );
  assert.equal(app.workRecord(work.id).status, "awaiting_review");
  assert.equal(app.detail(work.id).results.length, 0);
  assert.equal(app.reception.turn(turn.id).status, "queued");
  app.r.reception.settled = settled;
  app.reception.apply(turn, { kind: "deliver" });
  assert.equal(app.detail(work.id).results.length, 1);
});

test("saved reports, grants and unsettled turns survive SQLite reopen without native work replay", (t) => {
  const profile = profileFor(t);
  let { app, uow } = createLocalDomain(profile);
  const work = delegate(app),
    { turn } = reportTurn(app, work);
  app.reception.started(turn.id);
  uow.close();
  ({ app, uow } = createLocalDomain(profile));
  t.after(() => uow.close());
  assert.equal(app.pendingWorks().length, 0);
  assert.equal(app.reception.pending().length, 1);
  assert.equal(
    app.reception.context(app.reception.turn(turn.id)).report.text,
    "worker report",
  );
  app.reception.apply(app.reception.turn(turn.id), { kind: "deliver" });
  assert.equal(app.detail(work.id).results.length, 1);
});

test("report reads are bounded, paginated and refuse unlinked work", (t) => {
  const { app } = domain(t),
    work = delegate(app),
    text = "正文".repeat(40000),
    { turn } = reportTurn(app, work, text);
  assert.equal(app.reception.context(turn).report.truncated, true);
  const session = app.receptionQueries.open(turn);
  const { response } = session.execute({
    kind: "query",
    name: "report.read",
    params: { workId: work.id, offset: 70000, limit: 1000 },
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.text.length, 1000);
  assert.equal(response.data.nextOffset, 71000);
  const other = app.works.submit("unlinked", {
    text: "other",
    completion: { output: "text" },
  });
  app.executions.report(app.workRecord(other.workId), "private report");
  assert.equal(
    session.execute({
      kind: "query",
      name: "report.read",
      params: { workId: other.workId },
    }).response.ok,
    false,
  );
});

test("routine proposals invoke the actual owner, retain receipt identity and enforce revisions", (t) => {
  const { app } = domain(t);
  app.reception.accept("schedule", { text: "每隔一小时检查项目" });
  const turn = app.reception.turn("schedule"),
    params = {
      text: "check project",
      startAt: Date.now() + 100000,
      intervalMs: 3600000,
      notify: "changed",
    };
  app.reception.apply(turn, {
    kind: "routine.create",
    params: { ...params, resources: [{ id: "all", binding: "/" }] },
  });
  app.reception.apply(turn, { kind: "routine.create", params });
  const [routine] = app.status().routines;
  assert.equal(app.status().routines.length, 1);
  assert.deepEqual(JSON.parse(routine.resources_json), []);
  assert.equal(routine.notify, "changed");
  app.reception.accept("pause", { text: "暂停该安排" });
  app.reception.apply(app.reception.turn("pause"), {
    kind: "routine.pause",
    routineId: routine.id,
    expectedRevision: 1,
  });
  app.reception.accept("resume", { text: "恢复" });
  assert.throws(
    () =>
      app.reception.apply(app.reception.turn("resume"), {
        kind: "routine.resume",
        routineId: routine.id,
        expectedRevision: 1,
      }),
    /Stale/,
  );
  app.reception.apply(app.reception.turn("resume"), {
    kind: "routine.resume",
    routineId: routine.id,
    expectedRevision: 2,
  });
  assert.equal(app.status().routines[0].status, "active");
});

test("routine source bindings are captured at creation and cannot inherit a new workspace", (t) => {
  const profile = profileFor(t),
    first = join(profile.path, "a"),
    second = join(profile.path, "b");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "a.md"), "old");
  writeFileSync(join(second, "b.md"), "new");
  let d = createLocalDomain(profile, new DirectoryKnowledgeSource(first));
  d.app.routines.add("r", {
    text: "read",
    startAt: Date.now(),
    intervalMs: 1000,
    maxRuns: 1,
  });
  d.uow.close();
  d = createLocalDomain(profile, new DirectoryKnowledgeSource(second));
  t.after(() => d.uow.close());
  assert.throws(() => d.app.routines.tick(), /binding changed/);
  assert.equal(d.app.status().works.length, 0);
});

test("pump isolates stage errors and retries with bounded backoff instead of starving other stages", () => {
  const runner = new LocalRunner({});
  // The memory file sync phase opens an empty unit of work on its cadence.
  runner.uow = { assertWriter() {}, transaction: (fn) => fn() };
  const calls = [];
  runner.fileEvents = { tick: () => calls.push("file") };
  runner.app = {
    routines: {
      tick: () => {
        calls.push("routine");
        throw new Error("routine fault");
      },
    },
    interactions: { expire: () => calls.push("interaction") },
    notifications: { flush: () => calls.push("notification") },
  };
  for (const key of ["work", "reception", "delivery", "messages", "learning"])
    runner[key] = { tick: () => calls.push(key) };
  runner.pump();
  assert.deepEqual(calls, [
    "file",
    "routine",
    "interaction",
    "work",
    "reception",
    "delivery",
    "messages",
    "learning",
    "notification",
  ]);
  assert.match(runner.phaseErrors.routines.error, /routine fault/);
  calls.length = 0;
  runner.pump();
  assert.equal(calls.includes("routine"), false);
  assert.equal(calls.includes("reception"), true);
  runner.app.routines.tick = () => calls.push("recovered");
  runner.phaseErrors.routines.nextAt = 0;
  runner.pump();
  assert.equal(runner.phaseErrors.routines, undefined);
  assert.equal(runner.healthError, null);
});

test("reception schedules user input ahead of background reports while reserving a background turn", async () => {
  const picked = [],
    rows = [{ id: "b", source_json: "{}" }, { id: "u" }];
  const service = {
    acknowledgePending() {},
    pending: () => rows,
    started(id) {
      picked.push(id);
      return false;
    },
  };
  const coordinator = new ReceptionCoordinator(service, {});
  for (let i = 0; i < 5; i++) {
    coordinator.tick();
    await coordinator.task;
  }
  assert.deepEqual(picked, ["u", "u", "u", "b", "u"]);
});

for (const boundary of [
  "report-saved-before-reception",
  "report-proposed-before-commit",
])
  test(`real process crash at ${boundary} resumes the parent and delivers once without repeating Pi work`, async (t) => {
    const profile = profileFor(t),
      call = (op, params = {}, id = crypto.randomUUID()) =>
        request(profile, { op, params, id });
    const first = await childRunner(t, profile, {
      LAB_TEST_CRASH_AT: boundary,
    });
    await call("say", { text: "整理一份本地笔记" }, "crash-work");
    assert.equal((await first.exited).code, 86);
    const second = await childRunner(t, profile);
    const turn = await call("turn", { inputId: "crash-work" });
    const done = await completed(profile, turn.work_id);
    assert.equal(done.reports.length, 1);
    assert.equal(done.deliveries.length, 1);
    assert.equal(files(profile, "artifacts").length, 1);
    assert.equal(files(profile, "mailbox").length, 1);
    assert.equal(
      (await call("conversation")).messages.filter(
        (m) => m.data.kind === "result",
      ).length,
      1,
    );
    const entries = await nativeEntries(profile, turn.work_id);
    assert.equal(
      entries.filter((e) => e.kind === "superapp.work-input").length,
      1,
    );
    await second.stop();
  });

test("real Pi completion reaches a new main-model round which controls the final delivered wording", async (t) => {
  const profile = profileFor(t),
    seen = [];
  const runner = await Runner.open(profile, {
    receptionModel: {
      async decide(input) {
        seen.push(input);
        return input.source?.kind === "execution-report"
          ? { kind: "deliver", text: "已完成比较，具体材料见本地结果。" }
          : { kind: "delegate", goal: "write a useful note" };
      },
    },
  });
  t.after(() => runner.close());
  runner.app.reception.accept("real-pi", {
    text: "原始请求，不要只给一个收到",
  });
  const done = await until(() => {
    const w = runner.app.status().works[0];
    return w?.status === "completed" && runner.app.detail(w.id);
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].request.original.text, "原始请求，不要只给一个收到");
  assert.equal(seen[1].report.assessment.passed, true);
  const result = runner.app.history
    .view()
    .messages.find((m) => m.data.kind === "result");
  assert.equal(result.text, "已完成比较，具体材料见本地结果。");
  assert.notEqual(done.results[0].text, result.text);
  assert.match(
    readFileSync(
      join(profile.path, "mailbox", files(profile, "mailbox")[0]),
      "utf8",
    ),
    /已完成比较/,
  );
});

test("an execution error remains a failed report and cannot be delivered as success", (t) => {
  const { app } = domain(t),
    work = delegate(app);
  const { turn } = reportTurn(app, work, "", new Error("tool unavailable"));
  assert.equal(app.detail(work.id).reports[0].status, "error");
  assert.throws(
    () => app.reception.apply(turn, { kind: "deliver", text: "success" }),
    /completion contract/,
  );
  app.reception.apply(turn, {
    kind: "blocked",
    text: "工具不可用，需要恢复连接后继续。",
  });
  assert.equal(app.workRecord(work.id).status, "blocked");
  assert.equal(app.detail(work.id).results.length, 0);
  assert.equal(
    app.history.view().messages.at(-1).text,
    "工具不可用，需要恢复连接后继续。",
  );
});

test("a quiet failed report can settle silently while remaining blocked with no delivery receipt", (t) => {
  const { app } = domain(t);
  app.routines.add("quiet-failure", {
    text: "watch",
    startAt: Date.now(),
    intervalMs: 1000,
    maxRuns: 1,
    notify: "always",
  });
  app.routines.tick();
  const work = app.status().works[0],
    { turn } = reportTurn(app, work, "", new Error("source unavailable"));
  app.reception.apply(turn, { kind: "silent" });
  assert.equal(app.workRecord(work.id).status, "blocked");
  assert.equal(app.reception.turn(turn.id).status, "settled");
  assert.equal(app.detail(work.id).deliveries.length, 0);
  assert.equal(app.history.view().messages.length, 0);
});

test("an expired routine retains its late report but cannot wake the parent or complete", (t) => {
  const { app, uow } = domain(t),
    start = Date.now();
  app.routines.add("expires", {
    text: "watch",
    startAt: start,
    intervalMs: 1000,
    expiresAt: start + 10000,
    notify: "always",
  });
  app.routines.tick();
  const work = app.status().works[0];
  app.executions.now = () => start + 20000;
  assert.equal(app.executions.report(work, "late report").stale, true);
  assert.equal(app.detail(work.id).reports.length, 1);
  assert.equal(systemTurns(uow).length, 0);
  assert.equal(app.workRecord(work.id).status, "blocked");
});

test("actual model-mode adapter sends continuation and routine instructions to the model request", async () => {
  const { ReceptionModel } = await import(
    "../src/adapters/models/reception-model.mjs"
  );
  let request;
  const model = new ReceptionModel({
    configured: {
      mode: "model",
      model: { provider: "controlled", modelId: "controlled" },
      models: {
        getModel() {
          return {};
        },
        async completeSimple(_model, input) {
          request = input;
          return {
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: '{"kind":"continue","goal":"finish missing evidence"}',
              },
            ],
          };
        },
      },
    },
  });
  const proposal = await model.decide(
    { source: { kind: "execution-report" }, report: { text: "partial" } },
    new AbortController().signal,
  );
  assert.equal(proposal.kind, "continue");
  assert.match(request.systemPrompt, /SYSTEM wake/);
  assert.match(request.systemPrompt, /routine.create/);
  assert.match(request.systemPrompt, /output:"text"/);
  assert.equal(
    JSON.parse(request.messages[0].content).source.kind,
    "execution-report",
  );
});

test("real Pi text-output work finishes with no artifact and returns through the parent", async (t) => {
  const profile = profileFor(t);
  const runner = await Runner.open(profile, {
    receptionModel: {
      async decide(input) {
        return input.source
          ? { kind: "deliver", text: "这是一条文本结果。" }
          : {
              kind: "delegate",
              goal: "a bounded textual answer",
              completion: { output: "text" },
            };
      },
    },
  });
  t.after(() => runner.close());
  runner.app.reception.accept("text-only", {
    text: "只给文本答复，不需要文件",
  });
  await until(() => runner.app.status().works[0]?.status === "completed");
  assert.equal(files(profile, "artifacts").length, 0);
  assert.equal(files(profile, "mailbox").length, 1);
  assert.equal(
    runner.app.history.view().messages.at(-1).text,
    "这是一条文本结果。",
  );
});

test("the real say CLI creates an interval routine through the configured reception path", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { root } = await import("./helpers.mjs");
  const profile = profileFor(t),
    child = await childRunner(t, profile);
  execFileSync(
    process.execPath,
    [
      "bin/assistant.mjs",
      "say",
      "--profile",
      profile.path,
      "--text",
      "每隔30秒提醒我检查项目",
      "--id",
      "cli-routine",
    ],
    { cwd: root, timeout: 5000 },
  );
  const turn = await until(async () => {
    const value = await request(profile, {
      op: "turn",
      params: { inputId: "cli-routine" },
    });
    if (value.status === "blocked") throw new Error(value.reply_text);
    return value.status === "settled" && value;
  });
  assert.equal(JSON.parse(turn.decision_json).kind, "routine.create");
  const status = await request(profile, { op: "status", params: {} });
  assert.equal(status.routines[0].interval_ms, 30000);
  assert.equal(status.routines[0].text, "检查项目");
  assert.equal(status.works.length, 0);
  await child.stop();
});

test("schema10 upgrade preserves an old snapshot and routine receipt without fabricating report events", (t) => {
  const profile = profileFor(t);
  let d = createLocalDomain(profile);
  const receipt = d.app.works.submit("old-work", { text: "preserve" }),
    work = d.app.workRecord(receipt.workId);
  const snapshot = d.app.executions.snapshot(work);
  const params = {
    text: "old routine",
    startAt: Date.now() + 100000,
    intervalMs: 1000,
  };
  const routine = d.app.routines.add("old-routine", params);
  legacyMemoryFixture(profile, d.uow.db);
  d.uow.db.exec(
    "DROP TABLE IF EXISTS execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; DROP TABLE memory_tombstone; DROP TABLE memory_refresh; DROP TABLE memory_learning_control; ALTER TABLE memory_learning DROP COLUMN batch_ids_json; ALTER TABLE memory_learning DROP COLUMN temporal; ALTER TABLE memory_learning DROP COLUMN today; DROP TABLE memory_detail; ALTER TABLE routine DROP COLUMN schedule_json; ALTER TABLE routine DROP COLUMN last_scheduled_at; ALTER TABLE routine DROP COLUMN stop_when; DROP TABLE usage_observation; ALTER TABLE execution DROP COLUMN guard_json; DROP TABLE execution_report; ALTER TABLE execution DROP COLUMN request_json; ALTER TABLE reception DROP COLUMN source_json; ALTER TABLE reception DROP COLUMN attempts; ALTER TABLE reception DROP COLUMN next_at; ALTER TABLE delivery DROP COLUMN message_text; ALTER TABLE delivery DROP COLUMN suppress_notification; ALTER TABLE routine DROP COLUMN resources_json; PRAGMA user_version=10;",
  );
  d.uow.close();
  d = createLocalDomain(profile);
  t.after(() => d.uow.close());
  assert.equal(d.uow.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.deepEqual(
    d.app.executions.snapshot(d.app.workRecord(work.id)),
    snapshot,
  );
  assert.equal(
    d.app.routines.add("old-routine", params).routineId,
    routine.routineId,
  );
  assert.equal(d.app.routines.add("old-routine", params).duplicate, true);
  assert.equal(d.app.detail(work.id).reports.length, 0);
  assert.equal(systemTurns(d.uow).length, 0);
});

test("one user input can create two independent works atomically and amend only the named stream", (t) => {
  const { app } = domain(t);
  app.reception.accept("two", { text: "分别比较方案和整理风险；两项都给文本" });
  const turn = app.reception.turn("two"),
    proposal = {
      kind: "batch",
      commands: [
        {
          kind: "delegate",
          goal: "compare options",
          completion: { output: "text" },
        },
        {
          kind: "delegate",
          goal: "list risks",
          completion: { output: "text" },
        },
      ],
    };
  app.reception.apply(turn, proposal);
  app.reception.apply(turn, proposal);
  const ids = JSON.parse(app.reception.turn("two").decision_json).workIds;
  assert.equal(ids.length, 2);
  assert.equal(app.status().works.length, 2);
  for (const id of ids)
    assert.equal(
      app.executions.snapshot(app.workRecord(id)).request.original.text,
      "分别比较方案和整理风险；两项都给文本",
    );
  app.reception.accept("change-one", {
    text: `只修改 ${ids[1]}：整理本周风险`,
  });
  app.reception.apply(app.reception.turn("change-one"), {
    kind: "amend",
    completion: { output: "text", requirements: [], checks: [] },
    workId: ids[1],
    expectedRevision: 1,
    goal: "this week's risks",
  });
  assert.equal(app.workRecord(ids[0]).revision, 1);
  assert.equal(app.workRecord(ids[1]).revision, 2);
  assert.equal(app.status().works.length, 2);
  assert.equal(
    app.executions.snapshot(app.workRecord(ids[1])).request.original.inputId,
    "two",
  );
});

test("a failure in the second batch command rolls back the first command and its receipt", (t) => {
  const { app } = domain(t);
  app.reception.accept("atomic-batch", { text: "do two things" });
  const turn = app.reception.turn("atomic-batch");
  assert.throws(
    () =>
      app.reception.apply(turn, {
        kind: "batch",
        commands: [
          { kind: "delegate", goal: "first" },
          { kind: "cancel", workId: "foreign", expectedRevision: 1 },
        ],
      }),
    /outside this conversation/,
  );
  assert.equal(app.status().works.length, 0);
  assert.equal(app.reception.turn(turn.id).status, "queued");
  app.reception.apply(turn, { kind: "delegate", goal: "first" });
  assert.equal(app.status().works.length, 1);
});

test("real Pi handles a batch in two independent streams and the parent closes each result once", async (t) => {
  const profile = profileFor(t);
  const runner = await Runner.open(profile, {
    receptionModel: {
      async decide(input) {
        return input.source
          ? { kind: "deliver", text: `结果：${input.report.workId}` }
          : {
              kind: "batch",
              commands: [
                {
                  kind: "delegate",
                  goal: "compare options",
                  completion: { output: "text" },
                },
                {
                  kind: "delegate",
                  goal: "list risks",
                  completion: { output: "text" },
                },
              ],
            };
      },
    },
  });
  t.after(() => runner.close());
  runner.app.reception.accept("parallel-input", {
    text: "比较方案，同时整理风险",
  });
  await until(
    () =>
      runner.app.status().works.length === 2 &&
      runner.app.status().works.every((w) => w.status === "completed"),
  );
  const messages = runner.app.history.view().messages;
  assert.equal(messages.filter((m) => m.role === "user").length, 1);
  assert.equal(messages.filter((m) => m.data.kind === "result").length, 2);
  assert.equal(files(profile, "mailbox").length, 2);
  assert.equal(files(profile, "artifacts").length, 0);
});

test("automatic continuation count and latest user direction persist across a real SQLite reopen", (t) => {
  const profile = profileFor(t);
  let d = createLocalDomain(profile),
    work = delegate(d.app);
  d.app.reception.accept("latest-direction", {
    text: "最新指示：保留关键限制",
  });
  d.app.reception.apply(d.app.reception.turn("latest-direction"), {
    kind: "amend",
    completion: { output: "text", requirements: [], checks: [] },
    workId: work.id,
    expectedRevision: 1,
    goal: "include limitations",
  });
  work = d.app.workRecord(work.id);
  const first = reportTurn(d.app, work);
  d.app.reception.apply(first.turn, {
    kind: "continue",
    goal: "finish remaining comparison",
  });
  work = d.app.workRecord(work.id);
  d.uow.close();
  d = createLocalDomain(profile);
  t.after(() => d.uow.close());
  const snapshot = d.app.executions.snapshot(work);
  assert.equal(snapshot.request.continuations, 1);
  assert.equal(snapshot.request.latest.inputId, "latest-direction");
  const next = reportTurn(d.app, work, "next report");
  assert.equal(d.app.reception.context(next.turn).request.continuations, 1);
  d.app.works.amend("explicit-owner-direction", {
    workId: work.id,
    expectedRevision: work.revision,
    text: "new explicit direction",
  });
  assert.equal(
    d.app.executions.snapshot(d.app.workRecord(work.id)).request.continuations,
    0,
  );
});

test("a saved unlinked failure retries only settlement after an owner fault, never the executor", async (t) => {
  const { WorkCoordinator } = await import(
    "../src/runtime/work-coordinator.mjs"
  );
  const { app } = domain(t),
    work = app.workRecord(
      app.works.submit("unlinked-fault", { text: "work" }).workId,
    );
  let executions = 0;
  const coordinator = new WorkCoordinator({
    app,
    concurrency: 1,
    executor: {
      async run() {
        executions++;
        throw new Error("execution failed");
      },
    },
  });
  const original = app.executions.blocked.bind(app.executions);
  app.executions.blocked = () => {
    throw new Error("settlement unavailable");
  };
  await assert.rejects(
    coordinator.execute(work, new AbortController().signal),
    /settlement unavailable/,
  );
  assert.equal(app.detail(work.id).reports.length, 1);
  app.executions.blocked = original;
  await coordinator.execute(
    app.workRecord(work.id),
    new AbortController().signal,
  );
  assert.equal(executions, 1);
  assert.equal(app.workRecord(work.id).status, "blocked");
});
