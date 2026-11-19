import test from "node:test";
import assert from "node:assert/strict";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { profileFor, running, until, completed } from "./helpers.mjs";
import { ReceptionDecision } from "../src/domain/conversation.mjs";

function domain(t) {
  const profile = profileFor(t);
  let d = createLocalDomain(profile);
  t.after(() => d.uow.close());
  return {
    get app() {
      return d.app;
    },
    get db() {
      return d.uow.db;
    },
    reopen() {
      d.uow.close();
      d = createLocalDomain(profile);
    },
  };
}
function linked(app, id = "work") {
  const receipt = app.works.submit(id, {
    text: "Original requirements",
    completion: { output: "text" },
  });
  app.history.link(app.history.main.id, receipt.workId);
  return app.workRecord(receipt.workId);
}
function report(app, w, text = "Evidence result") {
  app.executions.report(w, text);
  return app.reception
    .pending()
    .find(
      (t) =>
        t.source_json &&
        JSON.parse(t.source_json).executionId === w.active_execution_id,
    );
}
function acceptResult(app, w, text = "Evidence result") {
  const t = report(app, w, text);
  app.reception.apply(t, { kind: "deliver" });
  return app.detail(w.id).results.at(-1);
}
const definition = {
  objective: "Compare and implement",
  criteria: ["comparison and implementation have evidence"],
  priority: 1,
  maxParallel: 2,
  tasks: [
    {
      key: "research",
      text: "compare",
      dependsOn: [],
      completion: { output: "text" },
    },
    {
      key: "build",
      text: "implement using comparison",
      dependsOn: ["research"],
      completion: { output: "text" },
    },
    {
      key: "independent",
      text: "independent task",
      dependsOn: [],
      completion: { output: "text" },
    },
  ],
};

test("same-requirement continuation preserves immutable history and rejects a late old writer", (t) => {
  const d = domain(t),
    w = linked(d.app),
    turn = report(d.app, w, "partial evidence");
  d.app.reception.apply(turn, {
    kind: "continue",
    goal: "collect remaining evidence",
  });
  const next = d.app.workRecord(w.id);
  assert.equal(next.revision, 1);
  assert.equal(next.text, w.text);
  assert.notEqual(next.active_execution_id, w.active_execution_id);
  assert.throws(
    () => d.app.executions.assertAction(w, "publish_note"),
    /no longer owns/,
  );
  assert.equal(d.app.executions.report(w, "partial evidence").stale, true);
  assert.equal(d.app.works.blocked(w, "late failure"), false);
  d.reopen();
  assert.equal(
    d.app.executions.execution(next).predecessor_id,
    w.active_execution_id,
  );
  acceptResult(d.app, next, "complete evidence");
  assert.equal(d.app.detail(w.id).reports.length, 2);
  assert.equal(
    d.app.receptionQueries.overview(
      d.app.scope.queryGrant("q", d.app.history.main.id),
    ).total,
    1,
  );
});

test("ordered instructions survive reopen and become submitted only at native admission", (t) => {
  const d = domain(t),
    w = linked(d.app);
  d.app.executions.started(w);
  const p = { workId: w.id, expectedRevision: 1, text: "Add dates" };
  const first = d.app.works.instruct("first", p);
  d.app.works.instruct("second", { ...p, text: "Also include sources" });
  assert.equal(d.app.works.instruct("first", p).directiveId, first.directiveId);
  assert.throws(
    () => d.app.works.instruct("first", { ...p, text: "different" }),
    /reused|conflict/i,
  );
  d.reopen();
  assert.equal(d.app.detail(w.id).directives.length, 2);
  d.app.executions.report(w, "first turn done");
  const next = d.app.workRecord(w.id),
    snapshot = d.app.executions.snapshot(next);
  assert.deepEqual(
    snapshot.directives.map((x) => x.text),
    ["Add dates", "Also include sources"],
  );
  assert.equal(next.revision, 1);
  assert.equal(
    d.app.reception.pending().filter((t) => t.source_json).length,
    0,
  );
  assert.ok(
    d.app.detail(w.id).directives.every((x) => x.state === "scheduled"),
  );
  d.app.executions.bound(next, "native-thread", "native-request", {
    admitted: false,
  });
  assert.ok(
    d.app.detail(w.id).directives.every((x) => x.state === "scheduled"),
  );
  d.app.executions.bound(next, "native-thread", "native-request");
  assert.ok(
    d.app.detail(w.id).directives.every((x) => x.state === "submitted"),
  );
});

