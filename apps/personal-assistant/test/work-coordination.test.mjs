import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { ReceptionQuery } from "../src/domain/reception-query.mjs";
import { decodeOutput } from "../src/adapters/models/structured-output.mjs";
import { request } from "../src/runner.mjs";
import { profileFor, root, until, completed } from "./helpers.mjs";

function domain(t) {
  const profile = profileFor(t, { memoryPolicy: { enabled: false } });
  let value = createLocalDomain(profile);
  t.after(() => value.uow.close());
  return {
    get app() {
      return value.app;
    },
    get db() {
      return value.uow.db;
    },
    reopen() {
      value.uow.close();
      value = createLocalDomain(profile);
    },
  };
}
function work(app, id, text = id) {
  const receipt = app.works.submit(id, {
    text,
    completion: { output: "text" },
  });
  app.history.link(app.history.main.id, receipt.workId);
  return app.workRecord(receipt.workId);
}
function finish(app, w) {
  assert.equal(app.outcomes.record(w, "verified test result").accepted, true);
  app.outcomes.accepted(app.outcomes.pending().find((d) => d.work_id === w.id));
}
function accept(app, id, params = {}) {
  app.reception.accept(id, { text: "follow up", ...params });
  return app.reception.turn(id);
}
const read = (app, turn, name, params = {}) =>
  app.receptionQueries.open(turn).execute({ kind: "query", name, params }).response;

test("overview counts every linked work, prioritizes attention beyond closed history and remains read-only across restart", (t) => {
  const d = domain(t),
    app = d.app;
  const records = Array.from({ length: 14 }, (_, i) => work(app, `w-${i}`)).sort((a, b) => a.id.localeCompare(b.id));
  for (const w of records.slice(0, 8)) finish(app, w);
  const [waiting, blocked, running, cancelled, ...queued] = records.slice(8);
  app.interactions.request(waiting, "ask", "Which scope?");
  app.executions.blocked(blocked, "resource unavailable");
  app.executions.started(running);
  app.executions.bound(running, "private-native-thread", "private-submission");
  app.works.cancel("stop", { workId: cancelled.id, expectedRevision: 1 });
  app.works.submit("foreign", { text: "unlinked secret work" });
  const turn = accept(app, "overview");
  const before = d.db.prepare("SELECT total_changes() AS n").get().n;
  const seed = app.reception.context(turn),
    overview = seed.workOverview;
  assert.equal(overview.total, 14);
  assert.equal(overview.open, 5);
  assert.equal(overview.byStatus.completed, 8);
  assert.equal(overview.byStatus.cancelled, 1);
  assert.equal(overview.byStatus.waiting_input, 1);
  assert.equal(overview.byStatus.running, 1);
  assert.equal(overview.byStatus.blocked, 1);
  assert.equal(overview.byStatus.queued, 2);
  assert.deepEqual(
    overview.attention.slice(0, 3).map((w) => w.id),
    [waiting.id, blocked.id, running.id],
  );
  assert.equal(overview.attentionTruncated, false);
  assert.equal(seed.pendingInteractions[0].workId, waiting.id);
  assert.equal(overview.attention[2].session.bound, true);
  assert.equal(overview.attention[2].session.engine, "pi");
  assert.doesNotMatch(JSON.stringify(seed), /private-native-thread|private-submission|unlinked secret/);
  assert.equal(read(app, turn, "work.get", { workId: records[0].id }).data.work.delivery.status, "accepted");
  assert.equal(d.db.prepare("SELECT total_changes() AS n").get().n, before);
  d.reopen();
  const current = d.app.dispatch({ op: "work.overview", params: {} });
  assert.deepEqual(current.byStatus, overview.byStatus);
  assert.deepEqual(
    current.attention.map((w) => w.id),
    overview.attention.map((w) => w.id),
  );
  assert.equal(queued.length, 2);
});

