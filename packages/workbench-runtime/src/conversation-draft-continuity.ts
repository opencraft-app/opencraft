import {
  encodeComposerTarget,
  assertComposerPlacement,
  isComposerDocumentEmpty,
  type ComposerController,
  type ComposerContextReference,
  type ComposerSelections,
  type ComposerDraft,
  type ComposerDocument,
  type ComposerTarget,
} from "@opencraft/composer-core";

/** Storage is a platform adapter. Keys include the product/account namespace. */
export interface ConversationDraftStorage {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ConversationDraftContinuity {
  attach(viewId: string, controller: ComposerController, recovery?: {
    /** Snapshot from before asynchronous slot discovery, if applicable. */
    readonly initial: ComposerDraft;
    loaded(raw: string | null, canRestore: boolean): void;
    settled(): void;
  }): () => void;
  discard(viewId: string, target: ComposerTarget): void;
}

const VERSION = 1;
const MAX_CHARACTERS = 128 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textInline(value: unknown): boolean {
  if (!record(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text": return typeof value.text === "string";
    case "mention": return typeof value.id === "string" && typeof value.label === "string" && typeof value.mentionKind === "string";
    case "command": return typeof value.name === "string";
    case "resource": return typeof value.id === "string" && typeof value.title === "string" && typeof value.uri === "string";
    case "link": return typeof value.href === "string" && Array.isArray(value.children) && value.children.every(child => record(child) && child.type === "text" && typeof child.text === "string");
    case "hard-break": return true;
    default: return false;
  }
}

function block(value: unknown, depth: number): boolean {
  if (!record(value) || typeof value.type !== "string" || depth > 12) return false;
  switch (value.type) {
    case "paragraph": return Array.isArray(value.children) && value.children.every(textInline);
    case "code-block": return typeof value.text === "string" && (value.language === undefined || typeof value.language === "string");
    case "quote": return Array.isArray(value.children) && value.children.every(child => block(child, depth + 1));
    case "list": return typeof value.ordered === "boolean" && Array.isArray(value.items) && value.items.every(item => record(item) && typeof item.id === "string" && Array.isArray(item.children) && item.children.every(child => block(child, depth + 1)));
    case "divider": return true;
    default: return false;
  }
}

export function parseConversationDraftDocument(value: string | null): ComposerDocument | null {
  if (typeof value !== "string" || value.length > MAX_CHARACTERS) return null;
  try {
    const envelope: unknown = JSON.parse(value);
    if (!record(envelope) || envelope.version !== VERSION || !record(envelope.document)) return null;
    const draftDocument = envelope.document;
    if (draftDocument.version !== 1 || !Array.isArray(draftDocument.blocks) || draftDocument.blocks.length > 1000 || !draftDocument.blocks.every(item => block(item, 0))) return null;
    return draftDocument as unknown as ComposerDocument;
  } catch { return null; }
}

type SavedModelSelection = Pick<ComposerSelections, "model" | "effort" | "serviceTier">;
function historyReference(value: unknown): value is ComposerContextReference {
  return record(value) && value.kind === "file" && typeof value.id === "string" && value.id.length <= 512
    && typeof value.title === "string" && value.title.length <= 1024 && typeof value.uri === "string" && value.uri.startsWith("file:")
    && typeof value.visible === "boolean" && record(value.metadata)
    && typeof value.metadata.conversationSourceThreadId === "string" && value.metadata.conversationSourceThreadId.length <= 256
    && value.metadata.additionalContextKind === "untrusted" && typeof value.metadata.value === "string" && value.metadata.value.length <= 16384;
}
function modelSelection(value: unknown): SavedModelSelection {
  if (!record(value)) return {};
  return {
    ...(typeof value.model === "string" && value.model.length <= 8192 ? { model: value.model } : {}),
    ...(typeof value.effort === "string" && value.effort.length <= 128 ? { effort: value.effort } : {}),
    ...(value.serviceTier === null || typeof value.serviceTier === "string" && value.serviceTier.length <= 128 ? { serviceTier: value.serviceTier } : {}),
  };
}
function draftReferences(value: unknown): ComposerContextReference[] {
  return Array.isArray(value) && value.length <= 32 ? value.filter(historyReference).map(reference => ({
    id: reference.id, kind: "file", title: reference.title, uri: reference.uri, visible: reference.visible,
    metadata: { conversationSourceThreadId: reference.metadata!.conversationSourceThreadId, additionalContextKind: "untrusted", value: reference.metadata!.value },
  })) : [];
}
export function serializeConversationDraftDocument(document: ComposerDocument, target?: ComposerTarget,
  extras?: Pick<ComposerDraft, "context" | "selections">): string | null {
  const context = draftReferences(extras?.context), selections = modelSelection(extras?.selections);
  if (isComposerDocumentEmpty(document) && !context.length && !Object.keys(selections).length) return null;
  const value = JSON.stringify({ version: VERSION, document, ...(target?.type === "new-thread" ? { target } : {}),
    ...(context.length ? { context } : {}), ...(Object.keys(selections).length ? { modelSelection: selections } : {}) });
  return value.length <= MAX_CHARACTERS ? value : null;
}

/** Placement is recoverable input metadata, never execution admission. */
export function parseConversationDraftTarget(value: string | null): Extract<ComposerTarget, { type: "new-thread" }> | null {
  if (parseConversationDraftDocument(value) === null || value === null) return null;
  try {
    const target: unknown = JSON.parse(value).target;
    if (!record(target) || target.type !== "new-thread" || typeof target.draftId !== "string" || !target.draftId
      || !record(target.execution) || typeof target.execution.hostId !== "string" || !target.execution.hostId
      || !record(target.execution.workspace)) return null;
    const spaceId=target.execution.collaborationSpaceId;
    if(spaceId!==undefined&&(typeof spaceId!=="string"||!spaceId||spaceId.length>256))return null;
    const workspace = target.execution.workspace;
    if (!(workspace.cwd === null || typeof workspace.cwd === "string")
      || !Array.isArray(workspace.runtimeWorkspaceRoots) || !workspace.runtimeWorkspaceRoots.every(root => typeof root === "string")
      || !(workspace.projectId === undefined || workspace.projectId === null || typeof workspace.projectId === "string")) return null;
    assertComposerPlacement({ environment: target.execution.environment, workspace: {
      cwd: workspace.cwd, runtimeWorkspaceRoots: workspace.runtimeWorkspaceRoots, source: workspace.source,
    } });
    return target as unknown as Extract<ComposerTarget, { type: "new-thread" }>;
  } catch { return null; }
}

/**
 * One View owns one draft. Hydration may arrive late: it only applies while
 * the original empty document and semantic target still own the View.
 */
export function createConversationDraftContinuity(input: {
  readonly namespace: string;
  readonly storage: ConversationDraftStorage;
  readonly delayMs?: number;
}): ConversationDraftContinuity {
  if (!input.namespace.trim()) throw new RangeError("Draft namespace is required");
  const pending = new Map<string, Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const keyFor = (viewId: string, target: ComposerTarget) => conversationDraftStorageKey(input.namespace, viewId, target);
  const hasStoredContent = (draft: ComposerDraft) =>
    !isComposerDocumentEmpty(draft.document) || draftReferences(draft.context).length > 0;
  const enqueue = (key: string, operation: () => Promise<void>) => {
    const prior = pending.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    pending.set(key, next);
    void next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => undefined);
  };
  const cancelTimer = (key: string) => {
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(key);
  };
  const write = (key: string, draft: ComposerDraft) => {
    const value = serializeConversationDraftDocument(draft.document, draft.target, draft);
    enqueue(key, () => value === null ? input.storage.remove(key) : input.storage.save(key, value));
  };
  return {
    attach(viewId, controller, recovery) {
      const initial = recovery?.initial ?? controller.getSnapshot().draft;
      const key = keyFor(viewId, initial.target);
      let live = true;
      let hydrated = false;
      let loaded = false;
      let loadedValue: string | null = null;
      let keepSavedInput = false;
      const canRestore = () => {
        const { draft, hasTransientText } = controller.getSnapshot();
        return draft.id === initial.id && draft.lifecycle.phase === "editing" && !hasTransientText
          && isComposerDocumentEmpty(initial.document) && draft.document === initial.document
          && draft.attachments === initial.attachments && draft.attachments.length === 0
          && draft.context === initial.context && draft.context.length === 0
          && keyFor(viewId, draft.target) === key;
      };
      let previousDocument = initial.document;
      let previousTarget = initial.target;
      let previousContext = initial.context;
      let previousSelections = initial.selections;
      const persist = () => {
        if (!hydrated || !live) return;
        const current = controller.getSnapshot().draft;
        if (keyFor(viewId, current.target) !== key) return;
        if (current.document === previousDocument && current.context === previousContext && current.selections === previousSelections
          && (current.target === previousTarget || isComposerDocumentEmpty(current.document))) return;
        if (keepSavedInput && !hasStoredContent(current)) return;
        keepSavedInput = false;
        previousDocument = current.document;
        previousTarget = current.target;
        previousContext = current.context;
        previousSelections = current.selections;
        cancelTimer(key);
        const value = serializeConversationDraftDocument(current.document, current.target, current);
        if (value === null) {
          enqueue(key, () => input.storage.remove(key));
        } else if (input.delayMs === 0) {
          enqueue(key, () => input.storage.save(key, value));
        } else {
          timers.set(key, setTimeout(() => {
            timers.delete(key);
            enqueue(key, () => input.storage.save(key, value));
          }, input.delayMs ?? 180));
        }
      };
      const unsubscribe = controller.subscribe(persist);
      void (async () => {
        try {
          await (pending.get(key) ?? Promise.resolve()).catch(() => undefined);
          const value = await input.storage.load(key);
          loadedValue = value;
          loaded = true;
          if (!live) return;
          recovery?.loaded(value, canRestore());
          if (!live) return;
          const document = parseConversationDraftDocument(value);
          const current = controller.getSnapshot().draft;
          if (document !== null && canRestore()) {
            const envelope: unknown = value === null ? null : JSON.parse(value);
            controller.dispatch({ type: "replace-content", document, attachments: [], context: record(envelope) ? draftReferences(envelope.context) : [] });
            if (record(envelope) && current.selections.model === initial.selections.model
              && current.selections.effort === initial.selections.effort && current.selections.serviceTier === initial.selections.serviceTier)
              controller.dispatch({ type: "set-selections", patch: modelSelection(envelope.modelSelection) });
            previousDocument = controller.getSnapshot().draft.document;
            previousTarget = controller.getSnapshot().draft.target;
            previousContext = controller.getSnapshot().draft.context;
            previousSelections = controller.getSnapshot().draft.selections;
          } else if (document !== null && !hasStoredContent(current)) {
            // An empty editor after an early send/clear did not adopt the saved draft.
            keepSavedInput = true;
          }
          hydrated = true;
          persist();
        } catch {
          // Resume explicit edits. An untouched editor is never a reason to
          // erase data that the adapter could not read.
          hydrated = true;
          if (live) persist();
        } finally { recovery?.settled(); }
      })();
      return () => {
        if (!live) return;
        live = false;
        unsubscribe();
        const needsFlush = timers.has(key);
        cancelTimer(key);
        const current = controller.getSnapshot().draft;
        if ((keepSavedInput || (recovery !== undefined && !loaded)) && !hasStoredContent(current)) return;
        const hasUnhydratedInput = !hydrated && (current.document !== initial.document || current.context !== initial.context || current.selections !== initial.selections);
        const currentValue = serializeConversationDraftDocument(current.document, current.target, current);
        // Hydrating and leaving an untouched editor is not a new write. Preserve
        // pre-existing unsaved input and edits without rewriting the loaded slot.
        const hasLoadedInput = loaded && currentValue !== null && currentValue !== loadedValue;
        if (keyFor(viewId, current.target) === key && (needsFlush || hasUnhydratedInput || hasLoadedInput)) write(key, current);
      };
    },
    discard(viewId, target) {
      const key = keyFor(viewId, target);
      cancelTimer(key);
      enqueue(key, () => input.storage.remove(key));
    },
  };
}

/** Platform stores can enumerate and revoke one account's keys without parsing draft contents. */
export function conversationDraftStorageKey(namespace: string, viewId: string, target: ComposerTarget): string {
  return `opencraft.draft.v1.${namespace}.${JSON.stringify([viewId, encodeComposerTarget(target)])}`;
}

export function conversationDraftStoragePrefix(namespace: string): string {
  return `opencraft.draft.v1.${namespace}.`;
}
