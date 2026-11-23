import { legacyMemoryFixture } from "./helpers.mjs";
import { createExecutionPorts } from "../src/runtime/execution-ports.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RunPolicy } from "../src/domain/run-policy.mjs";
import { Runner } from "../src/runner.mjs";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { ModelCatalog } from "../src/adapters/models/model-catalog.mjs";
import { ReceptionModel } from "../src/adapters/models/reception-model.mjs";
import { MemoryLearningModel } from "../src/adapters/models/memory-learning-model.mjs";
import { readNativeUsage } from "../src/adapters/pi/native-usage.mjs";
import { withRequestDeadline } from "../src/adapters/local/request-deadline.mjs";
import {
  profileFor,
  running,
  until,
  completed,
  childRunner,
  files,
  nativeEntries,
  root,
} from "./helpers.mjs";

const counters = (input, output = 2) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0.1, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.12 },
});
function domain(t) {
  const profile = profileFor(t),
    d = createLocalDomain(profile);
  t.after(() => d.uow.close());
  return { ...d, profile };
}
function catalog(completeSimple, runPolicy) {
  return {
    profile: { config: { runPolicy } },
    configured: {
      mode: "model",
      model: { provider: "controlled", modelId: "test" },
      models: {
        getModel() {
          return {};
        },
        completeSimple,
      },
    },
  };
}

test("run policy validates finite local limits and remains separate from a spending budget", () => {
  assert.equal(RunPolicy.resolve().maxSteps, 128);
  for (const p of [
    { maxSteps: 0 },
    { workTimeoutMs: Infinity },
    { modelTimeoutMs: -1 },
    { maxRetries: 6 },
    { dollars: 5 },
  ])
    assert.throws(() => RunPolicy.resolve(p));
  assert.equal(RunPolicy.resolve({ maxRetries: 0 }).maxRetries, 0);
});

test("native request step identity survives reopen; recovery of the same task does not consume another step", (t) => {
  const profile = profileFor(t);
  let d = createLocalDomain(profile);
  const work = d.app.workRecord(
    d.app.works.submit("steps", { text: "task" }).workId,
  );
  d.app.executions.modelStep(work, "task-1", 1);
  d.uow.close();
  d = createLocalDomain(profile);
  t.after(() => d.uow.close());
  d.app.executions.modelStep(work, "task-1", 1);
  assert.throws(
    () => d.app.executions.modelStep(work, "task-2", 1),
    /model-step limit/,
  );
  const state = JSON.parse(d.app.executions.execution(work).guard_json);
  assert.equal(state.steps, 1);
  assert.equal(state.stopReason, "steps");
  d.app.works.amend("amend", {
    workId: work.id,
    expectedRevision: 1,
    text: "new bounded goal",
  });
  d.app.executions.modelStep(d.app.workRecord(work.id), "task-3", 1);
  assert.equal(
    JSON.parse(d.app.executions.execution(d.app.workRecord(work.id)).guard_json)
      .steps,
    1,
  );
});

test("real Pi step guard aborts before another provider request and retains the already published effect", async (t) => {
  const { runner, profile, call } = await running(t, {
    runPolicy: { maxSteps: 1 },
  });
  const { workId } = await call("submit", { text: "write a note" });
  const detail = await until(
    () =>
      runner.app.workRecord(workId).status === "blocked" &&
      runner.app.detail(workId),
  );
  assert.match(detail.work.error, /model-step limit/);
  assert.equal(JSON.parse(detail.executions[0].guard_json).steps, 1);
  assert.equal(detail.results.length, 0);
  assert.equal(detail.deliveries.length, 0);
  assert.equal(files(profile, "artifacts").length, 1);
  assert.equal(detail.reports[0].status, "error");
  assert.equal(
    (await nativeEntries(profile, workId)).filter(
      (e) => e.kind === "pi.assistant",
    ).length,
    1,
  );
  assert.ok(
    runner.app.usage.read({ workId }).executions[0].control.lastRun.elapsedMs >=
      0,
  );
  // More capacity is an explicit configuration change; new revision gets its own bounded run.
  profile.config.runPolicy.maxSteps = 3;
  await call("amend", {
    workId,
    expectedRevision: 1,
    text: "finish the revised note",
  });
  await completed(profile, workId);
  assert.equal(runner.app.detail(workId).executions.length, 2);
});

