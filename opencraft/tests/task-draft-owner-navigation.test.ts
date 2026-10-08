import assert from "node:assert/strict";
import test from "node:test";
import { asHostId } from "@opencraft/chat-core";
import { composerDocumentToPlainText, type ComposerController } from "@opencraft/composer-core";
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
  createWorkbenchThreadLocation,
} from "@opencraft/workbench-runtime";
import { createWorkbenchNavigationTransaction } from "../apps/workbench-web/src/runtime/workbench-navigation-transaction";
import {
  createWorkbenchEntryResolver,
  resolveRetainedWorkbenchLocation,
} from "../apps/workbench-web/src/runtime/workbench-location-restoration";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const write = (controller: ComposerController, text: string) => controller.dispatch({ type: "set-document", document: {
  version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
} });

test("promotion updates a View-evicted owner before POP restores its canonical Thread slot", async () => {
  let sequence = 0;
  const services = { now: Date.now, createId: () => `owner-navigation-${++sequence}` };
  const runtime = { async connect() {}, async dispose() {},
    async acquireThread(threadId: string) { return { threadId, release() {} }; } };
  const hosts = new HostRuntimeRegistry([{ descriptor: {
    hostId: "local", label: "Synthetic owner navigation", kind: "local", transportEndpoint: null,
    executionLocation: null, workspaceBrowseRoots: [],
  }, createRuntime: () => runtime }]);
  const scopes = createConversationScopeRegistry({ initialDraft: {
    draftId: "synthetic-client-draft",
    execution: { hostId: asHostId("local"), workspace: { cwd: null, runtimeWorkspaceRoots: [] } },
  } });
  const initialDraft = scopes.getActiveDraft()!;
  const initial = createWorkbenchDraftLocation("local", initialDraft.id);
  const coordinator = createWorkbenchCoordinator(hosts, initial);
  const bindings = createConversationBindingStore();
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({
    scopeLeases: leases, composerServices: services,
    onEvictDraft: viewId => navigation.forgetView(viewId),
  });
  const activation = createConversationActivationCoordinator(coordinator, bindings, scopes, leases, views);
  const owners = { hasHost: (hostId: string) => hosts.has(hostId), bindings, scopes };
  const navigation = createWorkbenchNavigationTransaction(initial, activation, scopes, {
    mode: "memory",
    resolveCanonicalLocation: location => resolveRetainedWorkbenchLocation(location, owners) ?? location,
    isRetainedView(location, viewId) {
      const owner = views.getDraftOwner(viewId);
      if (owner === null) return false;
      const target = owner.composer.getSnapshot().draft.target;
      return location.kind === "draft"
        ? target.type === "new-thread" && target.execution.hostId === location.hostId && target.draftId === location.draftId
        : target.type === "existing-thread" && target.key.hostId === location.key.hostId && target.key.threadId === location.key.threadId;
    },
    resolveRestoredEntry: createWorkbenchEntryResolver({ ...owners, views,
      fallback: () => ({ location: coordinator.getSnapshot().location,
        routeScopeId: asRouteScopeId(coordinator.getSnapshot().viewId!) }),
    }),
  });
  activation.mountInitial(initial, navigation.getSnapshot().routeScopeId);
  try {
    const firstView = navigation.getSnapshot().routeScopeId;
    const firstController = views.get(firstView)!.composer;
    write(firstController, "old page input");
    for (let index = 0; index < 25; index++) {
      await navigation.selectConversation(createWorkbenchThreadLocation("local", `visited-${index}`));
      write(views.get(navigation.getSnapshot().routeScopeId)!.composer, `cached draft ${index}`);
    }
    assert.equal(views.get(firstView), null, "the old Draft View really left its presentation cache");
    assert.equal(views.getDraftOwner(firstView)?.composer, firstController);
    assert.equal(await navigation.navigate(initial), true);
    const secondView = navigation.getSnapshot().routeScopeId;
    assert.notEqual(secondView, firstView);
    const secondController = views.get(secondView)!.composer;
    write(secondController, "synthetic accepted input");
    const submission = secondController.createSubmitIntent();
    scopes.beginSubmit(initialDraft.id, submission);
    const receipt = { commandId: submission.commandId, clientMessageId: submission.clientMessageId,
      hostId: "local", threadId: "synthetic-promoted", turnId: "synthetic-turn", acceptedAt: Date.now(), replayed: false };
    scopes.acceptSubmission(initialDraft.id, receipt);
    scopes.beginPromotion(initialDraft.id);
    const canonical = createWorkbenchThreadLocation("local", receipt.threadId);
    assert.deepEqual(await navigation.promoteDraft(initialDraft.id, receipt), canonical);
    assert.equal(views.getDraftOwner(firstView)?.composer, firstController);
    assert.deepEqual(firstController.getSnapshot().draft.target, { type: "existing-thread", key: canonical.key });
    for (let index = 0; index < 26; index++) { navigation.back(); await settle(); }
    assert.equal(navigation.getSnapshot().routeScopeId, firstView);
    assert.deepEqual(navigation.getSnapshot().location, canonical);
    assert.equal(views.get(firstView)?.composer, firstController);
    assert.equal(views.get(firstView)?.scopeId, initialDraft.scopeId);
    assert.equal(composerDocumentToPlainText(secondController.getSnapshot().draft.document), "");
    assert.equal(firstController.getSnapshot().hasContent, false);
    assert.equal(firstController.hasRetainedContent(), true, "the original target's unsent document remains controller-owned");
    for (let index = 0; index < 21; index++) {
      await navigation.selectConversation(createWorkbenchThreadLocation("local", `after-promotion-${index}`));
      write(views.get(navigation.getSnapshot().routeScopeId)!.composer, `post-promotion input ${index}`);
    }
    assert.equal(views.get(firstView), null);
    assert.equal(views.getDraftOwner(firstView)?.composer, firstController,
      "presentation eviction cannot close an owner whose current target is empty but another target has input");
    assert.equal(await navigation.selectConversation(canonical), true);
    assert.equal(navigation.getSnapshot().routeScopeId, firstView);
    assert.equal(views.get(firstView)?.composer, firstController);
    assert.deepEqual(firstController.getSnapshot().draft.target, { type: "existing-thread", key: canonical.key });
  } finally {
    navigation.dispose(); activation.dispose(); views.dispose(); leases.dispose();
    scopes.dispose(); bindings.dispose(); coordinator.dispose(); await hosts.dispose();
  }
});
