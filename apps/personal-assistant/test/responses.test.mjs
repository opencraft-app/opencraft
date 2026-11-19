import test from "node:test";
import assert from "node:assert/strict";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { Runner } from "../src/runner.mjs";
import { profileFor, until } from "./helpers.mjs";

const notices = (app, kind) => app.history.view().messages.filter((m) => m.data.kind === kind);

test("reception activity is a durable projection, never a chat acknowledgement", (t) => {
  const profile = profileFor(t);
  let domain = createLocalDomain(profile);
  domain.app.reception.accept("one", { text: "hello" });
  domain.app.reception.accept("two", { text: "next" });
  assert.deepEqual(domain.app.status().reception, { queued: 2, running: 0 });
  domain.app.reception.started("one");
  assert.deepEqual(domain.app.status().reception, { queued: 1, running: 1 });
  domain.uow.close();
  domain = createLocalDomain(profile);
  t.after(() => domain.uow.close());
  assert.deepEqual(domain.app.status().reception, { queued: 1, running: 1 });
  domain.app.reception.apply(domain.app.reception.turn("one"), {
    kind: "reply",
    text: "answer",
  });
  domain.app.reception.failed(domain.app.reception.turn("two"), new Error("private provider details"));
  assert.deepEqual(domain.app.status().reception, { queued: 0, running: 0 });
  assert.equal(notices(domain.app, "acknowledgement").length, 0);
  assert.equal(notices(domain.app, "reception-error").length, 1);
  assert.doesNotMatch(notices(domain.app, "reception-error")[0].text, /private provider/);
});

test("progress is scoped, once per revision, durable, and cannot complete work", (t) => {
  const profile = profileFor(t);
  let domain = createLocalDomain(profile);
  let { app } = domain;
  const { workId } = app.works.submit("work", { text: "write a note" });
  app.history.link(app.history.main.id, workId);
  let work = app.workRecord(workId);
  app.executions.started(work);
  app.executions.reportProgress();
  assert.equal(notices(app, "progress").length, 0);
  app.executions.now = () => Date.now() + 31000;
  app.executions.reportProgress();
  assert.equal(notices(app, "progress").length, 1);
  assert.equal(app.detail(workId).results.length, 0);
  assert.equal(app.workRecord(workId).status, "running");
  domain.uow.close();
  domain = createLocalDomain(profile);
  t.after(() => domain.uow.close());
  app = domain.app;
  app.executions.now = () => Date.now() + 31000;
  app.executions.reportProgress();
  assert.equal(notices(app, "progress").length, 1);
  app.works.amend("revise", {
    workId,
    text: "revised note",
    expectedRevision: 1,
  });
  work = app.workRecord(workId);
  app.executions.now = Date.now;
  app.executions.started(work);
  app.executions.now = () => Date.now() + 31000;
  app.executions.reportProgress();
  assert.equal(notices(app, "progress").length, 2);
});

test("execution failure notifies once, omits raw error and ignores stale failures", (t) => {
  const { app, uow } = createLocalDomain(profileFor(t));
  t.after(() => uow.close());
  const { workId } = app.works.submit("work", { text: "write" });
  app.history.link(app.history.main.id, workId);
  const old = app.workRecord(workId);
  app.works.amend("amend", { workId, expectedRevision: 1, text: "new" });
  app.executions.blocked(old, new Error("stale"));
  assert.equal(notices(app, "execution-blocked").length, 0);
  const current = app.workRecord(workId);
  app.executions.blocked(current, new Error("private diagnostic"));
  app.executions.blocked(current, new Error("second diagnostic"));
  const [message] = notices(app, "execution-blocked");
  assert.equal(notices(app, "execution-blocked").length, 1);
  assert.doesNotMatch(message.text, /private diagnostic|second diagnostic/);
  assert.equal(app.workRecord(workId).status, "blocked");
  app.executions.reportProgress();
  assert.equal(notices(app, "progress").length, 0);
});

