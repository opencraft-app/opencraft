import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { legacyMemoryFixture } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { profileFor, running, until } from "./helpers.mjs";
import { MemorySynthesisPolicy, boundMemoryEvidence, memoryTombstoneId } from "../src/domain/memory-synthesis.mjs";
import { MemoryLearningCoordinator } from "../src/runtime/memory-learning-coordinator.mjs";

function capture(app, id = "input", text = "I now live in Shenzhen") {
  app.reception.accept(id, { text });
  app.reception.apply(app.reception.turn(id), {
    kind: "reply",
    text: "Understood",
  });
  return app.memoryLearning.get(`learning:${id}`);
}
function proposal(job, content = "Lives in Shenzhen", extra = {}) {
  return {
    changes: [
      {
        action: "create",
        content,
        kind: "profile",
        sourceEvidenceIds: [job.evidence[0].id],
        ...extra,
      },
    ],
  };
}
function commit(app, job, raw = proposal(job)) {
  app.memoryLearning.proposed(job.id, raw);
  return app.memoryLearning.finish(job.id, { approved: true });
}
function local(t, options = {}) {
  const s = new Store(profileFor(t, options));
  t.after(() => s.close());
  return s;
}

test("content normalization/dedup promotes an automatic fact to explicit without a second key", (t) => {
  const { app } = local(t);
  const job0 = capture(app);
  commit(app, job0, proposal(job0, "Lives  in\n Shenzhen"));
  const first = app.memory.list()[0];
  const saved = app.memory.change("explicit", "memory.set", {
    key: "other",
    value: "Lives in Shenzhen",
    expectedRevision: 0,
  });
  assert.equal(saved.key, first.key);
  assert.equal(app.memory.list().length, 1);
  assert.equal(app.memory.learningSnapshot().facts[0].origin, "explicit");
  const job = capture(app, "correction");
  assert.throws(
    () =>
      app.memoryLearning.proposed(
        job.id,
        proposal(job, "Lives elsewhere", {
          action: "update",
          id: app.memory.learningSnapshot().facts[0].id,
        }),
      ),
    /protected/,
  );
});

test("explicit forget protects normalized content across new keys and reopen; explicit re-add clears it", (t) => {
  const profile = profileFor(t);
  let s = new Store(profile);
  let job = capture(s.app);
  commit(s.app, job);
  const entry = s.app.memory.list()[0];
  s.app.memory.change("forget", "memory.forget", {
    key: entry.key,
    expectedRevision: entry.revision,
  });
  s.close();
  s = new Store(profile);
  t.after(() => s.close());
  job = capture(s.app, "resurrect");
  commit(s.app, job, proposal(job, "LIVES  IN\n SHENZHEN"));
  assert.deepEqual(s.app.memory.list(), []);
  // Compatibility protocol must not provide a back door via a new key.
  job = capture(s.app, "old-protocol");
  commit(s.app, job, {
    changes: [
      {
        key: "new-key",
        value: "Lives in Shenzhen",
        evidenceIds: [job.evidence[0].id],
      },
    ],
  });
  assert.deepEqual(s.app.memory.list(), []);
  s.app.memory.change("restore", "memory.set", {
    key: "restored",
    value: "Lives in Shenzhen",
    expectedRevision: 0,
  });
  assert.equal(s.app.memory.list().length, 1);
  assert.equal(s.app.r.memories.tombstoned(memoryTombstoneId("user", null, "Lives in Shenzhen")), false);
});

test("synthesis updates and removes obsolete facts; automatic removal does not become a user forget", (t) => {
  const { app } = local(t);
  let job = capture(app);
  commit(app, job);
  let fact = app.memory.learningSnapshot().facts[0];
  job = capture(app, "move", "I moved to Beijing");
  commit(
    app,
    job,
    proposal(job, "Lives in Beijing", {
      action: "update",
      id: fact.id,
      kind: "log",
    }),
  );
  fact = app.memory.learningSnapshot().facts[0];
  assert.equal(fact.content, "Lives in Beijing");
  assert.equal(fact.kind, "log");
  job = capture(app, "remove", "Please remove this outdated location");
  commit(app, job, {
    changes: [
      {
        action: "remove",
        id: fact.id,
        sourceEvidenceIds: [job.evidence[0].id],
      },
    ],
  });
  assert.deepEqual(app.memory.list(), []);
  job = capture(app, "again", "I live in Beijing");
  commit(app, job, proposal(job, "Lives in Beijing"));
  assert.equal(app.memory.list()[0].value, "Lives in Beijing");
});

