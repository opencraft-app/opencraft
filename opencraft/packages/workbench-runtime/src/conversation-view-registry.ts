import type { HostId } from "@opencraft/chat-core";
import {
  type ComposerController,
  type ComposerStoreServices,
  type ComposerTarget,
} from "@opencraft/composer-core";

import type { ConversationScopeId } from "./conversation-binding";
import type { ConversationScopeLeaseRegistry } from "./conversation-scope-lease";
import type { ConversationDraftContinuity } from "./conversation-draft-continuity";
import {
  createConversationDraftOwnerRegistry,
  type ConversationDraftOwner,
  type ConversationDraftOwnerRegistry,
} from "./conversation-draft-owner-registry";

export type ConversationViewId = string;

export interface ConversationViewLease {
  readonly viewId: ConversationViewId;
  readonly scopeId: ConversationScopeId;
  readonly hostId: HostId;
  readonly composer: ComposerController;
  readonly retainCount: number;
}

interface MutableConversationViewLease {
  readonly viewId: ConversationViewId;
  readonly scopeId: ConversationScopeId;
  readonly hostId: HostId;
  readonly composer: ComposerController;
  unsubscribeComposer: () => void;
  readonly releaseScope: () => void;
  readonly retainers: Map<symbol, () => void>;
  touchedAt: number;
}

export interface ConversationViewRegistry {
  ensure(
    viewId: ConversationViewId,
    scopeId: ConversationScopeId,
    hostId: HostId,
    target: ComposerTarget,
  ): ConversationViewLease;
  get(viewId: ConversationViewId): ConversationViewLease | null;
  /** Input may outlive its presentation cache, but never its account owner. */
  getDraftOwner(viewId: ConversationViewId): ConversationDraftOwner | null;
  hasRetainedInput(scopeId: ConversationScopeId): boolean;
  bindScopeTarget(scopeId: ConversationScopeId, target: ComposerTarget): void;
  replaceDraftContinuity(next: ConversationDraftContinuity | undefined): void;
  retain(viewId: ConversationViewId, reason: string): () => void;
  close(viewId: ConversationViewId): boolean;
  dispose(): void;
}

export interface ConversationViewRegistryConfig {
  readonly scopeLeases: ConversationScopeLeaseRegistry;
  readonly composerServices: ComposerStoreServices;
  readonly draftContinuity?: ConversationDraftContinuity;
  /** An injected Application owner is disposed by its caller, not the View cache. */
  readonly draftOwners?: ConversationDraftOwnerRegistry;
  readonly onEvictDraft?: (viewId: ConversationViewId, scopeId: ConversationScopeId) => void;
  readonly onDisposeView?: (viewId: ConversationViewId) => void;
  readonly onDisposeError?: (error: AggregateError, viewId: ConversationViewId) => void;
  readonly maxInactiveViews?: number;
}

/**
 * Owns presentation state for one concrete route/tab surface. Multiple Views
 * may observe the same Conversation Scope while borrowing independent Composer,
 * scroll and physical presentation state. Conversation panel state belongs to
 * the parent Scope and is deliberately absent here. Each cached View retains
 * its semantic Scope. Cached presentations do not retain Draft owners: their
 * content budget and attachment lifetime are independent of the View budget.
 */
