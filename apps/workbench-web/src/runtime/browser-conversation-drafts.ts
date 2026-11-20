import type { ComposerTarget } from "@opencraft/composer-core";
import { reportDisplayEvent } from "./recovery-diagnostics";
import { displayStorageFailure, storedDisplayTimingCounts } from "./display-timing-diagnostics";
import type { ClientLocalDocuments } from "@opencraft/document-storage/client-local-documents";
import { readMigratingLocalDocument } from "./local-document-migration";
import {
  conversationDraftStoragePrefix,
  conversationDisplayStoragePrefix,
  type ConversationDraftStorage,
  type ConversationDisplayStorage,
} from "@opencraft/workbench-runtime";

/** Local browser profile storage; the account service rotates this scope on sign-out. */
export function createBrowserConversationDraftStorage(scope: string, documents?: ClientLocalDocuments): {
  readonly storage: ConversationDraftStorage;
  readonly displayStorage: ConversationDisplayStorage;
  loadViewId(target: ComposerTarget, preferred?: string): Promise<string | null>;
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
    async loadViewId(target, preferred) {
      if (revoked) return null;
      const { findSavedDraftView } = await import("./browser-draft-slot");
      return findSavedDraftView(target, preferred, scope, prefix, documents, storage, () => revoked);
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
