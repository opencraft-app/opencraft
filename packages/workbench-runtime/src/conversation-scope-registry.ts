import { asHostId } from "@opencraft/chat-core";
import type {
  ComposerExecutionTarget,
  ComposerTarget,
  SubmissionReceipt,
  SubmitIntent,
} from "@opencraft/composer-core";

import {
  asConversationScopeId,
  type ConversationScopeId,
} from "./conversation-binding";

export type NewThreadDraftEntrypoint = "home" | "new-chat";
export type NewThreadDraftPhase =
  | "editing"
  | "submitting"
  | "submit-failed"
  | "accepted"
  | "promoting";

export function draftSubmissionOwnsNavigation(phase: NewThreadDraftPhase): boolean {
  return phase === "submitting" || phase === "accepted" || phase === "promoting";
}

export interface NewThreadDraftSnapshot {
  readonly id: string;
  readonly scopeId: ConversationScopeId;
  readonly entrypoint: NewThreadDraftEntrypoint;
  readonly target: Extract<ComposerTarget, { readonly type: "new-thread" }>;
  readonly phase: NewThreadDraftPhase;
  readonly error: Error | null;
  /** Once present, retries must resume promotion and must never submit again. */
  readonly receipt: SubmissionReceipt | null;
  /** Immutable first-Turn command owned by this Scope from the submit gesture onward. */
  readonly submission: SubmitIntent | null;
  readonly createdAt: number;
}

export interface ConversationScopeRegistrySnapshot {
  readonly revision: number;
  readonly activeDraftId: string | null;
  readonly drafts: readonly NewThreadDraftSnapshot[];
}

export interface OpenNewThreadDraftOptions {
  /** Preparation may allocate a Host-owned draft without replacing the visible one. */
  readonly activate?: boolean;
  readonly execution: ComposerExecutionTarget;
  readonly entrypoint?: NewThreadDraftEntrypoint;
  readonly draftId?: string;
}

export interface ConversationScopeRegistryConfig {
  readonly initialDraft?: OpenNewThreadDraftOptions | null;
  readonly createDraftId?: () => string;
  readonly now?: () => number;
  /** Empty, editable Draft metadata is bounded separately from retained input. */
  readonly maxRetainedDrafts?: number;
  /** Read the Application input owner; this probe acquires no execution lease. */
  readonly isInputRetained?: (scopeId: ConversationScopeId) => boolean;
}

export interface ConversationScopeRegistry {
  getSnapshot(): ConversationScopeRegistrySnapshot;
  subscribe(listener: () => void): () => void;
  getDraft(draftId: string): NewThreadDraftSnapshot | null;
  getActiveDraft(): NewThreadDraftSnapshot | null;
  openDraft(options: OpenNewThreadDraftOptions): NewThreadDraftSnapshot;
  activateDraft(draftId: string): NewThreadDraftSnapshot;
  deactivateDraft(): void;
  retargetDraft(draftId: string, execution: ComposerExecutionTarget): NewThreadDraftSnapshot;
  beginSubmit(draftId: string, submission: SubmitIntent): NewThreadDraftSnapshot;
  acceptSubmission(draftId: string, receipt: SubmissionReceipt): NewThreadDraftSnapshot;
  beginPromotion(draftId: string): NewThreadDraftSnapshot;
  failDraft(draftId: string, error: unknown): NewThreadDraftSnapshot | null;
  failPromotion(draftId: string, error: unknown): NewThreadDraftSnapshot | null;
  promoteDraft(draftId: string): boolean;
  dismissDraft(draftId: string): boolean;
  dispose(): void;
}