test("amend supersedes queued instructions; rollback retains original ownership", (t) => {
  const d = domain(t),
    w = linked(d.app);
  d.app.works.instruct("old-instruction", {
    workId: w.id,
    expectedRevision: 1,
    text: "old instruction",
  });
  d.app.works.amend("change", {
    workId: w.id,
    expectedRevision: 1,
    text: "new requirements",
  });
  assert.equal(d.app.detail(w.id).directives[0].state, "superseded");
  assert.deepEqual(
    d.app.executions.snapshot(d.app.workRecord(w.id)).directives,
    [],
  );
  assert.throws(
    () =>
      d.app.works.instruct("late", {
        workId: w.id,
        expectedRevision: 1,
        text: "stale",
      }),
    /Stale/,
  );
});

test("DAG releases successors from accepted results before message delivery and pins consumed results", (t) => {
  const d = domain(t),
    g = d.app.goals.create("goal", { definition });
  const [a, b, c] = ["research", "build", "independent"].map((key) =>
    d.app.workRecord(g.works.find((w) => w.key === key).id),
  );
  assert.deepEqual(
    new Set(d.app.pendingWorks().map((w) => w.id)),
    new Set([a.id, c.id]),
  );
  const result = acceptResult(d.app, a, "comparison with sources");
  assert.equal(d.app.workRecord(a.id).status, "awaiting_delivery");
  assert.ok(d.app.pendingWorks().some((w) => w.id === b.id));
  const snapshot = d.app.executions.snapshot(b);
  assert.equal(snapshot.dependencyResults[0].resultId, result.id);
  assert.equal(snapshot.dependencyResults[0].text, "comparison with sources");
  d.reopen();
  assert.equal(
    d.app.executions.snapshot(b).dependencyResults[0].resultId,
    result.id,
  );
  d.app.works.amend("change-source", {
    workId: a.id,
    expectedRevision: 1,
    text: "different comparison",
  });
  assert.ok(d.app.goals.reasons(b).some((x) => x.startsWith("stale-input:")));
  assert.throws(
    () => d.app.executions.assertAction(b, "publish_note"),
    /dependency/,
  );
  assert.ok(d.app.pendingWorks().some((w) => w.id === c.id));
  assert.equal(d.app.goals.detail(g.id).readyForReview, false);
});

test("plan validation is atomic, goal CAS and pause gate execution without changing requirements", (t) => {
  const d = domain(t);
  assert.throws(
    () =>
      d.app.goals.create("cycle", {
        definition: {
          ...definition,
          tasks: [
            { key: "a", text: "A", dependsOn: ["b"] },
            { key: "b", text: "B", dependsOn: ["a"] },
          ],
        },
      }),
    /Cyclic/,
  );
  assert.deepEqual(d.app.goals.list(), []);
  assert.equal(d.app.status().works.length, 0);
  const g = d.app.goals.create("good", { definition });
  const w = d.app.workRecord(g.works[0].id);
  d.app.goals.change("pause", "goal.pause", {
    goalId: g.id,
    expectedRevision: 1,
  });
  assert.equal(d.app.pendingWorks().length, 0);
  assert.throws(
    () => d.app.executions.assertAction(w, "publish_note"),
    /paused/,
  );
  assert.throws(
    () =>
      d.app.goals.change("stale", "goal.resume", {
        goalId: g.id,
        expectedRevision: 1,
      }),
    /Stale/,
  );
  d.reopen();
  d.app.goals.change("resume", "goal.resume", {
    goalId: g.id,
    expectedRevision: 2,
  });
  assert.equal(d.app.workRecord(w.id).revision, 1);
  assert.ok(d.app.pendingWorks().length);
  assert.throws(
    () =>
      d.app.goals.extend("bad-extend", {
        goalId: g.id,
        expectedRevision: 3,
        tasks: [{ key: "bad", text: "bad", dependsOn: ["missing"] }],
      }),
    /Unknown dependency/,
  );
  assert.equal(d.app.goals.detail(g.id).revision, 3);
});

