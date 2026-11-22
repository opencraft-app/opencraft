import { PassThrough } from "node:stream";
import { createStdioPeer } from "../src/adapters/local/stdio-peer.mjs";
import {
  parseThreadCommand,
  replaceThreadCommandIdempotencyKey,
} from "@opencraft/appserver-protocol/thread-command";
import test from "node:test";
import assert from "node:assert/strict";
import { profileFor } from "./helpers.mjs";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { ThreadCompletionCoordinator } from "../src/runtime/thread-completion-coordinator.mjs";
import { WorkCoordinator } from "../src/runtime/work-coordinator.mjs";
import { createExecutionPorts } from "../src/runtime/execution-ports.mjs";
const prepare = (app, work, argv) =>
  app.executions.threads.prepare(work, parseThreadCommand(argv), argv);
const resource = { id: "platform.threads", binding: "fixed-bot-epoch" };
const argv = (key) => [
  "thread",
  "start",
  "--profile",
  "default",
  "--prompt",
  "Do the task",
  "--idempotency-key",
  key,
];
function fixture(t) {
  const profile = profileFor(t),
    ctx = createLocalDomain(profile, null, { platformThreads: resource });
  let current = ctx;
  t.after(() => current.uow.close());
  const app = ctx.app;
  app.reception.accept("request", {
    text: "Create a task and tell me when finished",
  });
  app.reception.apply(app.reception.turn("request"), {
    kind: "delegate",
    goal: "Do the task",
    completion: { output: "text" },
  });
  const work = app.workRecord(app.reception.turn("request").work_id);
  function link(key = "first") {
    const row = prepare(app, work, argv(key));
    app.executions.threads.accepted(work, row, {
      operationId: "op-" + key,
      workId: work.id,
      state: "submitted",
    });
    return row;
  }
  return {
    profile,
    app,
    work,
    link,
    get uow() {
      return current.uow;
    },
    reopen() {
      current.uow.close();
      current = createLocalDomain(profile, null, { platformThreads: resource });
      return current;
    },
  };
}
const turns = (app) => app.reception.pending().filter((t) => t.source_json);
const completion = (
  work,
  id = "first",
  status = "completed",
  text = "REAL NATIVE RESULT",
  turnId = "native-turn",
) => ({
  operationId: "op-" + id,
  workId: work.id,
  state: "submitted",
  reference: "opencraft://server/thread/shared",
  input: {
    deliveryState: "injected",
    targetTurnId: "native-turn",
    completion: { version: 1, turnId, status, text },
  },
});
function coordinator(
  app,
  command,
  onError = (error) => {
    throw error;
  },
) {
  return new ThreadCompletionCoordinator({
    app,
    command,
    assertOwner() {},
    onError,
    settle: (...args) => app.executions.report(...args),
  });
}

test("submission cannot complete Work; correlated terminal result wakes the original assistant once", async (t) => {
  const f = fixture(t);
  f.link();
  assert.equal(f.app.executions.report(f.work, "Task submitted").held, true);
  assert.equal(turns(f.app).length, 0);
  assert.equal(f.app.executions.savedReport(f.work), undefined);
  const c = coordinator(f.app, async (args, workId) => {
    assert.deepEqual(args, ["thread", "operation", "show", "op-first"]);
    assert.equal(workId, f.work.id);
    return completion(f.work);
  });
  await c.reconcile(new AbortController().signal);
  assert.equal(turns(f.app).length, 1);
  assert.match(f.app.executions.savedReport(f.work).text, /REAL NATIVE RESULT/);
  assert.equal(f.app.workRecord(f.work.id).status, "awaiting_review");
  await c.reconcile(new AbortController().signal);
  assert.equal(turns(f.app).length, 1);
  const turn = turns(f.app)[0];
  assert.equal(
    f.app.reception.context(turn).request.original.text,
    "Create a task and tell me when finished",
  );
  f.app.reception.apply(turn, {
    kind: "deliver",
    text: "Finished with native evidence",
  });
  const delivery = f.app.outcomes.pending()[0];
  assert.equal(f.app.workRecord(f.work.id).status, "awaiting_delivery");
  f.app.outcomes.accepted(delivery);
  assert.equal(f.app.workRecord(f.work.id).status, "completed");
});

