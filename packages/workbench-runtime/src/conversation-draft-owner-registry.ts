import type { HostId } from "@opencraft/chat-core";
import {
  createComposerController,
  encodeComposerTarget,
  isComposerDocumentEmpty,
  type ComposerAction,
  type ComposerController,
  type ComposerStoreServices,
  type ComposerStoreSnapshot,
  type ComposerTarget,
} from "@opencraft/composer-core";

import type { ConversationDraftContinuity } from "./conversation-draft-continuity";

/** A stable editor slot, independent of a mounted or cached View. */
export type ConversationDraftOwnerId = string;

export interface ConversationDraftOwner {
  readonly ownerId: ConversationDraftOwnerId;
  readonly hostId: HostId;
  readonly composer: ComposerController;
  readonly retainCount: number;
}

export interface ConversationDraftOwnerRegistry {
  ensure(ownerId: ConversationDraftOwnerId, hostId: HostId, target: ComposerTarget): ConversationDraftOwner;
  get(ownerId: ConversationDraftOwnerId): ConversationDraftOwner | null;
  bindTarget(ownerId: ConversationDraftOwnerId, target: ComposerTarget): void;
  /** Only a physical editor or interaction retains an owner; cached Views do not. */
  retain(ownerId: ConversationDraftOwnerId, reason: string): () => void;
  touch(ownerId: ConversationDraftOwnerId): void;
  /** Read-only admission probe for an empty editor before it acquires content. */
  canAdmitContent(ownerId: ConversationDraftOwnerId): boolean;
  replaceDraftContinuity(next: ConversationDraftContinuity | undefined): void;
  close(ownerId: ConversationDraftOwnerId): boolean;
  dispose(): void;
}

export interface ConversationDraftOwnerRegistryConfig {
  /** Target-keyed draft storage is incompatible with editor-slot isolation. */
  readonly composerServices: ComposerStoreServices;
  readonly draftContinuity?: ConversationDraftContinuity;
  readonly maxDrafts?: number;
  /** Revoke presentation caches/checkpoints referencing a removed owner. */
  readonly onEvict?: (ownerId: ConversationDraftOwnerId) => void;
  readonly onDisposeError?: (error: AggregateError, ownerId: ConversationDraftOwnerId) => void;
}

export class ConversationDraftCapacityError extends Error {
  constructor(readonly ownerId: ConversationDraftOwnerId, readonly maxDrafts: number) {
    super(`Conversation draft capacity ${maxDrafts} is occupied by active drafts`);
    this.name = "ConversationDraftCapacityError";
  }
}

interface MutableDraftOwner {
  readonly ownerId: ConversationDraftOwnerId;
  readonly hostId: HostId;
  readonly composer: ComposerController;
  readonly baseComposer: ComposerController;
  readonly retainers: Set<symbol>;
  readonly targets: Map<string, ComposerTarget>;
  readonly submittingDrafts: Set<string>;
  unsubscribeComposer: () => void;
  stopDraftContinuity: () => void;
  continuityPaused: boolean;
  hasBeenRetained: boolean;
  hasHadContent: boolean;
  touchedAt: number;
}

function targetHost(target: ComposerTarget): HostId {
  return target.type === "new-thread" ? target.execution.hostId : target.key.hostId;
}

function changedContent(previous: ComposerStoreSnapshot, next: ComposerStoreSnapshot): boolean {
  return previous.draft.document !== next.draft.document
    || previous.draft.attachments.length !== next.draft.attachments.length
    || previous.draft.attachments.some((attachment, index) => attachment.id !== next.draft.attachments[index]?.id)
    || previous.draft.context !== next.draft.context
    || previous.hasTransientText !== next.hasTransientText;
}

/**
 * Application/account-owned input. An owner retains its Controller and its
 * platform attachment session without retaining a Scope, Thread or runtime.
 * Content capacity is enforced against inactive owners in least-used order.
 * Admission rejects new content when the entire capacity belongs to editing or
 * sending owners, preserving existing input without exceeding the limit.
 */
