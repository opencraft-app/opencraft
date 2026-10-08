import assert from "node:assert/strict";
import test from "node:test";

import { asHostId, createConversationKey } from "@opencraft/chat-core";
import {
  composerDocumentToPlainText,
  type ComposerController,
  type ComposerDocument,
  type ComposerStoreServices,
  type ComposerTarget,
} from "@opencraft/composer-core";
import {
  conversationDraftStorageKey,
  createConversationDraftContinuity,
  serializeConversationDraftDocument,
  type ConversationDraftContinuity,
} from "@opencraft/workbench-runtime";
import {
  ConversationDraftCapacityError,
  createConversationDraftOwnerRegistry,
} from "../packages/workbench-runtime/src/conversation-draft-owner-registry";

const hostId = asHostId("local");
const target = (id: string): ComposerTarget => ({ type: "existing-thread", key: createConversationKey(hostId, id) });
const document = (text: string): ComposerDocument => ({
  version: 1,
  blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
});
const content = (composer: ComposerController, text: string) => composer.dispatch({ type: "set-document", document: document(text) });
const text = (composer: ComposerController) => composerDocumentToPlainText(composer.getSnapshot().draft.document);
function services(): ComposerStoreServices {
  let id = 0;
  return { now: () => id, createId: () => `draft-${++id}` };
}

test("51 content owners evict the least recently used inactive draft, including attachment resources", () => {
  const removed: string[] = [];
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), onEvict: id => removed.push(id) });
  const first = registry.ensure("slot-0", hostId, target("thread-0")).composer;
  const originalId = first.getSnapshot().draft.id;
  first.dispatch({ type: "add-attachment", attachment: {
    id: "image", name: "image.png", mimeType: "image/png", size: 12,
    uri: null, lifecycle: "processing", error: null,
  } });
  let released = 0;
  first.onDispose(() => { released++; });
  for (let index = 1; index <= 50; index++) {
    content(registry.ensure(`slot-${index}`, hostId, target(`thread-${index}`)).composer, `draft ${index}`);
  }
  assert.deepEqual(removed, ["slot-0"]);
  assert.equal(registry.get("slot-0"), null);
  assert.equal(released, 1);
  assert.throws(() => first.updateDraftAttachment(originalId, "image", { uri: "late", lifecycle: "ready" }), /disposed/u);
  assert.equal(registry.get("slot-50")?.composer.getSnapshot().draft.attachments.length, 0);
  registry.dispose();
});

test("empty owners do not consume capacity and the last editor release removes an empty owner", () => {
  const removed: string[] = [];
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), onEvict: id => removed.push(id) });
  for (let index = 0; index < 60; index++) registry.ensure(`empty-${index}`, hostId, target(`empty-${index}`));
  for (let index = 0; index < 50; index++) content(registry.ensure(`content-${index}`, hostId, target(`content-${index}`)).composer, "saved");
  assert.equal(registry.get("content-0") !== null, true);
  assert.deepEqual(removed, []);
  const releaseFirst = registry.retain("empty-0", "main");
  const releaseSecond = registry.retain("empty-0", "interaction");
  releaseFirst();
  assert.equal(registry.get("empty-0")?.retainCount, 1);
  releaseSecond();
  releaseSecond();
  assert.equal(registry.get("empty-0"), null);
  assert.deepEqual(removed, ["empty-0"]);
  registry.dispose();
});

test("50 retained drafts protect editing even when an older active draft is least recently used", () => {
  const registry = createConversationDraftOwnerRegistry({ composerServices: services() });
  const releases: Array<() => void> = [];
  for (let index = 0; index < 50; index++) {
    const ownerId = `active-${index}`;
    const composer = registry.ensure(ownerId, hostId, target(ownerId)).composer;
    releases.push(registry.retain(ownerId, "editor"));
    content(composer, ownerId);
  }
  const extra = registry.ensure("inactive", hostId, target("inactive")).composer;
  assert.throws(() => content(extra, "over capacity"), ConversationDraftCapacityError);
  assert.equal(extra.getSnapshot().hasContent, false);
  for (let index = 0; index < 50; index++) assert.equal(registry.get(`active-${index}`)?.retainCount, 1);
  assert.equal(registry.close("active-0"), false);
  for (const release of releases) release();
  registry.dispose();
});

