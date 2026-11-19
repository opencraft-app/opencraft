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
  checkpoint(): void;
  revokeAndClear(): void;
} {
  const prefix = conversationDraftStoragePrefix(scope);
  const displayPrefix = conversationDisplayStoragePrefix(scope);
  const checkpointPrefix = `checkpoint:${prefix}`;
  const staged = new Map<string, { value: string | null }>();
  const checkpoints = new Set<string>();
  let revoked = false;
  const checkpointKeys = () => {
    const keys: string[] = [];
    try {
      for (let index = 0; index < window.sessionStorage.length; index++) {
        const key = window.sessionStorage.key(index);
        if (key?.startsWith(checkpointPrefix)) keys.push(key.slice("checkpoint:".length));
      }
    } catch { /* Drafts can still use the primary document store. */ }
    return keys;
  };
  const storage: ConversationDraftStorage = {
    async load(key) {
      if (revoked || !key.startsWith(prefix)) return null;
      let checkpoint: string | null | undefined;
      try {
        const raw = window.sessionStorage.getItem(`checkpoint:${key}`);
        if (raw !== null) {
          const value: unknown = JSON.parse(raw);
          if (value === null || (typeof value === "string" && parseConversationDraftDocument(value) !== null)) {
            checkpoint = value;
            checkpoints.add(key);
          }
        }
      } catch { /* Use the primary document when a tab checkpoint is unreadable. */ }
      // Read the original even when a checkpoint exists so the next durable
      // write retains the document adapter's compare-and-set baseline.
      const original = documents ? readMigratingLocalDocument(documents, key, window.localStorage)
        : Promise.resolve().then(() => window.localStorage.getItem(key));
      if (checkpoint === undefined) return original;
      await original.catch(() => undefined);
      return revoked ? null : checkpoint;
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
    stage(key, value) {
      if (revoked || !key.startsWith(prefix)) return () => {};
      const entry = { value };
      staged.set(key, entry);
      return () => {
        if (staged.get(key) !== entry) return;
        staged.delete(key);
        if (!checkpoints.delete(key)) return;
        try { window.sessionStorage.removeItem(`checkpoint:${key}`); }
        catch { /* A confirmed document remains recoverable. */ }
      };
    },
  };
  return {
    storage,
    checkpoint() {
      if (revoked) return;
      for (const [key, entry] of staged) {
        try {
          window.sessionStorage.setItem(`checkpoint:${key}`, JSON.stringify(entry.value));
          checkpoints.add(key);
        } catch { /* Earlier durable drafts remain recoverable if tab storage is full. */ }
      }
    },
    async loadViewId(target) {
      if (revoked) return null;
      try {
        const keys = new Set([...checkpointKeys(), ...(documents ? await documents.keys() : [])]);
        for (let index = window.localStorage.length - 1; index >= 0; index--) {
          const key = window.localStorage.key(index);
          if (key?.startsWith(prefix)) keys.add(key);
        }
        const encoded = encodeComposerTarget(target);
        for (const key of keys) {
          if (revoked) return null;
          if (!key.startsWith(prefix)) continue;
          let slot: unknown;
          try { slot = JSON.parse(key.slice(prefix.length)); } catch { continue; }
          if (!Array.isArray(slot) || slot.length !== 2 || typeof slot[0] !== "string" || !slot[0] || slot[1] !== encoded) continue;
          const raw = await storage.load(key);
          if (!revoked && parseConversationDraftDocument(raw) !== null) return slot[0];
        }
      } catch { /* Missing storage does not block a new editor slot. */ }
      return null;
    },
    async loadNewTarget(draftId) {
      if (revoked) return null;
      try {
        const keys = new Set([...checkpointKeys(), ...(documents ? await documents.keys() : [])]);
        for (const key of keys) {
          if (revoked) return null;
          const target = parseConversationDraftTarget(await storage.load(key));
          if (target?.draftId === draftId) return target;
        }
        for (let index = 0; index < window.localStorage.length; index++) {
          const key = window.localStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          const target = parseConversationDraftTarget(await storage.load(key));
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
      staged.clear();
      checkpoints.clear();
      void documents?.revokeAndClear().catch(() => undefined);
      try { for (const key of checkpointKeys()) window.sessionStorage.removeItem(`checkpoint:${key}`); }
      catch { /* A revoked adapter cannot restore tab checkpoints. */ }
      try {
        for (let index = window.localStorage.length - 1; index >= 0; index--) {
          const key = window.localStorage.key(index);
          if (key?.startsWith(prefix) || key?.startsWith(displayPrefix)) window.localStorage.removeItem(key);
        }
      } catch { /* Storage can be unavailable; revoked adapters cannot read it. */ }
    },
  };
}
