import { workObservation } from "../src/runtime/work-observation.mjs";
import { LocalArtifactStore } from "../src/adapters/filesystem/artifact-store.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Runner } from "../src/runner.mjs";
import { loadProfile } from "../src/profile.mjs";
import { profileFor, running, until, completed, publishTestNote } from "./helpers.mjs";

const add = (app, notify = "always", id = "rule") =>
  app.triggers.add(id, {
    eventType: "project.updated",
    goal: "Record the project update",
    notify,
  });
function finish(store, workId, text = "a result") {
  const work = store.requireWork(workId);
  const artifact = new LocalArtifactStore(join(store.profile.path, "artifacts")).publishNote(
    store.app.executions.execution(work).id,
    text,
  );
  store.app.completion.publishedNote(work, artifact, text);
  store.app.outcomes.record(work, text);
  const delivery = store.app.outcomes.pending().find((d) => d.work_id === workId);
  store.app.outcomes.accepted(delivery);
  return delivery;
}
const messages = (app) => app.history.view().messages.filter((m) => m.data.kind === "notification");

test("chat reminder without notify produces one durable message, never a terminal activity card", (t) => {
  const profile = profileFor(t);
  let store = new Store(profile);
  t.after(() => store.close());
  const { app } = store;
  app.reception.accept("reminder-request", { text: "一小时后提醒我吃饭" });
  const turn = app.reception.turn("reminder-request");
  const at = Date.now() + 3600000;
  const proposal = { kind: "routine.create", params: { text: "提醒用户吃饭", schedule: { kind: "once", at } } };
  app.reception.apply(turn, proposal);
  app.reception.apply(turn, proposal);
  assert.equal(app.status().routines.length, 1);
  assert.equal(app.status().routines[0].notify, "always");
  app.routines.tick(at);
  const work = app.status().works[0];
  assert.equal(workObservation(app.status().works).length, 1);
  finish(store, work.id, "到饭点了，你之前让我一小时后提醒你。");
  assert.deepEqual(workObservation(app.status().works), []);
  store.close();
  store = new Store(profile);
  store.app.notifications.now = () => Date.now() + 1000;
  store.app.notifications.flush();
  const notice = messages(store.app)[0];
  assert.equal(notice.text, "到饭点了，你之前让我一小时后提醒你。");
  const envelope = store.app.messages.get(notice.id);
  assert.equal(envelope.state, "pending", "local completion does not claim external delivery");
  store.app.reception.accept("later-message", { text: "好的，谢谢" });
  store.app.notifications.flush();
  const history = store.app.history.view().messages;
  assert.equal(messages(store.app).length, 1);
  assert.ok(history.findIndex((row) => row.id === notice.id) < history.findIndex((row) => row.text === "好的，谢谢"));
  assert.deepEqual(workObservation(store.app.status().works), []);
});

test("explicit quiet chat arrangements and low-level automation retain notification policies", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  for (const notify of ["never", "changed"]) {
    store.app.reception.accept(notify, { text: "设置后台安排" });
    store.app.reception.apply(store.app.reception.turn(notify), {
      kind: "routine.create",
      params: { text: notify, notify, schedule: { kind: "once", at: Date.now() + 3600000 } },
    });
    assert.equal(store.app.status().routines.find((row) => row.text === notify).notify, notify);
  }
  const r = store.app.routines.add("internal", {
    text: "internal",
    schedule: { kind: "once", at: Date.now() + 3600000 },
  });
  assert.equal(store.app.status().routines.find((row) => row.id === r.routineId).notify, "never");
});

test("event matches durable rules and duplicate admission never creates duplicate work", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store,
    rule = add(app);
  assert.equal(app.triggers.emit("unrelated", { eventType: "other", data: {} }).workIds.length, 0);
  const params = { eventType: "project.updated", data: { project: "alpha" } };
  const receipt = app.triggers.emit("evt", params);
  assert.equal(receipt.workIds.length, 1);
  assert.equal(app.triggers.emit("evt", params).duplicate, true);
  assert.throws(
    () => app.triggers.emit("evt", { ...params, data: { project: "beta" } }),
    /identity|payload|different|reused/i,
  );
  const work = app.workRecord(receipt.workIds[0]);
  const origin = JSON.parse(work.origin_json);
  assert.equal(origin.quietOrigin, true);
  assert.equal(origin.notify, "always");
  assert.equal(origin.data.project, "alpha");
  app.triggers.enable("disable", {
    triggerId: rule.triggerId,
    expectedRevision: 1,
    enabled: false,
  });
  assert.equal(app.triggers.emit("later", params).workIds.length, 0);
  assert.throws(
    () =>
      app.triggers.enable("stale", {
        triggerId: rule.triggerId,
        expectedRevision: 1,
        enabled: true,
      }),
    /stale/,
  );
});

