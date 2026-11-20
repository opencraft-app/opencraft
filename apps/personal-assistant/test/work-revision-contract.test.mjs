import test from "node:test";
import assert from "node:assert/strict";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { ReceptionDecision } from "../src/domain/conversation.mjs";
import {
  selectedSchema,
  decodeSelected,
  decodeRoutes,
  decodeOutput,
  validateOutput,
} from "../src/adapters/models/structured-output.mjs";
import { profileFor } from "./helpers.mjs";
const contract = { output: "text", requirements: [], checks: [] };
function domain(t) {
  const profile = profileFor(t, { memoryPolicy: { enabled: false } });
  let now = Date.now(),
    d = createLocalDomain(profile, null, { now: () => now });
  t.after(() => d.uow.close());
  return {
    get app() {
      return d.app;
    },
    get db() {
      return d.uow.db;
    },
    advance(ms) {
      now += ms;
    },
    reopen() {
      d.uow.close();
      d = createLocalDomain(profile, null, { now: () => now });
    },
  };
}
function work(app, id, completion = contract) {
  const r = app.works.submit(id, { text: id, completion });
  app.history.link(app.history.main.id, r.workId);
  return app.workRecord(r.workId);
}
function intake(app, id, workId) {
  app.reception.accept(id, {
    text: "replace the old requirements",
    ...(workId ? { workId } : {}),
  });
  return app.reception.turn(id);
}
function answer(app, w, id, value, options) {
  const q = app.interactions.request(w, id, `Question ${id}?`, options);
  app.interactions.answer(`answer-${id}`, {
    interactionId: q.id,
    expectedRevision: w.revision,
    text: value,
  });
  return q;
}
function continueWork(app, w, id = "next") {
  app.executions.blocked(w, "controlled settled boundary");
  app.works.continue(id, {
    workId: w.id,
    expectedRevision: w.revision,
    text: "process the additional instruction",
  });
  return app.workRecord(w.id);
}

test("model amendment requires a full replacement in flat and selected protocols; targeted routing permits one action", () => {
  const base = {
    kind: "amend",
    workId: "w",
    expectedRevision: 1,
    goal: "new goal",
  };
  for (const completion of [
    undefined,
    null,
    {},
    { output: "text" },
    { ...contract, checks: null },
  ]) {
    const proposal = { ...base, completion };
    assert.throws(
      () => ReceptionDecision.parse(proposal),
      /complete completion/,
    );
    assert.throws(() =>
      decodeSelected(JSON.stringify({ proposal }), ["amend"], {}),
    );
    assert.throws(() =>
      decodeOutput("reception", JSON.stringify({ proposal }), {}),
    );
  }
  const proposal = { ...base, completion: contract };
  assert.equal(
    validateOutput(selectedSchema(["amend"], {}), { proposal }),
    true,
  );
  assert.deepEqual(
    decodeSelected(JSON.stringify({ proposal }), ["amend"], {}),
    proposal,
  );
  assert.deepEqual(
    decodeRoutes(JSON.stringify({ operations: ["amend"] }), {
      targetWork: { id: "w" },
    }),
    ["amend"],
  );
  assert.throws(() =>
    decodeRoutes(JSON.stringify({ operations: ["amend", "reject"] }), {
      targetWork: { id: "w" },
    }),
  );
  assert.deepEqual(
    decodeRoutes(JSON.stringify({ operations: ["delegate", "delegate"] }), {}),
    ["delegate", "delegate"],
  );
});

