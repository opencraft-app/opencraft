import {
  conversationDraftStoragePrefix,
  conversationDisplayStoragePrefix,
  type ConversationDraftStorage,
  type ConversationDisplayStorage,
} from "@opencraft/workbench-runtime";

/** Local browser profile storage; the account service rotates this scope on sign-out. */
export function createBrowserConversationDraftStorage(scope: string): {
  readonly storage: ConversationDraftStorage;
  readonly displayStorage: ConversationDisplayStorage;
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
    displayStorage: {
      async load(key) { return !revoked && key.startsWith(displayPrefix) ? window.localStorage.getItem(key) : null; },
      async save(key, value) { if (!revoked && key.startsWith(displayPrefix)) window.localStorage.setItem(key, value); },
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
