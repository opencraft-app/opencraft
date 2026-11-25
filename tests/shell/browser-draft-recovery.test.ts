import assert from "node:assert/strict";
import test from "node:test";
import { createConversationKey } from "@opencraft/chat-core";
import {
  composerDocumentToPlainText, createComposerController, type ComposerDocument, type ComposerTarget,
} from "@opencraft/composer-core";
import {
  conversationDraftStorageKey, createConversationDraftContinuity, createWorkbenchThreadLocation, serializeConversationDraftDocument,
} from "@opencraft/workbench-runtime";
import { BrowserDraftRecovery } from "../../apps/workbench-web/src/runtime/browser-draft-recovery";
import { createWorkbenchNavigationTransaction } from "../../apps/workbench-web/src/runtime/workbench-navigation-transaction";

const document = (text: string): ComposerDocument => ({ version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }] });
const target = (id: string): ComposerTarget => ({ type: "existing-thread", key: createConversationKey("local", id) });
const createEditor = (target: ComposerTarget) => createComposerController(target, { now: Date.now, createId: () => crypto.randomUUID() });
const text = (editor: ReturnType<typeof createEditor>) => composerDocumentToPlainText(editor.getSnapshot().draft.document);

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise(r => setTimeout(r, 2));
  assert.ok(check());
}

function fixture(find = async (_: ComposerTarget, view: string): Promise<string | null> => "stored-" + view) {
  const state = new BrowserDraftRecovery();
  const reads = new Map<string, ReturnType<typeof Promise.withResolvers<string | null>>>();
  const writes: string[] = [];
  const saved = new Map<string, string>();
  const detach = state.bind(createConversationDraftContinuity({ namespace: "acct", delayMs: 0, storage: {
    load: key => { const result = Promise.withResolvers<string | null>(); reads.set(key, result); return result.promise; },
    save: async (key, value) => { writes.push(key); saved.set(key, value); },
    remove: async key => { writes.push(key); saved.delete(key); },
  } }), find, () => {});
  return { state, reads, writes, saved, detach };
}

test("pending startup draft permits settings and another cold Thread, each callback stays with its editor", async () => {
  const { state, reads, writes, detach } = fixture();
  const a = createEditor(target("a")), b = createEditor(target("b"));
  let stopB: (() => void) | undefined;
  const route = createWorkbenchNavigationTransaction(createWorkbenchThreadLocation("local", "a"), {
    setViewId() {}, cancelPending() {}, prepare: async () => null,
    mountRestored(_location: unknown, view: string) { stopB = detach.attach(view, b); },
  } as any, { getActiveDraft: () => null } as any, { mode: "memory", recoverInputAfterMount: state.markCold });
  const viewA = route.getSnapshot().routeScopeId;
  state.markCold(viewA);
  const stopA = detach.attach(viewA, a);
  try {
    route.openSettings();
    assert.equal(route.getSnapshot().applicationRoute.kind, "settings");
    assert.equal(await route.selectConversation(createWorkbenchThreadLocation("local", "b")), true);
    const viewB = route.getSnapshot().routeScopeId;
    assert.notEqual(viewA, viewB);
    assert.ok(state.isPending(viewA) && state.isPending(viewB));
    await waitFor(() => reads.size === 2);
    reads.get(conversationDraftStorageKey("acct", "stored-" + viewA, target("a")))!.resolve(serializeConversationDraftDocument(document("A")));
    await waitFor(() => !state.isPending(viewA));
    assert.equal(text(a), "A"); assert.equal(text(b), ""); assert.ok(state.isPending(viewB));
    assert.deepEqual(route.getSnapshot().location, createWorkbenchThreadLocation("local", "b"));
    reads.get(conversationDraftStorageKey("acct", "stored-" + viewB, target("b")))!.resolve(null);
    await waitFor(() => !state.isPending(viewB));
  } finally { stopA(); stopB?.(); route.dispose(); }
  await new Promise(r => setImmediate(r));
  assert.deepEqual(writes, [], "mounting and leaving untouched editors must not save empty content");
});

