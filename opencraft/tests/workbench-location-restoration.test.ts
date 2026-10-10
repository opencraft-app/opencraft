import assert from "node:assert/strict";
import test from "node:test";
import { createConversationKey } from "@opencraft/chat-core";
import { composerDocumentToPlainText } from "@opencraft/composer-core";
import { createWorkbenchDraftLocation, createWorkbenchThreadLocation } from "../packages/workbench-runtime/src/index";
import { createApplicationNavigation, readWorkbenchBootstrapLocation } from "../apps/workbench-web/src/runtime/workbench-navigation";
import { resolveRetainedWorkbenchLocation } from "../apps/workbench-web/src/runtime/workbench-location-restoration";
import { createNavigationRestorationSession } from "./fixtures/navigation-restoration-session";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("bootstrap candidate comes from the current entry, not global last-used preferences", () => {
  const state = { usr: { namespace: "opencraft.application-route.v8",
    location: { kind: "thread", hostId: "local", threadId: "entry-thread" } } };
  assert.deepEqual(readWorkbenchBootstrapLocation(new URL("https://fixture/settings/appearance"), state),
    createWorkbenchThreadLocation("local", "entry-thread"));
  assert.deepEqual(readWorkbenchBootstrapLocation(new URL("https://fixture/local/url-thread?hostId=local"), state),
    createWorkbenchThreadLocation("local", "url-thread"));
  assert.equal(readWorkbenchBootstrapLocation(new URL("https://fixture/settings/appearance"), { usr: { namespace: "other", location: state.usr.location } }), null);
  assert.equal(readWorkbenchBootstrapLocation(new URL("https://fixture/settings/appearance"), null), null);
});

test("resource owners reject expired Drafts/unknown Hosts but resolve promoted aliases", async () => {
  const session = createNavigationRestorationSession();
  try {
    const owners = { bindings: session.bindings, scopes: session.scopes, hasHost: (id: string) => id === "local" };
    assert.deepEqual(resolveRetainedWorkbenchLocation(session.initial, owners), session.initial);
    assert.equal(resolveRetainedWorkbenchLocation(session.initial, { ...owners, scopes: null }), null);
    assert.equal(resolveRetainedWorkbenchLocation(createWorkbenchDraftLocation("local", "expired"), owners), null);
    assert.equal(resolveRetainedWorkbenchLocation(createWorkbenchThreadLocation("removed", "thread"), owners), null);
    const draft = session.scopes.getActiveDraft()!;
    session.bindings.bind(draft.scopeId, createConversationKey("local", "promoted"));
    assert.deepEqual(resolveRetainedWorkbenchLocation(session.initial, { ...owners, scopes: null }),
      createWorkbenchThreadLocation("local", "promoted"));
  } finally { await session.dispose(); }
});

test("embedded memory navigation cannot borrow its containing page's Chat identity or history", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const outerState = { usr: { namespace: "opencraft.application-route.v8",
    location: { kind: "thread", hostId: "outer", threadId: "private" } } };
  const url = new URL("https://fixture/local/private?hostId=outer");
  assert.equal(readWorkbenchBootstrapLocation(url, outerState, "memory"), null);
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: url.href }, history: { state: outerState,
      replaceState() { throw new Error("outer history was written"); },
      pushState() { throw new Error("outer history was written"); } },
  } });
  const own = createWorkbenchThreadLocation("local", "embedded");
  const nav = createApplicationNavigation(own, { mode: "memory", initialEntries: ["/"] });
  try {
    assert.deepEqual(nav.getSnapshot().location, own);
    assert.equal(nav.getSnapshot().applicationRoute.kind, "conversation");
    nav.openSettings(); nav.openChat();
    assert.deepEqual(nav.getSnapshot().location, own);
    assert.equal((globalThis as any).window.history.state, outerState);
  } finally {
    nav.dispose();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as any).window;
  }
});

test("expired references fall back to the actual retained View, keeping its input", async () => {
  const session = createNavigationRestorationSession();
  try {
    const current = session.navigation.getSnapshot();
    const view = session.views.get(current.routeScopeId)!;
    view.composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "keep my input" }] }] } });
    const resolved = session.resolveRestoredEntry({ location: createWorkbenchDraftLocation("local", "expired"), routeScopeId: current.routeScopeId });
    assert.deepEqual(resolved, { location: session.initial, routeScopeId: current.routeScopeId });
    assert.equal(session.views.get(resolved.routeScopeId)?.composer, view.composer);
    assert.equal(composerDocumentToPlainText(view.composer.getSnapshot().draft.document), "keep my input");
    assert.equal(session.connectCalls, 0);
  } finally { await session.dispose(); }
});