test("all 50 active drafts reject new content until one becomes eligible for eviction", () => {
  const removed: string[] = [];
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), onEvict: id => removed.push(id) });
  const releases: Array<() => void> = [];
  for (let index = 0; index < 50; index++) {
    const ownerId = `active-${index}`;
    const composer = registry.ensure(ownerId, hostId, target(ownerId)).composer;
    releases.push(registry.retain(ownerId, "editor"));
    content(composer, ownerId);
  }
  const extra = registry.ensure("active-50", hostId, target("active-50")).composer;
  releases.push(registry.retain("active-50", "editor"));
  assert.equal(registry.canAdmitContent("active-50"), false);
  assert.throws(() => content(extra, "new input"), ConversationDraftCapacityError);
  assert.equal(extra.getSnapshot().hasContent, false);
  assert.deepEqual(removed, []);
  releases[0]!();
  assert.equal(registry.canAdmitContent("active-50"), true);
  content(extra, "new input");
  assert.deepEqual(removed, ["active-0"]);
  assert.equal(registry.get("active-50")?.composer.getSnapshot().hasContent, true);
  registry.dispose();
  for (const release of releases) assert.doesNotThrow(release);
});

test("retain, release, explicit touch and content edits update inactive LRU ordering", () => {
  const removed: string[] = [];
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), maxDrafts: 3, onEvict: id => removed.push(id) });
  for (const id of ["a", "b", "c"]) content(registry.ensure(id, hostId, target(id)).composer, id);
  registry.retain("a", "editor")();
  registry.touch("b");
  content(registry.get("c")!.composer, "c edited");
  content(registry.ensure("d", hostId, target("d")).composer, "d");
  assert.deepEqual(removed, ["a"]);
  // Submission status changes do not count as a user revisiting the draft.
  registry.get("b")!.composer.dispatch({ type: "set-lifecycle", phase: "failed", error: "retry" });
  content(registry.ensure("e", hostId, target("e")).composer, "e");
  assert.deepEqual(removed, ["a", "b"]);
  registry.dispose();
});

test("a submitting owner remains protected until settlement, including a cached target", () => {
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), maxDrafts: 1 });
  const sending = registry.ensure("sending", hostId, target("a")).composer;
  content(sending, "A sends");
  const draftId = sending.getSnapshot().draft.id;
  const intent = sending.createSubmitIntent();
  sending.dispatch({ type: "set-lifecycle", phase: "submitting" });
  registry.bindTarget("sending", target("b"));
  content(sending, "B still edits");
  const other = registry.ensure("other", hostId, target("other")).composer;
  assert.throws(() => content(other, "other"), ConversationDraftCapacityError);
  assert.equal(other.getSnapshot().hasContent, false);
  assert.equal(registry.close("sending"), false);
  assert.equal(sending.settleSubmission(draftId, intent, { status: "accepted" }), true);
  assert.equal(text(sending), "B still edits");
  assert.equal(registry.close("sending"), true);
  assert.equal(sending.settleSubmission(draftId, intent, { status: "accepted" }), false);
  registry.dispose();
});

test("hidden target content consumes capacity and survives the editor's last release", () => {
  const removed: string[] = [];
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), maxDrafts: 1, onEvict: id => removed.push(id) });
  const composer = registry.ensure("slot", hostId, target("a")).composer;
  const release = registry.retain("slot", "editor");
  content(composer, "hidden A");
  registry.bindTarget("slot", target("b"));
  assert.equal(composer.getSnapshot().hasContent, false);
  assert.equal(composer.hasRetainedContent(), true);
  assert.equal(composer.hasTargetContent(target("a")), true);
  const other = registry.ensure("other", hostId, target("other")).composer;
  assert.equal(registry.canAdmitContent("other"), false);
  assert.throws(() => content(other, "cannot exceed capacity"), ConversationDraftCapacityError);
  release();
  assert.equal(registry.get("slot")?.composer, composer);
  assert.deepEqual(removed, []);
  registry.bindTarget("slot", target("a"));
  assert.equal(text(composer), "hidden A");
  content(other, "replaces unused slot");
  assert.equal(registry.get("slot"), null);
  assert.deepEqual(removed, ["slot"]);
  registry.dispose();
});