export function createConversationDraftOwnerRegistry(
  config: ConversationDraftOwnerRegistryConfig,
): ConversationDraftOwnerRegistry {
  const maxDrafts = config.maxDrafts ?? 50;
  if (!Number.isInteger(maxDrafts) || maxDrafts < 0) {
    throw new RangeError("Conversation draft capacity must be a nonnegative integer");
  }
  if (config.composerServices.drafts !== undefined) {
    throw new Error("Conversation draft owners require editor-slot continuity, not target-keyed draft storage");
  }
  const entries = new Map<ConversationDraftOwnerId, MutableDraftOwner>();
  let draftContinuity = config.draftContinuity;
  let disposed = false;
  let logicalClock = 0;
  let mutationDepth = 0;
  let pruning = false;
  const ensureOpen = () => {
    if (disposed) throw new Error("Conversation draft owner registry is disposed");
  };
  const read = (ownerId: ConversationDraftOwnerId): MutableDraftOwner => {
    const entry = entries.get(ownerId);
    if (entry === undefined) throw new Error(`Conversation draft owner ${ownerId} is unavailable`);
    return entry;
  };
  const snapshot = (entry: MutableDraftOwner): ConversationDraftOwner => ({
    ownerId: entry.ownerId,
    hostId: entry.hostId,
    composer: entry.composer,
    retainCount: entry.retainers.size,
  });
  const protectedOwner = (entry: MutableDraftOwner) => {
    for (const draftId of entry.submittingDrafts) {
      if (entry.composer.getDraftPhase(draftId) !== "submitting") entry.submittingDrafts.delete(draftId);
    }
    return entry.retainers.size > 0
      || entry.composer.getSnapshot().draft.lifecycle.phase === "submitting"
      || entry.submittingDrafts.size > 0;
  };
  const destroy = (entry: MutableDraftOwner, discard: boolean): AggregateError | null => {
    if (entries.get(entry.ownerId) !== entry) return null;
    entries.delete(entry.ownerId);
    const failures: unknown[] = [];
    const run = (operation: () => void) => {
      try { operation(); } catch (error) { failures.push(error); }
    };
    run(entry.stopDraftContinuity);
    run(entry.unsubscribeComposer);
    if (discard) {
      for (const target of entry.targets.values()) run(() => draftContinuity?.discard(entry.ownerId, target));
    }
    run(() => entry.composer.dispose());
    run(() => config.onEvict?.(entry.ownerId));
    return failures.length === 0 ? null : new AggregateError(failures, `Failed to dispose Conversation draft owner ${entry.ownerId}`);
  };
  const evict = (entry: MutableDraftOwner, discard = true) => {
    const failure = destroy(entry, discard);
    if (failure !== null) config.onDisposeError?.(failure, entry.ownerId);
  };
  const nonempty = () => [...entries.values()].filter(entry => entry.composer.hasRetainedContent());
  const oldestEligible = () => nonempty().filter(entry => !protectedOwner(entry))
    .sort((left, right) => left.touchedAt - right.touchedAt)[0];
  const canAdmitContent = (entry: MutableDraftOwner) => entry.composer.hasRetainedContent()
    || nonempty().length < maxDrafts || oldestEligible() !== undefined;
  const admitContent = (entry: MutableDraftOwner) => {
    if (entry.composer.hasRetainedContent()) return;
    while (nonempty().length >= maxDrafts) {
      const candidate = oldestEligible();
      if (candidate === undefined) {
        // Hydration must not subsequently persist the still-empty snapshot over
        // the stored content whose admission was refused.
        entry.stopDraftContinuity();
        entry.stopDraftContinuity = () => {};
        entry.continuityPaused = draftContinuity !== undefined;
        throw new ConversationDraftCapacityError(entry.ownerId, maxDrafts);
      }
      evict(candidate);
    }
  };
  const actionHasContent = (action: ComposerAction): boolean => {
    switch (action.type) {
      case "set-document": return !isComposerDocumentEmpty(action.document);
      case "replace-content": return !isComposerDocumentEmpty(action.document)
        || action.attachments.length > 0 || action.context.length > 0;
      case "add-attachment":
      case "add-context": return true;
      default: return false;
    }
  };
  const prune = () => {
    if (disposed || mutationDepth > 0 || pruning) return;
    pruning = true;
    try {
      for (const entry of [...entries.values()]) {
        if (entry.hasBeenRetained && !entry.composer.hasRetainedContent() && !protectedOwner(entry)) {
          evict(entry, entry.hasHadContent);
        }
      }
      const contentOwners = nonempty();
      let excess = contentOwners.length - maxDrafts;
      const candidates = contentOwners.filter(entry => !protectedOwner(entry))
        .sort((left, right) => left.touchedAt - right.touchedAt);
      for (const entry of candidates) {
        if (excess <= 0) break;
        evict(entry);
        excess--;
      }
      for (const entry of entries.values()) {
        if (entry.continuityPaused && canAdmitContent(entry)) attach(entry);
      }
    } finally { pruning = false; }
  };
  const attach = (entry: MutableDraftOwner) => {
    const target = entry.composer.getSnapshot().draft.target;
    entry.targets.set(encodeComposerTarget(target), target);
    entry.continuityPaused = false;
    entry.stopDraftContinuity = draftContinuity?.attach(entry.ownerId, entry.composer) ?? (() => {});
  };
  const bindTarget = (entry: MutableDraftOwner, target: ComposerTarget) => {
    if (targetHost(target) !== entry.hostId) {
      throw new Error(`Conversation draft owner ${entry.ownerId} belongs to Host ${entry.hostId}`);
    }
    const previousTarget = entry.composer.getSnapshot().draft.target;
    const targetChanged = encodeComposerTarget(previousTarget) !== encodeComposerTarget(target);
    if (targetChanged && entry.composer.hasTargetContent(target)) admitContent(entry);
    mutationDepth++;
    try {
      if (targetChanged) {
        entry.stopDraftContinuity();
        entry.stopDraftContinuity = () => {};
        if (previousTarget.type === "new-thread" && target.type === "existing-thread") {
          draftContinuity?.discard(entry.ownerId, previousTarget);
        }
      }
      entry.baseComposer.dispatch({ type: "switch-target", target, preserveDraft: true });
      entry.touchedAt = ++logicalClock;
      if (targetChanged) attach(entry);
      else entry.targets.set(encodeComposerTarget(target), target);
    } finally { mutationDepth--; }
    prune();
  };

  return {
    ensure(ownerId, hostId, target) {
      ensureOpen();
      if (!ownerId.trim()) throw new RangeError("Conversation draft owner identity must not be empty");
      if (targetHost(target) !== hostId) throw new Error(`Conversation draft target belongs to Host ${targetHost(target)}`);
      const existing = entries.get(ownerId);
      if (existing !== undefined) {
        if (existing.hostId !== hostId) throw new Error(`Conversation draft owner ${ownerId} belongs to Host ${existing.hostId}`);
        if (encodeComposerTarget(existing.composer.getSnapshot().draft.target) !== encodeComposerTarget(target)) {
          throw new Error(`Conversation draft owner ${ownerId} already belongs to another target`);
        }
        existing.touchedAt = ++logicalClock;
        return snapshot(existing);
      }
      const baseComposer = createComposerController(target, config.composerServices);
      const composer: ComposerController = {
        ...baseComposer,
        dispatch(action) {
          if (entries.get(ownerId) !== entry) {
            baseComposer.dispatch(action);
            return;
          }
          if (action.type === "switch-target") {
            bindTarget(entry, action.target);
            return;
          }
          if (actionHasContent(action)) admitContent(entry);
          baseComposer.dispatch(action);
        },
        settleSubmission(draftId, intent, result) {
          const continuity = draftContinuity;
          const settled = baseComposer.settleSubmission(draftId, intent, result);
          // A cached target has no current persistence subscription. An
          // accepted send must still revoke its saved text before returning
          // to that target, while newly edited content remains recoverable.
          if (settled && result.status === "accepted" && !baseComposer.hasTargetContent(intent.target)) {
            continuity?.discard(ownerId, intent.target);
          }
          return settled;
        },
        beginTransientTextInput(observer) {
          const input = baseComposer.beginTransientTextInput(observer);
          return input === null ? null : {
            ...input,
            update(value) {
              if (entries.get(ownerId) !== entry) return;
              if (value.length > 0) admitContent(entry);
              input.update(value);
            },
          };
        },
      };
      const entry: MutableDraftOwner = {
        ownerId,
        hostId,
        composer,
        baseComposer,
        retainers: new Set(),
        targets: new Map(),
        submittingDrafts: new Set(),
        unsubscribeComposer: () => {},
        stopDraftContinuity: () => {},
        continuityPaused: false,
        hasBeenRetained: false,
        hasHadContent: false,
        touchedAt: ++logicalClock,
      };
      entries.set(ownerId, entry);
      let previous = entry.composer.getSnapshot();
      entry.unsubscribeComposer = entry.composer.subscribe(() => {
        if (entries.get(ownerId) !== entry) return;
        const next = entry.composer.getSnapshot();
        if (entry.composer.hasRetainedContent()) entry.hasHadContent = true;
        if (next.draft.lifecycle.phase === "submitting") entry.submittingDrafts.add(next.draft.id);
        if (changedContent(previous, next)) entry.touchedAt = ++logicalClock;
        previous = next;
        prune();
      });
      mutationDepth++;
      try { attach(entry); } catch (error) {
        destroy(entry, false);
        throw error;
      } finally { mutationDepth--; }
      // A synchronous storage adapter may hydrate during attach. Give the
      // caller its physical retain before considering that restored content.
      void Promise.resolve().then(prune);
      return snapshot(entry);
    },
    get(ownerId) {
      const entry = entries.get(ownerId);
      return entry === undefined ? null : snapshot(entry);
    },
    bindTarget(ownerId, target) {
      ensureOpen();
      bindTarget(read(ownerId), target);
    },
    retain(ownerId, reason) {
      ensureOpen();
      if (!reason.trim()) throw new RangeError("Conversation draft retainer must not be empty");
      const entry = read(ownerId);
      const token = Symbol(reason);
      entry.retainers.add(token);
      entry.hasBeenRetained = true;
      entry.touchedAt = ++logicalClock;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (entries.get(ownerId) !== entry) return;
        entry.retainers.delete(token);
        entry.touchedAt = ++logicalClock;
        if (!entry.composer.hasRetainedContent() && !protectedOwner(entry)) evict(entry, entry.hasHadContent);
        prune();
      };
    },
    touch(ownerId) {
      ensureOpen();
      read(ownerId).touchedAt = ++logicalClock;
      prune();
    },
    canAdmitContent(ownerId) {
      ensureOpen();
      return canAdmitContent(read(ownerId));
    },
    replaceDraftContinuity(next) {
      ensureOpen();
      mutationDepth++;
      try {
        for (const entry of entries.values()) {
          entry.stopDraftContinuity();
          entry.stopDraftContinuity = () => {};
          for (const target of entry.targets.values()) draftContinuity?.discard(entry.ownerId, target);
          entry.composer.dispatch({ type: "reset-all" });
          entry.targets.clear();
          entry.submittingDrafts.clear();
        }
        draftContinuity = next;
        for (const entry of entries.values()) attach(entry);
      } finally { mutationDepth--; }
      prune();
    },
    close(ownerId) {
      const entry = entries.get(ownerId);
      if (entry === undefined || protectedOwner(entry)) return false;
      const failure = destroy(entry, true);
      if (failure !== null) throw failure;
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const failures: AggregateError[] = [];
      for (const entry of [...entries.values()]) {
        const failure = destroy(entry, false);
        if (failure !== null) failures.push(failure);
      }
      if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose Conversation draft owners");
    },
  };
}