test("promoted references preserve View identity but different Scopes cannot reuse it", async () => {
  const session = createNavigationRestorationSession();
  try {
    const before = session.navigation.getSnapshot();
    const draft = session.scopes.getActiveDraft()!;
    session.bindings.bind(draft.scopeId, createConversationKey("local", "promoted"));
    const alias = session.resolveRestoredEntry({ location: session.initial, routeScopeId: before.routeScopeId });
    assert.equal(alias.routeScopeId, before.routeScopeId);
    assert.deepEqual(alias.location, createWorkbenchThreadLocation("local", "promoted"));
    const other = session.resolveRestoredEntry({ location: createWorkbenchThreadLocation("local", "other"), routeScopeId: before.routeScopeId });
    assert.notEqual(other.routeScopeId, before.routeScopeId);
    assert.equal(session.views.get(before.routeScopeId)?.scopeId, draft.scopeId);
  } finally { await session.dispose(); }
});

test("POP of an evicted Draft corrects the Router entry and restores the retained View", async () => {
  const session = createNavigationRestorationSession();
  try {
    assert.equal(session.initial.kind, "draft");
    const original = session.initial as ReturnType<typeof createWorkbenchDraftLocation>;
    const next = session.scopes.openDraft({ execution: { hostId: "local", workspace: { cwd: null, runtimeWorkspaceRoots: [] } } });
    session.navigation.navigateToHome(createWorkbenchDraftLocation("local", next.id));
    const current = session.navigation.getSnapshot();
    session.navigation.openSettings();
    session.scopes.dismissDraft(original.draftId);
    session.navigation.back(); await settle();
    session.navigation.back(); await settle();
    const after = session.navigation.getSnapshot();
    assert.equal(after.applicationRoute.kind, "conversation");
    assert.equal(after.action, "replace");
    assert.deepEqual(after.location, current.location);
    assert.equal(after.routeScopeId, current.routeScopeId);
    assert.equal(after.historyIndex, 0);
    assert.equal(session.coordinator.getSnapshot().viewId, after.routeScopeId);
    session.navigation.forward(); await settle();
    assert.deepEqual(session.navigation.getSnapshot().location, current.location);
  } finally { await session.dispose(); }
});

test("POP of a promoted Draft canonicalizes without replacing its View", async () => {
  const session = createNavigationRestorationSession();
  try {
    const before = session.navigation.getSnapshot();
    const draft = session.scopes.getActiveDraft()!;
    session.navigation.openSettings();
    const key = createConversationKey("local", "promoted");
    session.bindings.bind(draft.scopeId, key);
    session.views.bindScopeTarget(draft.scopeId, { type: "existing-thread", key });
    session.scopes.dismissDraft(draft.id);
    await session.navigation.navigate(createWorkbenchThreadLocation("local", "promoted"));
    session.navigation.back(); await settle();
    assert.equal(await session.navigation.openChat(), true);
    assert.equal(session.navigation.getSnapshot().routeScopeId, before.routeScopeId);
    assert.equal(session.coordinator.getSnapshot().viewId, before.routeScopeId);
    assert.deepEqual(session.navigation.getSnapshot().location, createWorkbenchThreadLocation("local", "promoted"));
  } finally { await session.dispose(); }
});

test("semantic selection returns the retained Thread View from every surface without awaiting Host", async () => {
  const initial = createWorkbenchThreadLocation("local", "retained");
  const session = createNavigationRestorationSession({ initialThread: initial, connect: () => new Promise(() => {}) });
  try {
    const before = session.navigation.getSnapshot();
    const composer = session.views.get(before.routeScopeId)!.composer;
    composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "keep this page" }] }] } });
    for (const open of [() => session.navigation.openSettings(), () => session.navigation.openExtensionView("files")]) {
      open();
      const selection = session.navigation.selectConversation(initial);
      assert.equal(session.navigation.getSnapshot().applicationRoute.kind, "conversation");
      assert.equal(await selection, true);
      assert.equal(session.navigation.getSnapshot().routeScopeId, before.routeScopeId);
      assert.equal(session.views.get(before.routeScopeId)!.composer, composer);
      assert.equal(composerDocumentToPlainText(composer.getSnapshot().draft.document), "keep this page");
    }
    const revision = session.navigation.getSnapshot().revision;
    const calls = session.connectCalls;
    assert.equal(await session.navigation.selectConversation(initial), true);
    assert.equal(session.navigation.getSnapshot().revision, revision, "selecting the visible View is not a PUSH");
    assert.equal(session.connectCalls, calls, "duplicate visible selection must not restart readiness");
  } finally { await session.dispose(); }
});