test("restart keeps held answer and frees model capacity without repeating its execution", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Provisional answer");
  const { app } = f.reopen();
  let runs = 0;
  const work = new WorkCoordinator({
    app,
    executor: {
      async run() {
        runs++;
        return "must not run";
      },
    },
    concurrency: 1,
  });
  work.tick();
  assert.equal(runs, 0);
  assert.equal(work.active.size, 0);
  await coordinator(app, async () => completion(f.work)).reconcile(
    new AbortController().signal,
  );
  assert.equal(turns(app).length, 1);
  assert.equal(runs, 0);
});

test("native completion before model answer is retained and used when the answer arrives", async (t) => {
  const f = fixture(t);
  f.link();
  await coordinator(f.app, async () => completion(f.work)).reconcile(
    new AbortController().signal,
  );
  assert.equal(turns(f.app).length, 0);
  assert.equal(f.app.executions.report(f.work, "Queued it").routed, true);
  assert.equal(turns(f.app).length, 1);
});

test("unknown delivery and another Turn cannot fabricate completion", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Queued it");
  let errors = 0;
  await coordinator(f.app, async () => ({
    ...completion(f.work),
    input: { deliveryState: "unknown" },
  })).reconcile(new AbortController().signal);
  assert.equal(turns(f.app).length, 0);
  await coordinator(
    f.app,
    async () =>
      completion(f.work, "first", "completed", "unrelated", "another-turn"),
    () => errors++,
  ).reconcile(new AbortController().signal);
  assert.equal(errors, 1);
  assert.equal(turns(f.app).length, 0);
});

test("native failure reaches parent review but can never be delivered as successful completion", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Queued");
  await coordinator(f.app, async () =>
    completion(f.work, "first", "failed", "Native task failed"),
  ).reconcile(new AbortController().signal);
  const turn = turns(f.app)[0];
  assert.ok(turn);
  assert.equal(f.app.executions.savedReport(f.work).status, "error");
  assert.throws(
    () => f.app.reception.apply(turn, { kind: "deliver", text: "Success" }),
    /satisf|returned|contract/i,
  );
  assert.equal(f.app.detail(f.work.id).results.length, 0);
  f.app.reception.apply(turn, {
    kind: "blocked",
    text: "The native task failed; intervention is needed",
  });
  assert.equal(f.app.workRecord(f.work.id).status, "blocked");
});

test("lost acceptance reply replays the same durable idempotent intent after restart", async (t) => {
  const f = fixture(t);
  prepare(f.app, f.work, argv("stable"));
  f.app.executions.report(f.work, "Submitting");
  const { app } = f.reopen(),
    calls = [];
  const c = coordinator(app, async (args) => {
    calls.push(args);
    if (args[1] === "start")
      return {
        operationId: "op-stable",
        workId: f.work.id,
        state: "submitted",
      };
    return completion(f.work, "stable");
  });
  await c.reconcile(new AbortController().signal);
  assert.deepEqual(
    calls[0],
    app.executions.threads.argv(app.executions.threads.pending()[0]),
  );
  assert.notEqual(calls[0].at(-1), "stable");
  assert.equal(turns(app).length, 0);
  await c.reconcile(new AbortController().signal);
  assert.equal(turns(app).length, 1);
  assert.equal(calls.filter((a) => a[1] === "start").length, 1);
});

test("multiple inputs wait for all receipts but same-Turn evidence appears once", async (t) => {
  const f = fixture(t);
  f.link("first");
  f.link("second");
  f.app.executions.report(f.work, "Both submitted");
  let second = false;
  const c = coordinator(f.app, async (args) =>
    args[3] === "op-second" && !second
      ? { operationId: "op-second", workId: f.work.id, state: "submitted" }
      : completion(f.work, args[3].slice(3)),
  );
  await c.reconcile(new AbortController().signal);
  assert.equal(turns(f.app).length, 0);
  second = true;
  await c.reconcile(new AbortController().signal);
  assert.equal(turns(f.app).length, 1);
  assert.equal(
    f.app.executions.savedReport(f.work).text.match(/REAL NATIVE RESULT/g)
      .length,
    1,
  );
});