test("completed subtasks do not assert semantic goal success; explicit evidence is required", (t) => {
  const d = domain(t),
    g = d.app.goals.create("review", {
      definition: { ...definition, tasks: [definition.tasks[0]] },
    });
  const w = d.app.workRecord(g.works[0].id);
  assert.throws(
    () =>
      d.app.goals.confirm("early", {
        goalId: g.id,
        expectedRevision: 1,
        evidence: [],
      }),
    /missing/,
  );
  const result = acceptResult(d.app, w);
  assert.equal(d.app.goals.detail(g.id).state, "active");
  assert.equal(d.app.goals.detail(g.id).semanticReview.kind, "unverified");
  assert.throws(
    () =>
      d.app.goals.confirm("invent", {
        goalId: g.id,
        expectedRevision: 1,
        evidence: [
          {
            criterionId: "criterion-1",
            statement: "done",
            resultIds: ["fake"],
          },
        ],
      }),
    /unavailable/,
  );
  const confirmed = d.app.goals.confirm("confirm", {
    goalId: g.id,
    expectedRevision: 1,
    evidence: [
      {
        criterionId: "criterion-1",
        statement: "Owner checked the comparison",
        resultIds: [result.id],
      },
    ],
  });
  assert.equal(confirmed.state, "achieved");
  assert.equal(confirmed.semanticReview.kind, "owner-attested");
  assert.throws(
    () => ReceptionDecision.parse({ kind: "goal.confirm" }),
    /Unsupported/,
  );
});

test("goal parallelism and query views use live owned state", (t) => {
  const d = domain(t),
    g = d.app.goals.create("p1", {
      definition: { ...definition, maxParallel: 1 },
    });
  const other = d.app.goals.create("p2", {
    definition: { ...definition, priority: 2 },
  });
  const first = d.app.pendingWorks();
  assert.ok(other.works.some((w) => w.id === first[0].id));
  assert.equal(
    first.filter((w) => g.works.some((x) => x.id === w.id)).length,
    1,
  );
  d.app.reception.accept("query", { text: "show goals" });
  const turn = d.app.reception.turn("query"),
    session = d.app.receptionQueries.open(turn);
  assert.equal(d.app.reception.context(turn).goals.items.length, 2);
  const before = d.db.prepare("SELECT total_changes() AS n").get().n;
  const response = session.execute({
    kind: "query",
    name: "goal.get",
    params: { goalId: g.id },
  });
  assert.equal(response.response.data.works.length, 3);
  assert.equal(d.db.prepare("SELECT total_changes() AS n").get().n, before);
  d.app.reception.accept("scoped", {
    text: "this work only",
    workId: g.works[0].id,
  });
  assert.throws(
    () =>
      d.app.reception.apply(d.app.reception.turn("scoped"), {
        kind: "goal.create",
        definition,
      }),
    /targeted/i,
  );
});

test(
  "public runner executes an authorized dependent plan and preserves goal evidence across tasks",
  { timeout: 30000 },
  async (t) => {
    const { call } = await running(t);
    const g = await call("goal.create", {
      definition: { ...definition, tasks: definition.tasks.slice(0, 2) },
    });
    for (const w of g.works)
      await until(async () => {
        const detail = await call("work", { workId: w.id });
        if (detail.work.status === "blocked")
          throw new Error(detail.work.error);
        return detail.work.status === "completed";
      }, 15000);
    const final = await call("goal.get", { goalId: g.id });
    assert.equal(final.readyForReview, true);
    assert.equal(final.state, "active");
    const b = await call("work", {
      workId: g.works.find((w) => w.key === "build").id,
    });
    assert.equal(
      JSON.parse(b.executions[0].context_json).dependencyResults.length,
      1,
    );
  },
);

