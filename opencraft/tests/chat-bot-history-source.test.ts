import assert from "node:assert/strict";
import test from "node:test";

import type { AppServerBotMessage, AppServerBotMethodResult } from "@opencraft/appserver-protocol";
import { AppServerBotConversationSource, type AppServerBotConversationService, type HostBotConversationEvent } from "@opencraft/bot-conversation-appserver";
import { createConversationKey } from "@opencraft/chat-core";
import type { SubmitIntent } from "@opencraft/composer-core";

const key = createConversationKey("host-a", "room-a");
const author = { participantId: "bot:a", kind: "bot" as const, displayName: "A" };
const conversation = { conversationId: key.threadId, revision: 1, topology: "direct" as const,
  title: "A", participantIds: [author.participantId], createdAtMs: 1, updatedAtMs: 1 };
const row = (id: string, text = id, state: AppServerBotMessage["state"] = "complete"): AppServerBotMessage => ({
  messageId: id, conversationId: key.threadId, author, createdAtMs: 1, updatedAtMs: 1,
  state, content: [{ type: "text", text }],
});
type Read = AppServerBotMethodResult<"bot/conversation/read">;
type Page = AppServerBotMethodResult<"bot/messages/list">;
const snapshot = (data: readonly AppServerBotMessage[], nextCursor?: string, epoch = "epoch-a", nextSeq = 0): Read => ({
  conversation, participants: [author], initialMessagesPage: { data, ...(nextCursor === undefined ? {} : { nextCursor }) },
  executions: [], interactions: [], presence: [], liveCursor: { epoch, nextSeq },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
class Service {
  listener: ((event: HostBotConversationEvent) => void) | null = null;
  read = snapshot([row("anchor")], "older-1");
  page: Page | Promise<Page> = { data: [row("old")], nextCursor: "older-2" };
  calls = 0;
  listCalls = 0;
  subscribe(listener: (event: HostBotConversationEvent) => void) { this.listener = listener; return () => { this.listener = null; }; }
  async waitForCapability() {}
  async readConversation() { this.calls += 1; return this.read; }
  async listMessages() { this.listCalls += 1; return this.page; }
  emit(method: "bot/message/started" | "bot/message/completed", seq: number, message: AppServerBotMessage, epoch = "epoch-a") {
    this.listener?.({ hostId: key.hostId, method, params: { conversationId: key.threadId, stamp: { epoch, seq }, message } });
  }
  source() { return new AppServerBotConversationSource(this as unknown as AppServerBotConversationService); }
}
const ids = (source: AppServerBotConversationSource) => source.getSnapshot(key).transcript.map((message) => message.id);
const intent: SubmitIntent = { commandId: "command-a", clientMessageId: "client-a", target: { type: "existing-thread", key },
  document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "draft" }] }] },
  attachments: [], context: [], selections: {}, options: { autoContext: true }, createdAt: 10 };

test("Bot resync grafts loaded durable prefix and retains separately owned live messages", async () => {
  const service = new Service();
  const source = service.source();
  await source.load(key);
  await source.loadOlder(key);
  service.emit("bot/message/started", 0, row("live", "latest live text", "streaming"));
  service.read = snapshot([row("anchor"), row("tail")], "fresh-older", "epoch-a", 1);
  service.emit("bot/message/completed", 2, row("gap"));
  await source.load(key);
  assert.deepEqual(ids(source), ["old", "anchor", "tail", "live"]);
  assert.equal(source.getSnapshot(key).transcript.at(-1)?.streaming, true);
  assert.equal(source.getSnapshot(key).history.hasOlder, true);
  source.dispose();
});

test("Bot lagging resync cannot replay an older full message over retained live text", async () => {
  const service = new Service();
  const source = service.source();
  await source.load(key);
  service.emit("bot/message/started", 0, row("live", "initial", "streaming"));
  service.listener?.({ hostId: key.hostId, method: "bot/message/delta", params: { conversationId: key.threadId,
    stamp: { epoch: "epoch-a", seq: 1 }, messageId: "live", partIndex: 0, deltaSeq: 0, delta: " + latest" } });
  service.read = snapshot([row("anchor")], "fresh-older", "epoch-a", 0);
  service.emit("bot/message/completed", 3, row("gap"));
  await source.load(key);
  service.emit("bot/message/started", 0, row("live", "initial", "streaming"));
  service.listener?.({ hostId: key.hostId, method: "bot/message/delta", params: { conversationId: key.threadId,
    stamp: { epoch: "epoch-a", seq: 1 }, messageId: "live", partIndex: 0, deltaSeq: 0, delta: " + latest" } });
  assert.deepEqual(source.getSnapshot(key).transcript.at(-1)?.content, [{ type: "text", text: "initial + latest" }]);
  source.dispose();
});