test("open pagination/search and closed history are explicit, bounded, and do not leak unlinked work", (t) => {
  const { app } = domain(t);
  const opened = Array.from({ length: 17 }, (_, i) => work(app, `open-${i}`, `migration plan ${i}`));
  const closed = work(app, "closed", "migration complete");
  finish(app, closed);
  const foreign = app.works.submit("unlinked", {
    text: "migration private",
  }).workId;
  const turn = accept(app, "list");
  assert.equal(app.reception.context(turn).workOverview.attentionTruncated, true);
  let after;
  const ids = [];
  do {
    const response = read(app, turn, "works.list", {
      state: "open",
      limit: 5,
      ...(after ? { after } : {}),
    });
    assert.equal(response.ok, true);
    ids.push(...response.data.items.map((w) => w.id));
    after = response.data.next;
  } while (after);
  assert.deepEqual(ids, opened.map((w) => w.id).sort());
  assert.deepEqual(
    read(app, turn, "works.list", { state: "closed" }).data.items.map((w) => w.id),
    [closed.id],
  );
  assert.equal(read(app, turn, "works.list", { query: opened[4].id }).data.items[0].id, opened[4].id);
  assert.equal(read(app, turn, "works.list", { query: "migration plan 16" }).data.items.length, 1);
  assert.deepEqual(read(app, turn, "works.list", { query: foreign }).data.items, []);
  assert.equal(read(app, turn, "work.get", { workId: foreign }).ok, false);
  assert.equal(read(app, turn, "works.list", { state: "invented" }).ok, false);
  assert.throws(
    () =>
      ReceptionQuery.parse({
        kind: "query",
        name: "work.overview",
        params: { limit: 100 },
      }),
    /parameters/,
  );
  assert.deepEqual(
    decodeOutput(
      "reception",
      JSON.stringify({
        proposal: {
          kind: "query",
          name: "works.list",
          params: { state: null, query: null, after: null, limit: null },
        },
      }),
    ),
    { kind: "query", name: "works.list", params: {} },
  );
});

test("targeted intake is durable, checks membership/revision before history, and exposes questions beyond the global window", (t) => {
  const d = domain(t),
    app = d.app;
  const works = Array.from({ length: 9 }, (_, i) => work(app, `waiting-${i}`));
  const questions = works.map((w) => app.interactions.request(w, "ask", "Pick a scope"));
  const global = app.reception.context(accept(app, "global"));
  const hidden = questions.find((q) => !global.pendingInteractions.some((i) => i.id === q.id));
  const target = works.find((w) => w.id === hidden.work_id);
  const foreign = app.works.submit("foreign", { text: "private" });
  const count = app.history.view().messages.length;
  assert.throws(() => accept(app, "bad-target", { workId: foreign.workId }), /outside/);
  assert.throws(() => accept(app, "bad-revision", { workId: target.id, expectedRevision: 2 }), /Stale/);
  assert.throws(() => accept(app, "missing-target", { expectedRevision: 1 }), /target/);
  assert.equal(app.history.view().messages.length, count);
  accept(app, "target", { workId: target.id, expectedRevision: 1 });
  d.reopen();
  const turn = d.app.reception.turn("target"),
    input = d.app.reception.context(turn);
  assert.equal(input.targetWork.id, target.id);
  assert.equal(input.targetWork.capturedRevision, 1);
  assert.equal(input.targetWork.changedSinceIntake, false);
  assert.equal(input.questionsWorkId, target.id);
  assert.deepEqual(
    input.pendingInteractions.map((q) => q.id),
    [hidden.id],
  );
  assert.deepEqual(
    read(d.app, turn, "questions.list", { workId: target.id }).data.items.map((q) => q.id),
    [hidden.id],
  );
  assert.deepEqual(read(d.app, turn, "questions.list", { workId: foreign.workId }).data.items, []);
});

test("targeted proposals cannot drift, drop their captured scope, or partially commit a bad batch", (t) => {
  const { app } = domain(t),
    a = work(app, "A"),
    b = work(app, "B");
  const qa = app.interactions.request(a, "ask", "A scope?"),
    qb = app.interactions.request(b, "ask", "B scope?");
  const turn = accept(app, "follow-A", { workId: a.id });
  for (const proposal of [
    { kind: "delegate", goal: "new work" },
    {
      kind: "amend",
      completion: { output: "text", requirements: [], checks: [] },
      workId: b.id,
      expectedRevision: 1,
      goal: "wrong",
    },
    {
      kind: "answer",
      interactionId: qb.id,
      expectedRevision: 1,
      text: "wrong",
    },
    {
      kind: "batch",
      commands: [
        { kind: "cancel", workId: a.id, expectedRevision: 1 },
        { kind: "cancel", workId: b.id, expectedRevision: 1 },
      ],
    },
  ])
    assert.throws(() => app.reception.apply(turn, proposal), /target|captured|unrelated/);
  const forged = {
    ...turn,
    query_scope_json: JSON.stringify({
      ...JSON.parse(turn.query_scope_json),
      targetWork: undefined,
    }),
  };
  assert.throws(
    () =>
      app.reception.apply(forged, {
        kind: "cancel",
        workId: b.id,
        expectedRevision: 1,
      }),
    /captured/,
  );
  assert.equal(app.workRecord(a.id).status, "waiting_input");
  assert.equal(app.workRecord(b.id).status, "waiting_input");
  assert.equal(app.status().works.length, 2);
  const answer = {
    kind: "answer",
    interactionId: qa.id,
    expectedRevision: 1,
    text: "this week",
  };
  app.reception.apply(turn, answer);
  app.reception.apply(turn, answer);
  assert.equal(app.workRecord(a.id).status, "queued");
  assert.equal(app.workRecord(b.id).status, "waiting_input");
  assert.equal(app.detail(a.id).interactions[0].answer, "this week");
});