test("cancelled or superseded Work does not consume a late task result", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Queued");
  f.app.works.cancel("cancel", { workId: f.work.id });
  let calls = 0;
  await coordinator(f.app, async () => {
    calls++;
    return completion(f.work);
  }).reconcile(new AbortController().signal);
  assert.equal(calls, 0);
  assert.equal(turns(f.app).length, 0);
});

test("revoke during observation is rechecked and prevents a stale commit", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Queued");
  let errors = 0;
  const c = coordinator(
    f.app,
    async () => {
      f.app.works.cancel("cancel", { workId: f.work.id });
      return completion(f.work);
    },
    () => errors++,
  );
  await c.reconcile(new AbortController().signal);
  assert.equal(turns(f.app).length, 0);
  assert.equal(errors, 0);
});

test("Core authority denial reports unknown outcome without replacement task", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Queued");
  let calls = 0;
  await coordinator(f.app, async () => {
    calls++;
    throw Object.assign(Error("assistant_thread_grant_revoked"), {
      status: 403,
    });
  }).reconcile(new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(turns(f.app).length, 1);
  assert.match(f.app.executions.savedReport(f.work).text, /no replacement/i);
  assert.equal(f.app.executions.savedReport(f.work).status, "error");
});

test("bounded reconciliation advances beyond the first batch of running tasks", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) f.link("n" + i);
  f.app.executions.report(f.work, "Queued");
  const seen = new Set();
  const c = coordinator(f.app, async (args) => {
    seen.add(args[3]);
    return { operationId: args[3], workId: f.work.id, state: "submitted" };
  });
  await c.reconcile(new AbortController().signal);
  await c.reconcile(new AbortController().signal);
  assert.equal(seen.size, 10);
  assert.equal(turns(f.app).length, 0);
});

test("real model tool persists intent before I/O and preserves immutable operation identity", async (t) => {
  const f = fixture(t),
    snapshot = f.app.executions.snapshot(f.work);
  let inspected = false;
  const ports = createExecutionPorts(
    f.app,
    () => {},
    async (args, workId) => {
      assert.equal(f.app.executions.threads.pending().length, 1);
      inspected = true;
      return { operationId: "op-first", workId, state: "submitted" };
    },
  ).toolsFor(f.work, snapshot);
  await ports.threadCommand(argv("first"));
  assert.ok(inspected);
  assert.equal(f.app.executions.threads.pending()[0].operation_id, "op-first");
  await assert.rejects(
    ports.threadCommand([
      ...argv("first").slice(0, -4),
      "different",
      "--idempotency-key",
      "first",
    ]),
    /identity|intent|argument/,
  );
});

test("settled platform report replays do not create another report or parent wake", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Queued");
  await coordinator(f.app, async () => completion(f.work)).reconcile(
    new AbortController().signal,
  );
  assert.equal(f.app.executions.report(f.work, "Queued").duplicate, true);
  const report = f.app.executions.savedReport(f.work);
  assert.equal(
    f.app.executions.report(f.work, report.text, report.error).duplicate,
    true,
  );
  assert.equal(turns(f.app).length, 1);
});