test("replacement drops old criteria, retires old questions, preserves the frozen snapshot and settled replay", (t) => {
  const d = domain(t),
    app = d.app;
  const w = work(app, "old", {
    output: "note",
    requirements: ["OLD on 2026-12-01"],
    checks: [{ kind: "note_contains", text: "OLD" }],
  });
  const original = app.executions.snapshot(w);
  const q = app.interactions.request(w, "old-question", "old date?");
  const turn = intake(app, "change", w.id);
  assert.throws(
    () =>
      app.reception.apply(turn, {
        kind: "amend",
        workId: w.id,
        expectedRevision: 1,
        goal: "NEW",
      }),
    /complete completion/,
  );
  assert.equal(app.workRecord(w.id).revision, 1);
  app.reception.apply(turn, {
    kind: "amend",
    workId: w.id,
    expectedRevision: 1,
    goal: "NEW",
    completion: {
      output: "note",
      requirements: ["NEW only"],
      checks: [{ kind: "note_contains", text: "NEW" }],
    },
  });
  const current = app.workRecord(w.id),
    snapshot = app.executions.snapshot(current);
  assert.equal(current.revision, 2);
  assert.doesNotMatch(JSON.stringify(snapshot.completion), /OLD|2026-12-01/);
  assert.match(JSON.stringify(snapshot.completion), /NEW/);
  assert.deepEqual(
    JSON.parse(app.executions.execution(w).context_json),
    original,
  );
  assert.throws(() =>
    app.interactions.answer("late", {
      interactionId: q.id,
      expectedRevision: 1,
      text: "old",
    }),
  );
  assert.equal(app.reception.apply(turn, { kind: "amend" }).status, "settled");
  d.reopen();
  assert.equal(d.app.workRecord(w.id).revision, 2);
  assert.deepEqual(d.app.executions.snapshot(current), snapshot);
});

test("explicit partial model amendment carries criteria forward while typed rebase-compatible amendments retain defaults", (t) => {
  const { app } = domain(t),
    keep = {
      output: "text",
      requirements: ["keep this constraint"],
      checks: [],
    },
    w = work(app, "initial", keep);
  app.works.amend("typed", {
    workId: w.id,
    expectedRevision: 1,
    text: "same acceptance, rebound dependencies",
  });
  assert.deepEqual(
    app.executions.snapshot(app.workRecord(w.id)).completion.requirements,
    keep.requirements,
  );
  app.reception.apply(intake(app, "partial", w.id), {
    kind: "amend",
    workId: w.id,
    expectedRevision: 2,
    goal: "full updated goal",
    completion: {
      ...keep,
      requirements: [...keep.requirements, "new constraint"],
    },
  });
  assert.deepEqual(
    app.executions.snapshot(app.workRecord(w.id)).completion.requirements,
    [...keep.requirements, "new constraint"],
  );
});

test("same-revision continuation preserves ordinary answers with provenance, never old execution authority or old evidence", (t) => {
  const d = domain(t),
    app = d.app,
    w = work(app, "date");
  const original = app.executions.snapshot(w);
  const q = answer(app, w, "date", "2026-12-18");
  app.executions.bound(w, "native-thread", "native-submission");
  const current = continueWork(app, w);
  const snapshot = app.executions.snapshot(current);
  assert.equal(current.revision, 1);
  assert.notEqual(current.active_execution_id, w.active_execution_id);
  assert.equal(
    app.executions.execution(current).session_root,
    app.executions.execution(w).session_root,
  );
  assert.deepEqual(
    snapshot.confirmedInputs.items.map((i) => [
      i.interactionId,
      i.sourceExecutionId,
      i.answer,
    ]),
    [[q.id, w.active_execution_id, "2026-12-18"]],
  );
  assert.deepEqual(
    JSON.parse(app.executions.execution(w).context_json),
    original,
  );
  assert.throws(
    () => app.executions.assertAction(w, "publish_note"),
    /execution|Execution/,
  );
  assert.throws(
    () => app.interactions.request(w, "stale", "Ask again?"),
    /execution|Execution/,
  );
  assert.throws(
    () =>
      app.interactions.answer("replace-answer", {
        interactionId: q.id,
        expectedRevision: 1,
        text: "wrong",
      }),
    /answered/,
  );
  assert.deepEqual(
    app
      .detail(w.id)
      .completion.executions.find(
        (e) => e.executionId === current.active_execution_id,
      )?.evidence ?? [],
    [],
  );
  d.reopen();
  assert.deepEqual(d.app.executions.snapshot(current), snapshot);
  const second = continueWork(d.app, current, "third");
  assert.equal(
    d.app.executions.snapshot(second).confirmedInputs.items[0].answer,
    "2026-12-18",
  );
  d.app.works.amend("different-direction", {
    workId: w.id,
    expectedRevision: 1,
    text: "new direction",
    completion: contract,
  });
  assert.deepEqual(
    d.app.executions.snapshot(d.app.workRecord(w.id)).confirmedInputs.items,
    [],
  );
  assert.equal(
    d.app.detail(w.id).interactions.find((i) => i.id === q.id).state,
    "superseded",
  );
});