export function createConversationViewRegistry(
  config: ConversationViewRegistryConfig,
): ConversationViewRegistry {
  const entries = new Map<ConversationViewId, MutableConversationViewLease>();
  // Binding metadata outlives the presentation, but does not retain its Scope.
  // Promotion must rebind every input slot, including ones whose UI was evicted.
  const ownerScopes = new Map<ConversationViewId, {
    readonly scopeId: ConversationScopeId;
    readonly composer: ComposerController;
    readonly stop: () => void;
  }>();
  let disposed = false;
  let logicalClock = 0;
  const maxInactiveViews = config.maxInactiveViews ?? 20;
  const draftOwners = config.draftOwners ?? createConversationDraftOwnerRegistry({
    composerServices: config.composerServices,
    draftContinuity: config.draftContinuity,
    onDisposeError: config.onDisposeError,
  });

  const ensureOpen = () => {
    if (disposed) throw new Error("Conversation View registry is disposed");
  };
  const snapshot = (entry: MutableConversationViewLease): ConversationViewLease => ({
    viewId: entry.viewId,
    scopeId: entry.scopeId,
    hostId: entry.hostId,
    composer: entry.composer,
    retainCount: entry.retainers.size,
  });
  const destroy = (entry: MutableConversationViewLease): AggregateError | null => {
    entries.delete(entry.viewId);
    const failures: unknown[] = [];
    try {
      entry.unsubscribeComposer();
    } catch (error) {
      failures.push(error);
    }
    try {
      for (const release of entry.retainers.values()) release();
      entry.retainers.clear();
    } catch (error) {
      failures.push(error);
    }
    try {
      entry.releaseScope();
    } catch (error) {
      failures.push(error);
    }
    try {
      config.onDisposeView?.(entry.viewId);
    } catch (error) {
      failures.push(error);
    }
    const owner = draftOwners.get(entry.viewId);
    if (owner !== null && !owner.composer.hasRetainedContent()) {
      try { draftOwners.close(entry.viewId); } catch (error) { failures.push(error); }
    }
    return failures.length === 0
      ? null
      : new AggregateError(failures, `Failed to dispose Conversation View ${entry.viewId}`);
  };
  const prune = () => {
    const inactive = [...entries.values()]
      .filter((entry) => entry.retainers.size === 0)
      .sort((left, right) => left.touchedAt - right.touchedAt);
    while (inactive.length > maxInactiveViews) {
      const entry = inactive.shift()!;
      const failure = destroy(entry);
      if (failure !== null) config.onDisposeError?.(failure, entry.viewId);
    }
  };

  return {
    ensure(viewId, scopeId, hostId, target) {
      ensureOpen();
      const existing = entries.get(viewId);
      if (existing !== undefined) {
        if (existing.scopeId !== scopeId || existing.hostId !== hostId) {
          throw new Error(
            `Conversation View ${viewId} already belongs to Scope ${existing.scopeId}`,
          );
        }
        return snapshot(existing);
      }
      const scope = config.scopeLeases.get(scopeId);
      if (scope === null) throw new Error(`Conversation Scope ${scopeId} is unavailable`);
      if (scope.hostId !== hostId) {
        throw new Error(`Conversation Scope ${scopeId} belongs to Host ${scope.hostId}`);
      }
      const owner = draftOwners.ensure(viewId, hostId, target);
      const ownerScope = ownerScopes.get(viewId);
      if (ownerScope !== undefined && ownerScope.scopeId !== scopeId) {
        throw new Error(`Conversation draft owner ${viewId} belongs to Scope ${ownerScope.scopeId}`);
      }
      if (ownerScope === undefined) {
        const stop = owner.composer.onDispose(() => {
          ownerScopes.delete(viewId);
          const view = entries.get(viewId);
          if (view !== undefined) {
            const failure = destroy(view);
            if (failure !== null) config.onDisposeError?.(failure, viewId);
          }
          config.onEvictDraft?.(viewId, scopeId);
        });
        ownerScopes.set(viewId, { scopeId, composer: owner.composer, stop });
      }
      const created: MutableConversationViewLease = {
        viewId,
        scopeId,
        hostId,
        composer: owner.composer,
        unsubscribeComposer: () => {},
        releaseScope: config.scopeLeases.retain(scopeId, `conversation-view:${viewId}`),
        retainers: new Map(),
        touchedAt: ++logicalClock,
      };
      // Conversation Scope owns the conversation's explicitly chosen Composer
      // selections (Codex keeps them on the conversation state, not on any
      // route-local Composer). Seed a fresh Composer draft from the Scope and
      // mirror later draft changes back so View recreation cannot lose them.
      const storedSelections = config.scopeLeases.readSelections(scopeId);
      if (storedSelections !== null) {
        created.composer.dispatch({ type: "set-selections", patch: storedSelections });
      }
      let mirroredSelections = created.composer.getSnapshot().draft.selections;
      created.unsubscribeComposer = created.composer.subscribe(() => {
        const selections = created.composer.getSnapshot().draft.selections;
        if (selections === mirroredSelections) return;
        mirroredSelections = selections;
        // A fresh draft after switch-target starts empty; that is target
        // rotation, not an explicit reset, so it must not erase Scope state.
        if (Object.keys(selections).length === 0) return;
        config.scopeLeases.writeSelections(scopeId, selections);
      });
      entries.set(viewId, created);
      prune();
      return snapshot(created);
    },
    get(viewId) {
      const entry = entries.get(viewId);
      return entry === undefined ? null : snapshot(entry);
    },
    getDraftOwner: (viewId) => draftOwners.get(viewId),
    hasRetainedInput: (scopeId) => [...ownerScopes.values()].some(owner =>
      owner.scopeId === scopeId && owner.composer.hasRetainedContent()),
    bindScopeTarget(scopeId, target) {
      ensureOpen();
      for (const [viewId, owner] of ownerScopes) {
        if (owner.scopeId !== scopeId) continue;
        draftOwners.bindTarget(viewId, target);
        // A promoted Draft target has no cached Composer draft; restore the
        // Scope's chosen selections so they carry into the canonical Thread.
        const draftSelections = owner.composer.getSnapshot().draft.selections;
        const storedSelections = config.scopeLeases.readSelections(scopeId);
        if (storedSelections !== null && Object.keys(draftSelections).length === 0) {
          owner.composer.dispatch({ type: "set-selections", patch: storedSelections });
        }
        const entry = entries.get(viewId);
        if (entry !== undefined) entry.touchedAt = ++logicalClock;
      }
    },
    replaceDraftContinuity(next) {
      ensureOpen();
      config.scopeLeases.clearSelections();
      draftOwners.replaceDraftContinuity(next);
    },
    retain(viewId, reason) {
      ensureOpen();
      const entry = entries.get(viewId);
      if (entry === undefined) throw new Error(`Conversation View ${viewId} is unavailable`);
      if (reason.trim().length === 0) throw new RangeError("Conversation View retainer must not be empty");
      const token = Symbol(reason);
      entry.retainers.set(token, draftOwners.retain(viewId, reason));
      entry.touchedAt = ++logicalClock;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const releaseDraft = entry.retainers.get(token);
        entry.retainers.delete(token);
        releaseDraft?.();
        entry.touchedAt = ++logicalClock;
        prune();
      };
    },
    close(viewId) {
      const entry = entries.get(viewId);
      if (entry !== undefined && entry.retainers.size > 0) return false;
      // Explicit close discards input; automatic cache pruning does not.
      return draftOwners.close(viewId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      for (const entry of [...entries.values()]) {
        const failure = destroy(entry);
        if (failure !== null) failures.push(failure);
      }
      if (config.draftOwners === undefined) {
        try { draftOwners.dispose(); } catch (error) { failures.push(error); }
      }
      for (const owner of ownerScopes.values()) owner.stop();
      ownerScopes.clear();
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose Conversation Views");
      }
    },
  };
}