test("schema20 upgrade preserves old data and creates only Execution-owned relationship records", (t) => {
  const f = fixture(t),
    before = f.app.workRecord(f.work.id);
  f.uow.db.exec(
    "DROP TABLE work_operation; DROP TABLE execution_thread_answer; DROP TABLE execution_thread_link; PRAGMA user_version=20;",
  );
  const { app, uow } = f.reopen();
  assert.equal(uow.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.deepEqual(app.workRecord(f.work.id), before);
  assert.equal(uow.db.prepare("pragma quick_check").get().quick_check, "ok");
  assert.deepEqual(uow.db.prepare("pragma foreign_key_check").all(), []);
  assert.deepEqual(app.executions.threads.pending(), []);
});

test("known submission refusal and cancelled input cannot hold a Work forever", async (t) => {
  for (const kind of ["refused", "cancelled"]) {
    const f = fixture(t);
    f.link();
    f.app.executions.report(f.work, "Submitted");
    const c = coordinator(f.app, async () => {
      if (kind === "refused")
        throw Object.assign(Error("assistant_thread_turn_changed"), {
          status: 409,
        });
      return {
        operationId: "op-first",
        workId: f.work.id,
        state: "submitted",
        input: { deliveryState: "cancelled" },
      };
    });
    await c.reconcile(new AbortController().signal);
    assert.equal(turns(f.app).length, 1);
    assert.equal(f.app.executions.savedReport(f.work).status, "error");
  }
});

test("unlinked native failure blocks rather than delivering the provisional acceptance note", async (t) => {
  const f = fixture(t);
  const workId = f.app.works.submit("unlinked", {
      text: "Do task",
      completion: { output: "text" },
    }).workId,
    work = f.app.workRecord(workId);
  const link = prepare(f.app, work, argv("unlinked"));
  f.app.executions.threads.accepted(work, link, {
    operationId: "op-unlinked",
    workId,
    state: "submitted",
  });
  f.app.executions.report(work, "Task submitted");
  const owner = new WorkCoordinator({
    app: f.app,
    executor: {},
    concurrency: 1,
  });
  const c = new ThreadCompletionCoordinator({
    app: f.app,
    assertOwner() {},
    command: async () =>
      completion(work, "unlinked", "failed", "Native failure"),
    settle: (...args) => owner.settleReport(...args),
    onError: (e) => {
      throw e;
    },
  });
  await c.reconcile(new AbortController().signal);
  assert.equal(f.app.workRecord(workId).status, "blocked");
  assert.equal(f.app.detail(workId).results.length, 0);
  assert.equal(f.app.outcomes.pending().length, 0);
});

test("same model key in different immutable executions has distinct wire identity", (t) => {
  const f = fixture(t),
    one = prepare(f.app, f.work, argv("same"));
  const secondId = f.app.works.submit("second", { text: "Other task" }).workId,
    second = f.app.workRecord(secondId),
    two = prepare(f.app, second, argv("same"));
  assert.notEqual(
    f.app.executions.threads.argv(one).at(-1),
    f.app.executions.threads.argv(two).at(-1),
  );
  assert.deepEqual(
    f.app.executions.threads.argv(one),
    f.app.executions.threads.argv(one),
  );
});

test("close releases observation that ignores cancellation; late reply cannot publish a result", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Queued");
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const c = coordinator(f.app, () => held);
  c.tick();
  await new Promise(setImmediate);
  await Promise.race([
    c.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("close hung")), 1000),
    ),
  ]);
  release(completion(f.work));
  await new Promise(setImmediate);
  assert.equal(turns(f.app).length, 0);
  assert.equal(f.app.executions.threads.pending().length, 1);
});

test("ready-report cursor skips paused work instead of starving the next runnable report", async (t) => {
  const f = fixture(t),
    paused = new Set();
  let runnable;
  f.uow.transaction(() => {
    for (let i = 0; i < 65; i++) {
      const workId = f.app.works.submit("many-" + i, {
          text: "Task " + i,
          completion: { output: "text" },
        }).workId,
        work = f.app.workRecord(workId),
        link = prepare(f.app, work, argv("n" + i));
      f.app.executions.threads.accepted(work, link, {
        operationId: "op-n" + i,
        workId,
        state: "submitted",
      });
      f.app.executions.report(work, "Queued");
      f.app.executions.threads.observe(
        work,
        { ...link, operation_id: "op-n" + i },
        completion(work, "n" + i),
      );
      if (i < 64) paused.add(workId);
      else runnable = work;
    }
  });
  f.app.executions.ready = (work) => !paused.has(work.id);
  const c = coordinator(f.app, () => {
    throw Error("already settled");
  });
  await c.reconcile(new AbortController().signal);
  assert.equal(f.app.executions.savedReport(runnable), undefined);
  await c.reconcile(new AbortController().signal);
  assert.ok(f.app.executions.savedReport(runnable));
});

test("same native Turn ID in different conversations or Hosts preserves all results across restart", async (t) => {
  const f = fixture(t);
  for (const key of ["first", "second", "third"]) f.link(key);
  f.app.executions.report(f.work, "All submitted");
  const refs = {
    first: "opencraft://host-a/thread/one",
    second: "opencraft://host-a/thread/two",
    third: "opencraft://host-b/thread/one",
  };
  const c = coordinator(f.app, async (args) => {
    const key = args[3].slice(3);
    if (key === "third")
      return { operationId: args[3], workId: f.work.id, state: "submitted" };
    return {
      ...completion(f.work, key, "completed", "RESULT_" + key),
      reference: refs[key],
    };
  });
  await c.reconcile(new AbortController().signal);
  assert.equal(turns(f.app).length, 0);
  const { app } = f.reopen();
  await coordinator(app, async () => ({
    ...completion(f.work, "third", "completed", "RESULT_third"),
    reference: refs.third,
  })).reconcile(new AbortController().signal);
  const report = app.executions.savedReport(f.work);
  for (const key of Object.keys(refs))
    assert.match(report.text, new RegExp("RESULT_" + key));
  assert.equal(turns(app).length, 1);
});

