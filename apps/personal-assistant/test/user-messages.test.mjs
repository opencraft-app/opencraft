import { legacyCoordinationFixture } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.mjs";
import { Runner, request } from "../src/runner.mjs";
import { LocalAttachmentStore } from "../src/adapters/filesystem/attachment-store.mjs";
import { LocalMessageDelivery } from "../src/adapters/filesystem/message-delivery.mjs";
import { MessageDispatcher } from "../src/runtime/message-dispatcher.mjs";
import { createExecutionPorts } from "../src/runtime/execution-ports.mjs";
import { digest } from "../src/domain/values.mjs";
import { profileFor, running, until, childRunner, completed, root } from "./helpers.mjs";

const exec = promisify(execFile);
const call = (p, op, params = {}, id = crypto.randomUUID()) => request(p, { op, params, id });
const getStore = (t) => {
  const s = new Store(profileFor(t));
  t.after(() => {
    if (s.db.isOpen) s.close();
  });
  return s;
};
const list = (app) => app.messages.list({ limit: 50 }).items;
function question(app, id = "work", options = {}) {
  const receipt = app.works.submit(id, { text: "等待真实用户选择" });
  app.history.link(app.history.main.id, receipt.workId);
  const work = app.workRecord(receipt.workId);
  app.executions.started(work);
  const q = app.interactions.request(work, "choice-call", "选择范围", options);
  return {
    work,
    q,
    message: list(app).find((m) => m.body.interactionId === q.id),
  };
}

test("every assistant-visible history write creates one atomic typed outbox item; user messages do not", (t) => {
  const s = getStore(t),
    a = s.app;
  a.history.append(a.history.main.id, "user", "user", "hello");
  a.history.append(a.history.main.id, "reply", "assistant", "answer");
  a.history.append(a.history.main.id, "reply", "assistant", "answer");
  assert.equal(list(a).length, 1);
  assert.equal(list(a)[0].body.content, "answer");
  assert.equal(list(a)[0].state, "pending");
  assert.equal(list(a)[0].readStatus, "unknown");
  s.db.exec(
    "CREATE TEMP TRIGGER message_fail BEFORE INSERT ON user_message BEGIN SELECT RAISE(ABORT,'outbox failed'); END",
  );
  assert.throws(() => a.history.append(a.history.main.id, "atomic", "assistant", "must roll back"), /outbox failed/);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM conversation_message WHERE text='must roll back'").get().n, 0);
});

test("text, attachment IDs and same-conversation reply references are immutable and cannot grant a destination", (t) => {
  const s = getStore(t),
    a = s.app;
  const assets = new LocalAttachmentStore(join(s.profile.path, "attachments"));
  const file = assets.importBytes("report.txt", Buffer.from("real report bytes"));
  const parent = a.history.append(a.history.main.id, "u", "user", "原请求");
  const id = a.history.send(a.history.main.id, "rich", {
    type: "text",
    content: "报告",
    attachments: [{ attachmentId: file.attachmentId }],
    replyTo: parent,
  });
  assert.equal(a.messages.get(id).body.files[0].sha256, file.sha256);
  assert.throws(
    () =>
      a.history.send(a.history.main.id, "rich", {
        type: "text",
        content: "报告",
        replyTo: parent,
      }),
    /different payload/,
  );
  assert.throws(
    () =>
      a.history.send(a.history.main.id, "channel", {
        type: "text",
        content: "x",
        channel: "slack:someone",
      }),
    /not configured/,
  );
  assert.throws(
    () =>
      a.history.send(a.history.main.id, "foreign", {
        type: "text",
        content: "x",
        replyTo: "foreign",
      }),
    /outside/,
  );
  assert.throws(
    () =>
      a.history.send(a.history.main.id, "path", {
        type: "attachment",
        attachmentId: "/etc/passwd",
      }),
    /reference/,
  );
  assert.throws(
    () =>
      a.history.send(a.history.main.id, "forged", {
        type: "question",
        interactionId: "made-up",
      }),
    /Unsupported/,
  );
});