test("selection respects entry View identity rather than merging same-Thread inputs", async () => {
  const initial = createWorkbenchThreadLocation("local", "shared");
  const session = createNavigationRestorationSession({ initialThread: initial });
  try {
    const first = session.navigation.getSnapshot().routeScopeId;
    const write = (id: typeof first, text: string) => session.views.get(id)!.composer.dispatch({
      type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }] },
    });
    write(first, "first page");
    session.navigation.openSettings();
    assert.equal(await session.navigation.navigate(initial), true, "explicit opening remains distinct from selection");
    const second = session.navigation.getSnapshot().routeScopeId;
    assert.notEqual(first, second);
    write(second, "second page");
    session.navigation.back(); await settle();
    assert.equal(await session.navigation.selectConversation(initial), true);
    assert.equal(session.navigation.getSnapshot().routeScopeId, first);
    assert.equal(session.coordinator.getSnapshot().viewId, first);
    assert.equal(composerDocumentToPlainText(session.views.get(first)!.composer.getSnapshot().draft.document), "first page");
    assert.equal(composerDocumentToPlainText(session.views.get(second)!.composer.getSnapshot().draft.document), "second page");
  } finally { await session.dispose(); }
});

test("repeated remote selection has one owner and a newer surface cancels it", async () => {
  let release!: () => void;
  const session = createNavigationRestorationSession({ connect: () => new Promise<void>(resolve => { release = resolve; }) });
  try {
    const target = createWorkbenchThreadLocation("local", "slow");
    const first = session.navigation.selectConversation(target);
    const second = session.navigation.selectConversation(target);
    assert.equal(first, second);
    await settle();
    assert.deepEqual(session.coordinator.getSnapshot().pendingLocation, target);
    session.navigation.openSettings();
    release();
    assert.equal(await first, false);
    assert.equal(await second, false);
    assert.equal(session.navigation.getSnapshot().applicationRoute.kind, "settings");
    assert.deepEqual(session.coordinator.getSnapshot().location, session.initial);
    assert.equal(session.coordinator.getSnapshot().pendingLocation, null);
  } finally { await session.dispose(); }
});

test("accepted promotion keeps its original Scope/View and resets the submitted draft", async () => {
  const session = createNavigationRestorationSession();
  try {
    const before = session.navigation.getSnapshot();
    const draft = session.scopes.getActiveDraft()!;
    const composer = session.views.get(before.routeScopeId)!.composer;
    composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "original input" }] }] } });
    const submission = composer.createSubmitIntent();
    session.scopes.beginSubmit(draft.id, submission);
    const receipt = { commandId: submission.commandId, clientMessageId: submission.clientMessageId,
      hostId: "local", threadId: "accepted", turnId: null, acceptedAt: Date.now(), replayed: false };
    session.scopes.acceptSubmission(draft.id, receipt);
    session.scopes.beginPromotion(draft.id);
    assert.deepEqual(await session.navigation.promoteDraft(draft.id, receipt), createWorkbenchThreadLocation("local", "accepted"));
    assert.equal(session.navigation.getSnapshot().routeScopeId, before.routeScopeId);
    assert.equal(session.views.get(before.routeScopeId)!.scopeId, draft.scopeId);
    assert.equal(session.views.get(before.routeScopeId)!.composer, composer);
    assert.equal(composerDocumentToPlainText(submission.document), "original input");
    assert.equal(composerDocumentToPlainText(composer.getSnapshot().draft.document), "", "submitted input is not copied into a new turn");
    assert.equal(session.bindings.findScope(createConversationKey("local", "accepted")), draft.scopeId);
  } finally { await session.dispose(); }
});

test("selection does not coalesce a different pending View of the same Thread", async () => {
  let release!: () => void;
  const initial = createWorkbenchThreadLocation("local", "shared");
  const session = createNavigationRestorationSession({ initialThread: initial,
    connect: () => new Promise<void>(resolve => { release = resolve; }) });
  try {
    const original = session.navigation.getSnapshot().routeScopeId;
    session.navigation.openSettings();
    const explicitOpen = session.navigation.navigate(initial);
    await settle();
    const selection = session.navigation.selectConversation(initial);
    assert.notEqual(selection, explicitOpen, "the remembered View and a new View are different destinations");
    assert.equal(session.navigation.getSnapshot().applicationRoute.kind, "conversation");
    assert.equal(await selection, true, "retained selection is not gated by the new View's readiness");
    assert.equal(session.navigation.getSnapshot().routeScopeId, original);
    release();
    assert.equal(await explicitOpen, false);
    await settle();
    assert.equal(session.coordinator.getSnapshot().viewId, original);
  } finally { await session.dispose(); }
});