test("legacy outcomes without conversation identity are not merged by Turn ID", async (t) => {
  const f = fixture(t);
  f.link("first");
  f.link("second");
  f.app.executions.report(f.work, "Both submitted");
  await coordinator(f.app, async (args) => {
    const key = args[3].slice(3),
      result = completion(f.work, key, "completed", "LEGACY_" + key);
    delete result.reference;
    return result;
  }).reconcile(new AbortController().signal);
  const report = f.app.executions.savedReport(f.work);
  assert.match(report.text, /LEGACY_first/);
  assert.match(report.text, /LEGACY_second/);
});

test("different evidence for the same conversation and Turn is retained including failure", async (t) => {
  const f = fixture(t);
  f.link("first");
  f.link("second");
  f.app.executions.report(f.work, "Both submitted");
  await coordinator(f.app, async (args) => {
    const key = args[3].slice(3);
    return completion(
      f.work,
      key,
      key === "first" ? "completed" : "failed",
      "EVIDENCE_" + key,
    );
  }).reconcile(new AbortController().signal);
  const report = f.app.executions.savedReport(f.work);
  assert.match(report.text, /EVIDENCE_first/);
  assert.match(report.text, /EVIDENCE_second/);
  assert.ok(report.error);
});

test("unaccepted refusals retain one evidence entry per link even without an operation ID", (t) => {
  const f = fixture(t);
  for (const key of ["first", "second"]) {
    const link = prepare(f.app, f.work, argv(key));
    f.app.executions.threads.refused(f.work, link);
  }
  f.app.executions.report(f.work, "Both refused");
  const report = f.app.executions.savedReport(f.work);
  assert.equal(
    report.text.match(/The platform refused this task intent/g).length,
    2,
  );
  assert.ok(report.error);
});

function threadPipe(t, handle) {
  const a = new PassThrough(),
    b = new PassThrough();
  const server = createStdioPeer({ input: a, output: b, handle });
  const client = createStdioPeer({
    input: b,
    output: a,
    handle() {
      throw Error("unused");
    },
  });
  t.after(() => {
    client.close();
    server.close();
    a.destroy();
    b.destroy();
  });
  return () =>
    client.request("platform/opencraft/personal-assistant/threads/command");
}
for (const status of [400, 401, 403, 409])
  test(`real IPC terminal failure ${status} settles held Work once without replacement`, async (t) => {
    const f = fixture(t);
    f.link();
    f.app.executions.report(f.work, "Submitted");
    let calls = 0;
    const command = threadPipe(t, () => {
      calls++;
      throw Object.assign(Error("private error"), { status });
    });
    const c = coordinator(f.app, command);
    await c.reconcile(new AbortController().signal);
    const report = f.app.executions.savedReport(f.work);
    assert.equal(report.status, "error");
    assert.match(
      report.text,
      status === 401 || status === 403 ? /no longer authorized/ : /refused/,
    );
    assert.doesNotMatch(report.text, /private error/);
    assert.equal(turns(f.app).length, 1);
    await c.reconcile(new AbortController().signal);
    assert.equal(calls, 1);
    assert.equal(turns(f.app).length, 1);
  });
test("real IPC transient failure stays unresolved and subsequently completes the original operation", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Submitted");
  let calls = 0,
    errors = 0;
  const command = threadPipe(t, () => {
    if (++calls === 1)
      throw Object.assign(Error("private unavailable"), { status: 503 });
    return completion(f.work);
  });
  const c = coordinator(f.app, command, () => errors++);
  await c.reconcile(new AbortController().signal);
  assert.equal(f.app.executions.savedReport(f.work), undefined);
  assert.equal(f.app.executions.threads.pending().length, 1);
  assert.equal(errors, 1);
  await c.reconcile(new AbortController().signal);
  assert.match(f.app.executions.savedReport(f.work).text, /REAL NATIVE RESULT/);
  assert.equal(turns(f.app).length, 1);
  assert.equal(calls, 2);
});