test("report delivery, plan extension and criterion review commit atomically under goal ownership", (t) => {
  const d = domain(t),
    g = d.app.goals.create("atomic", {
      definition: { ...definition, tasks: [definition.tasks[0]] },
    });
  const w = d.app.workRecord(g.works[0].id),
    turn = report(d.app, w);
  assert.throws(
    () =>
      d.app.reception.apply(turn, {
        kind: "deliver",
        goalPlan: {
          goalId: g.id,
          expectedRevision: 1,
          tasks: [{ key: "bad", text: "bad", dependsOn: ["missing"] }],
        },
      }),
    /Unknown dependency/,
  );
  assert.equal(d.app.detail(w.id).results.length, 0);
  assert.equal(d.app.workRecord(w.id).status, "awaiting_review");
  d.app.reception.apply(turn, {
    kind: "deliver",
    goalPlan: {
      goalId: g.id,
      expectedRevision: 1,
      tasks: [
        {
          key: "verify",
          text: "verify evidence",
          dependsOn: ["research"],
          completion: { output: "text" },
        },
      ],
    },
  });
  const updated = d.app.goals.detail(g.id),
    next = d.app.workRecord(updated.works.find((w) => w.key === "verify").id);
  assert.ok(d.app.pendingWorks().some((w) => w.id === next.id));
  const last = report(d.app, next, "review result");
  const evidence = [
    {
      criterionId: "criterion-1",
      statement: "Checked both results against the criterion",
      resultIds: [
        `result:${w.active_execution_id}`,
        `result:${next.active_execution_id}`,
      ],
    },
  ];
  assert.throws(
    () =>
      d.app.reception.apply(last, {
        kind: "deliver",
        goalReview: { goalId: "unrelated", expectedRevision: 2, evidence },
      }),
    /unrelated/,
  );
  assert.equal(d.app.detail(next.id).results.length, 0);
  d.app.reception.apply(last, {
    kind: "deliver",
    goalReview: { goalId: g.id, expectedRevision: 2, evidence },
  });
  assert.equal(d.app.goals.detail(g.id).semanticReview.kind, "model-reviewed");
  assert.equal(d.app.goals.detail(g.id).state, "achieved");
  assert.throws(
    () =>
      d.app.works.amend("closed", {
        workId: w.id,
        expectedRevision: 1,
        text: "change",
      }),
    /closed/,
  );
  d.app.goals.change("reopen", "goal.reopen", {
    goalId: g.id,
    expectedRevision: 3,
  });
  assert.equal(d.app.goals.detail(g.id).semanticReview.kind, "unverified");
});

test("explicit dependency rebase preserves old snapshots and invalidates transitive consumers", (t) => {
  const d = domain(t),
    g = d.app.goals.create("transitive", {
      definition: {
        ...definition,
        tasks: [
          ...definition.tasks.slice(0, 2),
          {
            key: "final",
            text: "final",
            dependsOn: ["build"],
            completion: { output: "text" },
          },
        ],
      },
    });
  const [a, b, c] = ["research", "build", "final"].map((key) =>
    d.app.workRecord(g.works.find((w) => w.key === key).id),
  );
  acceptResult(d.app, a);
  const old = d.app.executions.snapshot(b);
  acceptResult(d.app, b);
  assert.ok(d.app.pendingWorks().some((w) => w.id === c.id));
  d.app.works.amend("upstream", {
    workId: a.id,
    expectedRevision: 1,
    text: "new input contract",
  });
  assert.ok(
    d.app.goals.reasons(c).some((x) => x.startsWith("invalid-upstream:")),
  );
  assert.throws(() => d.app.outcomes.record(b, "obsolete"), /dependency/);
  assert.throws(
    () =>
      d.app.goals.rebase("bad-rebase", {
        goalId: g.id,
        expectedRevision: 1,
        workId: b.id,
        expectedWorkRevision: 1,
        dependencies: [{ workId: a.id, revision: 1 }],
      }),
    /Stale/,
  );
  assert.equal(d.app.workRecord(b.id).revision, 1);
  const g2 = d.app.goals.rebase("rebase", {
    goalId: g.id,
    expectedRevision: 1,
    workId: b.id,
    expectedWorkRevision: 1,
    dependencies: [{ workId: a.id, revision: 2 }],
  });
  assert.equal(g2.revision, 2);
  assert.equal(d.app.workRecord(b.id).revision, 2);
  assert.deepEqual(
    JSON.parse(d.app.detail(b.id).executions[0].context_json),
    old,
  );
  acceptResult(d.app, d.app.workRecord(a.id), "new comparison");
  assert.ok(d.app.pendingWorks().some((w) => w.id === b.id));
  acceptResult(d.app, d.app.workRecord(b.id), "new implementation");
  assert.ok(!d.app.pendingWorks().some((w) => w.id === c.id));
  d.app.goals.rebase("rebase-final", {
    goalId: g.id,
    expectedRevision: 2,
    workId: c.id,
    expectedWorkRevision: 1,
    dependencies: [{ workId: b.id, revision: 2 }],
  });
  assert.ok(d.app.pendingWorks().some((w) => w.id === c.id));
});