test("real Pi execution timeout blocks work and leaves cancellation with the native owner", async (t) => {
  const { runner, profile, call } = await running(t, {
    fixtureDelayMs: 1000,
    runPolicy: { workTimeoutMs: 80 },
  });
  const { workId } = await call("submit", { text: "slow work" });
  const detail = await until(
    () =>
      runner.app.workRecord(workId).status === "blocked" &&
      runner.app.detail(workId),
  );
  assert.match(detail.work.error, /work-timeout/);
  assert.equal(detail.results.length, 0);
  assert.equal(files(profile, "artifacts").length, 0);
  assert.equal(detail.reports[0].status, "error");
});

test("a reception that ignores cancellation times out, releases its lane and cannot commit a late proposal", async (t) => {
  let runner, release;
  // Register before profileFor's deletion hook: an active runner may recreate
  // profile files during rm, and a failed deletion can skip its close hook.
  t.after(async () => {
    const profilePresent = existsSync(profile.path);
    const closing = runner?.close();
    release?.({ kind: "reply", text: "fixture closed" });
    await closing;
    assert.ok(profilePresent, "runner must stop before its profile is removed");
  });
  const profile = profileFor(t, { runPolicy: { modelTimeoutMs: 40 } });
  runner = await Runner.open(profile, {
    receptionModel: {
      async decide(input) {
        if (input.text === "hang")
          return new Promise((resolve) => {
            release = resolve;
          });
        return { kind: "reply", text: "next input accepted" };
      },
    },
  });
  runner.app.reception.accept("hanging", { text: "hang" });
  await until(() => runner.app.reception.turn("hanging").status === "blocked");
  release({ kind: "delegate", goal: "late unwanted job" });
  runner.app.reception.accept("next", { text: "next" });
  await until(() => runner.app.reception.turn("next").status === "settled");
  assert.equal(runner.app.status().works.length, 0);
  assert.match(
    runner.app.reception.turn("hanging").reply_text,
    /planning-timeout/,
  );
});

test("an already aborted one-shot request never enters a provider and has no unhandled rejection", async () => {
  const c = new AbortController();
  c.abort(new Error("stop"));
  let calls = 0;
  await assert.rejects(
    withRequestDeadline(
      () => {
        calls++;
      },
      c.signal,
      10,
    ),
    /stop/,
  );
  assert.equal(calls, 0);
});

test("actual model adapter forwards limits and records usage before JSON parsing, including malformed replies", async (t) => {
  const { app } = domain(t);
  let options;
  const model = new ReceptionModel(
    catalog(
      async (_model, _input, o) => {
        options = o;
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "not json" }],
          usage: counters(10),
        };
      },
      { modelTimeoutMs: 100, maxRetries: 0 },
    ),
    { recordUsage: (v) => app.usage.recordCall(v) },
  );
  await assert.rejects(
    model.decide({ text: "private wording" }, new AbortController().signal),
  );
  assert.equal(options.timeoutMs, 100);
  assert.equal(options.maxRetries, 0);
  const result = app.usage.read();
  assert.equal(result.items[0].usage.input, 10);
  assert.equal(result.items[0].outcome, "returned");
  assert.equal(JSON.stringify(result).includes("private wording"), false);
});