test("binary attachments export exact bytes, reject symlinks/tampering and do not resolve another profile's IDs", async (t) => {
  const s = getStore(t),
    a = s.app,
    store = new LocalAttachmentStore(join(s.profile.path, "attachments"));
  const bytes = Buffer.from([0, 255, 1, 2, 3]),
    asset = store.importBytes("image.png", bytes);
  assert.equal(store.importBytes("image.png", bytes).attachmentId, asset.attachmentId);
  const id = a.history.send(a.history.main.id, "asset", {
    type: "attachment",
    attachmentId: asset.attachmentId,
  });
  const row = a.messages.pending()[0],
    delivery = new LocalMessageDelivery(join(s.profile.path, "outgoing"), store);
  const receipt = await delivery.deliver(row);
  a.messages.accepted(row, receipt);
  const written = JSON.parse(readFileSync(join(s.profile.path, "outgoing", receipt.remoteId)));
  assert.deepEqual(readFileSync(join(s.profile.path, "outgoing", written.files[0].path)), bytes);
  assert.equal(a.messages.get(id).state, "accepted");
  const other = new LocalAttachmentStore(join(profileFor(t).path, "attachments"));
  assert.throws(() => other.describe(asset.attachmentId), /ENOENT/);
  const source = join(s.profile.path, "source.txt"),
    link = join(s.profile.path, "link.txt");
  writeFileSync(source, "x");
  symlinkSync(source, link);
  assert.throws(() => store.importFile(link), /ELOOP/);
  writeFileSync(join(store.root, `${asset.attachmentId}.blob`), "changed");
  await assert.rejects(delivery.deliver(row), /no longer match/);
  assert.throws(() => store.importBytes("../bad", bytes), /name/);
});

test("transport failure persists only delivery retry and preserves order across reopen", async (t) => {
  const s = getStore(t),
    a = s.app,
    p = s.profile;
  const first = a.history.send(a.history.main.id, "one", {
    type: "text",
    content: "one",
  });
  const second = a.history.send(a.history.main.id, "two", {
    type: "text",
    content: "two",
  });
  const dispatcher = new MessageDispatcher(a.messages, {
    async deliver() {
      throw new Error("offline");
    },
  });
  dispatcher.tick();
  await dispatcher.task;
  assert.equal(a.messages.get(first).attempts, 1);
  assert.equal(a.messages.get(second).attempts, 0);
  assert.equal(a.messages.pending().length, 0);
  await dispatcher.close();
  s.close();
  const reopened = new Store(p);
  t.after(() => reopened.close());
  reopened.app.messages.now = () => Date.now() + 60000;
  const ids = [],
    real = new LocalMessageDelivery(join(p.path, "outgoing"), new LocalAttachmentStore(join(p.path, "attachments")));
  const resumed = new MessageDispatcher(reopened.app.messages, {
    async deliver(m) {
      ids.push(m.id);
      return real.deliver(m);
    },
  });
  resumed.tick();
  await resumed.task;
  resumed.tick();
  await resumed.task;
  await resumed.close();
  assert.deepEqual(ids, [first, second]);
  assert.equal(reopened.app.pendingWorks().length, 0);
});

test("wrong transport receipt is rejected and cannot mark a message accepted", (t) => {
  const s = getStore(t),
    a = s.app;
  a.history.send(a.history.main.id, "msg", { type: "text", content: "hello" });
  const m = a.messages.pending()[0];
  assert.throws(
    () =>
      a.messages.accepted(m, {
        messageId: "wrong",
        channel: "local:main",
        level: "accepted",
        remoteId: "x",
      }),
    /receipt/,
  );
  assert.equal(a.messages.get(m.id).state, "pending");
});

test("one permanently failing message is retained as failed after five attempts and does not starve later messages", (t) => {
  const s = getStore(t),
    a = s.app;
  const first = a.history.send(a.history.main.id, "bad", {
    type: "text",
    content: "unavailable",
  });
  const second = a.history.send(a.history.main.id, "next", {
    type: "text",
    content: "later",
  });
  let now = Date.now();
  a.messages.now = () => now;
  for (let i = 0; i < 5; i++) {
    const m = a.messages.pending()[0];
    assert.equal(m.id, first);
    a.messages.failed(m, new Error("permanent"));
    now += 60000;
  }
  assert.equal(a.messages.get(first).state, "failed");
  assert.equal(a.messages.get(first).attempts, 5);
  assert.equal(a.messages.pending()[0].id, second);
  assert.equal(
    a.dispatch({
      op: "message.retry",
      id: "retry-one",
      params: { messageId: first },
    }).reset,
    1,
  );
  assert.equal(a.messages.pending()[0].id, first);
});