test("confirmed inputs exclude expired, sensitive, pending and foreign facts; bounds omit whole answers", (t) => {
  const d = domain(t),
    app = d.app,
    w = work(app, "bounded");
  answer(app, w, "expires", "expired fact", { expiresInMs: 1000 });
  const handoff = app.interactions.request(w, "approval", "owner handoff?", {
    kind: "handoff",
  });
  app.interactions.resolve("resolve", {
    interactionId: handoff.id,
    expectedRevision: 1,
    text: "private approval",
  });
  answer(app, work(app, "foreign"), "foreign", "foreign fact");
  d.advance(1001);
  for (let n = 0; n < 33; n++) {
    d.advance(1);
    answer(app, w, `q${n}`, `valid ${n}`);
  }
  d.advance(1);
  answer(app, w, "large", "x".repeat(20000));
  const pending = app.interactions.request(w, "pending", "not answered?");
  const current = continueWork(app, w);
  const confirmed = app.executions.snapshot(current).confirmedInputs;
  assert.equal(confirmed.omitted, true);
  assert.equal(confirmed.items.length, 31);
  assert.doesNotMatch(
    JSON.stringify(confirmed.items),
    /expired fact|private approval|foreign fact|not answered|xxxxx/,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(confirmed.items)) < 16000);
  assert.equal(
    app.detail(w.id).interactions.find((i) => i.id === handoff.id).state,
    "superseded",
  );
  assert.equal(
    app.detail(w.id).interactions.find((i) => i.id === pending.id).state,
    "superseded",
  );
});

for (const reverse of [false, true])
  test(`conflicting amend/reject batch is rejected before effects in either order (${reverse}) and records safe diagnostics`, (t) => {
    const d = domain(t),
      app = d.app,
      w = work(app, "batch");
    const q = app.interactions.request(w, "ask", "private question?");
    const turn = intake(app, "batch-input");
    const commands = [
      {
        kind: "amend",
        workId: w.id,
        expectedRevision: 1,
        goal: "PRIVATE NEW GOAL",
        completion: contract,
      },
      { kind: "reject", interactionId: q.id, expectedRevision: 1 },
    ];
    if (reverse) commands.reverse();
    const before = d.db.prepare("SELECT total_changes() n").get().n;
    let failure;
    try {
      app.reception.apply(turn, { kind: "batch", commands });
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message ?? "", /Conflicting commands/);
    assert.equal(d.db.prepare("SELECT total_changes() n").get().n, before);
    assert.equal(app.workRecord(w.id).revision, 1);
    assert.equal(app.detail(w.id).interactions[0].state, "pending");
    app.reception.failed(turn, failure);
    d.reopen();
    const receipt = d.app.reception.turn(turn.id),
      saved = JSON.parse(receipt.decision_json);
    assert.equal(receipt.status, "blocked");
    assert.deepEqual(saved.commandFailure, {
      code: "conflicting_commands",
      index: 1,
      commands: commands.map((c) => c.kind),
    });
    assert.doesNotMatch(receipt.decision_json, /PRIVATE|private question/);
  });

test("independent amendments remain atomic and valid; reject cannot be combined with answering a sibling question", (t) => {
  const { app } = domain(t),
    a = work(app, "A"),
    b = work(app, "B");
  app.reception.apply(intake(app, "independent"), {
    kind: "batch",
    commands: [a, b].map((w) => ({
      kind: "amend",
      workId: w.id,
      expectedRevision: 1,
      goal: `new ${w.id}`,
      completion: contract,
    })),
  });
  assert.equal(app.workRecord(a.id).revision, 2);
  assert.equal(app.workRecord(b.id).revision, 2);
  const current = app.workRecord(a.id),
    q1 = app.interactions.request(current, "q1", "first?"),
    q2 = app.interactions.request(current, "q2", "second?");
  assert.throws(
    () =>
      app.reception.apply(intake(app, "conflicting-questions"), {
        kind: "batch",
        commands: [
          {
            kind: "answer",
            interactionId: q1.id,
            expectedRevision: 2,
            text: "yes",
          },
          { kind: "reject", interactionId: q2.id, expectedRevision: 2 },
        ],
      }),
    /Conflicting/,
  );
  assert.equal(
    app.detail(a.id).interactions.every((i) => i.state === "pending"),
    true,
  );
});

