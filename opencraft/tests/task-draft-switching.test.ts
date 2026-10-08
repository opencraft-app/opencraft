import assert from "node:assert/strict";
import test from "node:test";

import { createConversationKey } from "@opencraft/chat-core";
import {
  composerDocumentToPlainText,
  type ComposerAttachment,
  type ComposerController,
  type ComposerDocument,
} from "@opencraft/composer-core";
import {
  HostRuntimeRegistry,
  asRouteScopeId,
  createConversationActivationCoordinator,
  createConversationBindingStore,
  createConversationDraftOwnerRegistry,
  createConversationScopeLeaseRegistry,
  createConversationScopeRegistry,
  createConversationViewRegistry,
  createWorkbenchCoordinator,
  createWorkbenchThreadLocation,
} from "@opencraft/workbench-runtime";
import { attachmentPreviewSession } from "../packages/codex-composer/src/attachment-preview-session";
import { createWorkbenchNavigationTransaction } from "../apps/workbench-web/src/runtime/workbench-navigation-transaction";
import { createWorkbenchEntryResolver } from "../apps/workbench-web/src/runtime/workbench-location-restoration";

const document = (text: string): ComposerDocument => ({
  version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const location = (thread: string) => createWorkbenchThreadLocation("local", thread);

/** Real navigation/resource owners; only remote Host activation is replaced. */
function createSession() {
  let sequence = 0;
  const services = { now: Date.now, createId: () => `switch-draft-${++sequence}` };
  const runtime = {
    async connect() {}, async dispose() {},
    async acquireThread(threadId: string) { return { threadId, release() {} }; },
  };
  const hosts = new HostRuntimeRegistry([{ descriptor: {
    hostId: "local", label: "Draft switching", kind: "local", transportEndpoint: null,
    executionLocation: null, workspaceBrowseRoots: [],
  }, createRuntime: () => runtime }]);
  const initial = location("a");
  const scopes = createConversationScopeRegistry({ initialDraft: null });
  const coordinator = createWorkbenchCoordinator(hosts, initial);
  const bindings = createConversationBindingStore();
  const leases = createConversationScopeLeaseRegistry({});
  const owners = createConversationDraftOwnerRegistry({ composerServices: services });
  const views = createConversationViewRegistry({ scopeLeases: leases, composerServices: services, draftOwners: owners });
  const activation = createConversationActivationCoordinator(coordinator, bindings, scopes, leases, views);
  const resolveRestoredEntry = createWorkbenchEntryResolver({
    hasHost: id => hosts.has(id), bindings, scopes, views,
    fallback: () => ({ location: coordinator.getSnapshot().location,
      routeScopeId: asRouteScopeId(coordinator.getSnapshot().viewId!) }),
  });
  const navigation = createWorkbenchNavigationTransaction(initial, activation, scopes,
    { mode: "memory", resolveRestoredEntry, isRetainedView: (_location, viewId) => owners.get(viewId) !== null });
  activation.mountInitial(initial, navigation.getSnapshot().routeScopeId);
  return {
    navigation, owners, views, activation,
    current() { return views.get(navigation.getSnapshot().routeScopeId)!.composer; },
    async select(thread: string) {
      assert.equal(await navigation.selectConversation(location(thread)), true);
      assert.deepEqual(navigation.getSnapshot().location, location(thread));
      assert.equal(coordinator.getSnapshot().phase, "ready");
      return this.current();
    },
    async dispose() {
      navigation.dispose(); activation.dispose(); views.dispose(); owners.dispose();
      leases.dispose(); coordinator.dispose(); scopes.dispose(); bindings.dispose(); await hosts.dispose();
    },
  };
}

function holdFiles(composer: ComposerController, files: readonly File[]) {
  const session = attachmentPreviewSession(composer);
  const jobs: { file: File; pending: ComposerAttachment; signal?: AbortSignal;
    complete: (attachment: ComposerAttachment) => void }[] = [];
  session.addFiles(files, (file, pending, signal) => new Promise<ComposerAttachment>(resolve => {
    jobs.push({ file, pending, signal, complete: resolve });
  }));
  return { session, jobs };
}

test("completed A → B → A selection keeps the same draft, image bytes and Markdown File", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const a = app.current(), aView = app.navigation.getSnapshot().routeScopeId;
  const imageBytes = new Uint8Array([0, 255, 17, 42, 128]);
  const mdBytes = new TextEncoder().encode("# 草稿\r\n\n- preserve exact bytes\n");
  const image = new File([imageBytes], "capture.png", { type: "image/png" });
  const markdown = new File([mdBytes], "notes.md", { type: "text/markdown" });
  a.dispatch({ type: "set-document", document: document("unfinished A") });
  const { session, jobs } = holdFiles(a, [image, markdown]);
  await flush();
  const original = a.getSnapshot().draft;
  const preview = session.previewUrl(original.id, original.attachments[0]!.id)!;
  assert.match(preview, /^blob:/u);

  const b = await app.select("b");
  b.dispatch({ type: "set-document", document: document("independent B") });
  assert.notEqual(b, a);
  assert.equal(jobs.every(job => job.signal?.aborted === false), true);
  for (const job of jobs) job.complete({ ...job.pending, lifecycle: "ready", error: null,
    uri: job.file === image ? "data:image/png;base64,AP8RKoA=" : "file:///fixture/notes.md" });
  await flush();
  assert.equal(b.getSnapshot().draft.attachments.length, 0, "late A completion cannot attach to B");
  assert.equal(composerDocumentToPlainText(b.getSnapshot().draft.document), "independent B");

  const returned = await app.select("a");
  assert.equal(app.navigation.getSnapshot().routeScopeId, aView);
  assert.equal(returned, a);
  assert.equal(returned.getSnapshot().draft.id, original.id);
  assert.equal(composerDocumentToPlainText(returned.getSnapshot().draft.document), "unfinished A");
  assert.deepEqual(returned.getSnapshot().draft.attachments.map(asset => asset.lifecycle), ["ready", "ready"]);
  assert.equal(attachmentPreviewSession(returned), session);
  assert.equal(session.previewUrl(original.id, original.attachments[0]!.id), preview);
  assert.deepEqual(new Uint8Array(await (await fetch(preview)).arrayBuffer()), imageBytes);
  assert.equal(jobs[1]!.file, markdown);
  assert.deepEqual(new Uint8Array(await jobs[1]!.file.arrayBuffer()), mdBytes);
  let retriedFile: File | null = null;
  assert.equal(session.retry(original.id, original.attachments[1]!.id, async (selected, pending) => {
    retriedFile = selected;
    assert.equal(selected, markdown, "retry reads the File retained by the real attachment owner");
    assert.deepEqual(new Uint8Array(await selected.arrayBuffer()), mdBytes);
    return { ...pending, lifecycle: "ready", uri: "file:///fixture/notes.md" };
  }), true);
  await flush();
  assert.equal(retriedFile, markdown);
});

test("the 20-View presentation cache can evict A without disposing its draft or attachment job", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const a = app.current(), aView = app.navigation.getSnapshot().routeScopeId;
  const bytes = new Uint8Array([9, 2, 1, 7]);
  const held = holdFiles(a, [new File([bytes], "persistent.png", { type: "image/png" })]);
  await flush();
  const draft = a.getSnapshot().draft;
  const preview = held.session.previewUrl(draft.id, draft.attachments[0]!.id)!;
  for (let index = 0; index < 25; index++) {
    const next = await app.select(`visited-${index}`);
    next.dispatch({ type: "set-document", document: document(`visited draft ${index}`) });
  }
  assert.equal(app.views.get(aView), null, "the physical View really left its cache");
  assert.equal(app.owners.get(aView)?.composer, a, "draft lifetime does not follow the View cache");
  assert.equal(held.jobs[0]!.signal?.aborted, false);
  assert.deepEqual(new Uint8Array(await (await fetch(preview)).arrayBuffer()), bytes);
  held.jobs[0]!.complete({ ...held.jobs[0]!.pending, lifecycle: "ready", uri: "data:image/png;base64,CQIBBw==" });
  await flush();
  assert.equal(await app.select("a"), a);
  assert.equal(a.getSnapshot().draft.attachments[0]?.lifecycle, "ready");
  assert.equal(held.session.previewUrl(draft.id, draft.attachments[0]!.id), preview);
});