test("stale targets cannot silently rebase and revised work exposes only its current execution", (t) => {
  const { app } = domain(t),
    a = work(app, "A"),
    b = work(app, "B");
  app.executions.bound(a, "old-native-thread", "old-submission");
  const turn = accept(app, "stale", { workId: a.id });
  app.works.amend("external-edit", {
    workId: a.id,
    expectedRevision: 1,
    text: "revised goal",
  });
  assert.equal(app.reception.context(turn).targetWork.changedSinceIntake, true);
  assert.equal(app.reception.context(turn).targetWork.session.bound, false);
  assert.throws(
    () =>
      app.reception.apply(turn, {
        kind: "amend",
        completion: { output: "text", requirements: [], checks: [] },
        workId: a.id,
        expectedRevision: 2,
        goal: "silent rebase",
      }),
    /captured/,
  );
  assert.throws(
    () =>
      app.reception.apply(turn, {
        kind: "amend",
        completion: { output: "text", requirements: [], checks: [] },
        workId: a.id,
        expectedRevision: 1,
        goal: "stale edit",
      }),
    /Stale/,
  );
  const fresh = accept(app, "fresh", { workId: a.id });
  app.reception.apply(fresh, {
    kind: "amend",
    completion: { output: "text", requirements: [], checks: [] },
    workId: a.id,
    expectedRevision: 2,
    goal: "updated complete goal",
  });
  assert.equal(app.workRecord(a.id).revision, 3);
  assert.equal(app.workRecord(b.id).revision, 1);
  assert.equal(app.detail(a.id).executions.length, 3);
  assert.equal(app.status().works.length, 2);
});

test("system report wakes also see the global overview but can settle only their own work", (t) => {
  const { app } = domain(t),
    waiting = work(app, "waiting"),
    done = work(app, "done");
  app.interactions.request(waiting, "ask", "Which scope?");
  app.executions.report(done, "useful result");
  const turn = app.reception.pending().find((t) => t.source_json);
  const seed = app.reception.context(turn);
  assert.equal(seed.workOverview.total, 2);
  assert.equal(seed.workOverview.byStatus.waiting_input, 1);
  assert.equal(seed.workOverview.byStatus.awaiting_review, 1);
  assert.equal(seed.source.workId, done.id);
  assert.throws(
    () =>
      app.reception.apply(turn, {
        kind: "cancel",
        workId: waiting.id,
        expectedRevision: 1,
      }),
    /decision|continuation/i,
  );
  app.reception.apply(turn, { kind: "deliver", text: "result ready" });
  assert.equal(app.workRecord(waiting.id).status, "waiting_input");
  assert.equal(app.workRecord(done.id).status, "awaiting_delivery");
});

test("real CLI targeted follow-up survives restart, resumes the same Pi session, and leaves another finished work alone", async (t) => {
  const profile = profileFor(t, {
    concurrency: 1,
    memoryPolicy: { enabled: false },
  });
  let runner = await LocalRunner.open(profile);
  t.after(async () => {
    await runner?.close();
  });
  const call = (op, params = {}, id = crypto.randomUUID()) => request(profile, { op, params, id });
  const cli = async (...args) =>
    JSON.parse(
      (
        await promisify(execFile)(process.execPath, ["bin/assistant.mjs", ...args, "--profile", profile.path], {
          cwd: root,
        })
      ).stdout,
    ).result;
  await call("say", { text: "整理资料，先问我范围" }, "create-A");
  const a = await until(async () => {
    const turn = await call("turn", { inputId: "create-A" });
    return (
      turn.work_id && (await call("work", { workId: turn.work_id })).work.status === "waiting_input" && turn.work_id
    );
  });
  await call("say", { text: "整理另一份笔记" }, "create-B");
  const b = await until(async () => (await call("turn", { inputId: "create-B" })).work_id);
  const finished = await completed(profile, b);
  const bound = (await call("work", { workId: a })).executions[0];
  await runner.close();
  runner = undefined;
  runner = await LocalRunner.open(profile);
  const overview = await cli("overview");
  assert.equal(overview.total, 2);
  assert.equal(overview.byStatus.completed, 1);
  assert.equal(overview.byStatus.waiting_input, 1);
  await cli("say", "--work", a, "--revision", "1", "--id", "answer-A", "--text", "回答：只整理本周");
  const done = await completed(profile, a);
  assert.equal(done.executions.length, 1);
  assert.equal(done.executions[0].conversation_id, bound.conversation_id);
  assert.equal(done.executions[0].submission_id, bound.submission_id);
  assert.equal(done.interactions.length, 1);
  assert.equal(done.interactions[0].state, "answered");
  assert.equal((await call("work", { workId: b })).executions[0].id, finished.executions[0].id);
  assert.equal((await cli("overview")).total, 2);
});