test("model failure and timeout are recorded as unknown counters rather than zero spend", async (t) => {
  const { app } = domain(t);
  const options = { recordUsage: (v) => app.usage.recordCall(v) };
  const fail = new ReceptionModel(
    catalog(async () => {
      throw new Error("provider quota exhausted");
    }),
    options,
  );
  await assert.rejects(
    fail.decide({}, new AbortController().signal),
    /quota exhausted/,
  );
  const slow = new ReceptionModel(
    catalog(async () => new Promise(() => {}), { modelTimeoutMs: 20 }),
    options,
  );
  // A referenced timer keeps this isolated no-I/O model test alive until its deadline.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      slow.decide({}, new AbortController().signal),
      /model-timeout/,
    );
  } finally {
    clearInterval(keepAlive);
  }
  const usage = app.usage.read();
  assert.equal(usage.items.length, 2);
  assert.deepEqual(
    new Set(usage.items.map((r) => r.outcome)),
    new Set(["error", "timeout"]),
  );
  assert.equal(usage.totalsByMode[0].knownTotals.totalTokens, null);
  assert.equal(usage.totalsByMode[0].unknownObservations.totalTokens, 2);
});

test("memory proposal and verification use the same bounded transport and separate observations", async (t) => {
  const { app } = domain(t);
  let calls = 0;
  const model = new MemoryLearningModel(
    catalog(async () => ({
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: ++calls === 1 ? '{"changes":[]}' : '{"approved":true}',
        },
      ],
      usage: counters(3),
    })),
    { recordUsage: (v) => app.usage.recordCall(v) },
  );
  await model.propose(
    { evidence: [], snapshot: {} },
    new AbortController().signal,
  );
  await model.verify(
    { evidence: [], snapshot: {}, proposal: { changes: [] } },
    new AbortController().signal,
  );
  assert.deepEqual(
    new Set(app.usage.read().items.map((r) => r.kind)),
    new Set(["memory-propose", "memory-verify"]),
  );
  assert.equal(app.usage.read().totalsByMode[0].knownTotals.totalTokens, 10);
});

test("Pi usage snapshots replace prior totals, separate fixture from model, and paginate independently of totals", (t) => {
  const { app } = domain(t),
    { workId } = app.works.submit("usage", { text: "work" });
  const snapshot = {
    models: { "faux/faux-1": counters(5), "controlled/real": counters(10) },
    tools: {},
  };
  app.usage.recordNative(workId, snapshot, "model");
  app.usage.recordNative(workId, snapshot, "model");
  snapshot.models["controlled/real"] = counters(20);
  app.usage.recordNative(workId, snapshot, "model");
  const result = app.usage.read({ workId, limit: 1 });
  assert.ok(result.next);
  assert.equal(result.items.length, 1);
  assert.equal(
    result.totalsByMode.find((g) => g.mode === "model").knownTotals.input,
    20,
  );
  assert.equal(
    result.totalsByMode.find((g) => g.mode === "fixture").knownTotals.input,
    5,
  );
  assert.equal(app.usage.read({ workId, after: result.next }).items.length, 1);
  assert.throws(() => app.usage.read({ workId: "foreign" }), /Unknown work/);
  assert.throws(() => app.usage.read({ limit: 101 }), /1..100/);
});

test("direct observation IDs deduplicate while omitted fields remain unknown", (t) => {
  const { app } = domain(t),
    record = {
      id: "one",
      kind: "reception",
      mode: "model",
      provider: "p",
      model: "m",
      usage: { input: 4 },
      outcome: "returned",
      elapsedMs: 5,
    };
  app.usage.recordCall(record);
  app.usage.recordCall(record);
  const value = app.usage.read();
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].usage.output, null);
  assert.equal(value.totalsByMode[0].knownTotals.input, 4);
  assert.equal(value.totalsByMode[0].unknownObservations.output, 1);
  assert.throws(
    () => app.dispatch({ op: "usage.record", params: record }),
    /Unknown operation/,
  );
});

test("read-only native usage neither resumes a suspended worker nor duplicates its native input", async (t) => {
  const profile = profileFor(t, { fixtureDelayMs: 500 });
  let runner = await Runner.open(profile);
  const { workId } = runner.app.works.submit("suspend", {
    text: "resume later",
  });
  await until(() => runner.app.detail(workId).executions[0].submission_id);
  await runner.close();
  const before = await nativeEntries(profile, workId);
  const catalog = await ModelCatalog.open(profile);
  const state = await readNativeUsage(
    join(profile.path, "executions", `${workId}.sqlite`),
    catalog.forExecution(`${workId}:r1`).models,
  );
  assert.ok(state.models);
  assert.equal(files(profile, "artifacts").length, 0);
  assert.equal((await nativeEntries(profile, workId)).length, before.length);
  runner = await Runner.open(profile);
  t.after(() => runner.close());
  await completed(profile, workId);
  assert.equal(
    (await nativeEntries(profile, workId)).filter(
      (e) => e.kind === "superapp.work-input",
    ).length,
    1,
  );
});