for (const turnId of [null, "native-turn"])
  test(`missing native receipt does not settle held Work (admitted Turn: ${turnId})`, async (t) => {
    const f = fixture(t);
    f.link();
    f.app.executions.report(f.work, "Submitted");
    const expected = ["thread", "operation", "show", "op-first"];
    const c = coordinator(f.app, async (args) => {
      assert.deepEqual(args, expected);
      return {
        operationId: "op-first",
        workId: f.work.id,
        state: "submitted",
        input: {
          deliveryState: "injected",
          targetTurnId: turnId,
          completion: {
            version: 1,
            turnId,
            status: "unknown",
            text: "",
            truncated: false,
          },
        },
      };
    });
    await c.reconcile(new AbortController().signal);
    assert.equal(f.app.executions.savedReport(f.work), undefined);
    assert.equal(turns(f.app).length, 0);
    assert.equal(f.app.executions.threads.pending().length, 1);
    const { app } = f.reopen();
    assert.equal(app.executions.savedReport(f.work), undefined);
    await coordinator(app, async (args) => {
      assert.deepEqual(args, expected);
      return completion(f.work);
    }).reconcile(new AbortController().signal);
    assert.match(app.executions.savedReport(f.work).text, /REAL NATIVE RESULT/);
    assert.equal(app.executions.savedReport(f.work).error, null);
    assert.equal(turns(app).length, 1);
    await coordinator(app, async () => {
      throw Error("settled operation must not be polled again");
    }).reconcile(new AbortController().signal);
    assert.equal(turns(app).length, 1);
  });

for (const accepted of [false, true])
  test(`background recovery fences changed platform binding (receipt accepted: ${accepted})`, async (t) => {
    const f = fixture(t);
    if (accepted) f.link();
    else prepare(f.app, f.work, argv("first"));
    f.app.executions.report(f.work, "Submitted");
    const { app } = f.reopen();
    app.scope.resources = [{ ...resource, binding: "replacement-binding" }];
    let calls = 0;
    const c = coordinator(app, async () => {
      calls++;
      return completion(f.work);
    });
    await c.reconcile(new AbortController().signal);
    assert.equal(calls, 0);
    assert.equal(app.workRecord(f.work.id).status, "blocked");
    assert.match(app.workRecord(f.work.id).error, /authority changed/);
    assert.equal(app.executions.savedReport(f.work), undefined);
    assert.equal(turns(app).length, 0);
    assert.deepEqual(app.executions.threads.waitingWorks(), []);
    assert.equal(app.executions.threads.pending().length, 0);
    await c.reconcile(new AbortController().signal);
    assert.equal(calls, 0);
  });

test("binding change during observation blocks the Work without accepting late native evidence", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Submitted");
  await coordinator(f.app, async () => {
    f.app.scope.resources = [];
    return completion(f.work, "first", "completed", "MUST NOT COMMIT");
  }).reconcile(new AbortController().signal);
  assert.equal(f.app.workRecord(f.work.id).status, "blocked");
  assert.equal(f.app.executions.savedReport(f.work), undefined);
  assert.equal(turns(f.app).length, 0);
  assert.deepEqual(f.app.executions.threads.waitingWorks(), []);
});

test("binding change after final observation fences the ready report", async (t) => {
  const f = fixture(t);
  f.link();
  await coordinator(f.app, async () => completion(f.work)).reconcile(
    new AbortController().signal,
  );
  f.app.scope.resources = [];
  assert.throws(() => f.app.executions.report(f.work, "Submitted"), /binding/);
  assert.equal(f.app.executions.savedReport(f.work), undefined);
  assert.equal(turns(f.app).length, 0);
});

