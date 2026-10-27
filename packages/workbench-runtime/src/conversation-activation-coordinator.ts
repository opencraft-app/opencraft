import { createConversationKey, encodeConversationKey, type ConversationKey } from "@opencraft/chat-core";
import type { ComposerExecutionTarget, SubmissionReceipt } from "@opencraft/composer-core";

import {
  asConversationScopeId,
  type ConversationBindingStore,
  type ConversationScopeId,
} from "./conversation-binding";
import type { ConversationScopeLeaseRegistry } from "./conversation-scope-lease";
import type { ConversationScopeRegistry } from "./conversation-scope-registry";
import type { ConversationViewRegistry } from "./conversation-view-registry";
import {
  createWorkbenchThreadLocation,
  type WorkbenchDraftLocation,
  type WorkbenchLocation,
} from "./workbench-location";
import type {
  WorkbenchActivatableRuntime,
  WorkbenchCoordinator,
} from "./workbench-coordinator";

export interface ConversationActivationCoordinator<TRuntime extends WorkbenchActivatableRuntime> {
  scopeIdFor(location: WorkbenchLocation): ConversationScopeId;
  /** Publishes only local Scope/View identity; it never starts a Host. */
  mountInitial(location: WorkbenchLocation, viewId: string): void;
  /** Publishes a New-chat Draft and View locally before Host preparation. */
  presentLocalDraft(location: WorkbenchDraftLocation, viewId: string): void;
  /**
   * Commits the initial local Scope/View before Host hydration. The returned
   * operation owns only remote readiness and may finish after React mounts.
   */
  presentInitial(location: WorkbenchLocation, viewId: string): Promise<boolean>;
  prepare(location: WorkbenchLocation): Promise<PreparedConversationActivation | null>;
  cancelPending(): void;
  preparePromotion(
    draftId: string,
    receipt: SubmissionReceipt,
  ): Promise<PreparedConversationActivation | null>;
  activate(location: WorkbenchLocation): Promise<boolean>;
  setViewId(viewId: string): void;
  retargetDraft(draftId: string, execution: ComposerExecutionTarget): void;
  promoteDraft(draftId: string, receipt: SubmissionReceipt): Promise<WorkbenchLocation>;
  dispose(): void;
}

export interface PreparedConversationActivation {
  readonly location: WorkbenchLocation;
  readonly scopeId: ConversationScopeId;
  commit(viewId?: string): boolean;
  cancel(): void;
}

export function canonicalThreadScopeId(key: ConversationKey): ConversationScopeId {
  return asConversationScopeId(`conversation:${encodeConversationKey(key)}`);
}

/** Owns the relationship between a retained Conversation Scope and its Thread. */
export function createConversationActivationCoordinator<
  TRuntime extends WorkbenchActivatableRuntime,