test("a late cached acceptance reclaims an unused now-empty owner, while failure keeps its input", () => {
  for (const outcome of ["accepted", "failed"] as const) {
    const removed: string[] = [];
    const registry = createConversationDraftOwnerRegistry({ composerServices: services(), onEvict: id => removed.push(id) });
    const composer = registry.ensure("slot", hostId, target("a")).composer;
    const release = registry.retain("slot", "editor");
    content(composer, "A sends");
    const draftId = composer.getSnapshot().draft.id;
    const intent = composer.createSubmitIntent();
    composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
    registry.bindTarget("slot", target("b"));
    release();
    assert.equal(registry.get("slot")?.composer, composer);
    assert.equal(composer.settleSubmission(draftId, intent,
      outcome === "accepted" ? { status: "accepted" } : { status: "failed", error: "try again" }), true);
    if (outcome === "accepted") {
      assert.equal(registry.get("slot"), null);
      assert.deepEqual(removed, ["slot"]);
    } else {
      assert.equal(registry.get("slot")?.composer, composer);
      assert.equal(composer.hasTargetContent(target("a")), true);
      assert.deepEqual(removed, []);
      registry.bindTarget("slot", target("a"));
      assert.equal(text(composer), "A sends");
    }
    registry.dispose();
  }
});

test("an active owner's cached accepted target becomes empty without stale capacity information", () => {
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), maxDrafts: 1 });
  const composer = registry.ensure("slot", hostId, target("a")).composer;
  const release = registry.retain("slot", "editor");
  content(composer, "A sends");
  const draftId = composer.getSnapshot().draft.id;
  const intent = composer.createSubmitIntent();
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  registry.bindTarget("slot", target("b"));
  assert.equal(composer.settleSubmission(draftId, intent, { status: "accepted" }), true);
  assert.equal(composer.hasRetainedContent(), false);
  const other = registry.ensure("other", hostId, target("other")).composer;
  registry.retain("other", "editor");
  content(other, "all capacity now used by other");
  assert.doesNotThrow(() => registry.bindTarget("slot", target("a")));
  assert.equal(composer.getSnapshot().hasContent, false);
  assert.equal(registry.get("slot")?.composer, composer);
  release();
  assert.equal(registry.get("slot"), null);
  registry.dispose();
});

test("a cached accepted submission discards its detached saved target without changing other input", async () => {
  const data = new Map<string, string>();
  const continuity = createConversationDraftContinuity({ namespace: "account", delayMs: 0, storage: {
    load: async key => data.get(key) ?? null,
    save: async (key, value) => { data.set(key, value); },
    remove: async key => { data.delete(key); },
  } });
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), draftContinuity: continuity });
  const composer = registry.ensure("slot", hostId, target("a")).composer;
  registry.retain("slot", "editor");
  content(composer, "A sends");
  await new Promise(resolve => setTimeout(resolve, 5));
  const aKey = conversationDraftStorageKey("account", "slot", target("a"));
  assert.equal(data.has(aKey), true);
  const draftId = composer.getSnapshot().draft.id;
  const intent = composer.createSubmitIntent();
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  registry.bindTarget("slot", target("b"));
  content(composer, "B remains unsent");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(composer.settleSubmission(draftId, intent, { status: "accepted" }), true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(data.has(aKey), false);
  assert.equal(text(composer), "B remains unsent");
  registry.bindTarget("slot", target("a"));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(text(composer), "");
  registry.bindTarget("slot", target("b"));
  assert.equal(text(composer), "B remains unsent");
  registry.dispose();
});

test("asset preparation completion does not make an unused draft more recently used", () => {
  const removed: string[] = [];
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), maxDrafts: 2, onEvict: id => removed.push(id) });
  const first = registry.ensure("first", hostId, target("first")).composer;
  first.dispatch({ type: "add-attachment", attachment: {
    id: "image", name: "image.png", mimeType: "image/png", size: 12,
    uri: null, lifecycle: "processing", error: null,
  } });
  content(registry.ensure("second", hostId, target("second")).composer, "newer");
  first.updateDraftAttachment(first.getSnapshot().draft.id, "image", { uri: "ready", lifecycle: "ready" });
  content(registry.ensure("third", hostId, target("third")).composer, "newest");
  assert.deepEqual(removed, ["first"]);
  registry.dispose();
});