test("fenced old Work does not prevent a new Work with current captured binding from settling", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Old task");
  f.app.scope.resources = [{ ...resource, binding: "new-binding" }];
  f.app.reception.accept("new-request", { text: "New task" });
  f.app.reception.apply(f.app.reception.turn("new-request"), {
    kind: "delegate",
    goal: "New task",
    completion: { output: "text" },
  });
  const work = f.app.workRecord(f.app.reception.turn("new-request").work_id);
  const link = prepare(f.app, work, argv("second"));
  f.app.executions.threads.accepted(work, link, {
    operationId: "op-second",
    workId: work.id,
    state: "submitted",
  });
  f.app.executions.report(work, "New task submitted");
  let calls = 0;
  await coordinator(f.app, async (args) => {
    calls++;
    assert.deepEqual(args, ["thread", "operation", "show", "op-second"]);
    return completion(work, "second");
  }).reconcile(new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(f.app.workRecord(f.work.id).status, "blocked");
  assert.match(f.app.executions.savedReport(work).text, /REAL NATIVE RESULT/);
  assert.equal(turns(f.app).length, 1);
});

test("tool post-await guard rejects lost acceptance under a changed binding", async (t) => {
  const f = fixture(t),
    snapshot = f.app.executions.snapshot(f.work);
  const ports = createExecutionPorts(
    f.app,
    () => {},
    async () => {
      f.app.scope.resources = [{ ...resource, binding: "replacement" }];
      return { operationId: "late-op", workId: f.work.id, state: "submitted" };
    },
  ).toolsFor(f.work, snapshot);
  await assert.rejects(ports.threadCommand(argv("first")), /binding/);
  const link = f.app.executions.threads.pending()[0];
  assert.equal(link.operation_id, null);
  const c = coordinator(f.app, async () => {
    throw Error("must not replay under replacement binding");
  });
  await c.reconcile(new AbortController().signal);
  assert.equal(f.app.workRecord(f.work.id).status, "blocked");
});

test("retired owner fencing is not converted into a local Work mutation", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Submitted");
  const c = new ThreadCompletionCoordinator({
    app: f.app,
    assertOwner() {
      throw Error("Retired writer");
    },
    command() {
      throw Error("must not call");
    },
    settle() {
      throw Error("must not settle");
    },
  });
  await assert.rejects(
    c.reconcile(new AbortController().signal),
    /Retired writer/,
  );
  assert.equal(f.app.workRecord(f.work.id).status, "queued");
  assert.equal(f.app.executions.threads.pending().length, 1);
});

for (const command of [
  [
    "thread",
    "start",
    "--prompt",
    "--idempotency-key",
    "--profile",
    "default",
    "--idempotency-key",
    "key",
  ],
  [
    "thread",
    "start",
    "--title",
    "--idempotency-key",
    "--idempotency-key",
    "key",
    "--prompt",
    "literal",
    "--profile",
    "default",
  ],
  [
    "thread",
    "tell",
    "reference",
    "--message",
    "--idempotency-key",
    "--delivery",
    "queue",
    "--idempotency-key",
    "key",
  ],
  [
    "thread",
    "tell",
    "--json",
    "--message",
    "--idempotency-key",
    "reference",
    "--delivery",
    "steer",
    "--expected-turn",
    "exact-turn",
    "--idempotency-key",
    "key",
  ],
  [
    "thread",
    "start",
    "--idempotency-key",
    "--idempotency-key",
    "--prompt",
    "literal",
    "--profile",
    "default",
  ],
])
  test(`execution-scoped key rewriting preserves flag-shaped literal values: ${JSON.stringify(command)}`, async (t) => {
    const f = fixture(t);
    const original = parseThreadCommand(command);
    const link = prepare(f.app, f.work, command);
    const wire = f.app.executions.threads.argv(link);
    const parsed = parseThreadCommand(wire);
    assert.equal(parsed.command, original.command);
    assert.deepEqual(parsed.arguments, original.arguments);
    assert.match(parsed.idempotencyKey, /^execution:/);
    assert.equal(wire.filter((v, i) => v !== command[i]).length, 1);
    assert.deepEqual(JSON.parse(link.argv_json), command);
    const { app } = f.reopen();
    let submitted;
    await coordinator(app, async (args) => {
      submitted = args;
      return {
        operationId: "literal-op",
        workId: f.work.id,
        state: "submitted",
      };
    }).reconcile(new AbortController().signal);
    assert.deepEqual(submitted, wire);
  });