>(
  coordinator: WorkbenchCoordinator<TRuntime>,
  bindings: ConversationBindingStore,
  scopes: ConversationScopeRegistry,
  leases: ConversationScopeLeaseRegistry,
  views: ConversationViewRegistry,
): ConversationActivationCoordinator<TRuntime> {
  let activeScopeId: ConversationScopeId | null = null;
  let activeViewId: string | null = null;
  let releaseActiveView: (() => void) | null = null;
  let disposed = false;
  let stopInitialRecovery: (() => void) | null = null;
  const draftRetainers = new Map<string, () => void>();

  const ensureOpen = () => {
    if (disposed) throw new Error("Conversation activation coordinator is disposed");
  };
  const ensureLocationScope = (location: WorkbenchLocation): ConversationScopeId => {
    if (location.kind === "draft") {
      const draft = scopes.getDraft(location.draftId);
      if (draft === null) throw new Error(`Draft ${location.draftId} is unavailable`);
      if (draft.target.execution.hostId !== location.hostId) {
        throw new Error(`Draft ${location.draftId} belongs to Host ${draft.target.execution.hostId}`);
      }
      bindings.register(draft.scopeId, location.hostId);
      leases.ensure(draft.scopeId, location.hostId, draft.target);
      return draft.scopeId;
    }
    const existing = bindings.findScope(location.key);
    const scopeId = existing ?? canonicalThreadScopeId(location.key);
    bindings.register(scopeId, location.key.hostId);
    if (existing === null) bindings.bind(scopeId, location.key);
    leases.ensure(scopeId, location.key.hostId, { type: "existing-thread", key: location.key });
    return scopeId;
  };
  const commitActiveView = (scopeId: ConversationScopeId, nextViewId?: string) => {
    const viewId = nextViewId ?? coordinator.getSnapshot().viewId;
    if (viewId === null) {
      throw new Error("Conversation activation requires an explicit View ID");
    }
    const scope = leases.get(scopeId);
    if (scope === null) throw new Error(`Conversation Scope ${scopeId} is unavailable`);
    if (activeViewId === viewId && activeScopeId === scopeId) return;
    views.ensure(viewId, scopeId, scope.hostId, scope.target);
    const nextRelease = views.retain(viewId, "active-route");
    const previousRelease = releaseActiveView;
    activeScopeId = scopeId;
    activeViewId = viewId;
    releaseActiveView = nextRelease;
    previousRelease?.();
  };
  const synchronizeDraftLifetimes = () => {
    const drafts = scopes.getSnapshot().drafts;
    const retainedIds = new Set(drafts.map((draft) => draft.id));
    for (const draft of drafts) {
      if (draftRetainers.has(draft.id)) continue;
      bindings.register(draft.scopeId, draft.target.execution.hostId);
      leases.ensure(draft.scopeId, draft.target.execution.hostId, draft.target);
      draftRetainers.set(draft.id, leases.retain(draft.scopeId, "draft-lifetime"));
    }
    for (const [draftId, release] of draftRetainers) {
      if (retainedIds.has(draftId)) continue;
      draftRetainers.delete(draftId);
      release();
    }
  };
  synchronizeDraftLifetimes();
  const unsubscribeDrafts = scopes.subscribe(synchronizeDraftLifetimes);

  const prepareLocation = async (
    location: WorkbenchLocation,
  ): Promise<PreparedConversationActivation | null> => {
    ensureOpen();
    const scopeId = ensureLocationScope(location);
    const prepared = await coordinator.prepare(location);
    if (prepared === null) return null;
    return {
      location,
      scopeId,
      commit(viewId) {
        return prepared.commit(() => {
          if (location.kind === "draft") scopes.activateDraft(location.draftId);
          else scopes.deactivateDraft();
          commitActiveView(scopeId, viewId);
        }, viewId);
      },
      cancel: prepared.cancel,
    };
  };

  const preparePromotion = async (
    draftId: string,
    receipt: SubmissionReceipt,
  ): Promise<PreparedConversationActivation | null> => {
    ensureOpen();
    const draft = scopes.getDraft(draftId);
    if (draft === null) throw new Error(`Draft ${draftId} is unavailable`);
    if (draft.target.execution.hostId !== receipt.hostId) {
      throw new Error(`Draft ${draftId} belongs to Host ${draft.target.execution.hostId}`);
    }
    const key = createConversationKey(receipt.hostId, receipt.threadId);
    const collision = bindings.findScope(key);
    if (collision !== null && collision !== draft.scopeId) {
      throw new Error(`Thread ${encodeConversationKey(key)} belongs to Conversation Scope ${collision}`);
    }
    const location = createWorkbenchThreadLocation(receipt.hostId, receipt.threadId);
    const prepared = await coordinator.prepare(location);
    if (prepared === null) return null;
    const nextTarget = { type: "existing-thread", key } as const;
    return {
      location,
      scopeId: draft.scopeId,
      commit(viewId) {
        return prepared.commit(() => {
          const current = scopes.getDraft(draftId);
          if (
            current === null
            || current.phase !== "promoting"
            || current.receipt === null
            || current.receipt.commandId !== receipt.commandId
            || current.receipt.threadId !== receipt.threadId
          ) {
            throw new Error(`Draft ${draftId} promotion was superseded`);
          }
          const currentCollision = bindings.findScope(key);
          if (currentCollision !== null && currentCollision !== draft.scopeId) {
            throw new Error(
              `Thread ${encodeConversationKey(key)} belongs to Conversation Scope ${currentCollision}`,
            );
          }
          leases.bindTarget(draft.scopeId, nextTarget);
          views.bindScopeTarget(draft.scopeId, nextTarget);
          bindings.bind(draft.scopeId, key);
          if (!scopes.promoteDraft(draftId)) {
            throw new Error(`Draft ${draftId} promotion was superseded`);
          }
          commitActiveView(draft.scopeId, viewId);
        }, viewId);
      },
      cancel: prepared.cancel,
    };
  };

  return {
    scopeIdFor(location) {
      ensureOpen();
      if (location.kind === "draft") {
        const draft = scopes.getDraft(location.draftId);
        if (draft === null) throw new Error(`Draft ${location.draftId} is unavailable`);
        return draft.scopeId;
      }
      const scopeId = bindings.findScope(location.key);
      if (scopeId === null) {
        throw new Error(`Thread ${encodeConversationKey(location.key)} has no Conversation Scope`);
      }
      return scopeId;
    },
    async activate(location) {
      const prepared = await prepareLocation(location);
      return prepared?.commit() ?? false;
    },
    mountInitial(location, viewId) {
      ensureOpen();
      const scopeId = ensureLocationScope(location);
      if (location.kind === "draft") scopes.activateDraft(location.draftId);
      else scopes.deactivateDraft();
      coordinator.presentInitial(location, viewId);
      commitActiveView(scopeId, viewId);
    },
    presentLocalDraft(location, viewId) {
      ensureOpen();
      const scopeId = ensureLocationScope(location);
      scopes.activateDraft(location.draftId);
      coordinator.presentLocalDraft(location, viewId);
      commitActiveView(scopeId, viewId);
    },
    presentInitial(location, viewId) {
      this.mountInitial(location, viewId);
      const runtime = coordinator.getRuntime();
      let expectedEpoch = -1;
      let inFlight = true;
      let stopped = false;
      let readyEpoch = 0;
      let lastReadyEpoch = -1;
      let previousPhase = runtime.getSnapshot?.().phase;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribeRuntime?.();
        unsubscribeCoordinator();
        if (stopInitialRecovery === stop) stopInitialRecovery = null;
      };
      const observe = () => {
        const phase = runtime.getSnapshot?.().phase;
        if (phase === "ready" && previousPhase !== "ready") readyEpoch++;
        previousPhase = phase;
        if (stopped || inFlight) return;
        const snapshot = coordinator.getSnapshot();
        if (disposed || snapshot.activationEpoch !== expectedEpoch) { stop(); return; }
        if (snapshot.phase !== "error") return;
        if (snapshot.failureStage !== "connection") { stop(); return; }
        if (phase === "ready" && readyEpoch !== lastReadyEpoch) {
          lastReadyEpoch = readyEpoch;
          void attempt().catch(() => stop());
        }
      };
      const attempt = () => {
        inFlight = true;
        const operation = prepareLocation(location);
        expectedEpoch = coordinator.getSnapshot().activationEpoch;
        return operation.then(prepared => {
          const committed = prepared?.commit(viewId) ?? false;
          if (committed) stop();
          return committed;
        }).finally(() => { inFlight = false; observe(); });
      };
      const unsubscribeRuntime = runtime.subscribe?.(observe);
      const unsubscribeCoordinator = coordinator.subscribe(observe);
      stopInitialRecovery = stop;
      return attempt();
    },
    prepare: prepareLocation,
    cancelPending: () => coordinator.cancelPending(),
    preparePromotion,
    setViewId(viewId) {
      ensureOpen();
      coordinator.setViewId(viewId);
    },
    retargetDraft(draftId, execution) {
      ensureOpen();
      const draft = scopes.retargetDraft(draftId, execution);
      leases.bindTarget(draft.scopeId, draft.target);
      views.bindScopeTarget(draft.scopeId, draft.target);
    },
    async promoteDraft(draftId, receipt) {
      const prepared = await preparePromotion(draftId, receipt);
      if (prepared === null) {
        throw coordinator.getSnapshot().error ?? new Error("Thread activation failed");
      }
      if (!prepared.commit()) {
        throw new Error(`Draft ${draftId} activation was superseded`);
      }
      return prepared.location;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopInitialRecovery?.();
      unsubscribeDrafts();
      for (const release of draftRetainers.values()) release();
      draftRetainers.clear();
      releaseActiveView?.();
      releaseActiveView = null;
      activeScopeId = null;
      activeViewId = null;
    },
  };
}
