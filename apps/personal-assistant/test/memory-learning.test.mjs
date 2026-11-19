import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { MemoryLearningCoordinator } from "../src/runtime/memory-learning-coordinator.mjs";
import { profileFor, running, until, completed } from "./helpers.mjs";

function capture(app, id = "input", text = "I prefer concise answers") {
  app.reception.accept(id, { text });
  app.reception.apply(app.reception.turn(id), {
    kind: "reply",
    text: "Acknowledged",
  });
  return app.memoryLearning.get(`learning:${id}`);
}
const proposal = (job, key = "response", value = "concise") => ({
  changes: [{ key, value, evidenceIds: [job.evidence[0].id] }],
});

test("ordinary interaction automatically learns with canonical user evidence and independent review", async (t) => {
  const { runner, call } = await running(t);
  await call("say", { text: "顺便说一下，我喜欢简短回答" }, "preference");
  await until(
    () =>
      runner.app.memoryLearning.get("learning:preference")?.state ===
      "committed",
  );
  const job = runner.app.memoryLearning.get("learning:preference");
  const entry = runner.app.memory.list().find((m) => m.value === "简短回答");
  assert.equal(entry.value, "简短回答");
  assert.equal(
    job.proposal.changes[0].sourceEvidenceIds[0],
    runner.app.history.view().messages.find((m) => m.role === "user").id,
  );
  assert.equal(
    runner.app.memory.learningSnapshot().memories[0].origin,
    "automatic",
  );
  await call("say", { text: "顺便说一下，我喜欢简短回答" }, "preference");
  assert.equal(runner.app.memory.list()[0].revision, 1);
});

test("review rejection and invalid or assistant-only citations cannot mutate memory", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store,
    job = capture(app);
  assert.throws(
    () =>
      app.memoryLearning.proposed(job.id, {
        changes: [
          { key: "x", value: "invented", evidenceIds: [job.evidence[1].id] },
        ],
      }),
    /original user/,
  );
  assert.throws(
    () =>
      app.memoryLearning.proposed(job.id, {
        changes: [{ key: "x", value: "invented", evidenceIds: ["fake"] }],
      }),
    /original user/,
  );
  app.memoryLearning.proposed(job.id, proposal(job));
  assert.equal(
    app.memoryLearning.finish(job.id, { approved: "true" }).state,
    "rejected",
  );
  assert.deepEqual(app.memory.list(), []);
});

test("explicit and forgotten facts are protected; automatic facts can be corrected", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store;
  app.memory.change("explicit", "memory.set", {
    key: "city",
    value: "Shanghai",
    expectedRevision: 0,
  });
  let job = capture(app, "first");
  assert.throws(
    () => app.memoryLearning.proposed(job.id, proposal(job, "city", "Beijing")),
    /protected/,
  );
  app.memoryLearning.proposed(job.id, proposal(job));
  app.memoryLearning.finish(job.id, { approved: true });
  job = capture(app, "correction", "I now prefer detailed answers");
  app.memoryLearning.proposed(job.id, proposal(job, "response", "detailed"));
  app.memoryLearning.finish(job.id, { approved: true });
  assert.equal(app.memory.list().find((m) => m.key === "response").revision, 2);
  app.memory.change("forget", "memory.forget", {
    key: "response",
    expectedRevision: 2,
  });
  job = capture(app, "forgotten");
  assert.throws(
    () => app.memoryLearning.proposed(job.id, proposal(job)),
    /protected/,
  );
});

test("a newer explicit change invalidates the entire pending synthesis", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store,
    job = capture(app);
  app.memoryLearning.proposed(job.id, proposal(job));
  app.memory.change("newer", "memory.set", {
    key: "response",
    value: "user choice",
    expectedRevision: 0,
  });
  assert.equal(
    app.memoryLearning.finish(job.id, { approved: true }).state,
    "queued",
  );
  assert.equal(app.memory.list()[0].value, "user choice");
});

test("persisted proposal resumes with review only after reopening; committed job cannot apply twice", async (t) => {
  const profile = profileFor(t);
  let store = new Store(profile);
  let job = capture(store.app);
  store.app.memoryLearning.proposed(job.id, proposal(job));
  store.close();
  store = new Store(profile);
  t.after(() => store.close());
  let reviews = 0;
  const coordinator = new MemoryLearningCoordinator(store.app.memoryLearning, {
    async propose() {
      throw new Error("must not repeat proposal");
    },
    async verify(input) {
      reviews++;
      assert.equal(input.proposal.changes[0].value, "concise");
      return { approved: true };
    },
  });
  coordinator.tick();
  await coordinator.task;
  job = store.app.memoryLearning.get(job.id);
  assert.equal(job.state, "committed");
  assert.equal(reviews, 1);
  store.app.memoryLearning.finish(job.id, { approved: true });
  assert.equal(store.app.memory.list()[0].revision, 1);
});

test("batch write failure rolls back every memory, provenance, epoch and job status", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store,
    job = capture(app);
  const raw = proposal(job);
  raw.changes.push({
    key: "other",
    value: "fact",
    evidenceIds: [job.evidence[0].id],
  });
  app.memoryLearning.proposed(job.id, raw);
  const original = app.r.memories.save.bind(app.r.memories);
  let n = 0;
  app.r.memories.save = (m) => {
    if (++n === 2) throw new Error("injected write failure");
    original(m);
  };
  assert.throws(
    () => app.memoryLearning.finish(job.id, { approved: true }),
    /injected/,
  );
  assert.deepEqual(app.memory.list(), []);
  assert.equal(app.memory.epoch(), 0);
  assert.equal(app.r.memories.provenance("response"), undefined);
  assert.equal(app.memoryLearning.get(job.id).state, "proposed");
  app.r.memories.save = original;
  assert.equal(
    app.memoryLearning.finish(job.id, { approved: true }).state,
    "committed",
  );
  assert.equal(app.memory.list().length, 2);
});