test("legacy facts may be corrected by cited evidence while explicit entries remain immutable", (t) => {
  const { app, db: _db } = local(t);
  const dir = app.memory.files.locations().user;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.md"), "# User\n\n- (2026-11-01) Lives in Shanghai\n");
  const fact = app.memory.learningSnapshot().facts[0];
  assert.equal(fact.origin, "legacy");
  const job = capture(app);
  commit(app, job, proposal(job, "Lives in Shenzhen", { action: "update", id: fact.id }));
  assert.equal(app.memory.list()[0].value, "Lives in Shenzhen");
  assert.equal(app.memory.learningSnapshot().facts[0].origin, "synthesis");
});

test("a duplicate merge keeps the existing fact and retires only the superseded automatic fact", (t) => {
  const { app } = local(t);
  let job = capture(app);
  commit(app, job);
  job = capture(app, "additional");
  commit(app, job, proposal(job, "Lives in China"));
  const target = app.memory.learningSnapshot().facts.find((f) => f.content === "Lives in Shenzhen");
  job = capture(app, "merge");
  commit(app, job, proposal(job, "Lives in China", { action: "update", id: target.id }));
  assert.deepEqual(
    app.memory.list().map((m) => m.value),
    ["Lives in China"],
  );
});

test("real default debounce is 15 seconds; restart merges only the latest 12 exchanges and retains canonical history", (t) => {
  assert.equal(MemorySynthesisPolicy.defaults.debounceMs, 15000);
  const profile = profileFor(t, { memoryPolicy: { debounceMs: 15000 } });
  let s = new Store(profile),
    now = Date.now();
  s.app.memoryLearning.now = () => now;
  for (let i = 0; i < 14; i++) {
    capture(s.app, `e${i}`, `Fact ${i}`);
    now += 100;
  }
  assert.deepEqual(s.app.memoryLearning.pending(), []);
  assert.equal(s.app.memoryLearning.get("learning:e0").state, "dropped");
  s.close();
  s = new Store(profile);
  t.after(() => s.close());
  s.app.memoryLearning.now = () => now + 15000;
  const [batch] = s.app.memoryLearning.pending();
  assert.equal(batch.evidence.length, 24);
  assert.equal(batch.batchIds.length, 12);
  assert.equal(batch.evidence[0].text, "Fact 2");
  assert.equal(batch.evidence.at(-2).text, "Fact 13");
  assert.equal(s.app.memoryLearning.get("learning:e13").state, "merged");
  assert.equal(s.app.history.view({ limit: 100 }).messages.filter((m) => m.role === "user").length, 14);
});

test("evidence truncation preserves both ends; per-fact content is normalized and bounded to 500", (t) => {
  const { app } = local(t);
  const text = "HEAD" + "x".repeat(15000) + "TAIL";
  const job = capture(app, "long", text);
  assert.match(job.evidence[0].text, /^HEAD/);
  assert.match(job.evidence[0].text, /TAIL$/);
  assert.ok(job.evidence[0].text.length < 8100);
  commit(app, job, proposal(job, "A".repeat(800)));
  assert.equal(app.memory.list()[0].value.length, 500);
  assert.equal(boundMemoryEvidence(" small "), "small");
});

test("hourly polling queues a daily persisted clock review; clock-only create is rejected and the controlled update preserves uncertainty", (t) => {
  const { app } = local(t);
  let now = Date.UTC(2026, 10, 3);
  app.memoryLearning.now = app.memory.now = () => now;
  let job = capture(app);
  commit(app, job, proposal(job, "Plans to travel on November 3", { kind: "log" }));
  app.memoryLearning.queueTemporal();
  assert.equal(app.memoryLearning.pending().length, 0);
  now += 86400000;
  app.memoryLearning.queueTemporal();
  const [review] = app.memoryLearning.pending();
  assert.equal(review.temporal, 1);
  assert.equal(review.today, "2026-11-04");
  assert.throws(
    () =>
      app.memoryLearning.proposed(review.id, {
        changes: [
          {
            action: "create",
            content: "Travel happened",
            kind: "log",
            sourceEvidenceIds: ["clock"],
          },
        ],
      }),
    /Clock/,
  );
  const fact = review.snapshot.facts[0];
  commit(app, review, {
    changes: [
      {
        action: "update",
        id: fact.id,
        content: "Previously planned travel for November 3; completion unknown",
        kind: "log",
        sourceEvidenceIds: ["clock"],
      },
    ],
  });
  assert.match(app.memory.list()[0].value, /completion unknown/);
  app.memoryLearning.queueTemporal();
  assert.deepEqual(app.memoryLearning.pending(), []);
  now += 3600000;
  app.memoryLearning.queueTemporal();
  assert.deepEqual(app.memoryLearning.pending(), []);
  job = capture(app, "unprivileged-clock");
  assert.throws(
    () =>
      app.memoryLearning.proposed(job.id, {
        changes: [
          {
            action: "remove",
            id: app.memory.learningSnapshot().facts[0].id,
            sourceEvidenceIds: ["clock"],
          },
        ],
      }),
    /authorized clock/,
  );
});

