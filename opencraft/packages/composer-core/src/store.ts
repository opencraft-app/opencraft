import {
  createEmptyComposerDocument,
  isComposerDocumentEmpty,
  type ComposerDocument,
} from "./document";
import {
  encodeComposerTarget,
  type ComposerAttachment,
  type ComposerContextReference,
  type ComposerDraft,
  type ComposerOptions,
  type ComposerSelections,
  type ComposerTarget,
  type SubmitIntent,
} from "./model";

export type ComposerAction =
  | { readonly type: "set-document"; readonly document: ComposerDocument }
  | {
      readonly type: "replace-content";
      readonly document: ComposerDocument;
      readonly attachments: readonly ComposerAttachment[];
      readonly context: readonly ComposerContextReference[];
    }
  | { readonly type: "add-attachment"; readonly attachment: ComposerAttachment }
  | {
      readonly type: "update-attachment";
      readonly id: string;
      readonly patch: Partial<Omit<ComposerAttachment, "id">>;
    }
  | { readonly type: "remove-attachment"; readonly id: string }
  | {
      readonly type: "add-context";
      readonly reference: ComposerContextReference;
    }
  | { readonly type: "remove-context"; readonly id: string }
  | {
      readonly type: "set-selections";
      readonly patch: Partial<ComposerSelections>;
    }
  | { readonly type: "set-options"; readonly patch: Partial<ComposerOptions> }
  | {
      readonly type: "set-lifecycle";
      readonly phase: ComposerDraft["lifecycle"]["phase"];
      readonly error?: string | null;
    }
  | { readonly type: "switch-target"; readonly target: ComposerTarget }
  | { readonly type: "clear" };

export interface ComposerStoreServices {
  readonly now: () => number;
  readonly createId: () => string;
}

export interface ComposerStoreSnapshot {
  readonly revision: number;
  readonly draft: ComposerDraft;
  readonly hasContent: boolean;
  /** Provisional View text participates in sendability before entering history. */
  readonly hasTransientText: boolean;
  readonly canSubmit: boolean;
  readonly hasProcessingAssets: boolean;
}

export interface ComposerViewHandle {
  focus(): void;
  blur(): void;
  insertText(text: string): void;
  beginTransientTextInput(): ComposerTransientTextInput | null;
  undo(): void;
  redo(): void;
}

/**
 * View-owned provisional text. It is painted at the current selection without
 * entering the durable draft or undo history until commit.
 */
export interface ComposerTransientTextInput {
  update(text: string): void;
  commit(text: string): void;
  cancel(): void;
}

export interface ComposerTransientTextInputObserver {
  finalized(result: ComposerTransientTextInputFinalization): void;
  /**
   * A submission consumed the previous provisional segment and the Composer
   * has now settled into an editable draft again. Continuous producers may
   * open their next segment here.
   */
  readyForNextInput?(): void;
}

export interface ComposerTransientTextInputFinalization {
  readonly mode: "commit" | "cancel";
  readonly cause:
    | "producer"
    | "submission"
    | "draft-reset"
    | "target-change"
    | "view-detach"
    | "superseded"
    | "dispose";
}

export interface ComposerController {
  getSnapshot(): ComposerStoreSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(action: ComposerAction): void;
  createSubmitIntent(): SubmitIntent;
  registerView(handle: ComposerViewHandle): () => void;
  focus(): void;
  blur(): void;
  insertText(text: string): void;
  beginTransientTextInput(
    observer?: ComposerTransientTextInputObserver,
  ): ComposerTransientTextInput | null;
  /** View acknowledgement after its physical document matches the Store. */
  settleTransientTextContinuation(): void;
  undo(): void;
  redo(): void;
  dispose(): void;
}

function createDraft(
  target: ComposerTarget,
  services: ComposerStoreServices,
): ComposerDraft {
  const now = services.now();
  return {
    id: services.createId(),
    target,
    document: createEmptyComposerDocument(),
    attachments: [],
    context: [],
    selections: {},
    options: { autoContext: true },
    lifecycle: { phase: "editing", error: null },
    createdAt: now,
    updatedAt: now,
  };
}

