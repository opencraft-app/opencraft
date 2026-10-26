import assert from "node:assert/strict";
import test from "node:test";
import { createConversationKey } from "@opencraft/chat-core";
import { createConversationOutbox, SubmissionOutcomeUnknownError, type ConversationOutboxEntry, type ConversationOutboxStorage } from "@opencraft/chat-runtime";
import type { SubmitIntent } from "@opencraft/composer-core";
import { createBrowserConversationOutbox } from "../../apps/workbench-web/src/runtime/browser-conversation-outbox";

const key = createConversationKey("host-a", "thread-a");
function intent(id: string): SubmitIntent {
  return { commandId: id, clientMessageId: `client-${id}`, target: { type: "existing-thread", key },
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: id }] }] },
    attachments: [], context: [], selections: { model: "m", permissionProfile: null }, options: { autoContext: true }, createdAt: 1 };
}
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); },
    removeItem: (k: string) => { values.delete(k); }, key: (n: number) => [...values.keys()][n] ?? null,
    get length() { return values.size; }, clear: () => values.clear() };
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function fixture(send?: (i: SubmitIntent) => Promise<void>) {
  let ready = false;
  let rows: readonly ConversationOutboxEntry[] = [];
  let fail = false;
  const listeners = new Set<() => void>();
  const storage: ConversationOutboxStorage = { read: () => rows, write: (_, next) => {
    if (fail) throw new Error("Quota exceeded"); rows = structuredClone(next);
  }, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const sent: SubmitIntent[] = [];
  const create = () => createConversationOutbox({ key, storage, ready: () => ready, blocked: () => false, publish() {}, retire() {},
    async send(i) { sent.push(i); await send?.(i); return { commandId: i.commandId, clientMessageId: i.clientMessageId, hostId: key.hostId, threadId: key.threadId, turnId: null, acceptedAt: 1, replayed: false }; } });
  return { create, sent, rows: () => rows, ready: () => { ready = true; }, fail: () => { fail = true; },
    changeScope: () => { rows = []; for (const listener of listeners) listener(); } };
}

test("offline input survives reload and moves FIFO into the Host queue once authoritative", async () => {
  const f = fixture(); const original = f.create();
  await original.admit(intent("one")); await original.admit(intent("two"));
  assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 2);
  original.dispose(); const restored = f.create();
  assert.deepEqual(restored.project().map(i => i.preview), ["one", "two"]);
  f.ready(); restored.wake(); restored.wake(); await settle();
  assert.deepEqual(f.sent.map(i => i.clientMessageId), ["client-one", "client-two"]);
  assert.ok(f.sent.every(i => i.target.type === "enqueue-follow-up")); assert.equal(f.rows().length, 0);
  restored.dispose();
});

test("quota, capacity and attachment refusal never claim local custody", async () => {
  const f = fixture(); const box = f.create(); f.fail();
  await assert.rejects(box.admit(intent("quota")), /Quota/); assert.equal(box.project().length, 0); box.dispose();
  const other = fixture(); const q = other.create();
  await assert.rejects(q.admit({ ...intent("attachment"), context: [{ id: "c", kind: "file", title: "file", uri: "blob:x", visible: true }] }), /Reconnect/);
  for (let i = 0; i < 50; i++) await q.admit(intent(String(i)));
  await assert.rejects(q.admit(intent("overflow")), /full/); q.dispose();
});

test("cancel and duplicate local admission preserve order without remote effects", async () => {
  const f = fixture(); const box = f.create(); await box.admit(intent("one")); await box.admit(intent("one")); await box.admit(intent("two"));
  assert.equal(box.project().length, 2); assert.equal(await box.remove("one"), true);
  f.ready(); box.wake(); await settle(); assert.deepEqual(f.sent.map(i => i.commandId), ["two"]); box.dispose();
});

