import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { ReceptionPlanner } from "../src/application/reception/planner.mjs";
import { ReceptionCoordinator } from "../src/runtime/reception-coordinator.mjs";
import { ReceptionQueries } from "../src/application/reception/query-service.mjs";
import {
  ReceptionQuery,
  RECEPTION_LIMITS,
} from "../src/domain/reception-query.mjs";
import { profileFor } from "./helpers.mjs";
function domain(t) {
  const d = createLocalDomain(profileFor(t));
  t.after(() => d.uow.close());
  return d;
}
function goal(app) {
  return app.goals.create("goal", {
    definition: {
      objective: "Check two dependent deliverables",
      criteria: ["Both verified"],
      tasks: [
        {
          key: "one",
          text: "first",
          dependsOn: [],
          completion: { output: "text" },
        },
        {
          key: "two",
          text: "second",
          dependsOn: ["one"],
          completion: { output: "text" },
        },
      ],
    },
  });
}
function report(app, id, text) {
  const work = app.workRecord(id);
  app.executions.report(work, text);
  return app.reception
    .pending()
    .find(
      (t) =>
        t.source_json &&
        JSON.parse(t.source_json).executionId === work.active_execution_id,
    );
}
test("report seed contains fresh scoped criteria and accepted evidence, never treats current candidate as accepted", (t) => {
  const { app, uow } = domain(t),
    g = goal(app);
  const first = g.works.find((w) => w.key === "one").id;
  const second = g.works.find((w) => w.key === "two").id;
  const a = report(app, first, "FIRST ACCEPTED EVIDENCE");
  app.reception.apply(a, { kind: "deliver" });
  const b = report(app, second, "SECOND CANDIDATE");
  const before = uow.db.prepare("SELECT total_changes() n").get().n;
  const context = app.reception.context(b);
  assert.equal(uow.db.prepare("SELECT total_changes() n").get().n, before);
  assert.equal(context.goalContext.id, g.id);
  assert.equal(context.goalContext.criteria[0].id, "criterion-1");
  assert.equal(context.goalContext.evidence.length, 1);
  assert.equal(context.goalContext.evidence[0].text, "FIRST ACCEPTED EVIDENCE");
  assert.notEqual(
    context.goalContext.evidence[0].resultId,
    context.report.candidateResultId,
  );
  const grant = app.receptionQueries.grant(b),
    source = JSON.parse(b.source_json);
  assert.throws(
    () =>
      app.receptionQueries.reportGoal(grant, { ...source, goalId: "foreign" }),
    /does not own/,
  );
  assert.throws(
    () =>
      app.receptionQueries.reportGoal(
        { ...grant, conversationId: "foreign" },
        source,
      ),
    /does not own/,
  );
});
test("report projection is bounded and marks omitted evidence/details", () => {
  let detail = {
    id: "g",
    works: [{ id: "w", resultId: "result:e" }],
    next: "next-page",
    objective: "x".repeat(11000),
  };
  const q = new ReceptionQueries({
    reads: {
      work: () => ({ work: { goal_id: "g" } }),
      goal: () => detail,
      report: () => ({ execution_id: "e", text: "中".repeat(3000) }),
    },
  });
  const read = () =>
    q.reportGoal({ conversationId: "c" }, { goalId: "g", workId: "w" });
  const v = read();
  assert.ok(ReceptionQuery.bytes(v) <= RECEPTION_LIMITS.resultBytes);
  assert.equal(v.evidenceTruncated, true);
  assert.equal(v.next, "next-page");
  detail = { ...detail, objective: "中".repeat(15000) };
  assert.deepEqual(read(), { id: "g", detailsOmitted: true });
});
test("planning deadline retains host query progress; retry refreshes it, and a late response cannot commit", async (t) => {
  const { app } = domain(t),
    g = goal(app);
  const workId = g.works.find((w) => w.key === "one").id;
  const turn = report(app, workId, "candidate");
  let release,
    calls = 0,
    failure,
    applied = 0;
  const planner = new ReceptionPlanner(
    {
      async decide() {
        if (++calls === 1)
          return { kind: "query", name: "goal.get", params: { goalId: g.id } };
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
    app.receptionQueries,
  );
  const coordinator = new ReceptionCoordinator(
    {
      started: () => true,
      context: () => app.reception.context(turn),
      apply: () => {
        applied++;
      },
      failed: (t, error, trace) => {
        failure = { error, trace };
      },
    },
    planner,
    { timeoutMs: 50 },
  );
  // Keep an event-loop handle while the deadline intentionally unrefs its timer.
  const keepAlive = delay(100);
  await coordinator.processAttempt(turn, new AbortController().signal);
  await keepAlive;
  assert.equal(failure.error.code, "RUN_LIMIT_PLANNING_TIMEOUT");
  assert.equal(failure.trace.length, 1);
  app.reception.failed(turn, failure.error, failure.trace);
  release({ kind: "deliver" });
  await delay(10);
  assert.equal(applied, 0);
  app.goals.change("pause", "goal.pause", {
    goalId: g.id,
    expectedRevision: 1,
  });
  const retry = app.reception.turn(turn.id);
  const recovered = new ReceptionPlanner(
    {
      async decide(input) {
        assert.equal(input.observations.length, 1);
        assert.equal(input.observations[0].response.data.revision, 2);
        assert.equal(input.observations[0].response.data.state, "paused");
        return { kind: "silent" };
      },
    },
    app.receptionQueries,
  );
  const result = await recovered.plan(
    retry,
    app.reception.context(retry),
    new AbortController().signal,
  );
  assert.equal(result.queries.length, 1);
  const endless = new ReceptionPlanner(
    {
      async decide() {
        return { kind: "query", name: "goal.get", params: { goalId: g.id } };
      },
    },
    app.receptionQueries,
  );
  await assert.rejects(
    endless.plan(retry, {}, new AbortController().signal),
    (e) =>
      /count exhausted/.test(e.message) &&
      e.queries.length === RECEPTION_LIMITS.queries,
  );
});