test("the 51st content draft evicts the least-used inactive owner and revokes its blob and job", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const a = app.current(), aView = app.navigation.getSnapshot().routeScopeId;
  const held = holdFiles(a, [new File(["evicted"], "oldest.png", { type: "image/png" })]);
  await flush();
  const draft = a.getSnapshot().draft, attachment = draft.attachments[0]!;
  const preview = held.session.previewUrl(draft.id, attachment.id)!;
  for (let index = 1; index <= 50; index++) {
    const next = await app.select(`content-${index}`);
    next.dispatch({ type: "set-document", document: document(`retained draft ${index}`) });
  }
  assert.equal(app.owners.get(aView), null);
  assert.equal(held.jobs[0]!.signal?.aborted, true);
  assert.equal(held.session.previewUrl(draft.id, attachment.id), null);
  await assert.rejects(fetch(preview), /fetch failed/u);
  assert.throws(() => a.createSubmitIntent(), /disposed/u);
  held.jobs[0]!.complete({ ...attachment, lifecycle: "ready", uri: "data:image/png;base64,ZXZpY3RlZA==" });
  await flush();
  const fresh = await app.select("a");
  assert.notEqual(fresh, a);
  assert.equal(fresh.getSnapshot().hasContent, false, "a late job cannot resurrect an evicted draft");
});

