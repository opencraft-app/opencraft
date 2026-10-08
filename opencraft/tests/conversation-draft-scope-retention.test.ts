import assert from "node:assert/strict";
import test from "node:test";
import { asHostId } from "@opencraft/chat-core";
import {
  composerDocumentToPlainText,
  createComposerController,
  type ComposerController,
} from "@opencraft/composer-core";
import {
  HostRuntimeRegistry,
  asRouteScopeId,
  createConversationActivationCoordinator,
  createConversationBindingStore,
  createConversationScopeLeaseRegistry,
  createConversationScopeRegistry,
  createConversationViewRegistry,
  createWorkbenchCoordinator,
  createWorkbenchDraftLocation,
  type ConversationScopeId,
} from "@opencraft/workbench-runtime";
import { createWorkbenchNavigationTransaction } from "../apps/workbench-web/src/runtime/workbench-navigation-transaction";
import {
  createWorkbenchEntryResolver,
  resolveRetainedWorkbenchLocation,
} from "../apps/workbench-web/src/runtime/workbench-location-restoration";

const hostId = asHostId("local");
const execution = { hostId, workspace: { cwd: null, runtimeWorkspaceRoots: [] } };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const write = (controller: ComposerController, text: string) => controller.dispatch({ type: "set-document", document: {
  version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
} });

test("retained input has a separate budget from the 20 empty New-chat metadata records", () => {
  const input = new Set<ConversationScopeId>();
  let time = 0;
  const scopes = createConversationScopeRegistry({ initialDraft: null, now: () => ++time,
    isInputRetained: scopeId => input.has(scopeId),
  });
  try {
    for (let index = 0; index < 50; index++) {
      const draft = scopes.openDraft({ draftId: `with-input-${index}`, execution });
      input.add(draft.scopeId);
    }
    for (let index = 0; index < 30; index++) scopes.openDraft({ draftId: `empty-${index}`, execution });
    const retained = scopes.getSnapshot().drafts;
    assert.equal(retained.filter(draft => input.has(draft.scopeId)).length, 50);
    assert.equal(retained.filter(draft => !input.has(draft.scopeId)).length, 20);
    assert.equal(scopes.getDraft("empty-0"), null);
    assert.notEqual(scopes.getDraft("empty-10"), null);
    for (let index = 0; index < 50; index++) assert.doesNotThrow(() => scopes.activateDraft(`with-input-${index}`));
  } finally { scopes.dispose(); }
});

test("absent input ownership keeps the original 20-record metadata bound", () => {
  const scopes = createConversationScopeRegistry({ initialDraft: null });
  try {
    for (let index = 0; index < 30; index++) scopes.openDraft({ draftId: `empty-${index}`, execution });
    assert.equal(scopes.getSnapshot().drafts.length, 20);
    assert.equal(scopes.getDraft("empty-0"), null);
    assert.equal(scopes.getActiveDraft()?.id, "empty-29");
  } finally { scopes.dispose(); }
});

test("metadata pruning cannot discard a pending first Turn or its accepted promotion receipt", () => {
  const scopes = createConversationScopeRegistry({ initialDraft: null, isInputRetained: () => false });
  const controllers: ComposerController[] = [];
  let sequence = 0;
  const services = { now: Date.now, createId: () => `scope-receipt-${++sequence}` };
  try {
    const protectedDrafts = ["submitting", "accepted", "promoting"] as const;
    for (const phase of protectedDrafts) {
      const draft = scopes.openDraft({ draftId: phase, execution });
      const controller = createComposerController(draft.target, services);
      controllers.push(controller);
      write(controller, `synthetic ${phase} input`);
      const submission = controller.createSubmitIntent();
      scopes.beginSubmit(draft.id, submission);
      if (phase !== "submitting") {
        scopes.acceptSubmission(draft.id, { commandId: submission.commandId, clientMessageId: submission.clientMessageId,
          hostId, threadId: `${phase}-thread`, turnId: null, acceptedAt: Date.now(), replayed: false });
      }
      if (phase === "promoting") scopes.beginPromotion(draft.id);
    }
    const receipts = protectedDrafts.map(id => scopes.getDraft(id)!.receipt);
    for (let index = 0; index < 30; index++) scopes.openDraft({ draftId: `new-empty-${index}`, execution });
    assert.equal(scopes.getSnapshot().drafts.length, 23);
    protectedDrafts.forEach((id, index) => {
      assert.equal(scopes.getDraft(id)?.phase, id);
      assert.equal(scopes.getDraft(id)?.receipt, receipts[index]);
    });
  } finally { for (const controller of controllers) controller.dispose(); scopes.dispose(); }
});

