import type { HostId } from "@opencraft/chat-core";
import type { ComposerSelections, ComposerTarget } from "@opencraft/composer-core";

import type { ConversationScopeId } from "./conversation-binding";

export interface ConversationScopeLease {
  readonly scopeId: ConversationScopeId;
  readonly hostId: HostId;
  readonly target: ComposerTarget;
  readonly retainCount: number;
}

interface MutableConversationScopeLease {
  readonly scopeId: ConversationScopeId;
  readonly hostId: HostId;
  target: ComposerTarget;
  /** Composer selections the user explicitly chose for this conversation. */
  selections: ComposerSelections | null;
  readonly retainers: Map<symbol, string>;
  touchedAt: number;
}

export interface ConversationScopeLeaseRegistry {
  ensure(scopeId: ConversationScopeId, hostId: HostId, target: ComposerTarget): ConversationScopeLease;
  get(scopeId: ConversationScopeId): ConversationScopeLease | null;
  bindTarget(scopeId: ConversationScopeId, target: ComposerTarget): ConversationScopeLease;
  /** Last explicitly chosen Composer selections for the conversation, if any. */
  readSelections(scopeId: ConversationScopeId): ComposerSelections | null;
  /** Replaces the stored selections; callers pass the authoritative snapshot. */
  writeSelections(scopeId: ConversationScopeId, selections: ComposerSelections): ConversationScopeLease;
  clearSelections(): void;
  retain(scopeId: ConversationScopeId, reason: string): () => void;
  close(scopeId: ConversationScopeId): boolean;
  dispose(): void;
}

export interface ConversationScopeLeaseRegistryConfig {
  readonly onDisposeScope?: (scopeId: ConversationScopeId) => void;
  /** Automatic LRU cleanup must not abort an unrelated activation transaction. */
  readonly onDisposeError?: (error: AggregateError, scopeId: ConversationScopeId) => void;
  readonly maxInactiveScopes?: number;
}

/**
 * Owns semantic resources for a stable Conversation Scope. A Draft promotion
 * changes the canonical target without changing the Scope identity. Retained
 * conversation UI state (for example panel layout or the conversation's
 * explicitly chosen Composer selections) may use this lifetime; route-local
 * Composer, scroll and physical presentation state may not.
 */
export function createConversationScopeLeaseRegistry(
  config: ConversationScopeLeaseRegistryConfig,
): ConversationScopeLeaseRegistry {
  const entries = new Map<ConversationScopeId, MutableConversationScopeLease>();
  let disposed = false;
  let logicalClock = 0;
  const maxInactiveScopes = config.maxInactiveScopes ?? 20;

  const ensureOpen = () => {
    if (disposed) throw new Error("Conversation Scope lease registry is disposed");
  };
  const snapshot = (entry: MutableConversationScopeLease): ConversationScopeLease => ({
    scopeId: entry.scopeId,
    hostId: entry.hostId,
    target: entry.target,
    retainCount: entry.retainers.size,
  });
  const destroy = (entry: MutableConversationScopeLease): AggregateError | null => {
    entries.delete(entry.scopeId);
    const failures: unknown[] = [];
    try {
      config.onDisposeScope?.(entry.scopeId);
    } catch (error) {
      failures.push(error);
    }
    return failures.length === 0
      ? null
      : new AggregateError(failures, `Failed to dispose Conversation Scope ${entry.scopeId}`);
  };
  const prune = () => {
    const inactive = [...entries.values()]
      .filter((entry) => entry.retainers.size === 0)
      .sort((left, right) => left.touchedAt - right.touchedAt);
    while (inactive.length > maxInactiveScopes) {
      const entry = inactive.shift()!;
      const failure = destroy(entry);
      if (failure !== null) config.onDisposeError?.(failure, entry.scopeId);
    }
  };

  return {
    ensure(scopeId, hostId, target) {
      ensureOpen();
      const existing = entries.get(scopeId);
      if (existing !== undefined) {
        if (existing.hostId !== hostId) {
          throw new Error(`Conversation Scope ${scopeId} already belongs to Host ${existing.hostId}`);
        }
        return snapshot(existing);
      }
      const created: MutableConversationScopeLease = {
        scopeId,
        hostId,
        target,
        selections: null,
        retainers: new Map(),
        touchedAt: ++logicalClock,
      };
      entries.set(scopeId, created);
      prune();
      return snapshot(created);
    },
    get(scopeId) {
      const entry = entries.get(scopeId);
      return entry === undefined ? null : snapshot(entry);
    },
    bindTarget(scopeId, target) {
      ensureOpen();
      const entry = entries.get(scopeId);
      if (entry === undefined) throw new Error(`Conversation Scope ${scopeId} is unavailable`);
      const targetHostId = target.type === "new-thread"
        ? target.execution.hostId
        : target.key.hostId;
      if (targetHostId !== entry.hostId) {
        throw new Error(`Conversation Scope ${scopeId} cannot move to Host ${targetHostId}`);
      }
      entry.target = target;
      entry.touchedAt = ++logicalClock;
      return snapshot(entry);
    },
    readSelections(scopeId) {
      ensureOpen();
      const entry = entries.get(scopeId);
      return entry === undefined ? null : entry.selections;
    },
    writeSelections(scopeId, selections) {
      ensureOpen();
      const entry = entries.get(scopeId);
      if (entry === undefined) throw new Error(`Conversation Scope ${scopeId} is unavailable`);
      entry.selections = { ...selections };
      entry.touchedAt = ++logicalClock;
      return snapshot(entry);
    },
    clearSelections() {
      ensureOpen();
      for (const entry of entries.values()) entry.selections = null;
    },
    retain(scopeId, reason) {
      ensureOpen();
      const entry = entries.get(scopeId);
      if (entry === undefined) throw new Error(`Conversation Scope ${scopeId} is unavailable`);
      if (reason.trim().length === 0) throw new RangeError("Conversation Scope retainer must not be empty");
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
    close(scopeId) {
      const entry = entries.get(scopeId);
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
        throw new AggregateError(failures, "Failed to dispose Conversation Scope leases");
      }
    },
  };
}