test("review failures retain the same proposal and stop after three persisted attempts", async (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store,
    job = capture(app);
  let proposals = 0;
  const coordinator = new MemoryLearningCoordinator(app.memoryLearning, {
    async propose() {
      proposals++;
      return proposal(job);
    },
    async verify() {
      throw new Error("review unavailable");
    },
  });
  for (let i = 0; i < 3; i++) {
    app.memoryLearning.now = () => Date.now() + i * 10000;
    coordinator.tick();
    await coordinator.task;
  }
  assert.equal(proposals, 1);
  assert.equal(app.memoryLearning.get(job.id).state, "failed");
  assert.equal(app.memoryLearning.get(job.id).attempts, 3);
  assert.deepEqual(app.memory.list(), []);
});

test("queued learning rebases stale snapshots without discarding original evidence", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store;
  const first = capture(app, "first"),
    second = capture(app, "second", "I work in a small team");
  app.memoryLearning.proposed(first.id, proposal(first, "style", "concise"));
  app.memoryLearning.finish(first.id, { approved: true });
  app.memoryLearning.proposed(second.id, proposal(second, "team", "small"));
  const rebased = app.memoryLearning.finish(second.id, { approved: true });
  assert.equal(rebased.state, "queued");
  assert.equal(rebased.proposal, null);
  assert.equal(rebased.snapshot.epoch, 1);
  assert.deepEqual(rebased.evidence, second.evidence);
  app.memoryLearning.proposed(second.id, proposal(rebased, "team", "small"));
  assert.equal(
    app.memoryLearning.finish(second.id, { approved: true }).state,
    "committed",
  );
  assert.equal(app.memory.list().length, 2);
});

test("production memory adapter uses separate bounded proposal and review exchanges", async (t) => {
  const { MemoryLearningModel } = await import(
    "../src/adapters/models/memory-learning-model.mjs"
  );
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store,
    job = capture(app);
  const exchanges = [];
  const model = new MemoryLearningModel({
    configured: {
      mode: "model",
      model: { provider: "test", modelId: "test" },
      models: {
        getModel() {
          return { id: "test" };
        },
        async completeSimple(_model, input, options) {
          exchanges.push({ input, options });
          const data = JSON.parse(input.messages[0].content);
          const output =
            exchanges.length === 1
              ? {
                  changes: [
                    {
                      key: "style",
                      value: "concise",
                      evidenceIds: [data.newEvidence[0].id],
                    },
                  ],
                }
              : { approved: true };
          return {
            stopReason: "stop",
            content: [{ type: "text", text: JSON.stringify(output) }],
          };
        },
      },
    },
  });
  const coordinator = new MemoryLearningCoordinator(app.memoryLearning, model);
  coordinator.tick();
  await coordinator.task;
  assert.equal(app.memoryLearning.get(job.id).state, "committed");
  assert.equal(exchanges.length, 2);
  assert.notEqual(
    exchanges[0].input.systemPrompt,
    exchanges[1].input.systemPrompt,
  );
  assert.equal(
    JSON.parse(exchanges[1].input.messages[0].content).proposedChanges[0].value,
    "concise",
  );
  assert.equal(exchanges[0].options.maxTokens, 16384);
  assert.deepEqual(
    Object.keys(JSON.parse(exchanges[0].input.messages[0].content)).sort(),
    ["currentMemories", "memoryTarget", "newEvidence", "temporal", "today"],
  );
});

test("automatic learning does not abort an admitted work, but explicit edits still fence it", async (t) => {
  const { profile, runner, call } = await running(t, { fixtureDelayMs: 500 });
  const receipt = await call("submit", { text: "write an ordinary note" });
  await until(
    async () =>
      (await call("work", { workId: receipt.workId })).inputs[0]?.delivered_at,
  );
  const job = capture(runner.app, "learn-while-running");
  runner.app.memoryLearning.proposed(job.id, proposal(job));
  runner.app.memoryLearning.finish(job.id, { approved: true });
  await completed(profile, receipt.workId);
  assert.equal(runner.app.memory.guardEpoch(), 0);
  assert.equal(runner.app.memory.epoch(), 1);
});

test('model capacity defers queued and saved proposals durably without consuming semantic attempts',t=>{
  const store=new Store(profileFor(t));t.after(()=>store.close());const {app}=store,job=capture(app,'rate-limited'),retryAt=Date.now()+90000;
  app.memoryLearning.failed(job.id,Object.assign(new Error('safe model busy'),{modelFailure:{kind:'rate_limit',retryAt}}));
  let current=app.memoryLearning.get(job.id);assert.equal(current.attempts,0);assert.equal(current.state,'queued');assert.equal(current.next_at,retryAt);
  current=app.memoryLearning.proposed(job.id,proposal(current));const saved=current.proposal;
  app.memoryLearning.failed(job.id,Object.assign(new Error('safe model busy'),{modelFailure:{kind:'rate_limit',retryAt:retryAt+1000}}));
  current=app.memoryLearning.get(job.id);assert.equal(current.attempts,0);assert.equal(current.state,'proposed');assert.deepEqual(current.proposal,saved);assert.equal(current.next_at,retryAt+1000);
  app.memoryLearning.failed(job.id,Error('invalid content'));assert.equal(app.memoryLearning.get(job.id).attempts,1);
});