test("schema11 migrates without fabricating old usage or altering a fixed execution snapshot", (t) => {
  const profile = profileFor(t);
  let d = createLocalDomain(profile);
  const work = d.app.workRecord(
      d.app.works.submit("old", { text: "old" }).workId,
    ),
    snapshot = d.app.executions.snapshot(work);
  legacyMemoryFixture(profile, d.uow.db);
  d.uow.db.exec(
    "DROP TABLE IF EXISTS execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; DROP TABLE memory_tombstone; DROP TABLE memory_refresh; DROP TABLE memory_learning_control; ALTER TABLE memory_learning DROP COLUMN batch_ids_json; ALTER TABLE memory_learning DROP COLUMN temporal; ALTER TABLE memory_learning DROP COLUMN today; DROP TABLE memory_detail; ALTER TABLE routine DROP COLUMN schedule_json; ALTER TABLE routine DROP COLUMN last_scheduled_at; ALTER TABLE routine DROP COLUMN stop_when; DROP TABLE usage_observation; ALTER TABLE execution DROP COLUMN guard_json; PRAGMA user_version=11;",
  );
  d.uow.close();
  d = createLocalDomain(profile);
  t.after(() => d.uow.close());
  assert.equal(d.uow.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.deepEqual(
    d.app.executions.snapshot(d.app.workRecord(work.id)),
    snapshot,
  );
  assert.equal(d.app.usage.read().items.length, 0);
});

test("real CLI configures limits and queries persisted Pi counters without presenting fixture as billing", async (t) => {
  const outer = profileFor(t),
    path = join(outer.path, "cli");
  const init = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "bin/assistant.mjs",
        "init",
        "--profile",
        path,
        "--owner",
        "local:usage-cli",
        "--max-steps",
        "8",
        "--work-timeout-ms",
        "20000",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.equal(init.runPolicy.maxSteps, 8);
  const { loadProfile } = await import("../src/profile.mjs");
  const profile = loadProfile(path),
    child = await childRunner(t, profile);
  const cli = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["bin/assistant.mjs", ...args, "--profile", path],
        { cwd: root, encoding: "utf8", timeout: 5000 },
      ),
    ).result;
  const work = cli("submit", "--text", "note", "--id", "usage-cli");
  await completed(profile, work.workId);
  const usage = cli("usage", "--work", work.workId, "--limit", "1");
  assert.equal(usage.items[0].source, "pi.usage");
  assert.equal(usage.totalsByMode[0].mode, "fixture");
  assert.equal(
    cli("work", "--work", work.workId).executions[0].guard_json !== null,
    true,
  );
  await child.stop();
});

test("usage storage failure does not replace a successful model reply or repeat the request", async () => {
  let calls = 0,
    observed = 0;
  const model = new ReceptionModel(
    catalog(async () => {
      calls++;
      return {
        stopReason: "stop",
        content: [
          { type: "text", text: '{"kind":"reply","text":"actual reply"}' },
        ],
        usage: counters(3),
      };
    }),
    {
      recordUsage() {
        throw new Error("observation store unavailable");
      },
      onUsageError() {
        observed++;
      },
    },
  );
  assert.equal(
    (await model.decide({}, new AbortController().signal)).text,
    "actual reply",
  );
  assert.equal(calls, 1);
  assert.equal(observed, 1);
});