test("pause retains a late report without accepting it, resumes once, and fences in-flight review", (t) => {
  const d = domain(t),
    g = d.app.goals.create("pause-result", {
      definition: { ...definition, tasks: [definition.tasks[0]] },
    }),
    w = d.app.workRecord(g.works[0].id);
  d.app.executions.started(w);
  d.app.goals.change("pause", "goal.pause", {
    goalId: g.id,
    expectedRevision: 1,
  });
  assert.equal(d.app.executions.report(w, "saved while paused").stale, true);
  assert.equal(d.app.detail(w.id).reports.length, 1);
  assert.equal(d.app.reception.pending().length, 0);
  d.reopen();
  d.app.goals.change("resume", "goal.resume", {
    goalId: g.id,
    expectedRevision: 2,
  });
  const turn = report(d.app, w, "saved while paused");
  d.app.goals.change("pause-again", "goal.pause", {
    goalId: g.id,
    expectedRevision: 3,
  });
  assert.throws(
    () => d.app.reception.apply(turn, { kind: "deliver" }),
    /paused/,
  );
  assert.equal(d.app.reception.pending().length, 0);
  d.app.goals.change("resume-again", "goal.resume", {
    goalId: g.id,
    expectedRevision: 4,
  });
  d.app.reception.apply(turn, { kind: "deliver" });
  assert.equal(d.app.detail(w.id).results.length, 1);
});

test("explicit supplemental instructions reset only the automatic continuation streak", (t) => {
  const d = domain(t);
  let w = linked(d.app);
  for (let i = 0; i < 4; i++) {
    acceptResult(d.app, w, `result ${i}`);
    d.app.works.instruct(`explicit-${i}`, {
      workId: w.id,
      expectedRevision: 1,
      text: `supplement ${i}`,
    });
    w = d.app.workRecord(w.id);
  }
  assert.equal(w.revision, 1);
  assert.equal(d.app.detail(w.id).executions.length, 5);
  assert.equal(
    JSON.parse(d.app.executions.execution(w).request_json).continuations,
    0,
  );
});

test("late reception failure cannot block a same-revision successor and step budget is cumulative", (t) => {
  const d = domain(t),
    w = linked(d.app),
    turn = report(d.app, w);
  d.app.executions.modelStep(w, "turn:0", 1);
  d.app.works.instruct("advance", {
    workId: w.id,
    expectedRevision: 1,
    text: "supplement",
  });
  const next = d.app.workRecord(w.id);
  d.app.reception.failed(turn, new Error("late model rejection"));
  assert.equal(d.app.workRecord(w.id).status, "queued");
  assert.equal(d.app.reception.turn(turn.id).status, "settled");
  assert.throws(() => d.app.executions.modelStep(next, "turn:0", 1), /limit/i);
  assert.equal(
    JSON.parse(d.app.executions.execution(next).guard_json).steps,
    1,
  );
});

test("bounded goal queries page all plan members without leaking resource grants", (t) => {
  const d = domain(t),
    g = d.app.goals.create("large", {
      definition: {
        ...definition,
        tasks: Array.from({ length: 32 }, (_, i) => ({
          key: `task-${i}`,
          text: "资料".repeat(1000),
          dependsOn: [],
          completion: { output: "text" },
        })),
      },
    });
  d.app.reception.accept("pages", { text: "inspect goals" });
  const turn = d.app.reception.turn("pages");
  let after,
    ids = [];
  do {
    const response = d.app.receptionQueries.open(turn).execute({
      kind: "query",
      name: "goal.get",
      params: { goalId: g.id, limit: 12, ...(after ? { after } : {}) },
    }).response;
    assert.equal(response.ok, true);
    assert.equal(response.data.resources_json, undefined);
    assert.ok(response.data.works.every((w) => w.textTruncated));
    ids.push(...response.data.works.map((w) => w.id));
    after = response.data.next;
  } while (after);
  assert.equal(new Set(ids).size, 32);
  assert.equal(ids.length, 32);
  assert.throws(
    () =>
      d.app.goals.create("unbounded", {
        definition: {
          ...definition,
          criteria: ["长".repeat(1000), "长".repeat(1000), "长".repeat(1000)],
        },
      }),
    /brief bound/,
  );
});