test("returning to a draft updates LRU while empty editors do not consume the 50-content capacity", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const a = app.current(), aView = app.navigation.getSnapshot().routeScopeId;
  a.dispatch({ type: "set-document", document: document("keep A") });
  const b = await app.select("b"), bView = app.navigation.getSnapshot().routeScopeId;
  b.dispatch({ type: "set-document", document: document("old B") });
  for (let index = 2; index < 50; index++) {
    const next = await app.select(`full-${index}`);
    next.dispatch({ type: "set-document", document: document(`content ${index}`) });
  }
  for (let index = 0; index < 70; index++) await app.select(`empty-${index}`);
  assert.equal(app.owners.get(aView)?.composer, a);
  assert.equal(app.owners.get(bView)?.composer, b);
  assert.equal(await app.select("a"), a);
  const newest = await app.select("overflow");
  newest.dispatch({ type: "set-document", document: document("51st nonempty draft") });
  assert.equal(app.owners.get(aView)?.composer, a);
  assert.equal(app.owners.get(bView), null, "the returned A is newer than inactive B");
});

test("explicitly opened Views of one conversation keep independent draft owners", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const first = app.current(), firstView = app.navigation.getSnapshot().routeScopeId;
  first.dispatch({ type: "set-document", document: document("first window") });
  await app.select("b");
  assert.equal(await app.navigation.navigate(location("a")), true);
  const second = app.current(), secondView = app.navigation.getSnapshot().routeScopeId;
  assert.notEqual(firstView, secondView);
  assert.notEqual(first, second);
  second.dispatch({ type: "set-document", document: document("second window") });
  assert.equal(composerDocumentToPlainText(first.getSnapshot().draft.document), "first window");
  assert.equal(composerDocumentToPlainText(second.getSnapshot().draft.document), "second window");
  app.navigation.back(); await flush();
  app.navigation.back(); await flush();
  assert.equal(app.current(), first);
  assert.equal(app.navigation.getSnapshot().routeScopeId, firstView);
});