test("shared key replacement validates input and preserves the caller's array", () => {
  const args = [
    "thread",
    "start",
    "--prompt",
    "--idempotency-key",
    "--profile",
    "default",
    "--idempotency-key",
    "old",
  ];
  const copy = [...args],
    result = replaceThreadCommandIdempotencyKey(args, "new");
  assert.deepEqual(args, copy);
  assert.equal(parseThreadCommand(result).idempotencyKey, "new");
  assert.throws(() => replaceThreadCommandIdempotencyKey(args, ""));
  assert.throws(() =>
    replaceThreadCommandIdempotencyKey(args, "x".repeat(16385)),
  );
  assert.throws(() =>
    replaceThreadCommandIdempotencyKey(
      ["thread", "start", "--prompt", "--idempotency-key"],
      "new",
    ),
  );
  assert.throws(() =>
    replaceThreadCommandIdempotencyKey(["thread", "profiles"], "new"),
  );
  assert.throws(() =>
    replaceThreadCommandIdempotencyKey(
      [...args, "--idempotency-key", "duplicate"],
      "new",
    ),
  );
});

test("malformed native completion stays unresolved and the original task can later complete", async (t) => {
  const f = fixture(t);
  f.link();
  f.app.executions.report(f.work, "Submitted");
  let invalid = true,
    errors = 0,
    calls = 0;
  const c = coordinator(
    f.app,
    async (args) => {
      calls++;
      assert.deepEqual(args, ["thread", "operation", "show", "op-first"]);
      const receipt = completion(f.work);
      if (invalid) receipt.input.completion.status = ["completed"];
      return receipt;
    },
    () => errors++,
  );
  await c.reconcile(new AbortController().signal);
  assert.equal(errors, 1);
  assert.equal(f.app.executions.savedReport(f.work), undefined);
  assert.equal(f.app.executions.threads.pending().length, 1);
  assert.equal(turns(f.app).length, 0);
  invalid = false;
  await c.reconcile(new AbortController().signal);
  assert.match(f.app.executions.savedReport(f.work).text, /REAL NATIVE RESULT/);
  assert.equal(turns(f.app).length, 1);
  assert.equal(calls, 2);
});

test("cancelled lost-acceptance reply cannot bind or wake a new Work using the same model key", async (t) => {
  const f = fixture(t),
    oldLink = prepare(f.app, f.work, argv("shared-key"));
  f.app.executions.report(f.work, "Old submission");
  let release, started;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const c = coordinator(f.app, async (args, workId) => {
    if (workId === f.work.id) {
      started();
      await blocked;
      return {
        operationId: "old-late-operation",
        workId: f.work.id,
        state: "submitted",
      };
    }
    assert.deepEqual(args, ["thread", "operation", "show", "op-new"]);
    return { ...completion({ id: workId }), operationId: "op-new" };
  });
  const reconciling = c.reconcile(new AbortController().signal);
  await began;
  f.app.works.cancel("cancel-old", { workId: f.work.id });
  f.app.reception.accept("new-request", { text: "New task" });
  f.app.reception.apply(f.app.reception.turn("new-request"), {
    kind: "delegate",
    goal: "New task",
    completion: { output: "text" },
  });
  const work = f.app.workRecord(f.app.reception.turn("new-request").work_id);
  const next = prepare(f.app, work, argv("shared-key"));
  assert.notEqual(
    f.app.executions.threads.argv(oldLink).at(-1),
    f.app.executions.threads.argv(next).at(-1),
  );
  f.app.executions.threads.accepted(work, next, {
    operationId: "op-new",
    workId: work.id,
    state: "submitted",
  });
  f.app.executions.report(work, "New submission");
  release();
  await reconciling;
  assert.equal(f.app.executions.savedReport(f.work), undefined);
  assert.equal(f.app.executions.savedReport(work), undefined);
  await c.reconcile(new AbortController().signal);
  assert.match(f.app.executions.savedReport(work).text, /REAL NATIVE RESULT/);
  assert.doesNotMatch(
    f.app.executions.savedReport(work).text,
    /old-late-operation|Old submission/,
  );
  assert.equal(f.app.executions.savedReport(f.work), undefined);
  assert.equal(f.app.workRecord(f.work.id).status, "cancelled");
  assert.equal(turns(f.app).length, 1);
});