test("Bot resync preserves an exhausted older boundary only with a shared durable anchor", async () => {
  const service = new Service();
  const source = service.source();
  await source.load(key);
  service.page = { data: [row("old")] };
  await source.loadOlder(key);
  service.read = snapshot([row("anchor"), row("tail")], "fresh-older");
  service.emit("bot/message/completed", 1, row("gap"));
  await source.load(key);
  assert.deepEqual(ids(source), ["old", "anchor", "tail"]);
  assert.equal(source.getSnapshot(key).history.hasOlder, false);
  source.dispose();
});

test("Bot reset cannot resurrect unanchored history, old-epoch live data or old write permissions", async () => {
  const service = new Service();
  const source = service.source();
  await source.load(key);
  await source.loadOlder(key);
  service.emit("bot/message/started", 0, row("live", "private live", "streaming"));
  service.read = { ...snapshot([], undefined, "epoch-b"), conversation: { ...conversation, readOnly: true } };
  service.emit("bot/message/completed", 0, row("reset"), "epoch-b");
  await source.load(key);
  assert.deepEqual(ids(source), []);
  assert.equal(source.getSnapshot(key).descriptor.readOnly, true);
  await assert.rejects(source.cancel(key, "execution-a"), /read-only/);
  source.dispose();
});

test("Bot reconnect retains unadopted local sending and failed messages independently of transport epoch", async () => {
  for (const delivery of ["sending", "failed"] as const) {
    const service = new Service();
    const accepted = deferred<AppServerBotMethodResult<"bot/message/send">>();
    const sendService = Object.assign(service, { sendMessage: () => accepted.promise });
    const source = sendService.source();
    await source.load(key);
    const sent = source.send(key, intent);
    const outcome = sent.catch((error) => error);
    await Promise.resolve();
    if (delivery === "failed") {
      accepted.reject(new Error("send failed"));
      assert.match((await outcome).message, /send failed/);
    }
    // Preserve the command's original identity through a transport replacement.
    service.read = snapshot([row("anchor")], undefined, "epoch-b");
    service.emit("bot/message/completed", 0, row("reset"), "epoch-b");
    await source.load(key);
    assert.equal(source.getSnapshot(key).transcript.at(-1)?.clientMessageId, intent.clientMessageId);
    assert.equal(source.getSnapshot(key).transcript.at(-1)?.delivery, delivery);
    if (delivery === "sending") {
      accepted.resolve({ message: { ...row("ack"), clientMessageId: intent.clientMessageId }, executions: [], replayed: false });
      await sent;
    }
    source.dispose();
  }
});

test("Bot durable client identity adopts an optimistic message across reconnect", async () => {
  const service = new Service();
  const accepted = deferred<AppServerBotMethodResult<"bot/message/send">>();
  Object.assign(service, { sendMessage: () => accepted.promise });
  const source = service.source();
  await source.load(key);
  const sent = source.send(key, intent);
  await Promise.resolve();
  const acknowledgment = { ...row("ack"), clientMessageId: intent.clientMessageId };
  service.read = snapshot([row("anchor"), acknowledgment], undefined, "epoch-b");
  service.emit("bot/message/completed", 0, row("reset"), "epoch-b");
  await source.load(key);
  assert.deepEqual(ids(source), ["anchor", "ack"]);
  assert.equal(source.getSnapshot(key).transcript.at(-1)?.delivery, "sent");
  accepted.resolve({ message: acknowledgment, executions: [], replayed: false });
  await sent;
  source.dispose();
});

