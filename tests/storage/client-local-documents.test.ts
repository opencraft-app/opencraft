import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { ClientLocalDocuments } from "@opencraft/document-storage/client-local-documents";
import type { ClientResourcePersistence } from "@opencraft/document-storage/client-resources";
import { SqliteClientResources } from "@opencraft/document-storage/client-resources-sqlite";
import { openIndexedDbClientResources } from "../../apps/workbench-web/src/runtime/indexeddb-client-resources";
import { readMigratingLocalDocument } from "../../apps/workbench-web/src/runtime/local-document-migration";
import { createBrowserConversationDraftStorage } from "../../apps/workbench-web/src/runtime/browser-conversation-drafts";
import { createPersistentComposerDrafts, BrowserComposerDrafts } from "../../apps/workbench-web/src/runtime/browser-composer-drafts";
import { createBrowserConversationOutbox } from "../../apps/workbench-web/src/runtime/browser-conversation-outbox";
import { createConversationOutbox, type ConversationOutboxEntry } from "@opencraft/chat-runtime";
import { createComposerController, encodeComposerTarget, type SubmitIntent, type ComposerTarget } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { conversationDraftStorageKey, serializeConversationDraftDocument } from "@opencraft/workbench-runtime";

Object.assign(globalThis, { IDBKeyRange });
class MemoryStorage {
  values = new Map<string, string>();
  getItem = (key: string) => this.values.get(key) ?? null;
  setItem = (key: string, value: string) => { this.values.set(key, value); };
  removeItem = (key: string) => { this.values.delete(key); };
  key = (index: number) => [...this.values.keys()][index] ?? null;
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
}
const document = (text: string) => ({ version: 1 as const, blocks: [{ type: "paragraph" as const, children: [{ type: "text" as const, text }] }] });
const key = createConversationKey("host", "thread");
const target: ComposerTarget = { type: "existing-thread", key };
const intent = (id: string): SubmitIntent => ({ commandId: id, clientMessageId: id, target, document: document(id),
  attachments: [], context: [], selections: {}, options: { autoContext: false }, createdAt: 1 });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