test("native usage survives restart and repeated post-restart snapshots do not inflate totals", async (t) => {
  const profile = profileFor(t);
  let runner = await Runner.open(profile);
  const { workId } = runner.app.works.submit("usage-reopen", {
    text: "one local note",
  });
  await until(() => runner.app.workRecord(workId).status === "completed");
  const before = runner.app.usage.read({ workId });
  assert.equal(before.items.length, 1);
  await runner.close();
  runner = await Runner.open(profile);
  t.after(() => runner.close());
  assert.deepEqual(
    runner.app.usage.read({ workId }).totalsByMode,
    before.totalsByMode,
  );
  const choice = (await ModelCatalog.open(profile)).forExecution(
    `${workId}:r1`,
  );
  const native = await readNativeUsage(
    join(profile.path, "executions", `${workId}.sqlite`),
    choice.models,
  );
  runner.app.usage.recordNative(workId, native, "fixture");
  runner.app.usage.recordNative(workId, native, "fixture");
  assert.deepEqual(
    runner.app.usage.read({ workId }).totalsByMode,
    before.totalsByMode,
  );
});

test("waiting for the user's answer does not keep the previous active-run timeout alive", async (t) => {
  const { runner, profile, call } = await running(t, {
    fixtureDelayMs: 0,
    runPolicy: { workTimeoutMs: 1000 },
  });
  const { workId } = await call("submit", { text: "先问我，再整理笔记" });
  const question = await until(() =>
    runner.app.interactions
      .list()
      .find((q) => q.work_id === workId && q.state === "pending"),
  );
  await until(() => runner.work.active.size === 0);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(runner.app.workRecord(workId).status, "waiting_input");
  assert.equal(runner.app.detail(workId).reports.length, 0);
  await call("interaction.answer", {
    interactionId: question.id,
    expectedRevision: 1,
    text: "本周进展",
  });
  await completed(profile, workId);
  assert.equal(
    runner.app.usage.read({ workId }).executions[0].control.lastRun.outcome,
    "returned",
  );
});

test("native quota failure retains the provider detail instead of showing only model_error", async (t) => {
  const { createModels, fauxProvider, fauxAssistantMessage } =
    await import("@earendil-works/pi-ai");
  const { PiExecutionAdapter } =
    await import("../src/adapters/pi/pi-execution-adapter.mjs");
  const { LocalArtifactStore } =
    await import("../src/adapters/filesystem/artifact-store.mjs");
  const { app, profile } = domain(t),
    models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "provider quota exhausted; retry after reset",
    }),
  ]);
  models.setProvider(faux.provider);
  profile.config.runPolicy.maxRetries = 0;
  const work = app.workRecord(
    app.works.submit("quota", { text: "task" }).workId,
  );
  const adapter = new PiExecutionAdapter({
    profile,
    ...createExecutionPorts(app),
    catalog: {
      forExecution: () => ({
        models,
        model: { provider: "faux", modelId: "faux-1" },
      }),
    },
    artifactStore: new LocalArtifactStore(join(profile.path, "artifacts")),
    knowledgeSource: null,
  });
  app.executions.started(work);
  await assert.rejects(
    adapter.run(work, new AbortController().signal),
    /provider quota exhausted/,
  );
  assert.equal(files(profile, "artifacts").length, 0);
  assert.equal(app.usage.read({ workId: work.id }).items[0].source, "pi.usage");
});

test("memory learning releases its slot on an uncooperative verification timeout and keeps the saved proposal", async () => {
  const { MemoryLearningCoordinator } =
    await import("../src/runtime/memory-learning-coordinator.mjs");
  let failed,
    proposed = 0;
  const job = {
    id: "learning",
    state: "proposed",
    proposal: { changes: [{ key: "k" }] },
    evidence: [],
    snapshot: {},
  };
  const service = {
    pending: () => [job],
    proposed() {
      proposed++;
    },
    failed(_id, error) {
      failed = error;
    },
    finish() {
      throw new Error("late verification must not commit");
    },
  };
  const coordinator = new MemoryLearningCoordinator(
    service,
    { verify: async () => new Promise(() => {}) },
    () => {},
    { timeoutMs: 20 },
  );
  coordinator.tick();
  await until(() => failed && !coordinator.task);
  assert.match(String(failed), /model-timeout/);
  assert.equal(proposed, 0);
  await coordinator.suspend();
});