test("Bot durable adoption settles an old send failure successfully without resurrecting the optimistic row", async () => {
  const service = new Service();
  const accepted = deferred<AppServerBotMethodResult<"bot/message/send">>();
  let sendCalls = 0;
  Object.assign(service, { sendMessage: () => { sendCalls += 1; return accepted.promise; } });
  const source = service.source();
  await source.load(key);
  let failedDraftRestores = 0;
  const sent = source.send(key, intent).catch((error) => { failedDraftRestores += 1; throw error; });
  await Promise.resolve();
  const acknowledgment = { ...row("durable-ack", "confirmed"), clientMessageId: intent.clientMessageId, createdAtMs: 30 };
  service.read = snapshot([row("anchor"), acknowledgment], undefined, "epoch-b");
  service.emit("bot/message/completed", 0, row("reset"), "epoch-b");
  await source.load(key);
  accepted.reject(new Error("Old connection failed after delivery"));
  assert.deepEqual(await sent, { commandId: intent.commandId, clientMessageId: intent.clientMessageId,
    messageId: "durable-ack", acceptedAtMs: 30 });
  assert.equal(failedDraftRestores, 0);
  assert.deepEqual(ids(source), ["anchor", "durable-ack"]);
  assert.equal(source.getSnapshot(key).transcript.at(-1)?.delivery, "sent");
  assert.equal((await source.send(key, intent)).messageId, "durable-ack");
  assert.equal(sendCalls, 1);
  source.dispose();
});

test("Bot older-window durable acknowledgment adopts local ownership before an old send failure", async () => {
  const service = new Service();
  const accepted = deferred<AppServerBotMethodResult<"bot/message/send">>();
  Object.assign(service, { sendMessage: () => accepted.promise });
  const source = service.source();
  await source.load(key);
  const sent = source.send(key, intent);
  await Promise.resolve();
  service.page = { data: [row("anchor"), { ...row("durable-ack"), clientMessageId: intent.clientMessageId }] };
  await source.loadOlder(key);
  assert.deepEqual(ids(source), ["anchor", "durable-ack"]);
  assert.equal(source.getSnapshot(key).transcript.at(-1)?.delivery, "sent");
  accepted.reject(new Error("Old connection failed after delivery"));
  assert.equal((await sent).messageId, "durable-ack");
  source.dispose();
});

test("Bot durable adoption ignores an older send receipt and cannot regress completed execution", async () => {
  const service = new Service();
  const accepted = deferred<AppServerBotMethodResult<"bot/message/send">>();
  Object.assign(service, { sendMessage: () => accepted.promise });
  const source = service.source();
  await source.load(key);
  const sent = source.send(key, intent);
  await Promise.resolve();
  const acknowledgment = { ...row("durable-ack", "confirmed"), clientMessageId: intent.clientMessageId, createdAtMs: 30 };
  const completed = { executionId: "execution-a", conversationId: key.threadId, participantId: author.participantId,
    causalMessageId: acknowledgment.messageId, status: "completed" as const, startedAtMs: 2, completedAtMs: 30 };
  service.read = { ...snapshot([row("anchor"), acknowledgment], undefined, "epoch-b"), executions: [completed] };
  service.emit("bot/message/completed", 0, row("reset"), "epoch-b");
  await source.load(key);
  accepted.resolve({ message: { ...row("old-ack", "lagging"), clientMessageId: intent.clientMessageId },
    executions: [{ ...completed, status: "running", completedAtMs: undefined }], replayed: false });
  assert.equal((await sent).messageId, "durable-ack");
  assert.deepEqual(ids(source), ["anchor", "durable-ack"]);
  assert.equal(source.getSnapshot(key).executions[0]?.status, "completed");
  source.dispose();
});

test("Bot same-client concurrent send cannot issue a second request", { timeout: 1_000 }, async () => {
  const service = new Service();
  const accepted = deferred<AppServerBotMethodResult<"bot/message/send">>();
  let sendCalls = 0;
  Object.assign(service, { sendMessage: () => { sendCalls += 1; return accepted.promise; } });
  const source = service.source();
  await source.load(key);
  const sent = source.send(key, intent);
  await Promise.resolve();
  await assert.rejects(source.send(key, intent), /already being sent/i);
  assert.equal(sendCalls, 1);
  accepted.resolve({ message: { ...row("ack"), clientMessageId: intent.clientMessageId }, executions: [], replayed: false });
  await sent;
  source.dispose();
});

