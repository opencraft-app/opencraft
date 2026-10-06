import type { HostId } from "@opencraft/chat-core";
import {
  createComposerController,
  type ComposerController,
  type ComposerStoreServices,
  type ComposerTarget,
  encodeComposerTarget,
} from "@opencraft/composer-core";

import type { ConversationScopeId } from "./conversation-binding";
import type { ConversationScopeLeaseRegistry } from "./conversation-scope-lease";
import type { ConversationDraftContinuity } from "./conversation-draft-continuity";

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
  stopDraftContinuity: () => void;
  readonly releaseScope: () => void;
  readonly retainers: Map<symbol, string>;
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
  readonly onDisposeView?: (viewId: ConversationViewId) => void;
  readonly onDisposeError?: (error: AggregateError, viewId: ConversationViewId) => void;
  readonly maxInactiveViews?: number;
}

/**
 * Owns presentation state for one concrete route/tab surface. Multiple Views
 * may observe the same Conversation Scope while keeping independent Composer,
 * scroll and physical presentation state. Conversation panel state belongs to
 * the parent Scope and is deliberately absent here. Each cached View retains
 * its semantic Scope.
 */
export function createConversationViewRegistry(
  config: ConversationViewRegistryConfig,
): ConversationViewRegistry {
  const entries = new Map<ConversationViewId, MutableConversationViewLease>();
  let disposed = false;
  let logicalClock = 0;
  let draftContinuity = config.draftContinuity;
  const maxInactiveViews = config.maxInactiveViews ?? 20;

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
      entry.stopDraftContinuity();
    } catch (error) {
      failures.push(error);
    }
    try {
      entry.unsubscribeComposer();
    } catch (error) {
      failures.push(error);
    }
    try {
      entry.composer.dispose();
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
      const created: MutableConversationViewLease = {
        viewId,
        scopeId,
        hostId,
        composer: createComposerController(target, config.composerServices),
        unsubscribeComposer: () => {},
        stopDraftContinuity: () => {},
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
      created.stopDraftContinuity = draftContinuity?.attach(viewId, created.composer) ?? (() => {});
      entries.set(viewId, created);
      prune();
      return snapshot(created);
    },
    get(viewId) {
      const entry = entries.get(viewId);
      return entry === undefined ? null : snapshot(entry);
    },
    bindScopeTarget(scopeId, target) {
      ensureOpen();
      for (const entry of entries.values()) {
        if (entry.scopeId !== scopeId) continue;
        const previousTarget = entry.composer.getSnapshot().draft.target;
        if (encodeComposerTarget(previousTarget) === encodeComposerTarget(target)) {
          entry.composer.dispatch({ type: "switch-target", target });
          entry.touchedAt = ++logicalClock;
          continue;
        }
        entry.stopDraftContinuity();
        if (previousTarget.type === "new-thread" && target.type === "existing-thread") {
          draftContinuity?.discard(entry.viewId, previousTarget);
        }
        entry.composer.dispatch({ type: "switch-target", target });
        entry.stopDraftContinuity = draftContinuity?.attach(entry.viewId, entry.composer) ?? (() => {});
        // A promoted Draft target has no cached Composer draft; restore the
        // Scope's chosen selections so they carry into the canonical Thread.
        const draftSelections = entry.composer.getSnapshot().draft.selections;
        const storedSelections = config.scopeLeases.readSelections(scopeId);
        if (storedSelections !== null && Object.keys(draftSelections).length === 0) {
          entry.composer.dispatch({ type: "set-selections", patch: storedSelections });
        }
        entry.touchedAt = ++logicalClock;
      }
    },
    replaceDraftContinuity(next) {
      ensureOpen();
      config.scopeLeases.clearSelections();
      for (const entry of entries.values()) {
        const target = entry.composer.getSnapshot().draft.target;
        entry.stopDraftContinuity();
        draftContinuity?.discard(entry.viewId, target);
        entry.composer.dispatch({ type: "reset-all" });
      }
      draftContinuity = next;
      for (const entry of entries.values()) {
        entry.stopDraftContinuity = draftContinuity?.attach(entry.viewId, entry.composer) ?? (() => {});
      }
    },
    retain(viewId, reason) {
      ensureOpen();
      const entry = entries.get(viewId);
      if (entry === undefined) throw new Error(`Conversation View ${viewId} is unavailable`);
      if (reason.trim().length === 0) throw new RangeError("Conversation View retainer must not be empty");
      const token = Symbol(reason);
      entry.retainers.set(token, reason);
      entry.touchedAt = ++logicalClock;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.retainers.delete(token);
        entry.touchedAt = ++logicalClock;
        prune();
      };
    },
    close(viewId) {
      const entry = entries.get(viewId);
      if (entry === undefined) return false;
      if (entry.retainers.size > 0) return false;
      const failure = destroy(entry);
      if (failure !== null) throw failure;
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      for (const entry of [...entries.values()]) {
        const failure = destroy(entry);
        if (failure !== null) failures.push(failure);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose Conversation Views");
      }
    },
  };
}