test("background results batch once after reopen, while work completion remains independent", (t) => {
  const profile = profileFor(t);
  let store = new Store(profile);
  add(store.app);
  const ids = ["one", "two"].map(
    (id) => store.app.triggers.emit(id, { eventType: "project.updated", data: {} }).workIds[0],
  );
  for (const id of ids) {
    finish(store, id, `result for ${id}`);
    assert.equal(store.work(id).status, "completed");
  }
  assert.equal(messages(store.app).length, 0);
  assert.deepEqual(
    workObservation(store.app.status().works),
    [],
    "finished work leaves current activity before notification flush",
  );
  store.close();
  store = new Store(profile);
  t.after(() => store.close());
  store.app.notifications.now = () => Date.now() + 1000;
  store.app.notifications.flush();
  store.app.notifications.flush();
  const [message] = messages(store.app);
  assert.equal(messages(store.app).length, 1);
  assert.deepEqual(message.data.workIds, ids);
  assert.equal(message.data.deliveryIds.length, 2);
  assert.equal(message.text, ids.map((id) => `result for ${id}`).join("\n\n"));
  assert.doesNotMatch(message.text, /工作：/);
  const stableId = message.id;
  assert.deepEqual(workObservation(store.app.status().works), []);
  store.close();
  store = new Store(profile);
  store.app.notifications.now = () => Date.now() + 2000;
  store.app.notifications.flush();
  assert.deepEqual(
    messages(store.app).map((row) => row.id),
    [stableId],
    "restart preserves one real history message, no pinned replacement",
  );
  assert.equal(store.app.status().works.length, 2, "task history remains available");
});

test("changed suppresses identical results, never stays quiet, and direct results retain original delivery", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store;
  add(app, "changed");
  for (const id of ["a", "b"])
    finish(store, app.triggers.emit(id, { eventType: "project.updated", data: {} }).workIds[0], "same content");
  app.notifications.now = () => Date.now() + 1000;
  app.notifications.flush();
  assert.equal(messages(app).length, 1);
  assert.equal(messages(app)[0].data.workIds.length, 1);
  finish(store, app.triggers.emit("c", { eventType: "project.updated", data: {} }).workIds[0], "changed content");
  app.notifications.now = () => Date.now() + 2000;
  app.notifications.flush();
  assert.equal(messages(app).length, 2);
  const quiet = app.triggers.add("quiet", {
    eventType: "quiet.event",
    goal: "quiet result",
    notify: "never",
  });
  const quietId = app.triggers.emit("quiet-fire", {
    eventType: "quiet.event",
    data: {},
  }).workIds[0];
  finish(store, quietId);
  app.notifications.flush();
  assert.equal(messages(app).length, 2);
  assert.equal(app.history.destinations(quietId).length, 0);
  const direct = store.submit("direct", { text: "direct" }).workId;
  app.history.link(app.history.main.id, direct);
  finish(store, direct);
  assert.equal(app.history.view().messages.filter((m) => m.data.kind === "result").length, 1);
});

test("notification batch and sent markers rollback together", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store;
  add(app);
  finish(store, app.triggers.emit("evt", { eventType: "project.updated", data: {} }).workIds[0]);
  app.notifications.now = () => Date.now() + 1000;
  const original = app.r.notifications.sent.bind(app.r.notifications);
  app.r.notifications.sent = () => {
    throw new Error("injected queue failure");
  };
  assert.throws(() => app.notifications.flush(), /injected/);
  assert.equal(messages(app).length, 0);
  app.r.notifications.sent = original;
  app.notifications.flush();
  assert.equal(messages(app).length, 1);
});