test("Bot backfill reprojects covered durable grouping without overwriting live text", async () => {
  const service = new Service();
  service.read = snapshot([{ ...row("assistant"), executionId: "partial" }], "older-1");
  const source = service.source();
  await source.load(key);
  service.emit("bot/message/started", 0, row("live", "in flight", "streaming"));
  service.page = { data: [row("user"), { ...row("assistant"), executionId: "real", causalMessageId: "user" }, row("live", "lagging")], nextCursor: "older-2" };
  await source.loadOlder(key);
  assert.deepEqual(ids(source), ["user", "assistant", "live"]);
  assert.equal(source.getSnapshot(key).transcript[1]?.executionId, "real");
  assert.equal(source.getSnapshot(key).transcript[1]?.causalMessageKey, "user");
  assert.equal(source.getSnapshot(key).transcript[2]?.content[0]?.type === "text" && source.getSnapshot(key).transcript[2]?.content[0]?.text, "in flight");
  source.dispose();
});

test("Bot overlapping backfill updates covered rows without moving an already loaded older prefix", async () => {
  const service = new Service();
  const source = service.source();
  await source.load(key);
  service.page = { data: [row("old")], nextCursor: "older-2" };
  await source.loadOlder(key);
  service.page = { data: [{ ...row("anchor"), executionId: "regrouped" }], nextCursor: "older-3" };
  await source.loadOlder(key);
  assert.deepEqual(ids(source), ["old", "anchor"]);
  assert.equal(source.getSnapshot(key).transcript[1]?.executionId, "regrouped");
  source.dispose();
});

test("Bot old history response is discarded after a replacement hydration", async () => {
  const service = new Service();
  const source = service.source();
  await source.load(key);
  const oldPage = deferred<Page>();
  service.page = oldPage.promise;
  const older = source.loadOlder(key);
  service.read = snapshot([row("replacement")], undefined, "epoch-b");
  service.emit("bot/message/completed", 0, row("reset"), "epoch-b");
  await source.load(key);
  oldPage.resolve({ data: [row("stale-private")], nextCursor: "stale-cursor" });
  await older;
  assert.deepEqual(ids(source), ["replacement"]);
  assert.deepEqual(source.getSnapshot(key).history, { hasOlder: false, loadingOlder: false });
  source.dispose();
});

test("Bot deletion and disposal invalidate pending history without a late publish", async () => {
  for (const action of ["delete", "dispose"] as const) {
    const service = new Service();
    const source = service.source();
    await source.load(key);
    const oldPage = deferred<Page>();
    service.page = oldPage.promise;
    const older = source.loadOlder(key);
    let publishes = 0;
    source.subscribe(key, () => { publishes += 1; });
    if (action === "delete") service.listener?.({ hostId: key.hostId, method: "bot/conversation/deleted", params: {
      conversationId: key.threadId, revision: 2, stamp: { epoch: "epoch-a", seq: 0 },
    } });
    else source.dispose();
    const before = publishes;
    oldPage.resolve({ data: [row("stale-private")], nextCursor: "stale-cursor" });
    await older;
    assert.equal(publishes, before, action);
    if (action === "delete") {
      assert.deepEqual(ids(source), ["anchor"]);
      assert.equal(source.getSnapshot(key).history.loadingOlder, false);
      source.dispose();
    }
  }
});

test("Bot rejects stationary and cyclic older cursors without advancing history", async () => {
  const service = new Service();
  const source = service.source();
  await source.load(key);
  service.page = { data: [], nextCursor: "older-1" };
  await assert.rejects(source.loadOlder(key), /earlier messages/i);
  assert.equal(service.listCalls, 1);
  assert.equal(source.getSnapshot(key).history.loadingOlder, false);
  service.page = { data: [], nextCursor: "older-2" };
  await source.loadOlder(key);
  service.page = { data: [], nextCursor: "older-1" };
  await assert.rejects(source.loadOlder(key), /earlier messages/i);
  assert.equal(service.listCalls, 3);
  assert.deepEqual(ids(source), ["anchor"]);
  source.dispose();
});
