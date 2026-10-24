import { reportDisplayEvent } from "./recovery-diagnostics";
import { displayStorageFailure, storedDisplayTimingCounts } from "./display-timing-diagnostics";
import {
  conversationDraftStoragePrefix,
  conversationDisplayStoragePrefix,
  parseConversationDraftTarget,
  type ConversationDraftStorage,
  type ConversationDisplayStorage,
} from "@opencraft/workbench-runtime";

/** Local browser profile storage; the account service rotates this scope on sign-out. */
export function createBrowserConversationDraftStorage(scope: string): {
  readonly storage: ConversationDraftStorage;
  readonly displayStorage: ConversationDisplayStorage;
  loadNewTarget(draftId: string): Promise<ReturnType<typeof parseConversationDraftTarget>>;
  revokeAndClear(): void;
} {
  const prefix = conversationDraftStoragePrefix(scope);
  const displayPrefix = conversationDisplayStoragePrefix(scope);
  let revoked = false;
  const storage: ConversationDraftStorage = {
    async load(key) {
      if (revoked || !key.startsWith(prefix)) return null;
      return window.localStorage.getItem(key);
    },
    async save(key, value) {
      if (!revoked && key.startsWith(prefix)) window.localStorage.setItem(key, value);
    },
    async remove(key) {
      if (!revoked && key.startsWith(prefix)) window.localStorage.removeItem(key);
    },
  };
  return {
    storage,
    async loadNewTarget(draftId) {
      if (revoked) return null;
      try {
        for (let index = 0; index < window.localStorage.length; index++) {
          const key = window.localStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          const target = parseConversationDraftTarget(window.localStorage.getItem(key));
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
      try {
        for (let index = window.localStorage.length - 1; index >= 0; index--) {
          const key = window.localStorage.key(index);
          if (key?.startsWith(prefix) || key?.startsWith(displayPrefix)) window.localStorage.removeItem(key);
        }
      } catch { /* Storage can be unavailable; revoked adapters cannot read it. */ }
    },
  };
}