test("file source notices real changes, persists baseline across restart, and distinguishes repeated cycles", async (t) => {
  // Stop producers before profileFor's cleanup removes their artifact directory.
  let runner;
  t.after(async () => runner?.close());
  let profile = profileFor(t);
  const materials = join(profile.path, "materials");
  mkdirSync(materials);
  writeFileSync(join(materials, "project.md"), "A");
  writeFileSync(join(profile.path, "profile.json"), JSON.stringify({ ...profile.config, workspace: materials }));
  profile = loadProfile(profile.path);
  runner = await Runner.open(profile);
  runner.app.triggers.add("file-rule", {
    eventType: "file.changed",
    path: "project.md",
    goal: "Read changed project material",
    notify: "always",
  });
  await until(() => runner.app.r.triggers.observation("project.md"));
  assert.equal(runner.app.status().works.length, 0);
  writeFileSync(join(materials, "project.md"), "B");
  await until(() => runner.app.status().works.length === 1);
  await completed(profile, runner.app.status().works[0].id);
  await runner.close();
  writeFileSync(join(materials, "project.md"), "A");
  runner = await Runner.open(profile);
  await until(() => runner.app.status().works.length === 2);
  writeFileSync(join(materials, "project.md"), "B");
  await until(() => runner.app.status().works.length === 3);
  assert.equal(runner.app.r.triggers.observation("project.md").revision, 4);
  unlinkSync(join(materials, "project.md"));
  await until(() => runner.app.status().works.length === 4);
  assert.equal(runner.app.r.triggers.observation("project.md").sha256, null);
});

test("event rules reject traversal, oversized data, and cannot expand a captured material binding", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store;
  assert.throws(
    () =>
      app.triggers.add("bad", {
        eventType: "file.changed",
        path: "../secret.md",
        goal: "read",
      }),
    /relative/,
  );
  assert.throws(
    () =>
      app.triggers.emit("huge", {
        eventType: "event",
        data: { text: "x".repeat(9000) },
      }),
    /8000/,
  );
  app.scope.resources = [{ id: "materials", binding: "old" }];
  add(app);
  app.scope.resources = [{ id: "materials", binding: "new" }];
  assert.throws(() => app.triggers.emit("rebind", { eventType: "project.updated", data: {} }), /binding changed/);
  assert.equal(app.status().works.length, 0);
  app.triggers.add("file", {
    eventType: "file.changed",
    path: "project.md",
    goal: "read",
  });
  app.scope.resources = [];
  assert.deepEqual(app.triggers.watchedPaths(), []);
});

test("scheduled notification policy is captured per occurrence and survives amendment", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store;
  app.routines.add("routine", {
    text: "daily summary",
    startAt: Date.now() - 1,
    intervalMs: 1000,
    maxRuns: 1,
    notify: "changed",
  });
  app.routines.tick();
  const work = app.status().works[0];
  assert.equal(JSON.parse(work.origin_json).notify, "changed");
  assert.equal(app.history.destinations(work.id).length, 1);
  store.amend("amend", {
    workId: work.id,
    text: "different summary",
    expectedRevision: 1,
  });
  assert.equal(store.work(work.id).origin_json, work.origin_json);
});

test("duplicate delivery acceptance cannot inflate unread counts or repeat direct results", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const { app } = store;
  const { workId } = store.submit("direct-once", { text: "note" });
  app.history.link(app.history.main.id, workId);
  const delivery = finish(store, workId);
  assert.equal(app.attention.status().unread_count, 1);
  app.outcomes.accepted(delivery);
  app.outcomes.accepted(delivery);
  assert.equal(app.attention.status().unread_count, 1);
  assert.equal(app.history.view().messages.filter((m) => m.data.kind === "result").length, 1);
});

test("CLI creates, emits and disables a real local event rule", async (t) => {
  const { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const { profile } = await running(t);
  const cli = async (args) =>
    JSON.parse(
      (await promisify(execFile)(process.execPath, ["bin/assistant.mjs", ...args, "--profile", profile.path])).stdout,
    ).result;
  const rule = await cli([
    "trigger-add",
    "--event-type",
    "project.updated",
    "--text",
    "record update",
    "--notify",
    "always",
  ]);
  const event = await cli([
    "event-emit",
    "--event-type",
    "project.updated",
    "--data",
    '{"project":"alpha"}',
    "--id",
    "cli-event",
  ]);
  assert.equal(event.workIds.length, 1);
  await completed(profile, event.workIds[0]);
  await until(async () => (await cli(["conversation"])).messages.some((m) => m.data.kind === "notification"));
  await cli(["trigger-enable", "--trigger", rule.triggerId, "--revision", "1", "--enabled", "false"]);
  assert.equal((await cli(["trigger-list"]))[0].enabled, 0);
  assert.equal((await cli(["event-emit", "--event-type", "project.updated", "--id", "cli-second"])).workIds.length, 0);
});