test("lost ACK blocks FIFO until positive server proof, including across reload", async () => {
  const f = fixture(async () => { throw new SubmissionOutcomeUnknownError(); }); const box = f.create();
  await box.admit(intent("one")); await box.admit(intent("two")); f.ready(); box.wake(); await settle();
  assert.equal(box.project()[0]?.state, "unknown"); box.wake(); await settle(); assert.equal(f.sent.length, 1);
  box.dispose(); const restored = f.create(); restored.wake(); await settle(); assert.equal(f.sent.length, 1);
  await restored.reconcile(new Set(["client-one"])); assert.equal(restored.project()[0]?.clientMessageId, "client-two"); restored.dispose();
});

test("a tab reloaded during send does not replay the attempt", async () => {
  let release!: () => void; const f = fixture(() => new Promise<void>(r => { release = r; })); const box = f.create();
  await box.admit(intent("one")); f.ready(); box.wake(); await settle(); assert.equal(f.rows()[0]?.state, "sending");
  box.dispose(); const restored = f.create(); assert.equal(restored.project()[0]?.state, "unknown"); restored.wake();
  release(); await settle(); assert.equal(f.sent.length, 1); assert.equal(f.rows().length, 1); restored.dispose();
});

test("late completion cannot overwrite a replacement account queue", async () => {
  let release!: () => void; const f = fixture(() => new Promise<void>(r => { release = r; })); const box = f.create();
  await box.admit(intent("old")); f.ready(); box.wake(); await settle(); f.changeScope(); release(); await settle();
  assert.equal(box.project().length, 0); assert.equal(f.rows().length, 0); box.dispose();
});

test("browser adapter partitions server, account, Host, profile and thread and revokes old scopes", () => {
  const storage = memoryStorage(); let scope: string | null = "server-a/account-a";
  const manager = createBrowserConversationOutbox({ storage, scope: () => scope }); const first = manager.forProfile(1);
  first.write(key, [{ intent: intent("one"), state: "waiting" }]);
  assert.equal(first.read(key).length, 1); assert.equal(first.read(createConversationKey("host-b", "thread-a")).length, 0);
  assert.equal(first.read(createConversationKey("host-a", "thread-b")).length, 0); assert.equal(manager.forProfile(2).read(key).length, 0);
  const peer = createBrowserConversationOutbox({ storage, scope: () => "server-b/account-a" }); assert.equal(peer.forProfile(1).read(key).length, 0);
  scope = "server-a/account-b"; manager.refreshScope(); assert.equal(first.read(key).length, 0);
  scope = "server-a/account-a"; manager.refreshScope(); assert.equal(first.read(key).length, 0);
  scope = null; manager.refreshScope(); assert.throws(() => first.write(key, [{ intent: intent("denied"), state: "waiting" }]), /identity/);
});

test("corrupt persisted input fails visibly rather than partially replaying it", () => {
  const storage = memoryStorage(); const manager = createBrowserConversationOutbox({ storage, scope: () => "account" });
  const port = manager.forProfile(1); port.write(key, [{ intent: intent("one"), state: "waiting" }]);
  storage.setItem(storage.key(0)!, '{"version":1,"entries":[{}]}'); assert.throws(() => port.read(key), /Invalid/);
});


test("browser custody refuses a document that could not survive reload", () => {
  const storage = memoryStorage();
  const port = createBrowserConversationOutbox({ storage, scope: () => "account" }).forProfile(1);
  const oversized = intent("x".repeat(128 * 1024));
  assert.throws(() => port.write(key, [{ intent: oversized, state: "waiting" }]), /cannot be saved/);
  assert.equal(storage.length, 0);
});


test("server confirmation before a lost RPC ACK continues draining the next input", async () => {
  let box: ReturnType<typeof createConversationOutbox>;
  const f = fixture(async i => {
    if (i.commandId === "one") {
      box.reconcile(new Set([i.clientMessageId]));
      throw new SubmissionOutcomeUnknownError();
    }
  });
  box = f.create(); await box.admit(intent("one")); await box.admit(intent("two"));
  f.ready(); box.wake(); await settle();
  assert.deepEqual(f.sent.map(i => i.commandId), ["one", "two"]);
  assert.equal(box.project().length, 0); box.dispose();
});