test("fact IDs must come from the captured snapshot; one target can change at most once", (t) => {
  const { app } = local(t);
  let job = capture(app);
  commit(app, job);
  job = capture(app, "new");
  assert.throws(
    () => app.memoryLearning.proposed(job.id, proposal(job, "other", { action: "update", id: "unknown" })),
    /Unknown/,
  );
  const id = job.snapshot.facts[0].id,
    c = { action: "remove", id, sourceEvidenceIds: [job.evidence[0].id] };
  assert.throws(() => app.memoryLearning.proposed(job.id, { changes: [c, c] }), /Duplicate/);
  assert.throws(() => app.memoryLearning.proposed(job.id, { changes: Array(65).fill(c) }), /64/);
});

test("synthesis snapshot is capped at 512 and prioritizes explicit profile facts over dated legacy entries", (t) => {
  const { app, db } = local(t);
  const insert = db.prepare("INSERT INTO memory VALUES(?,?,1,?,0)");
  app.uow.transaction(() => {
    for (let i = 0; i < 520; i++) insert.run(`l${i}`, `Legacy ${i}`, "legacy");
  });
  app.memory.change("explicit", "memory.set", {
    key: "z-explicit",
    value: "Important explicit fact",
    expectedRevision: 0,
  });
  const snapshot = app.memory.learningSnapshot();
  assert.equal(snapshot.facts.length, 512);
  assert.equal(snapshot.facts[0].origin, "explicit");
  assert.equal(snapshot.facts[0].content, "Important explicit fact");
});

test("full synthesis batch and job settlement roll back together on a late write failure", (t) => {
  const { app } = local(t),
    job = capture(app);
  app.memoryLearning.proposed(job.id, {
    changes: [...proposal(job).changes, ...proposal(job, "Works in a small team").changes],
  });
  const save = app.r.memories.save.bind(app.r.memories);
  let calls = 0;
  app.r.memories.save = (m) => {
    if (++calls === 2) throw new Error("late write failure");
    save(m);
  };
  assert.throws(() => app.memoryLearning.finish(job.id, { approved: true }), /late write/);
  assert.deepEqual(app.memory.list(), []);
  assert.equal(app.memory.epoch(), 0);
  assert.equal(app.memoryLearning.get(job.id).state, "proposed");
  app.r.memories.save = save;
  assert.equal(app.memoryLearning.finish(job.id, { approved: true }).state, "committed");
});

test("the 90-second policy is a whole attempt deadline, including proposal plus review; late review cannot commit", async (t) => {
  assert.equal(MemorySynthesisPolicy.defaults.deadlineMs, 90000);
  const { app } = local(t),
    job = capture(app);
  let resolveReview;
  const coordinator = new MemoryLearningCoordinator(
    app.memoryLearning,
    {
      async propose() {
        await new Promise((r) => setTimeout(r, 25));
        return proposal(job);
      },
      verify() {
        return new Promise((r) => {
          resolveReview = r;
        });
      },
    },
    () => {},
    { timeoutMs: 60 },
  );
  const keepAlive = setTimeout(() => {}, 500);
  t.after(() => clearTimeout(keepAlive));
  coordinator.tick();
  await coordinator.task;
  assert.equal(app.memoryLearning.get(job.id).state, "proposed");
  assert.equal(app.memoryLearning.get(job.id).attempts, 1);
  resolveReview({ approved: true });
  await Promise.resolve();
  assert.deepEqual(app.memory.list(), []);
});