test("failed settlement preserves input, accepted settlement and explicit clear release attachment resources", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const a = app.current();
  a.dispatch({ type: "set-document", document: document("send attempt") });
  const held = holdFiles(a, [new File(["kept"], "keep.png", { type: "image/png" })]);
  await flush();
  const original = a.getSnapshot().draft, attachment = original.attachments[0]!;
  const preview = held.session.previewUrl(original.id, attachment.id)!;
  held.jobs[0]!.complete({ ...attachment, lifecycle: "ready", uri: "data:image/png;base64,a2VwdA==" });
  await flush();
  const rejectedIntent = a.createSubmitIntent();
  a.dispatch({ type: "set-lifecycle", phase: "submitting" });
  assert.equal(a.settleSubmission(original.id, rejectedIntent, { status: "failed", error: "Fixture rejection" }), true);
  assert.equal(a.getSnapshot().draft.id, original.id);
  assert.equal(composerDocumentToPlainText(a.getSnapshot().draft.document), "send attempt");
  assert.equal(held.session.previewUrl(original.id, attachment.id), preview);
  const acceptedIntent = a.createSubmitIntent();
  a.dispatch({ type: "set-lifecycle", phase: "submitting" });
  assert.equal(a.settleSubmission(original.id, acceptedIntent, { status: "accepted" }), true);
  assert.equal(a.getSnapshot().hasContent, false);
  assert.equal(held.session.previewUrl(original.id, attachment.id), null);
  await assert.rejects(fetch(preview), /fetch failed/u);

  const pending = holdFiles(a, [new File(["clear"], "clear.png", { type: "image/png" })]);
  await flush();
  const cleared = a.getSnapshot().draft, pendingAsset = cleared.attachments[0]!;
  a.dispatch({ type: "clear" });
  assert.equal(pending.jobs[0]!.signal?.aborted, true);
  assert.equal(pending.session.previewUrl(cleared.id, pendingAsset.id), null);
});

test("a late accepted settlement consumes only A while the fully activated B keeps its input", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const a = app.current();
  a.dispatch({ type: "set-document", document: document("accepted A") });
  const held = holdFiles(a, [new File(["accepted"], "accepted.png", { type: "image/png" })]);
  await flush();
  const draft = a.getSnapshot().draft, asset = draft.attachments[0]!;
  const preview = held.session.previewUrl(draft.id, asset.id)!;
  held.jobs[0]!.complete({ ...asset, lifecycle: "ready", uri: "data:image/png;base64,YWNjZXB0ZWQ=" });
  await flush();
  const intent = a.createSubmitIntent();
  a.dispatch({ type: "set-lifecycle", phase: "submitting" });
  const b = await app.select("b");
  b.dispatch({ type: "set-document", document: document("B edited during A settlement") });
  const bDraft = b.getSnapshot().draft;
  assert.equal(a.settleSubmission(draft.id, intent, { status: "accepted" }), true);
  assert.equal(a.getSnapshot().hasContent, false);
  assert.equal(held.session.previewUrl(draft.id, asset.id), null);
  await assert.rejects(fetch(preview), /fetch failed/u);
  assert.equal(b.getSnapshot().draft.id, bDraft.id);
  assert.equal(composerDocumentToPlainText(b.getSnapshot().draft.document), "B edited during A settlement");
  assert.equal(app.current(), b);
});

test("account revocation clears active and View-evicted drafts and fences both late resolvers", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const a = app.current(), aView = app.navigation.getSnapshot().routeScopeId;
  a.dispatch({ type: "set-document", document: document("old account A") });
  const first = holdFiles(a, [new File(["old-A"], "account-a.png", { type: "image/png" })]);
  await flush();
  for (let index = 0; index < 25; index++) {
    const next = await app.select(`account-cached-${index}`);
    next.dispatch({ type: "set-document", document: document(`old account draft ${index}`) });
  }
  assert.equal(app.views.get(aView), null);
  const b = await app.select("b");
  b.dispatch({ type: "set-document", document: document("old account B") });
  const second = holdFiles(b, [new File(["old-B"], "account-b.png", { type: "image/png" })]);
  await flush();
  app.views.replaceDraftContinuity(undefined);
  assert.equal(a.getSnapshot().hasContent, false);
  assert.equal(b.getSnapshot().hasContent, false);
  for (const held of [first, second]) {
    assert.equal(held.jobs[0]!.signal?.aborted, true);
    held.jobs[0]!.complete({ ...held.jobs[0]!.pending, lifecycle: "ready", uri: "data:image/png;base64,b2xk" });
  }
  await flush();
  assert.equal((await app.select("a")).getSnapshot().hasContent, false);
  assert.equal(b.getSnapshot().hasContent, false);
  assert.deepEqual(a.getSnapshot().draft.target, { type: "existing-thread", key: createConversationKey("local", "a") });
});