test("queued revision-bound messages are withdrawn when a newer work instruction supersedes them", (t) => {
  const s = getStore(t),
    a = s.app;
  const receipt = a.works.submit("revision-work", { text: "original" });
  a.history.link(a.history.main.id, receipt.workId);
  const id = a.history.append(a.history.main.id, "progress", "assistant", "旧进度", {
    kind: "progress",
    workId: receipt.workId,
    revision: 1,
  });
  a.works.amend("new-revision", {
    workId: receipt.workId,
    text: "new instructions",
    expectedRevision: 1,
  });
  assert.equal(a.messages.pending().length, 0);
  assert.equal(a.messages.get(id).state, "withdrawn");
  assert.equal(a.history.view().messages[0].text, "旧进度");
});

test("choice cards reuse Interaction, validate real offered values and atomically record a user response", (t) => {
  const s = getStore(t),
    a = s.app,
    { work, q, message } = question(a, "choice", {
      choices: [
        { label: "本周", value: "week" },
        { label: "本月", value: "month" },
      ],
    });
  assert.equal(message.body.type, "question");
  assert.equal(message.body.question.choices.length, 2);
  assert.throws(
    () =>
      a.dispatch({
        op: "message.respond",
        id: "bad",
        params: {
          messageId: message.id,
          expectedRevision: 1,
          value: "invented",
        },
      }),
    /offered choice/,
  );
  const result = a.dispatch({
    op: "message.respond",
    id: "answer",
    params: { messageId: message.id, expectedRevision: 1, value: "week" },
  });
  assert.equal(result.workId, work.id);
  assert.equal(a.interactions.list()[0].answer, "week");
  assert.equal(a.messages.get(message.id).interactionState, "answered");
  assert.equal(a.works.require(work.id).record.status, "queued");
  assert.equal(
    a.dispatch({
      op: "message.respond",
      id: "answer",
      params: { messageId: message.id, expectedRevision: 1, value: "week" },
    }).duplicate,
    true,
  );
  assert.equal(a.history.view().messages.filter((m) => m.data.interactionId === q.id && m.role === "user").length, 1);
  assert.equal(a.messages.pending().length, 0);
  assert.equal(a.messages.get(message.id).state, "withdrawn");
});

test("decline, expiration and cancellation cannot reopen an old card", (t) => {
  const s = getStore(t),
    a = s.app;
  const first = question(a, "reject");
  a.dispatch({
    op: "message.respond",
    id: "decline",
    params: { messageId: first.message.id, expectedRevision: 1, reject: true },
  });
  assert.equal(a.messages.get(first.message.id).interactionState, "rejected");
  assert.equal(a.works.require(first.work.id).record.status, "blocked");
  const next = question(a, "cancel");
  a.works.cancel("cancel-action", {
    workId: next.work.id,
    expectedRevision: 1,
  });
  assert.throws(
    () =>
      a.dispatch({
        op: "message.respond",
        id: "late",
        params: { messageId: next.message.id, expectedRevision: 1, value: "x" },
      }),
    /cancelled|current|pending|superseded/,
  );
  const exp = question(a, "expire", { expiresInMs: 1000 });
  a.messages.now = () => Date.now() + 2000;
  a.interactions.now = () => Date.now() + 2000;
  a.interactions.expire();
  assert.equal(a.messages.get(exp.message.id).interactionState, "expired");
});

test("secret and authorization envelopes contain metadata only and ordinary message responses cannot supply secrets", (t) => {
  const s = getStore(t),
    a = s.app,
    { message } = question(a, "secret", {
      kind: "secret",
      provider: "example",
    });
  assert.equal(message.body.type, "secret-request");
  assert.equal(message.body.question.secureInput, true);
  assert.equal(message.body.question.provider, "example");
  assert.throws(
    () =>
      a.dispatch({
        op: "message.respond",
        id: "unsafe",
        params: {
          messageId: message.id,
          expectedRevision: 1,
          value: "SYNTHETIC-SECRET",
        },
      }),
    /typed intervention/,
  );
  assert.doesNotMatch(JSON.stringify(s.db.prepare("SELECT * FROM user_message").all()), /SYNTHETIC-SECRET/);
});