test("disabled synthesis does not capture or schedule model work", (t) => {
  const { app } = local(t, { memoryPolicy: { enabled: false } });
  assert.equal(capture(app), undefined);
  app.memoryLearning.queueTemporal();
  assert.deepEqual(app.memoryLearning.pending(), []);
});

test("profile/recent prompt is installed in real execution snapshots and reception context", async (t) => {
  const { runner, call } = await running(t);
  await call("memory.set", {
    key: "city",
    value: "Lives in Shenzhen",
    expectedRevision: 0,
  });
  await call("memory.set", {
    key: "travel",
    value: "Plans to travel November 3",
    kind: "log",
    expectedRevision: 0,
  });
  runner.app.reception.accept("query-context", {
    text: "What do you know about me?",
  });
  const context = runner.app.reception.context(runner.app.reception.turn("query-context"));
  assert.equal(context.memoryContext.profile[0].content, "Lives in Shenzhen");
  const memories = [...context.memoryContext.profile, ...context.memoryContext.recent, ...context.memoryRecall];
  assert.equal(memories.filter((m) => (m.content ?? m.value) === "Plans to travel November 3").length, 1);
  const work = await call("submit", { text: "write a useful note" });
  await until(() => runner.app.r.executions.list(work.workId)[0]?.context_json);
  const snapshot = JSON.parse(runner.app.r.executions.list(work.workId)[0].context_json);
  assert.equal(snapshot.memoryContext.profile[0].content, "Lives in Shenzhen");
  assert.equal(snapshot.memoryContext.semanticSearch, false);
});

test("rejected modern proposals retry a fresh proposal at most three times and never write", (t) => {
  const { app } = local(t);
  let job = capture(app);
  let now = Date.now();
  app.memoryLearning.now = () => now;
  for (let i = 0; i < 3; i++) {
    app.memoryLearning.proposed(job.id, proposal(job));
    job = app.memoryLearning.finish(job.id, { approved: false });
    if (i < 2) {
      assert.equal(job.state, "queued");
      assert.deepEqual(app.memoryLearning.pending(), []);
      now += 10000;
    }
  }
  assert.equal(job.state, "rejected");
  assert.deepEqual(app.memory.list(), []);
});

test("a modern persisted proposal reopens at verification, and a newer explicit edit fences the whole batch", async (t) => {
  const profile = profileFor(t);
  let s = new Store(profile);
  const job = capture(s.app);
  s.app.memoryLearning.proposed(job.id, proposal(job));
  s.close();
  s = new Store(profile);
  t.after(() => s.close());
  let reviews = 0;
  s.app.memory.change("new-user", "memory.set", {
    key: "city",
    value: "Lives in Beijing",
    expectedRevision: 0,
  });
  const coordinator = new MemoryLearningCoordinator(s.app.memoryLearning, {
    propose() {
      throw new Error("persisted proposal must be reused");
    },
    async verify() {
      reviews++;
      return { approved: true };
    },
  });
  coordinator.tick();
  await coordinator.task;
  assert.equal(reviews, 1);
  assert.equal(s.app.memoryLearning.get(job.id).state, "queued");
  assert.deepEqual(
    s.app.memory.list().map((m) => m.value),
    ["Lives in Beijing"],
  );
});

test("large user/project-style memory context stays within the reception byte bound with truthful truncation", (t) => {
  const { app } = local(t);
  for (let i = 0; i < 70; i++)
    app.memory.change(`fact${i}`, "memory.set", {
      key: `k${i}`,
      value: `${i}：` + "事实".repeat(248),
      expectedRevision: 0,
    });
  app.reception.accept("large-context", { text: "请结合我的背景回答" });
  const context = app.reception.context(app.reception.turn("large-context"));
  assert.ok(new TextEncoder().encode(JSON.stringify(context)).length <= 128000);
  assert.ok(context.memoryContext.profile.length <= 50);
  assert.equal(context.memoryContext.truncated, true);
});

test("note writes use dated memory with the Grok-style Note prefix", (t) => {
  const { app } = local(t);
  app.memory.change("note", "memory.set", {
    key: "reminder",
    kind: "note",
    value: "Discuss the timeline",
    expectedRevision: 0,
  });
  const m = app.memory.list()[0];
  assert.equal(m.kind, "log");
  assert.equal(m.value, "Note: Discuss the timeline");
});

