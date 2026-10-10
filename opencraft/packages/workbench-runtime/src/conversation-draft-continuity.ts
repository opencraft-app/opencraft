import {
  encodeComposerTarget,
  isComposerDocumentEmpty,
  type ComposerController,
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
  attach(viewId: string, controller: ComposerController): () => void;
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
  if (value === null || value.length > MAX_CHARACTERS) return null;
  try {
    const envelope: unknown = JSON.parse(value);
    if (!record(envelope) || envelope.version !== VERSION || !record(envelope.document)) return null;
    const draftDocument = envelope.document;
    if (draftDocument.version !== 1 || !Array.isArray(draftDocument.blocks) || draftDocument.blocks.length > 1000 || !draftDocument.blocks.every(item => block(item, 0))) return null;
    return draftDocument as unknown as ComposerDocument;
  } catch { return null; }
}

export function serializeConversationDraftDocument(document: ComposerDocument, target?: ComposerTarget): string | null {
  if (isComposerDocumentEmpty(document)) return null;
  const value = JSON.stringify({ version: VERSION, document, ...(target?.type === "new-thread" ? { target } : {}) });
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
    const workspace = target.execution.workspace;
    if (!(workspace.cwd === null || typeof workspace.cwd === "string")
      || !Array.isArray(workspace.runtimeWorkspaceRoots) || !workspace.runtimeWorkspaceRoots.every(root => typeof root === "string")
      || !(workspace.projectId === undefined || workspace.projectId === null || typeof workspace.projectId === "string")) return null;
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
  const write = (key: string, document: ComposerDocument, target: ComposerTarget) => {
    const value = serializeConversationDraftDocument(document, target);
    enqueue(key, () => value === null ? input.storage.remove(key) : input.storage.save(key, value));
  };
  return {
    attach(viewId, controller) {
      const initial = controller.getSnapshot().draft;
      const key = keyFor(viewId, initial.target);
      let live = true;
      let hydrated = false;
      const persist = () => {
        if (!hydrated || !live) return;
        const current = controller.getSnapshot().draft;
        if (keyFor(viewId, current.target) !== key) return;
        cancelTimer(key);
        const value = serializeConversationDraftDocument(current.document, current.target);
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
          if (!live) return;
          const document = parseConversationDraftDocument(value);
          const current = controller.getSnapshot().draft;
          if (document !== null && isComposerDocumentEmpty(initial.document) && current.document === initial.document
            && keyFor(viewId, current.target) === key && current.attachments.length === 0 && current.context.length === 0) {
            controller.dispatch({ type: "replace-content", document, attachments: [], context: [] });
          }
        } catch { /* A failed local read never prevents editing. */ }
        finally { hydrated = true; if (live) persist(); }
      })();
      return () => {
        if (!live) return;
        live = false;
        unsubscribe();
        cancelTimer(key);
        const current = controller.getSnapshot().draft;
        if (keyFor(viewId, current.target) === key && (hydrated || current.document !== initial.document)) write(key, current.document, current.target);
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