test("report review sees confirmed answers and cumulative directives survive a second continuation without reassigning receipts", (t) => {
  const { app } = domain(t),
    w = work(app, "continued-facts");
  const initial = app.executions.snapshot(w);
  const q = answer(app, w, "ordinary", "2026-12-18");
  app.works.instruct("first-instruction", {
    workId: w.id,
    expectedRevision: 1,
    text: "include rain gear",
  });
  app.works.instruct("second-instruction", {
    workId: w.id,
    expectedRevision: 1,
    text: "also include charger",
  });
  const next = continueWork(app, w),
    snapshot = app.executions.snapshot(next);
  app.executions.bound(next, "thread", "submission");
  const submitted = app.detail(w.id).directives;
  app.executions.report(next, "result to review");
  const turn = app.reception
    .pending()
    .find((t) => t.source_json && t.work_id === w.id);
  const context = app.reception.context(turn);
  assert.equal(context.confirmedInputs.items[0].interactionId, q.id);
  assert.equal(context.confirmedInputs.items[0].answer, "2026-12-18");
  assert.deepEqual(context.pendingInteractions, []);
  assert.deepEqual(context.directives.items, snapshot.directives);
  assert.equal(context.directives.omitted, false);
  app.reception.apply(turn, { kind: "continue", goal: "verify the result" });
  const third = app.workRecord(w.id),
    thirdSnapshot = app.executions.snapshot(third);
  assert.equal(thirdSnapshot.confirmedInputs.items[0].answer, "2026-12-18");
  assert.deepEqual(thirdSnapshot.directives, snapshot.directives);
  assert.deepEqual(app.detail(w.id).directives, submitted);
  assert.deepEqual(
    JSON.parse(app.executions.execution(w).context_json),
    initial,
  );
  assert.deepEqual(
    JSON.parse(app.executions.execution(next).context_json),
    snapshot,
  );
  app.works.amend("new-revision", {
    workId: w.id,
    expectedRevision: 1,
    text: "fresh requirements",
    completion: contract,
  });
  assert.deepEqual(
    app.executions.snapshot(app.workRecord(w.id)).directives,
    [],
  );
});

test("cumulative directives are bounded across attempts and do not present queued instructions as admitted", (t) => {
  const { app } = domain(t);
  let w = work(app, "bounded-directives");
  for (let i = 0; i < 34; i++) {
    app.works.instruct(`d${i}`, {
      workId: w.id,
      expectedRevision: 1,
      text: `instruction ${i}`,
    });
    w = continueWork(app, w, `attempt-${i}`);
    app.executions.bound(w, "thread", `submission-${i}`);
  }
  app.works.instruct("not-admitted", {
    workId: w.id,
    expectedRevision: 1,
    text: "wait for next boundary",
  });
  const snapshot = app.executions.snapshot(w);
  assert.equal(snapshot.directivesOmitted, true);
  assert.equal(snapshot.directives.length, 32);
  assert.equal(snapshot.directives[0].text, "instruction 2");
  assert.equal(snapshot.directives.at(-1).text, "instruction 33");
  assert.equal(
    snapshot.directives.some((d) => d.text.includes("next boundary")),
    false,
  );
});

test("goal lifecycle and member-work actions cannot share a dependent batch", (t) => {
  const { app } = domain(t);
  const g = app.goals.create("goal", {
    definition: {
      objective: "prepare",
      criteria: ["prepared"],
      tasks: [
        {
          key: "one",
          text: "prepare note",
          dependsOn: [],
          completion: contract,
        },
      ],
    },
  });
  const w = g.works[0];
  for (const reverse of [false, true]) {
    const commands = [
      { kind: "goal.cancel", goalId: g.id, expectedRevision: g.revision },
      {
        kind: "amend",
        workId: w.id,
        expectedRevision: 1,
        goal: "different note",
        completion: contract,
      },
    ];
    if (reverse) commands.reverse();
    assert.throws(
      () =>
        app.reception.apply(intake(app, `goal-conflict-${reverse}`), {
          kind: "batch",
          commands,
        }),
      /Conflicting/,
    );
    assert.equal(app.goals.detail(g.id).state, "active");
    assert.equal(app.workRecord(w.id).revision, 1);
  }
});
