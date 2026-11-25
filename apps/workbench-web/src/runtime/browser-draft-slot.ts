import { traceBrowserStorage } from "./browser-storage-diagnostics";
import { createRouteScopeId } from "./workbench-navigation";
import { encodeComposerTarget, type ComposerController, type ComposerTarget } from "@opencraft/composer-core";
import {
  conversationDraftStorageKey, parseConversationDraftDocument, parseConversationDraftTarget,
  type ConversationDraftStorage, type ConversationDraftContinuity,
} from "@opencraft/workbench-runtime";
import type { ClientLocalDocuments } from "@opencraft/document-storage/client-local-documents";

export async function findSavedDraftView(target: ComposerTarget, preferred: string | undefined, scope: string,
  prefix: string, documents: ClientLocalDocuments | undefined, storage: ConversationDraftStorage, revoked: () => boolean) {
  let preferredBelongsToAnotherHost = false;
  const matches = async (key: string, isPreferred = false) => {
    const raw = await storage.load(key);
    if (revoked() || parseConversationDraftDocument(raw) === null) return false;
    if (target.type !== "new-thread") return true;
    const saved = parseConversationDraftTarget(raw);
    if (!saved || (saved.draftId === target.draftId && saved.execution.hostId === target.execution.hostId)) return true;
    if (isPreferred) preferredBelongsToAnotherHost = true;
    return false;
  };
  if (preferred && await matches(conversationDraftStorageKey(scope, preferred, target), true)) return preferred;
  const keys = new Set(documents ? await documents.keys() : []);
  for (let index = window.localStorage.length - 1; index >= 0; index--) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) keys.add(key);
  }
  const encoded = encodeComposerTarget(target);
  for (const key of keys) {
    if (revoked()) return null;
    if (!key.startsWith(prefix)) continue;
    let slot: unknown;
    try { slot = JSON.parse(key.slice(prefix.length)); } catch { continue; }
    if (Array.isArray(slot) && slot.length === 2 && typeof slot[0] === "string" && slot[0]
      && slot[1] === encoded && await matches(key)) return slot[0];
  }
  return preferredBelongsToAnotherHost ? createRouteScopeId() : null;
}

export type DraftSlotOwners = Map<string, { target: string; id: string }>;

export async function attachSavedDraft(input: {
  viewId: string; controller: ComposerController; initial: ReturnType<ComposerController["getSnapshot"]>["draft"];
  target: string; slots: DraftSlotOwners; continuity: ConversationDraftContinuity;
  find(target: ComposerTarget, preferred: string): Promise<string | null>;
  restorePlacement(target: Extract<ComposerTarget, { type: "new-thread" }>): void;
  live(): boolean; finish(): void; attached(stop: () => void): void;
}) {
  const { viewId, controller, initial, target, slots } = input;
  const trace = traceBrowserStorage("recover-editor", "find-saved-view", { target: initial.target.type });
  input.attached(() => trace?.finish("detached"));
  const known = slots.get(viewId);
  const savedId = known?.target === target ? known.id : await input.find(initial.target, viewId).catch(() => {
    trace?.finish("error");
    return null;
  });
  if (!input.live()) return;
  // An independently opened View can own another draft for the same Thread.
  const inUse = savedId && [...slots].some(([owner, slot]) => owner !== viewId && slot.id === savedId && slot.target === target);
  const id = inUse && savedId === viewId ? createRouteScopeId() : !inUse && savedId ? savedId : viewId;
  slots.set(viewId, { target, id });
  trace?.phase("load-document");
  let loaded = false;
  const stop = input.continuity.attach(id, controller, {
    initial,
    loaded(raw, canRestore) {
      loaded = true;
      if (!canRestore || !input.live() || initial.target.type !== "new-thread"
        || controller.getSnapshot().draft.target !== initial.target) return;
      const saved = parseConversationDraftTarget(raw);
      if (saved && saved.draftId === initial.target.draftId && saved.execution.hostId === initial.target.execution.hostId)
        input.restorePlacement(saved);
    },
    settled() { trace?.finish(loaded ? "complete" : "error"); input.finish(); },
  });
  input.attached(() => { trace?.finish("detached"); stop(); });
}