for (const kind of ["sqlite", "indexeddb"] as const) {
  test(`${kind}: migrate task/Bot drafts, restart, tombstones, rich draft budget and targeted revocation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "oc-local-documents-"));
    const factory = new IDBFactory();
    const open = () => kind === "sqlite" ? Promise.resolve(new SqliteClientResources(join(root, "local.sqlite"))) : openIndexedDbClientResources("local", factory);
    let storage = await open();
    const legacy = new MemoryStorage();
    const previousWindow = globalThis.window;
    Object.assign(globalThis, { window: { localStorage: legacy } });
    try {
      const docs = new ClientLocalDocuments(Promise.resolve(storage), "account", "conversation-draft");
      const task = createBrowserConversationDraftStorage("account", docs);
      const draftTarget: ComposerTarget = { type: "new-thread", draftId: "saved-new", execution: { hostId: "host", workspace: { cwd: null, runtimeWorkspaceRoots: [] } } };
      const savedKey = conversationDraftStorageKey("account", "view", draftTarget);
      const saved = serializeConversationDraftDocument(document("task input"), draftTarget)!;
      legacy.setItem(savedKey, saved);
      assert.equal(await task.storage.load(savedKey), saved);
      assert.equal(legacy.getItem(savedKey), null, "only remove source after accepted import");
      assert.equal((await task.loadNewTarget("saved-new"))?.draftId, "saved-new");
      assert.equal(await task.loadViewId(draftTarget), "view", "a fresh document restores the existing input slot rather than copying input");
      const botDocs = new ClientLocalDocuments(Promise.resolve(storage), "account", "composer-draft");
      new BrowserComposerDrafts(legacy, "bot").write(target, { document: document("Bot input"), attachments: [], context: [] });
      const bot = createPersistentComposerDrafts(legacy, "bot", botDocs);
      assert.deepEqual((await bot.read(target))?.document, document("Bot input"));
      assert.equal(legacy.getItem(`bot:${encodeComposerTarget(target)}`), null);
      await bot.write(target, { document: document("x".repeat(2 * 1024 * 1024)), attachments: [], context: [] });
      const remote = { namespace: "account", name: "thread-catalog", id: "host", authority: "remote" as const };
      await assert.rejects(storage.compareAndSet(remote, 0, { version: 2, savedAt: 1, value: "x".repeat(1024 * 1024) }), /quota/);
      await storage.clearRemoteNamespace("account");
      await task.storage.remove(savedKey);
      legacy.setItem(savedKey, saved); // An old source that could not be deleted cannot revive a removed draft.
      await storage.close(); storage = await open();
      const reopened = new ClientLocalDocuments(Promise.resolve(storage), "account", "conversation-draft");
      assert.equal(await readMigratingLocalDocument(reopened, savedKey, legacy), null);
      const restoredBot = createPersistentComposerDrafts(legacy, "bot", new ClientLocalDocuments(Promise.resolve(storage), "account", "composer-draft"));
      assert.equal((await restoredBot.read(target))?.document.blocks.length, 1);
      await reopened.revokeAndClear();
      assert.deepEqual(await storage.listLocalKeys("account", "conversation-draft"), []);
      assert.equal((await storage.listLocalKeys("account", "composer-draft")).length, 1);
    } finally { Object.assign(globalThis, { window: previousWindow }); await storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test(`${kind}: outbox migrates old tab input, rejects concurrent custody and never replays a persisted attempt`, async () => {
    const root = mkdtempSync(join(tmpdir(), "oc-local-outbox-"));
    const storage = kind === "sqlite" ? new SqliteClientResources(join(root, "queue.sqlite")) : await openIndexedDbClientResources("queue", new IDBFactory());
    const legacy = new MemoryStorage();
    const old = createBrowserConversationOutbox({ storage: legacy as Storage, scope: () => "account" }).forProfile(1);
    old.write(key, [{ intent: intent("old-input"), state: "waiting" }]);
    const manager = () => createBrowserConversationOutbox({ storage: legacy as Storage, scope: () => "account",
      documents: scope => new ClientLocalDocuments(Promise.resolve(storage), scope, "conversation-outbox") });
    const port = manager().forProfile(1);
    try {
      assert.equal((await port.read(key))[0]?.intent.commandId, "old-input");
      assert.equal(legacy.length, 0);
      const peerPort = manager().forProfile(1); await peerPort.read(key);
      await port.write(key, [{ intent: intent("old-input"), state: "waiting" }, { intent: intent("next"), state: "waiting" }]);
      await assert.rejects(Promise.resolve().then(() => peerPort.write(key, [])), /conflict/);
      let ready = false, sends = 0;
      let release!: () => void;
      const box = createConversationOutbox({ key, storage: port, ready: () => ready, blocked: () => false, publish() {}, retire() {},
        send: async input => { sends++; await new Promise<void>(resolve => { release = resolve; }); return { commandId: input.commandId, clientMessageId: input.clientMessageId, hostId: "host", threadId: "thread", turnId: null, acceptedAt: 1, replayed: false }; } });
      await box.ready(); assert.equal(box.project().length, 2);
      box.wake(); await tick(); assert.equal(sends, 0, "remembered input does not authorize sending");
      ready = true; box.wake();
      for (let n = 0; n < 50 && !sends; n++) await tick();
      assert.equal(sends, 1); box.dispose();
      const restored = createConversationOutbox({ key, storage: manager().forProfile(1), ready: () => true, blocked: () => false, publish() {}, retire() {}, send: async () => { throw new Error("must not replay"); } });
      await restored.ready(); assert.equal(restored.project()[0]?.state, "unknown");
      release(); await tick(); restored.wake(); await tick(); assert.equal(sends, 1);
      restored.dispose();
    } finally { await storage.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("failed import preserves legacy input; custody and transport wait for an accepted asynchronous write", async () => {
  const legacy = new MemoryStorage(); legacy.setItem("draft", "original");
  let fail = true, release!: () => void;
  const rows = new Map<string, { revision: number; version: number; savedAt: number; value: string | null }>();
  const storage: ClientResourcePersistence = {
    read: async key => rows.get(key.id) ?? null,
    compareAndSet: async (key, revision, row) => { if (fail) throw new Error("quota"); await new Promise<void>(r => { release = r; }); rows.set(key.id, { ...row, value: row.value as string | null, revision: revision + 1 }); return true; },
    listLocalKeys: async () => [], clearLocalResource: async () => { rows.clear(); }, clearRemoteNamespace: async () => {}, close() {},
  };
  const docs = new ClientLocalDocuments(Promise.resolve(storage), "account", "conversation-draft");
  assert.equal(await readMigratingLocalDocument(docs, "draft", legacy), "original");
  assert.equal(legacy.getItem("draft"), "original");
  await assert.rejects(docs.write("draft", "changed"), /quota/);
  fail = false;
  let accepted = false;
  const writing = docs.write("draft", "changed").then(() => { accepted = true; });
  await tick(); assert.equal(accepted, false); assert.equal(rows.size, 0);
  release(); await writing; assert.equal(accepted, true);
  let writeRelease!: () => void, sent = 0, admitted = false;
  const queue = createConversationOutbox({ key, storage: { read: () => [], write: async () => { await new Promise<void>(resolve => { writeRelease = resolve; }); }, subscribe: () => () => {} },
    ready: () => false, blocked: () => false, publish() {}, retire() {}, send: async () => { sent++; throw new Error("must not send"); } });
  const admission = queue.admit(intent("pending")).then(() => { admitted = true; });
  await tick(); assert.equal(admitted, false); assert.equal(queue.project().length, 0); assert.equal(sent, 0);
  writeRelease(); await admission; assert.equal(admitted, true); queue.dispose();
});

test("late asynchronous Bot draft hydration never replaces newly typed content", async () => {
  let resolve!: (value: { document: ReturnType<typeof document>; attachments: []; context: [] }) => void;
  const controller = createComposerController(target, { now: Date.now, createId: () => "draft", drafts: {
    read: () => new Promise(r => { resolve = r; }), write: async () => {},
  } });
  controller.dispatch({ type: "set-document", document: document("new input") });
  resolve({ document: document("old saved input"), attachments: [], context: [] }); await tick();
  assert.deepEqual(controller.getSnapshot().draft.document, document("new input")); controller.dispose();
});