test("routine and unlinked work never inject progress or failure into main chat", (t) => {
  const { app, uow } = createLocalDomain(profileFor(t));
  t.after(() => uow.close());
  const { workId } = app.works.submit("direct", {
    text: "private direct work",
  });
  app.executions.blocked(app.workRecord(workId), new Error("failed"));
  app.routines.add("routine", {
    text: "daily note",
    startAt: Date.now() - 1,
    intervalMs: 1000,
    maxRuns: 1,
  });
  app.routines.tick();
  const routine = app.status().works.find((w) => w.source === "routine");
  // Even accidental linking cannot turn routine progress into unsolicited chat.
  app.history.link(app.history.main.id, routine.id);
  app.executions.started(routine);
  app.executions.now = () => Date.now() + 31000;
  app.executions.reportProgress();
  app.executions.blocked(routine, new Error("failed"));
  assert.equal(app.history.view().messages.length, 0);
});

test("runtime projects a slow model without writing a message and later sends its answer", async (t) => {
  const profile = profileFor(t);
  let release;
  const runner = await Runner.open(profile, {
    receptionModel: {
      decide() {
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  t.after(() => runner.close());
  runner.app.reception.accept("pending-model", { text: "hello" });
  runner.app.reception.now = () => Date.now() + 6000;
  await until(() => release && runner.app.status().reception.running === 1);
  assert.equal(notices(runner.app, "acknowledgement").length, 0);
  release({ kind: "reply", text: "actual answer" });
  await until(() => runner.app.reception.turn("pending-model").status === "settled");
  assert.equal(runner.app.history.view().messages.at(-1).text, "actual answer");
  assert.equal(notices(runner.app, "acknowledgement").length, 0);
  assert.deepEqual(runner.app.status().reception, { queued: 0, running: 0 });
});

test("failure state and its notification commit atomically", (t) => {
  const { app, uow } = createLocalDomain(profileFor(t));
  t.after(() => uow.close());
  const { workId } = app.works.submit("atomic", { text: "write" });
  app.history.link(app.history.main.id, workId);
  const work = app.workRecord(workId);
  app.executions.started(work);
  const original = app.history.workNotice.bind(app.history);
  app.history.workNotice = () => {
    throw new Error("history unavailable");
  };
  assert.throws(() => app.executions.blocked(work, new Error("execution failed")), /history unavailable/);
  assert.equal(app.workRecord(workId).status, "running");
  assert.equal(app.executions.execution(work).status, "running");
  app.history.workNotice = original;
  app.executions.blocked(work, new Error("execution failed"));
  assert.equal(app.workRecord(workId).status, "blocked");
  assert.equal(notices(app, "execution-blocked").length, 1);
});

test("six queued inputs keep FIFO, expose one running turn, and never produce six fake replies", async (t) => {
  const calls = [];
  const runner = await Runner.open(profileFor(t), {
    receptionModel: {
      decide(input) {
        return new Promise((resolve, reject) => calls.push({ text: input.text, resolve, reject }));
      },
    },
  });
  t.after(() => runner.close());
  for (let i = 0; i < 6; i++) runner.app.reception.accept("input-" + i, { text: "message " + i });
  runner.app.reception.now = () => Date.now() + 6000;
  for (let i = 0; i < 6; i++) {
    await until(() => calls.length === i + 1);
    assert.equal(calls[i].text, "message " + i);
    assert.deepEqual(runner.app.status().reception, { queued: 5 - i, running: 1 });
    assert.equal(notices(runner.app, "acknowledgement").length, 0);
    if (i === 1 || i === 2) calls[i].reject(new Error("private-native-failure"));
    else calls[i].resolve({ kind: "reply", text: "answer " + i });
    await until(() => ["blocked", "settled"].includes(runner.app.reception.turn("input-" + i).status));
  }
  assert.deepEqual(runner.app.status().reception, { queued: 0, running: 0 });
  assert.equal(notices(runner.app, "reply").length, 4);
  assert.equal(notices(runner.app, "reception-error").length, 2);
  assert.equal(runner.app.history.view().messages.filter((m) => m.role === "assistant").length, 6);
});