test("capacity protects text, attachment, context and transient-input admission before mutating content", () => {
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), maxDrafts: 1 });
  const first = registry.ensure("first", hostId, target("first")).composer;
  const releaseFirst = registry.retain("first", "editor");
  content(first, "protected");
  const second = registry.ensure("second", hostId, target("second")).composer;
  const releaseSecond = registry.retain("second", "editor");
  assert.throws(() => second.dispatch({ type: "replace-content", document: document("new"), attachments: [], context: [] }), ConversationDraftCapacityError);
  assert.throws(() => second.dispatch({ type: "add-attachment", attachment: {
    id: "file", name: "file.txt", mimeType: "text/plain", size: 1,
    uri: "file", lifecycle: "ready", error: null,
  } }), ConversationDraftCapacityError);
  assert.throws(() => second.dispatch({ type: "add-context", reference: {
    id: "context", kind: "file", title: "context", uri: "context", visible: true,
  } }), ConversationDraftCapacityError);
  let provisional = "";
  second.registerView({
    focus() {}, blur() {}, insertText() {}, undo() {}, redo() {},
    beginTransientTextInput() { return { update(value) { provisional = value; }, commit() { return false; }, cancel() { provisional = ""; } }; },
  });
  const input = second.beginTransientTextInput()!;
  assert.throws(() => input.update("speech"), ConversationDraftCapacityError);
  assert.equal(provisional, "");
  assert.equal(second.getSnapshot().hasContent, false);
  releaseFirst();
  input.update("speech");
  assert.equal(registry.get("first"), null);
  assert.equal(second.getSnapshot().hasTransientText, true);
  input.cancel();
  releaseSecond();
  assert.equal(registry.get("second"), null);
  assert.doesNotThrow(() => input.update("late producer"));
  registry.dispose();
});

test("refused stored hydration stays saved and retries when active capacity becomes available", async () => {
  const data = new Map<string, string>();
  const secondTarget = target("second");
  const key = conversationDraftStorageKey("account", "second", secondTarget);
  const saved = serializeConversationDraftDocument(document("stored input"), secondTarget)!;
  data.set(key, saved);
  const continuity = createConversationDraftContinuity({ namespace: "account", delayMs: 0, storage: {
    load: async storageKey => data.get(storageKey) ?? null,
    save: async (storageKey, value) => { data.set(storageKey, value); },
    remove: async storageKey => { data.delete(storageKey); },
  } });
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), maxDrafts: 1, draftContinuity: continuity });
  const first = registry.ensure("first", hostId, target("first")).composer;
  registry.retain("first", "editor");
  content(first, "active input");
  const second = registry.ensure("second", hostId, secondTarget).composer;
  registry.retain("second", "editor");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(text(second), "");
  assert.equal(data.get(key), saved);
  first.dispatch({ type: "clear" });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(text(second), "stored input");
  registry.dispose();
});

test("releasing an empty editor before its delayed restore does not discard the unread saved draft", async () => {
  const savedTarget = target("delayed");
  const key = conversationDraftStorageKey("account", "slot", savedTarget);
  const saved = serializeConversationDraftDocument(document("unread input"), savedTarget)!;
  const data = new Map([[key, saved]]);
  let finishLoad!: () => void;
  const pending = new Promise<void>(resolve => { finishLoad = resolve; });
  const continuity = createConversationDraftContinuity({ namespace: "account", delayMs: 0, storage: {
    async load(storageKey) { await pending; return data.get(storageKey) ?? null; },
    async save(storageKey, value) { data.set(storageKey, value); },
    async remove(storageKey) { data.delete(storageKey); },
  } });
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), draftContinuity: continuity });
  const retired = registry.ensure("slot", hostId, savedTarget).composer;
  registry.retain("slot", "editor")();
  assert.equal(registry.get("slot"), null);
  finishLoad();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(data.get(key), saved);
  assert.equal(retired.hasRetainedContent(), false);
  const reopened = registry.ensure("slot", hostId, savedTarget).composer;
  registry.retain("slot", "editor");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(text(reopened), "unread input");
  registry.dispose();
});

