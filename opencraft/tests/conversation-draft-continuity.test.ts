import assert from "node:assert/strict";
import test from "node:test";

import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { composerDocumentToPlainText, createComposerController, type ComposerDocument } from "@opencraft/composer-core";
import {
  asConversationScopeId,
  conversationDraftStoragePrefix,
  createConversationDraftContinuity,
  createConversationScopeLeaseRegistry,
  createConversationViewRegistry,
  type ConversationDraftStorage,
} from "@opencraft/workbench-runtime";

const target = { type: "existing-thread", key: createConversationKey("local", "thread-1") } as const;
const document = (text: string): ComposerDocument => ({ version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }] });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

function memoryStorage(): ConversationDraftStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    load: async key => data.get(key) ?? null,
    save: async (key, value) => { data.set(key, value); },
    remove: async key => { data.delete(key); },
  };
}

test("a View restores its draft after disposal without sharing it with another account", async () => {
  const storage = memoryStorage();
  const continuity = createConversationDraftContinuity({ namespace: "account-a", storage, delayMs: 0 });
  const first = createComposerController(target, { now: Date.now, createId: () => "first" });
  const stopFirst = continuity.attach("view-1", first);
  first.dispatch({ type: "set-document", document: document("unfinished") });
  await tick();
  stopFirst();
  await tick();
  first.dispose();

  const reopened = createComposerController(target, { now: Date.now, createId: () => "second" });
  const stopReopened = continuity.attach("view-1", reopened);
  await tick();
  assert.equal(composerDocumentToPlainText(reopened.getSnapshot().draft.document), "unfinished");
  stopReopened();
  reopened.dispose();

  const other = createComposerController(target, { now: Date.now, createId: () => "third" });
  const stopOther = createConversationDraftContinuity({ namespace: "account-b", storage, delayMs: 0 }).attach("view-1", other);
  await tick();
  assert.equal(composerDocumentToPlainText(other.getSnapshot().draft.document), "");
  assert.equal([...storage.data.keys()].every(key => key.startsWith(conversationDraftStoragePrefix("account-a"))), true);
  stopOther();
  other.dispose();
});

test("a late cached read cannot replace text already typed in the View", async () => {
  const storage = memoryStorage();
  const seed = createConversationDraftContinuity({ namespace: "account", storage, delayMs: 0 });
  const first = createComposerController(target, { now: Date.now, createId: () => "first" });
  const stopFirst = seed.attach("view", first);
  first.dispatch({ type: "set-document", document: document("older") });
  await tick();
  stopFirst();
  await tick();
  first.dispose();

  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const delayed: ConversationDraftStorage = {
    ...storage,
    async load(key) { await blocked; return storage.load(key); },
  };
  const second = createComposerController(target, { now: Date.now, createId: () => "second" });
  const stopSecond = createConversationDraftContinuity({ namespace: "account", storage: delayed, delayMs: 0 }).attach("view", second);
  second.dispatch({ type: "set-document", document: document("newer") });
  release();
  await tick();
  assert.equal(composerDocumentToPlainText(second.getSnapshot().draft.document), "newer");
  stopSecond();
  second.dispose();
});

test("promoting an accepted first turn discards the original new-thread draft", async () => {
  const storage = memoryStorage();
  const continuity = createConversationDraftContinuity({ namespace: "account", storage, delayMs: 0 });
  const leases = createConversationScopeLeaseRegistry({});
  const scopeId = asConversationScopeId("scope");
  const hostId = asHostId("local");
  const draftTarget = {
    type: "new-thread", draftId: "draft-1",
    execution: { hostId, workspace: { cwd: null, runtimeWorkspaceRoots: [] } },
  } as const;
  leases.ensure(scopeId, hostId, draftTarget);
  const views = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: Date.now, createId: () => "id" },
    draftContinuity: continuity,
  });
  const composer = views.ensure("view", scopeId, hostId, draftTarget).composer;
  composer.dispatch({ type: "set-document", document: document("sent") });
  await tick();
  views.bindScopeTarget(scopeId, target);
  await tick();
  assert.equal(storage.data.size, 0);
  views.dispose();
  leases.dispose();
});

test("credential rotation clears active and target-cached Composer text", async () => {
  const storage = memoryStorage();
  const leases = createConversationScopeLeaseRegistry({});
  const scopeId = asConversationScopeId("scope");
  const hostId = asHostId("local");
  const otherTarget = { type: "existing-thread", key: createConversationKey("local", "thread-2") } as const;
  leases.ensure(scopeId, hostId, target);
  const views = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: Date.now, createId: () => "id" },
    draftContinuity: createConversationDraftContinuity({ namespace: "old-account", storage, delayMs: 0 }),
  });
  const composer = views.ensure("view", scopeId, hostId, target).composer;
  composer.dispatch({ type: "set-document", document: document("old first thread") });
  views.bindScopeTarget(scopeId, otherTarget);
  composer.dispatch({ type: "set-document", document: document("old second thread") });
  views.replaceDraftContinuity(createConversationDraftContinuity({ namespace: "new-account", storage, delayMs: 0 }));
  assert.equal(composerDocumentToPlainText(composer.getSnapshot().draft.document), "");
  views.bindScopeTarget(scopeId, target);
  await tick();
  assert.equal(composerDocumentToPlainText(composer.getSnapshot().draft.document), "");
  views.dispose();
  leases.dispose();
});
