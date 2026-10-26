import { encodeComposerTarget, type ComposerTarget } from "@opencraft/composer-core";
import { reportDisplayEvent } from "./recovery-diagnostics";
import { displayStorageFailure, storedDisplayTimingCounts } from "./display-timing-diagnostics";
import type { ClientLocalDocuments } from "@opencraft/document-storage/client-local-documents";
import { readMigratingLocalDocument } from "./local-document-migration";
import {
  conversationDraftStoragePrefix,
  conversationDisplayStoragePrefix,
  parseConversationDraftTarget,
  parseConversationDraftDocument,
  type ConversationDraftStorage,
  type ConversationDisplayStorage,
} from "@opencraft/workbench-runtime";

/** Local browser profile storage; the account service rotates this scope on sign-out. */
export function createBrowserConversationDraftStorage(scope: string, documents?: ClientLocalDocuments): {
  readonly storage: ConversationDraftStorage;
  readonly displayStorage: ConversationDisplayStorage;
  loadViewId(target: ComposerTarget): Promise<string | null>;
  loadNewTarget(draftId: string): Promise<ReturnType<typeof parseConversationDraftTarget>>;
  revokeAndClear(): void;
} {
  const prefix = conversationDraftStoragePrefix(scope);
  const displayPrefix = conversationDisplayStoragePrefix(scope);
  let revoked = false;
  const storage: ConversationDraftStorage = {
    async load(key) {
      if (revoked || !key.startsWith(prefix)) return null;
      return documents ? readMigratingLocalDocument(documents, key, window.localStorage) : window.localStorage.getItem(key);
    },
    async save(key, value) {
      if (revoked || !key.startsWith(prefix)) return;
      if (documents) await documents.write(key, value);
      else window.localStorage.setItem(key, value);
    },
    async remove(key) {
      if (revoked || !key.startsWith(prefix)) return;
      if (documents) await documents.write(key, null);
      window.localStorage.removeItem(key);
    },
  };
  return {
    storage,
    async loadViewId(target) {
      if (revoked) return null;
      try {
        const keys = documents ? [...await documents.keys()] : [];
        for (let index = window.localStorage.length - 1; index >= 0; index--) {
          const key = window.localStorage.key(index);
          if (key?.startsWith(prefix) && !keys.includes(key)) keys.push(key);
        }
        const encoded = encodeComposerTarget(target);
        for (const key of keys) {
          if (revoked) return null;
          if (!key.startsWith(prefix)) continue;
          let slot: unknown;
          try { slot = JSON.parse(key.slice(prefix.length)); } catch { continue; }
          if (!Array.isArray(slot) || slot.length !== 2 || typeof slot[0] !== "string" || !slot[0] || slot[1] !== encoded) continue;
          const raw = documents ? await readMigratingLocalDocument(documents, key, window.localStorage) : window.localStorage.getItem(key);
          if (!revoked && parseConversationDraftDocument(raw) !== null) return slot[0];
        }
      } catch { /* Missing storage does not block a new editor slot. */ }
      return null;
    },
    async loadNewTarget(draftId) {
      if (revoked) return null;
      try {
        if (documents) for (const key of await documents.keys()) {
          if (revoked) return null;
          const target = parseConversationDraftTarget((await documents.read(key)) ?? null);
          if (target?.draftId === draftId) return target;
        }
        for (let index = 0; index < window.localStorage.length; index++) {
          const key = window.localStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          const target = parseConversationDraftTarget(documents ? await readMigratingLocalDocument(documents, key, window.localStorage) : window.localStorage.getItem(key));
          if (target?.draftId === draftId) return target;
        }
      } catch { /* Storage denial must not prevent startup. */ }
      return null;
    },
    displayStorage: {
      async load(key) {
        if (revoked || !key.startsWith(displayPrefix)) return null;
        try { return window.localStorage.getItem(key); }
        catch (error) { reportDisplayEvent("display-load", { storageFailure: displayStorageFailure(error), cacheHit: 0 }); throw error; }
      },
      async save(key, value) {
        if (revoked || !key.startsWith(displayPrefix)) return;
        const counts = storedDisplayTimingCounts(value);
        try {
          window.localStorage.setItem(key, value);
          reportDisplayEvent("display-save", { ...counts, storageFailure: 0 });
        } catch (error) {
          reportDisplayEvent("display-save", { ...counts, storageFailure: displayStorageFailure(error) });
          throw error;
        }
      },
      async remove(key) { if (!revoked && key.startsWith(displayPrefix)) window.localStorage.removeItem(key); },
    },
    revokeAndClear() {
      revoked = true;
      void documents?.revokeAndClear().catch(() => undefined);
      try {
        for (let index = window.localStorage.length - 1; index >= 0; index--) {
          const key = window.localStorage.key(index);
          if (key?.startsWith(prefix) || key?.startsWith(displayPrefix)) window.localStorage.removeItem(key);
        }
      } catch { /* Storage can be unavailable; revoked adapters cannot read it. */ }
    },
  };
}