test("schema13 upgrade preserves explicit provenance, original dates and queued legacy proposals", (t) => {
  const profile = profileFor(t);
  let s = new Store(profile);
  s.app.memory.change("old-explicit", "memory.set", {
    key: "city",
    value: "Lives in Shanghai",
    expectedRevision: 0,
  });
  const before = s.app.memory.list()[0],
    job = capture(s.app);
  s.app.memoryLearning.proposed(job.id, {
    changes: [
      {
        key: "preference",
        value: "Concise answers",
        evidenceIds: [job.evidence[0].id],
      },
    ],
  });
  legacyMemoryFixture(profile, s.db);
  s.db.exec(
    "DROP TABLE IF EXISTS execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; DROP TABLE memory_tombstone; DROP TABLE memory_refresh; DROP TABLE memory_learning_control; ALTER TABLE memory_learning DROP COLUMN batch_ids_json; ALTER TABLE memory_learning DROP COLUMN temporal; ALTER TABLE memory_learning DROP COLUMN today; PRAGMA user_version=13;",
  );
  s.close();
  s = new Store(profile);
  t.after(() => s.close());
  assert.equal(s.db.prepare("PRAGMA user_version").get().user_version, 21);
  assert.equal(s.app.memory.list()[0].updatedAt, before.updatedAt);
  assert.equal(s.app.memory.learningSnapshot().facts[0].origin, "explicit");
  assert.equal(s.app.memoryLearning.get(job.id).state, "proposed");
  assert.equal(s.app.memoryLearning.finish(job.id, { approved: true }).state, "committed");
});

test("imported memories without a refresh marker are immediately eligible for a temporal review", (t) => {
  const { app } = local(t);
  app.memory.change("explicit", "memory.set", {
    key: "plan",
    value: "Plans for November 3",
    expectedRevision: 0,
  });
  app.memoryLearning.queueTemporal();
  const [job] = app.memoryLearning.pending();
  assert.equal(job.temporal, 1);
  assert.deepEqual(job.evidence, []);
  app.memoryLearning.proposed(job.id, { changes: [] });
  assert.equal(app.memoryLearning.finish(job.id, { approved: true }).state, "no-change");
  assert.equal(app.memory.reviewDue(null), false);
});

test("updating an obsolete automatic fact toward forgotten content retires the old fact without restoring the forgotten fact", (t) => {
  const { app } = local(t);
  app.memory.change("explicit", "memory.set", {
    key: "private",
    value: "Lives in Shenzhen",
    expectedRevision: 0,
  });
  app.memory.change("forget", "memory.forget", {
    key: "private",
    expectedRevision: 1,
  });
  let job = capture(app);
  commit(app, job, proposal(job, "Lives in Shanghai"));
  const target = app.memory.learningSnapshot().facts[0];
  job = capture(app, "update");
  commit(app, job, proposal(job, "Lives in Shenzhen", { action: "update", id: target.id }));
  assert.deepEqual(app.memory.list(), []);
});

test("large pre-migration facts cannot make every future synthesis skip due to an oversized compatibility view", (t) => {
  const { app, db: _db } = local(t);
  const dir = app.memory.files.locations().user;
  mkdirSync(dir, { recursive: true });
  const raw = Array.from({ length: 280 }, (_, i) => `- (2026-11-01) ${i}:` + "x".repeat(19000)).join("\n") + "\n";
  writeFileSync(join(dir, "profile.md"), raw);
  const job = capture(app);
  assert.equal(job.state, "queued");
  assert.equal(job.snapshot.facts.length, 280);
  assert.ok(job.snapshot.memories.every((m) => m.value.length === 500));
  assert.equal(readFileSync(join(dir, "profile.md"), "utf8"), raw);
  assert.equal(app.memory.list()[0].value.length, 500);
});

test("explicit keyed correction protects the replaced content from cross-key automatic reintroduction", (t) => {
  const { app } = local(t);
  app.memory.change("old", "memory.set", {
    key: "city",
    value: "Lives in Shanghai",
    expectedRevision: 0,
  });
  app.memory.change("correct", "memory.set", {
    key: "city",
    value: "Lives in Shenzhen",
    expectedRevision: 1,
  });
  const job = capture(app, "old-evidence", "I live in Shanghai");
  commit(app, job, proposal(job, "Lives in Shanghai"));
  assert.deepEqual(
    app.memory.list().map((m) => m.value),
    ["Lives in Shenzhen"],
  );
});