function updateDraft(
  draft: ComposerDraft,
  services: ComposerStoreServices,
  patch: Partial<ComposerDraft>,
): ComposerDraft {
  return { ...draft, ...patch, updatedAt: services.now() };
}

function reduce(
  draft: ComposerDraft,
  action: ComposerAction,
  services: ComposerStoreServices,
): ComposerDraft {
  switch (action.type) {
    case "set-document":
      return updateDraft(draft, services, { document: action.document });
    case "replace-content":
      return updateDraft(draft, services, {
        document: action.document,
        attachments: action.attachments,
        context: action.context,
        lifecycle: { phase: "editing", error: null },
      });
    case "add-attachment": {
      const attachments = [
        ...draft.attachments.filter(
          (attachment) => attachment.id !== action.attachment.id,
        ),
        action.attachment,
      ];
      return updateDraft(draft, services, { attachments });
    }
    case "update-attachment":
      return updateDraft(draft, services, {
        attachments: draft.attachments.map((attachment) =>
          attachment.id === action.id
            ? { ...attachment, ...action.patch, id: attachment.id }
            : attachment,
        ),
      });
    case "remove-attachment":
      return updateDraft(draft, services, {
        attachments: draft.attachments.filter(
          (attachment) => attachment.id !== action.id,
        ),
      });
    case "add-context":
      return updateDraft(draft, services, {
        context: [
          ...draft.context.filter(
            (reference) => reference.id !== action.reference.id,
          ),
          action.reference,
        ],
      });
    case "remove-context":
      return updateDraft(draft, services, {
        context: draft.context.filter(
          (reference) => reference.id !== action.id,
        ),
      });
    case "set-selections":
      return updateDraft(draft, services, {
        selections: { ...draft.selections, ...action.patch },
      });
    case "set-options":
      return updateDraft(draft, services, {
        options: { ...draft.options, ...action.patch },
      });
    case "set-lifecycle":
      return updateDraft(draft, services, {
        lifecycle: { phase: action.phase, error: action.error ?? null },
      });
    case "clear":
      return {
        ...createDraft(draft.target, services),
        selections: draft.selections,
        options: draft.options,
      };
    case "switch-target":
      return draft;
  }
}

function snapshot(
  revision: number,
  draft: ComposerDraft,
  hasTransientText = false,
): ComposerStoreSnapshot {
  const hasProcessingAssets = draft.attachments.some(
    (attachment) =>
      attachment.lifecycle === "pending" ||
      attachment.lifecycle === "uploading" ||
      attachment.lifecycle === "processing",
  );
  const hasContent =
    !isComposerDocumentEmpty(draft.document) ||
    draft.attachments.length > 0 ||
    draft.context.length > 0 ||
    hasTransientText;
  return {
    revision,
    draft,
    hasContent,
    hasTransientText,
    canSubmit:
      hasContent &&
      !hasProcessingAssets &&
      draft.lifecycle.phase !== "submitting",
    hasProcessingAssets,
  };
}