test("only accepted user transport is reported; sending a progress message never completes a work", async (t) => {
  const { profile, runner } = await running(t, { fixtureDelayMs: 1500 });
  const work = await call(profile, "submit", { text: "original work" }, "work");
  const reply = await call(profile, "message.send", { message: { type: "text", content: "正在处理" } }, "progress");
  await until(async () => (await call(profile, "message.get", { messageId: reply.messageId })).state === "accepted");
  assert.notEqual((await call(profile, "work", { workId: work.workId })).work.status, "completed");
  assert.equal((await call(profile, "message.get", { messageId: reply.messageId })).readStatus, "unknown");
  const ports = createExecutionPorts(runner.app).toolsFor(
    runner.app.workRecord(work.workId),
    runner.app.executions.snapshot(runner.app.workRecord(work.workId)),
  );
  assert.equal(ports.sendMessage, undefined);
  assert.equal(ports.messages, undefined);
});

test("real Pi choice wait resumes the original submission through the actual message response CLI", async (t) => {
  const { profile } = await running(t);
  const receipt = await call(profile, "say", { text: "整理一份笔记，先问我范围 [choice]" }, "native-choice");
  const card = await until(async () =>
    (await call(profile, "messages.list")).items.find((m) => m.body.type === "question"),
  );
  assert.equal(card.body.question.choices[0].value, "week");
  const turn = await call(profile, "turn", { inputId: "native-choice" });
  const before = await call(profile, "work", { workId: turn.work_id });
  const answer = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          "bin/assistant.mjs",
          "message-respond",
          "--profile",
          profile.path,
          "--message-id",
          card.id,
          "--revision",
          "1",
          "--value",
          "week",
        ],
        { cwd: root },
      )
    ).stdout,
  ).result;
  assert.equal(answer.workId, turn.work_id);
  const done = await completed(profile, turn.work_id);
  assert.equal(done.executions[0].submission_id, before.executions[0].submission_id);
  assert.equal(done.interactions[0].answer, "week");
  assert.equal(done.executions.length, 1);
});

test("actual main-model query, SendMessage proposal and CLI import/export use existing attachment IDs", async (t) => {
  const p = profileFor(t);
  let runner;
  try {
    const path = join(p.path, "file.bin");
    writeFileSync(path, Buffer.from([0, 1, 2, 255]));
    const imported = JSON.parse(
      (
        await exec(process.execPath, ["bin/assistant.mjs", "attachment-import", "--profile", p.path, "--file", path], {
          cwd: root,
        })
      ).stdout,
    ).result;
    let seen = false;
    runner = await Runner.open(p, {
      receptionModel: {
        async decide(input) {
          if (!input.observations.length) return { kind: "query", name: "attachments.list", params: {} };
          const files = input.observations[0].response.data.items;
          seen = true;
          return {
            kind: "send",
            message: {
              type: "attachment",
              attachmentId: files[0].attachmentId,
            },
          };
        },
      },
    });
    await call(p, "say", { text: "给我文件" }, "send-file");
    const turn = await until(async () => {
      const r = await call(p, "turn", { inputId: "send-file" });
      if (r.status === "blocked") throw new Error(r.reply_text);
      return r.status === "settled" && r;
    });
    assert.equal(turn.work_id, null);
    assert.equal(seen, true);
    const items = await until(async () => {
      const data = await call(p, "messages.list");
      return data.items.find((m) => m.body.type === "attachment" && m.state === "accepted") && data.items;
    });
    assert.equal(items[0].body.attachmentId, imported.attachmentId);
    const output = JSON.parse(
      (await exec(process.execPath, ["bin/assistant.mjs", "messages", "--profile", p.path], { cwd: root })).stdout,
    ).result;
    assert.equal(output.items.length, 1);
  } finally {
    // Stop all background writers before profileFor removes the profile.
    await runner?.close();
  }
});

test("a final typed attachment stays behind the original completion and result delivery checks", async (t) => {
  const p = profileFor(t);
  let attachment;
  const runner = await Runner.open(p, {
    receptionModel: {
      async decide(input) {
        if (!input.source) return { kind: "delegate", goal: "生成一份笔记" };
        if (!input.observations.length) return { kind: "query", name: "attachments.list", params: {} };
        attachment = input.observations[0].response.data.items[0].attachmentId;
        return {
          kind: "deliver",
          message: { type: "attachment", attachmentId: attachment },
        };
      },
    },
  });
  t.after(() => runner.close());
  await call(p, "say", { text: "整理笔记" }, "result-file");
  const accepted = await until(async () => {
    const r = await call(p, "turn", { inputId: "result-file" });
    return r.status === "settled" && r;
  });
  await completed(p, accepted.work_id);
  const result = await until(async () =>
    (await call(p, "messages.list")).items.find((m) => m.body.type === "attachment" && m.state === "accepted"),
  );
  assert.equal(result.body.attachmentId, attachment);
  assert.equal((await call(p, "work", { workId: accepted.work_id })).reports.length, 1);
});