function defaultDraftId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return `client-new-thread:${randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function normalizeExecution(execution: ComposerExecutionTarget): ComposerExecutionTarget {
  const roots = [...new Set(
    execution.workspace.runtimeWorkspaceRoots
      .map((root) => root.trim())
      .filter((root) => root.length > 0),
  )];
  const cwd = execution.workspace.cwd?.trim() || null;
  return {
    hostId: asHostId(execution.hostId),
    workspace: {
      cwd,
      runtimeWorkspaceRoots: roots,
      ...(execution.workspace.projectId === undefined
        ? {}
        : { projectId: execution.workspace.projectId }),
    },
  };
}

/**
 * Application owner for retained client Conversations that do not yet have a
 * server Thread. Browser history may activate any retained Draft independently.
 */
export function createConversationScopeRegistry(
  config: ConversationScopeRegistryConfig = {},
): ConversationScopeRegistry {
  const listeners = new Set<() => void>();
  const drafts = new Map<string, NewThreadDraftSnapshot>();
  const createDraftId = config.createDraftId ?? defaultDraftId;
  const now = config.now ?? Date.now;
  const maxRetainedDrafts = config.maxRetainedDrafts ?? 20;
  let activeDraftId: string | null = null;
  let disposed = false;
  let revision = 0;
  let snapshot: ConversationScopeRegistrySnapshot;

  const ensureOpen = () => {
    if (disposed) throw new Error("Conversation Scope registry is disposed");
  };
  const derive = (): ConversationScopeRegistrySnapshot => ({
    revision,
    activeDraftId,
    drafts: [...drafts.values()],
  });
  const publish = () => {
    revision += 1;
    snapshot = derive();
    for (const listener of listeners) listener();
  };
  const createDraft = (options: OpenNewThreadDraftOptions): NewThreadDraftSnapshot => {
    const id = options.draftId ?? createDraftId();
    if (id.trim().length === 0) throw new RangeError("Draft ID must not be empty");
    return Object.freeze({
      id,
      scopeId: asConversationScopeId(id),
      entrypoint: options.entrypoint ?? "new-chat",
      target: {
        type: "new-thread" as const,
        draftId: id,
        execution: normalizeExecution(options.execution),
      },
      phase: "editing" as const,
      error: null,
      receipt: null,
      submission: null,
      createdAt: now(),
    });
  };
  const requireDraft = (draftId: string): NewThreadDraftSnapshot => {
    const draft = drafts.get(draftId);
    if (draft === undefined) throw new Error(`New chat Draft ${draftId} is unavailable`);
    return draft;
  };
  const pruneDrafts = () => {
    const emptyEditable = [...drafts.values()].filter((draft) =>
      (draft.phase === "editing" || draft.phase === "submit-failed")
      && !(config.isInputRetained?.(draft.scopeId) ?? false));
    const inactive = emptyEditable.filter((draft) => draft.id !== activeDraftId)
      .sort((left, right) => left.createdAt - right.createdAt);
    let excess = emptyEditable.length - maxRetainedDrafts;
    while (excess > 0 && inactive.length > 0) {
      drafts.delete(inactive.shift()!.id);
      excess--;
    }
  };

  if (config.initialDraft !== undefined && config.initialDraft !== null) {
    const draft = createDraft(config.initialDraft);
    drafts.set(draft.id, draft);
    activeDraftId = draft.id;
  }
  snapshot = derive();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      ensureOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getDraft: (draftId) => drafts.get(draftId) ?? null,
    getActiveDraft: () => activeDraftId === null ? null : drafts.get(activeDraftId) ?? null,
    openDraft(options) {
      ensureOpen();
      if (options.draftId !== undefined) {
        const existing = drafts.get(options.draftId);
        if (existing !== undefined) {
          if (options.activate !== false) activeDraftId = existing.id;
          publish();
          return existing;
        }
      }
      const draft = createDraft(options);
      if (drafts.has(draft.id)) throw new Error(`Draft ${draft.id} already exists`);
      drafts.set(draft.id, draft);
      if (options.activate !== false) activeDraftId = draft.id;
      pruneDrafts();
      publish();
      return draft;
    },
    activateDraft(draftId) {
      ensureOpen();
      const draft = requireDraft(draftId);
      if (activeDraftId !== draftId) {
        activeDraftId = draftId;
        publish();
      }
      return draft;
    },
    deactivateDraft() {
      ensureOpen();
      if (activeDraftId === null) return;
      activeDraftId = null;
      publish();
    },
    retargetDraft(draftId, execution) {
      ensureOpen();
      const current = requireDraft(draftId);
      if (current.phase !== "editing" && current.phase !== "submit-failed") {
        throw new Error("The execution target cannot change after the first turn starts submitting");
      }
      if (asHostId(execution.hostId) !== current.target.execution.hostId) {
        throw new Error("A Conversation Scope cannot move to another Host; create a new Draft instead");
      }
      const next = Object.freeze({
        ...current,
        phase: "editing" as const,
        error: null,
        receipt: null,
        target: { ...current.target, execution: normalizeExecution(execution) },
      });
      drafts.set(draftId, next);
      publish();
      return next;
    },
    beginSubmit(draftId, submission) {
      ensureOpen();
      const current = requireDraft(draftId);
      if (current.phase !== "editing" && current.phase !== "submit-failed") {
        throw new Error(`Draft ${draftId} cannot start another first Turn from ${current.phase}`);
      }
      if (
        submission.target.type !== "new-thread"
        || submission.target.draftId !== draftId
        || submission.target.execution.hostId !== current.target.execution.hostId
      ) {
        throw new Error(`Submission does not belong to Draft ${draftId}`);
      }
      const next = Object.freeze({
        ...current,
        phase: "submitting" as const,
        error: null,
        receipt: null,
        submission,
      });
      drafts.set(draftId, next);
      publish();
      return next;
    },
    acceptSubmission(draftId, receipt) {
      ensureOpen();
      const current = requireDraft(draftId);
      if (current.phase !== "submitting") {
        if (current.receipt?.commandId === receipt.commandId) return current;
        throw new Error(`Draft ${draftId} cannot accept a submission from ${current.phase}`);
      }
      if (current.target.execution.hostId !== receipt.hostId) {
        throw new Error(`Draft ${draftId} belongs to Host ${current.target.execution.hostId}`);
      }
      const next = Object.freeze({
        ...current,
        phase: "accepted" as const,
        error: null,
        receipt,
      });
      drafts.set(draftId, next);
      publish();
      return next;
    },
    beginPromotion(draftId) {
      ensureOpen();
      const current = requireDraft(draftId);
      if (current.phase !== "accepted" || current.receipt === null) {
        throw new Error(`Draft ${draftId} has no accepted first Turn to promote`);
      }
      const next = Object.freeze({ ...current, phase: "promoting" as const, error: null });
      drafts.set(draftId, next);
      publish();
      return next;
    },
    failDraft(draftId, cause) {
      ensureOpen();
      const current = drafts.get(draftId);
      if (current === undefined) return null;
      if (current.phase !== "submitting") return current;
      const next = Object.freeze({
        ...current,
        phase: "submit-failed" as const,
        error: cause instanceof Error ? cause : new Error(String(cause)),
        receipt: null,
      });
      drafts.set(draftId, next);
      publish();
      return next;
    },
    failPromotion(draftId, cause) {
      ensureOpen();
      const current = drafts.get(draftId);
      if (current === undefined) return null;
      if (current.receipt === null) return current;
      const next = Object.freeze({
        ...current,
        phase: "accepted" as const,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
      drafts.set(draftId, next);
      publish();
      return next;
    },
    promoteDraft(draftId) {
      ensureOpen();
      const current = drafts.get(draftId);
      if (current === undefined) return false;
      if (current.phase !== "promoting" || current.receipt === null) {
        throw new Error(`Draft ${draftId} cannot be promoted from ${current.phase}`);
      }
      drafts.delete(draftId);
      if (activeDraftId === draftId) activeDraftId = null;
      publish();
      return true;
    },
    dismissDraft(draftId) {
      ensureOpen();
      if (!drafts.delete(draftId)) return false;
      if (activeDraftId === draftId) activeDraftId = null;
      publish();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      drafts.clear();
      activeDraftId = null;
    },
  };
}