export function createComposerController(
  target: ComposerTarget,
  services: ComposerStoreServices,
): ComposerController {
  let revision = 0;
  let draft = createDraft(target, services);
  let currentSnapshot = snapshot(revision, draft);
  const draftCache = new Map<string, ComposerDraft>();
  const listeners = new Set<() => void>();
  let view: ComposerViewHandle | null = null;
  let transient: {
    readonly input: ComposerTransientTextInput;
    readonly observer?: ComposerTransientTextInputObserver;
    text: string;
  } | null = null;
  let submissionContinuation: ComposerTransientTextInputObserver | null = null;
  let disposed = false;

  const ensureOpen = () => {
    if (disposed) throw new Error("Composer controller is disposed");
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const publishSnapshot = () => {
    revision += 1;
    currentSnapshot = snapshot(
      revision,
      draft,
      (transient?.text.length ?? 0) > 0,
    );
    notify();
  };

  const publish = (next: ComposerDraft) => {
    if (next === draft) return;
    draft = next;
    revision += 1;
    currentSnapshot = snapshot(
      revision,
      draft,
      (transient?.text.length ?? 0) > 0,
    );
    notify();
  };

  const finalizeTransient = (
    record: NonNullable<typeof transient>,
    mode: "commit" | "cancel",
    cause: ComposerTransientTextInputFinalization["cause"],
  ) => {
    if (transient !== record) return;
    transient = null;
    if (mode === "commit") record.input.commit(record.text);
    else record.input.cancel();
    if (cause === "submission") {
      submissionContinuation = record.observer ?? null;
    }
    record.observer?.finalized({ mode, cause });
    // A real editor commit synchronously publishes its durable document; a
    // cancel or detached test View still needs to publish loss of provisional
    // sendability itself.
    if (currentSnapshot.hasTransientText) publishSnapshot();
  };

  const resumeSubmissionContinuation = () => {
    const observer = submissionContinuation;
    submissionContinuation = null;
    observer?.readyForNextInput?.();
  };

  return {
    getSnapshot: () => currentSnapshot,
    subscribe(listener) {
      ensureOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(action) {
      ensureOpen();
      if (action.type === "switch-target" || action.type === "clear") {
        const active = transient;
        if (active !== null) {
          finalizeTransient(
            active,
            "cancel",
            action.type === "switch-target" ? "target-change" : "draft-reset",
          );
        }
      }
      if (action.type === "switch-target") {
        submissionContinuation = null;
        const currentKey = encodeComposerTarget(draft.target);
        draftCache.set(currentKey, draft);
        const targetKey = encodeComposerTarget(action.target);
        if (currentKey === targetKey) {
          publish({
            ...draft,
            target: action.target,
            updatedAt: services.now(),
          });
          return;
        }
        const restored = draftCache.get(targetKey);
        publish(restored ?? createDraft(action.target, services));
        return;
      }
      publish(reduce(draft, action, services));
    },
    createSubmitIntent() {
      ensureOpen();
      const active = transient;
      if (active !== null) {
        finalizeTransient(
          active,
          active.text.length > 0 ? "commit" : "cancel",
          "submission",
        );
      }
      if (!currentSnapshot.canSubmit)
        throw new Error(
          "Composer draft cannot be submitted in its current state",
        );
      return {
        commandId: services.createId(),
        clientMessageId: services.createId(),
        target: draft.target,
        document: draft.document,
        attachments: draft.attachments,
        context: draft.context,
        selections: draft.selections,
        options: draft.options,
        createdAt: services.now(),
      };
    },
    registerView(handle) {
      ensureOpen();
      view = handle;
      return () => {
        if (view !== handle) return;
        const active = transient;
        if (active !== null) finalizeTransient(active, "cancel", "view-detach");
        submissionContinuation = null;
        view = null;
      };
    },
    focus: () => view?.focus(),
    blur: () => view?.blur(),
    insertText: (text) => view?.insertText(text),
    beginTransientTextInput(observer) {
      ensureOpen();
      const previous = transient;
      if (previous !== null) finalizeTransient(previous, "cancel", "superseded");
      // A new producer has explicitly claimed the View; any older deferred
      // continuation can no longer resume into the same selection.
      submissionContinuation = null;
      const input = view?.beginTransientTextInput() ?? null;
      if (input === null) return null;
      const record = { input, observer, text: "" };
      transient = record;
      return {
        update(text) {
          if (transient !== record) return;
          const hadText = record.text.length > 0;
          record.text = text;
          input.update(text);
          if (hadText !== (text.length > 0)) publishSnapshot();
        },
        commit(text) {
          if (transient !== record) return;
          record.text = text;
          finalizeTransient(record, "commit", "producer");
        },
        cancel() {
          finalizeTransient(record, "cancel", "producer");
        },
      };
    },
    settleTransientTextContinuation() {
      ensureOpen();
      if (draft.lifecycle.phase === "submitting") return;
      resumeSubmissionContinuation();
    },
    undo: () => view?.undo(),
    redo: () => view?.redo(),
    dispose() {
      if (disposed) return;
      const active = transient;
      if (active !== null) finalizeTransient(active, "cancel", "dispose");
      submissionContinuation = null;
      disposed = true;
      listeners.clear();
      draftCache.clear();
      view = null;
    },
  };
}