function createSession() {
  let sequence = 0, threadAcquisitions = 0;
  const services = { now: Date.now, createId: () => `scope-owner-${++sequence}` };
  const runtime = { async connect() {}, async dispose() {},
    async acquireThread(threadId: string) { threadAcquisitions++; return { threadId, release() {} }; } };
  const hosts = new HostRuntimeRegistry([{ descriptor: {
    hostId, label: "Synthetic New-chat retention", kind: "local", transportEndpoint: null,
    executionLocation: null, workspaceBrowseRoots: [],
  }, createRuntime: () => runtime }]);
  const scopes = createConversationScopeRegistry({ initialDraft: { draftId: "content-0", execution },
    isInputRetained: scopeId => views.hasRetainedInput(scopeId),
  });
  const initial = createWorkbenchDraftLocation(hostId, scopes.getActiveDraft()!.id);
  const coordinator = createWorkbenchCoordinator(hosts, initial);
  const bindings = createConversationBindingStore();
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({ scopeLeases: leases, composerServices: services,
    onEvictDraft: viewId => navigation.forgetView(viewId),
  });
  const activation = createConversationActivationCoordinator(coordinator, bindings, scopes, leases, views);
  const owners = { hasHost: (id: string) => hosts.has(id), bindings, scopes };
  const navigation = createWorkbenchNavigationTransaction(initial, activation, scopes, {
    mode: "memory",
    resolveCanonicalLocation: location => resolveRetainedWorkbenchLocation(location, owners) ?? location,
    isRetainedView: (_location, viewId) => views.getDraftOwner(viewId) !== null,
    resolveRestoredEntry: createWorkbenchEntryResolver({ ...owners, views,
      fallback: () => ({ location: coordinator.getSnapshot().location,
        routeScopeId: asRouteScopeId(coordinator.getSnapshot().viewId!) }),
    }),
  });
  activation.mountInitial(initial, navigation.getSnapshot().routeScopeId);
  const current = () => views.get(navigation.getSnapshot().routeScopeId)!.composer;
  return {
    scopes, views, navigation, current,
    getThreadAcquisitions: () => threadAcquisitions,
    async open(id: string, text?: string) {
      const draft = scopes.openDraft({ draftId: id, execution });
      assert.equal(navigation.navigateToHome(createWorkbenchDraftLocation(hostId, draft.id)), true);
      const controller = current();
      if (text !== undefined) write(controller, text);
      await settle();
      return { draft, controller, viewId: navigation.getSnapshot().routeScopeId };
    },
    async dispose() {
      navigation.dispose(); activation.dispose(); views.dispose(); leases.dispose(); scopes.dispose();
      bindings.dispose(); coordinator.dispose(); await hosts.dispose();
    },
  };
}

test("50 nonempty New-chat drafts survive more than 20 subsequent pages and restore their original owners", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const retained = [{ draft: app.scopes.getActiveDraft()!, controller: app.current(),
    viewId: app.navigation.getSnapshot().routeScopeId }];
  write(retained[0]!.controller, "input 0");
  for (let index = 1; index < 50; index++) retained.push(await app.open(`content-${index}`, `input ${index}`));
  for (let index = 0; index < 30; index++) await app.open(`empty-page-${index}`);
  assert.equal(app.views.get(retained[0]!.viewId), null);
  retained.forEach(({ draft, controller }) => {
    assert.notEqual(app.scopes.getDraft(draft.id), null);
    assert.equal(app.views.hasRetainedInput(draft.scopeId), true);
    assert.equal(controller.hasRetainedContent(), true);
  });
  for (const [index, original] of retained.entries()) {
    assert.equal(await app.navigation.selectConversation(createWorkbenchDraftLocation(hostId, original.draft.id)), true);
    assert.equal(app.navigation.getSnapshot().routeScopeId, original.viewId);
    assert.equal(app.current(), original.controller);
    assert.equal(composerDocumentToPlainText(app.current().getSnapshot().draft.document), `input ${index}`);
  }
  assert.equal(app.getThreadAcquisitions(), 0, "retaining local input does not acquire execution Thread leases");
});

test("the 51st nonempty New-chat owner leaves discardable metadata while the other 49 remain restorable", async t => {
  const app = createSession(); t.after(() => app.dispose());
  const retained = [{ draft: app.scopes.getActiveDraft()!, controller: app.current(),
    viewId: app.navigation.getSnapshot().routeScopeId }];
  write(retained[0]!.controller, "input 0");
  for (let index = 1; index < 50; index++) retained.push(await app.open(`content-${index}`, `input ${index}`));
  const overflow = await app.open("content-50", "input 50");
  const evicted = retained[0]!;
  assert.equal(app.views.getDraftOwner(evicted.viewId), null);
  assert.notEqual(app.scopes.getDraft(evicted.draft.id), null, "input eviction does not immediately invalidate Home history metadata");
  assert.equal(app.views.hasRetainedInput(evicted.draft.scopeId), false);
  assert.throws(() => evicted.controller.createSubmitIntent(), /disposed/u);
  assert.notEqual(app.scopes.getDraft(overflow.draft.id), null);
  for (let index = 0; index < 30; index++) await app.open(`after-eviction-empty-${index}`);
  assert.equal(app.scopes.getDraft(evicted.draft.id), null, "the 20 empty-metadata budget eventually expires the evicted input's Scope");
  for (const [index, original] of retained.slice(1).entries()) {
    assert.notEqual(app.scopes.getDraft(original.draft.id), null);
    assert.equal(await app.navigation.selectConversation(createWorkbenchDraftLocation(hostId, original.draft.id)), true);
    assert.equal(app.current(), original.controller);
    assert.equal(composerDocumentToPlainText(app.current().getSnapshot().draft.document), `input ${index + 1}`);
  }
  assert.equal(app.getThreadAcquisitions(), 0);
});