test("owner reuse requires its original Host and semantic target, with explicit promotion binding", () => {
  const registry = createConversationDraftOwnerRegistry({ composerServices: services() });
  registry.ensure("slot", hostId, target("a"));
  assert.throws(() => registry.ensure("slot", hostId, target("b")), /another target/u);
  const remote = asHostId("remote");
  const remoteTarget: ComposerTarget = { type: "existing-thread", key: createConversationKey(remote, "a") };
  assert.throws(() => registry.ensure("slot", remote, remoteTarget), /belongs to Host/u);
  assert.throws(() => registry.bindTarget("slot", remoteTarget), /belongs to Host/u);
  registry.bindTarget("slot", target("b"));
  assert.equal(registry.ensure("slot", hostId, target("b")).composer, registry.get("slot")?.composer);
  registry.dispose();
});

test("an owner attaches one continuity writer, preserves placement changes and discards promotion storage", () => {
  const events: string[] = [];
  const continuity: ConversationDraftContinuity = {
    attach(ownerId) { events.push(`attach:${ownerId}`); return () => { events.push(`stop:${ownerId}`); }; },
    discard(ownerId, value) { events.push(`discard:${ownerId}:${value.type}`); },
  };
  const registry = createConversationDraftOwnerRegistry({ composerServices: services(), draftContinuity: continuity });
  const draft: ComposerTarget = { type: "new-thread", draftId: "new", execution: {
    hostId, workspace: { cwd: "/a", runtimeWorkspaceRoots: ["/a"] },
  } };
  const composer = registry.ensure("slot", hostId, draft).composer;
  assert.equal(registry.ensure("slot", hostId, draft).composer, composer);
  content(composer, "placement stays");
  registry.bindTarget("slot", { ...draft, execution: { hostId, workspace: { cwd: "/b", runtimeWorkspaceRoots: ["/b"] } } });
  assert.equal(text(composer), "placement stays");
  assert.deepEqual(events, ["attach:slot"]);
  registry.bindTarget("slot", target("canonical"));
  assert.deepEqual(events, ["attach:slot", "stop:slot", "discard:slot:new-thread", "attach:slot"]);
  let disposed = 0;
  composer.onDispose(() => { disposed++; });
  registry.dispose();
  registry.dispose();
  assert.equal(disposed, 1);
  assert.equal(events.at(-1), "stop:slot");
  assert.throws(() => composer.dispatch({ type: "clear" }), /disposed/u);
});

test("account continuity replacement resets active and target-cached content", () => {
  const oldEvents: string[] = [];
  const registry = createConversationDraftOwnerRegistry({
    composerServices: services(),
    draftContinuity: {
      attach(ownerId) { oldEvents.push(`attach:${ownerId}`); return () => { oldEvents.push(`stop:${ownerId}`); }; },
      discard(_ownerId, value) { oldEvents.push(`discard:${value.type === "new-thread" ? value.draftId : value.key.threadId}`); },
    },
  });
  const composer = registry.ensure("slot", hostId, target("a")).composer;
  const release = registry.retain("slot", "editor");
  content(composer, "old account A");
  registry.bindTarget("slot", target("b"));
  content(composer, "old account B");
  composer.dispatch({ type: "set-selections", patch: { model: "private" } });
  let newWriters = 0;
  registry.replaceDraftContinuity({ attach() { newWriters++; return () => {}; }, discard() {} });
  assert.equal(text(composer), "");
  assert.deepEqual(composer.getSnapshot().draft.selections, {});
  registry.bindTarget("slot", target("a"));
  assert.equal(text(composer), "");
  assert.equal(newWriters, 2);
  assert.equal(oldEvents.includes("discard:a"), true);
  assert.equal(oldEvents.includes("discard:b"), true);
  release();
  registry.dispose();
});

test("target-only storage is rejected instead of sharing content across editor slots", () => {
  assert.throws(() => createConversationDraftOwnerRegistry({ composerServices: {
    ...services(), drafts: { read: () => null, write: () => {} },
  } }), /editor-slot continuity/u);
});