test("revoking an owner before a delayed read completes never hydrates or erases its draft", async () => {
  const { state, reads, writes, detach } = fixture();
  const editor = createEditor(target("a"));
  state.markCold("v");
  const stop = detach.attach("v", editor);
  await waitFor(() => reads.size === 1);
  stop(); state.forget("v");
  reads.values().next().value!.resolve(serializeConversationDraftDocument(document("private")));
  await new Promise(r => setImmediate(r));
  assert.equal(text(editor), ""); assert.equal(state.isPending("v"), false); assert.deepEqual(writes, []);
});

test("restores new-draft placement and saves subsequent edits in the original slot", async () => {
  const recovery = new BrowserDraftRecovery();
  const initial = { type: "new-thread", draftId: "draft", execution: { hostId: "local", workspace: { cwd: null, runtimeWorkspaceRoots: [] } } } as const;
  const saved = { ...initial, execution: { ...initial.execution, workspace: { cwd: "/project", runtimeWorkspaceRoots: ["/project"] } } };
  const raw = serializeConversationDraftDocument(document("original"), saved);
  const writes: string[] = [];
  const editor = createEditor(initial);
  const port = recovery.bind(createConversationDraftContinuity({ namespace: "account", delayMs: 0, storage: {
    load: async () => raw, remove: async () => assert.fail("unexpected deletion"), save: async key => { writes.push(key); },
  } }), async () => "original-view", placement => {
    editor.dispatch({ type: "switch-target", target: placement, preserveDraft: true });
  });
  recovery.markCold("router-view");
  const stop = port.attach("router-view", editor);
  try {
    await waitFor(() => !recovery.isPending("router-view"));
    assert.equal(text(editor), "original");
    assert.deepEqual(editor.getSnapshot().draft.target, saved);
    editor.dispatch({ type: "set-document", document: document("changed") });
    await new Promise(r => setImmediate(r));
    assert.deepEqual(writes, [conversationDraftStorageKey("account", "original-view", saved)]);
  } finally { stop(); editor.dispose(); }
});

test("input typed during slot discovery wins and is saved when storage returns", async () => {
  const lookup = Promise.withResolvers<string | null>();
  const { state, reads, saved, detach } = fixture(() => lookup.promise);
  const conversation = target("thread");
  const editor = createEditor(conversation);
  state.markCold("view");
  const stop = detach.attach("view", editor);
  try {
    const newer = document("Keep the new text");
    editor.dispatch({ type: "set-document", document: newer });
    lookup.resolve("original-slot");
    const key = conversationDraftStorageKey("acct", "original-slot", conversation);
    await waitFor(() => reads.has(key));
    reads.get(key)!.resolve(serializeConversationDraftDocument(document("Older saved text")));
    await waitFor(() => saved.has(key));
    assert.equal(text(editor), "Keep the new text");
    assert.equal(saved.get(key), serializeConversationDraftDocument(newer));
  } finally { stop(); editor.dispose(); }
});

test("an accepted send during recovery does not resurrect or delete unread input", async () => {
  const lookup = Promise.withResolvers<string | null>();
  const { state, reads, writes, detach } = fixture(() => lookup.promise);
  const conversation = target("thread");
  const editor = createEditor(conversation);
  state.markCold("view");
  const stop = detach.attach("view", editor);
  try {
    editor.dispatch({ type: "set-document", document: document("Send the new text") });
    const draftId = editor.getSnapshot().draft.id;
    const intent = editor.createSubmitIntent();
    editor.dispatch({ type: "set-lifecycle", phase: "submitting" });
    assert.equal(editor.settleSubmission(draftId, intent, { status: "accepted" }), true);
    detach.discard("view", conversation);
    lookup.resolve("view");
    const key = conversationDraftStorageKey("acct", "view", conversation);
    await waitFor(() => reads.has(key));
    reads.get(key)!.resolve(serializeConversationDraftDocument(document("Unread previous draft")));
    await waitFor(() => !state.isPending("view"));
    assert.equal(text(editor), "");
  } finally { stop(); editor.dispose(); }
  await new Promise(r => setImmediate(r));
  assert.deepEqual(writes, []);
});