test("priority ages from durable work progress rather than monopolizing the first goal", (t) => {
  const profile = profileFor(t);
  let at = 100000;
  const d = createLocalDomain(profile, null, { now: () => at });
  t.after(() => d.uow.close());
  const tasks = [definition.tasks[0], definition.tasks[2]];
  const a = d.app.goals.create("a", { definition: { ...definition, tasks } }),
    b = d.app.goals.create("b", { definition: { ...definition, tasks } });
  const first = d.app.pendingWorks()[0],
    firstGoal = d.app.goals.forWork(first.id);
  at += 1000;
  d.app.executions.started(first);
  acceptResult(d.app, first);
  assert.notEqual(d.app.goals.forWork(d.app.pendingWorks()[0].id), firstGoal);
  d.app.goals.change("priority", "goal.update", {
    goalId: a.id,
    expectedRevision: 1,
    priority: 2,
  });
  assert.equal(d.app.goals.forWork(d.app.pendingWorks()[0].id), a.id);
  at += 180000;
  const hot = d.app.goals.create("new-high", {
    definition: { ...definition, priority: 2, tasks },
  });
  assert.notEqual(d.app.goals.forWork(d.app.pendingWorks()[0].id), hot.id);
  assert.equal(d.app.goals.detail(b.id).priority, 1);
});

test("supplement and dependency input totals stay bounded without losing evidence identity", (t) => {
  const d = domain(t),
    w = linked(d.app, "bounded-instructions");
  d.app.works.instruct("long1", {
    workId: w.id,
    expectedRevision: 1,
    text: "a".repeat(10000),
  });
  d.app.works.instruct("long2", {
    workId: w.id,
    expectedRevision: 1,
    text: "b".repeat(10000),
  });
  assert.throws(
    () =>
      d.app.works.instruct("overflow", {
        workId: w.id,
        expectedRevision: 1,
        text: "c".repeat(10000),
      }),
    /limit/,
  );
  assert.equal(d.app.detail(w.id).directives.length, 2);
  const g = d.app.goals.create("bounded-deps", {
    definition: {
      ...definition,
      tasks: [
        ...definition.tasks.filter((t) => t.key !== "build"),
        { ...definition.tasks[1], dependsOn: ["research", "independent"] },
      ],
    },
  });
  for (const key of ["research", "independent"])
    acceptResult(
      d.app,
      d.app.workRecord(g.works.find((w) => w.key === key).id),
      "e".repeat(12000),
    );
  const next = d.app.workRecord(g.works.find((w) => w.key === "build").id),
    s = d.app.executions.snapshot(next);
  assert.equal(s.dependencyResults.length, 2);
  assert.equal(
    s.dependencyResults.reduce((n, r) => n + r.text.length, 0),
    12000,
  );
  assert.ok(s.dependencyResults.every((r) => r.truncated && r.resultId));
});

test(
  "real CLI goal commands use the same receipt, revision and child-input owners",
  { timeout: 30000 },
  async (t) => {
    const { execFile } = await import("node:child_process"),
      { promisify } = await import("node:util");
    const { root } = await import("./helpers.mjs");
    const { profile, call } = await running(t);
    const cli = async (...args) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            [`${root}/bin/assistant.mjs`, ...args, "--profile", profile.path],
            { timeout: 10000 },
          )
        ).stdout,
      ).result;
    const g = await cli(
      "goal-create",
      "--id",
      "cli-goal",
      "--definition",
      JSON.stringify({ ...definition, tasks: [definition.tasks[0]] }),
    );
    const paused = await cli("goal-pause", "--goal", g.id, "--revision", "1");
    assert.equal(paused.state, "paused");
    const duplicate = await cli(
      "goal-create",
      "--id",
      "cli-goal",
      "--definition",
      JSON.stringify({ ...definition, tasks: [definition.tasks[0]] }),
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.id, g.id);
    await cli("goal-resume", "--goal", g.id, "--revision", "2");
    await until(
      async () =>
        (await call("work", { workId: g.works[0].id })).work.status ===
        "completed",
      10000,
    );
    const read = await cli("goal-get", "--goal", g.id);
    assert.equal(read.readyForReview, true);
    const detail = await call("work", { workId: g.works[0].id });
    assert.equal(detail.inputs.length, 1);
    assert.notEqual(detail.inputs[0].delivered_at, null);
  },
);