test("notification batching preserves all attachment references instead of dropping files beyond one envelope", (t) => {
  const s = getStore(t),
    a = s.app,
    store = new LocalAttachmentStore(join(s.profile.path, "attachments"));
  const asset = store.importBytes("note.md", Buffer.from("note"));
  const notices = Array.from({ length: 3 }, (_, i) => ({
    id: `notice-${i}`,
    conversation_id: a.history.main.id,
    work_id: `work-${i}`,
    delivery_id: `delivery-${i}`,
    text: "update",
    user_message_json: JSON.stringify({
      type: "text",
      content: "update",
      attachments: Array.from({ length: 4 }, () => ({
        attachmentId: asset.attachmentId,
      })),
    }),
  }));
  a.uow.transaction(() => a.history.batch(notices));
  const messages = list(a);
  assert.equal(messages.length, 2);
  assert.equal(
    messages.reduce((n, m) => n + m.body.files.length, 0),
    12,
  );
});

test("a slow transport leaves the socket available and preserves one in-flight message", async (t) => {
  const p = profileFor(t);
  let release,
    calls = 0;
  const transport = {
    async deliver(m) {
      calls++;
      return new Promise((resolve) => {
        release = () =>
          resolve({
            messageId: m.id,
            channel: "local:main",
            level: "accepted",
            remoteId: m.id,
          });
      });
    },
  };
  const runner = await Runner.open(p, { messageTransport: transport });
  t.after(() => runner.close());
  await call(p, "message.send", { message: { type: "text", content: "one" } }, "first");
  await call(p, "message.send", { message: { type: "text", content: "two" } }, "second");
  await until(() => calls === 1);
  assert.equal((await call(p, "status")).mode, "fixture");
  release();
  await until(() => calls === 2);
  release();
  await until(async () => (await call(p, "messages.list")).items.every((m) => m.state === "accepted"));
});

test("schema16 migration keeps historical conversations unchanged and does not replay old messages", (t) => {
  const s = getStore(t),
    p = s.profile,
    a = s.app;
  a.history.append(a.history.main.id, "old", "assistant", "old message");
  const before = s.db.prepare("SELECT * FROM conversation_message").all();
  legacyCoordinationFixture(s.db);
  s.db.exec(
    "DROP TABLE IF EXISTS execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; DROP TABLE user_message; ALTER TABLE delivery DROP COLUMN user_message_json; ALTER TABLE notification DROP COLUMN user_message_json; PRAGMA user_version=16",
  );
  s.close();
  const reopened = new Store(p);
  t.after(() => reopened.close());
  assert.equal(reopened.db.prepare("PRAGMA user_version").get().user_version, 21);
  assert.deepEqual(reopened.db.prepare("SELECT * FROM conversation_message").all(), before);
  assert.equal(list(reopened.app).length, 0);
});

test("real process exit after outgoing file write reconciles the same message without duplicate history", async (t) => {
  const p = profileFor(t),
    first = await childRunner(t, p, {
      LAB_TEST_CRASH_AT: "message-written-before-receipt",
    });
  const receipt = await call(p, "message.send", { message: { type: "text", content: "durable" } }, "crash-message");
  assert.equal((await first.exited).code, 86);
  const file = join(p.path, "outgoing", `${digest(receipt.messageId)}.json`),
    before = readFileSync(file);
  const next = await childRunner(t, p);
  await until(async () => (await call(p, "message.get", { messageId: receipt.messageId })).state === "accepted");
  assert.deepEqual(readFileSync(file), before);
  assert.equal(readdirSync(join(p.path, "outgoing")).filter((f) => f.endsWith(".json")).length, 1);
  assert.equal((await call(p, "conversation")).messages.filter((m) => m.text === "durable").length, 1);
  await next.stop();
});