test("browser queue preserves Fast and explicit Standard across reload", () => {
  const storage = memoryStorage();
  for (const serviceTier of ["fast", null]) {
    const first = createBrowserConversationOutbox({ storage, scope: () => "account" }).forProfile(1);
    first.write(key, [{ intent: { ...intent("speed"), selections: { serviceTier } }, state: "waiting" }]);
    const restored = createBrowserConversationOutbox({ storage, scope: () => "account" }).forProfile(1).read(key);
    assert.equal(restored[0]?.intent.selections.serviceTier, serviceTier);
  }
});

test("late positive proof wakes FIFO without another connection event or resending the uncertain input", async () => {
  const f = fixture(async i => { if (i.commandId === "one") throw new SubmissionOutcomeUnknownError(); });
  const box = f.create(); await box.admit(intent("one")); await box.admit(intent("two"));
  f.ready(); box.wake(); await settle();
  assert.equal(box.project()[0]?.state, "unknown");
  box.reconcile(new Set(["client-one"]));
  await settle();
  assert.deepEqual(f.sent.map(i => i.commandId), ["one", "two"]);
  assert.equal(box.project().length, 0); box.dispose();
});

test("synchronous readiness loss after custody publication keeps the undispatched input waiting", async () => {
  let ready = false; let revoke = true; let sent = 0;
  let rows: readonly ConversationOutboxEntry[] = [];
  let box: ReturnType<typeof createConversationOutbox>;
  box = createConversationOutbox({ key,
    storage: { read: () => rows, write: (_, next) => { rows = next; }, subscribe: () => () => {} },
    ready: () => ready, blocked: () => false, retire() {},
    publish() { if (revoke && rows[0]?.state === "sending") { revoke = false; ready = false; } },
    async send(i) { sent++; return { commandId: i.commandId, clientMessageId: i.clientMessageId,
      hostId: key.hostId, threadId: key.threadId, turnId: null, acceptedAt: 1, replayed: false }; },
  });
  await box.admit(intent("one")); ready = true; box.wake(); await settle();
  assert.equal(sent, 0); assert.equal(rows[0]?.state, "waiting");
  ready = true; box.wake(); await settle();
  assert.equal(sent, 1); assert.equal(rows.length, 0); box.dispose();
});

test('one local outbox owns cold-start input before a Thread exists and later attaches its live dispatcher', async () => {
  const f = fixture(); const box = f.create();
  await box.admit(intent('cold'));
  let sends = 0, notifications = 0;
  const unsubscribe = box.subscribe(() => { notifications++; });
  let releaseSend!: () => void;
  const detach = box.attach({ ready: () => true, blocked: () => false, publish() {}, retire() {},
    async send(input, options) {
      assert.equal(options.canDispatch(), true); sends++;
      await new Promise<void>(resolve => { releaseSend = resolve; });
      return { commandId: input.commandId, clientMessageId: input.clientMessageId, hostId: key.hostId, threadId: key.threadId, turnId: null, acceptedAt: 1, replayed: false };
    },
  });
  for (let n = 0; n < 20 && !sends; n++) await settle();
  assert.equal(sends, 1); detach();
  assert.equal(box.project()[0]?.state, 'unknown');
  releaseSend(); await settle();
  assert.equal(box.project().length, 1, 'late dispatcher ACK cannot erase replacement custody');
  await box.admit(intent('later'));
  box.attach({ ready: () => true, blocked: () => false, publish() {}, retire() {}, send: async () => { throw new Error('unknown must block FIFO'); } });
  await box.ready(); box.wake(); await settle();
  assert.equal(sends, 1); assert.equal(box.project().length, 2); assert.ok(notifications > 0);
  unsubscribe(); box.dispose();
});
