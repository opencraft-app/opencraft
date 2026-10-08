import Storage from "expo-sqlite/kv-store";
import {
  conversationDraftStoragePrefix,
  conversationDisplayStoragePrefix,
  type ConversationDraftStorage,
  type ConversationDisplayStorage,
} from "@opencraft/workbench-runtime";
import type { LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";

import { mobileAccountDisplayCache } from "./mobile-account-display-cache.native";

const scopeGenerations = new Map<string, number>();
const blockedScopes = new Set<string>();
const inFlightWrites = new Map<string, Set<Promise<void>>>();
const clearOperations = new Map<string, Promise<void>>();

function trackWrite(scope: string, operation: Promise<void>): Promise<void> {
  const writes = inFlightWrites.get(scope) ?? new Set<Promise<void>>();
  writes.add(operation);
  inFlightWrites.set(scope, writes);
  void operation.finally(() => {
    writes.delete(operation);
    if (writes.size === 0) inFlightWrites.delete(scope);
  }).catch(() => undefined);
  return operation;
}

/** A credential digest scopes drafts; no token or message text enters the key. */
export function mobileConversationDraftStorage(accountScope: string, botScope: string): ConversationDraftStorage {
  const prefix = conversationDraftStoragePrefix(botScope);
  const generation = scopeGenerations.get(accountScope) ?? 0;
  const allowed = (key: string) => key.startsWith(prefix)
    && !blockedScopes.has(accountScope)
    && (scopeGenerations.get(accountScope) ?? 0) === generation;
  return {
    async load(key) {
      if (!allowed(key)) return null;
      await clearOperations.get(accountScope);
      if (!allowed(key)) return null;
      return Storage.getItemAsync(key);
    },
    async save(key, value) {
      if (!allowed(key)) return;
      await clearOperations.get(accountScope);
      if (!allowed(key)) return;
      await trackWrite(accountScope, Storage.setItemAsync(key, value));
    },
    async remove(key) {
      if (!allowed(key)) return;
      await clearOperations.get(accountScope);
      if (allowed(key)) await trackWrite(accountScope, Storage.removeItemAsync(key).then(() => undefined));
    },
  };
}

export function mobileConversationDisplayStorage(accountScope: string, botScope: string): ConversationDisplayStorage {
  const prefix = conversationDisplayStoragePrefix(botScope);
  const generation = scopeGenerations.get(accountScope) ?? 0;
  const allowed = (key: string) => key.startsWith(prefix)
    && !blockedScopes.has(accountScope)
    && (scopeGenerations.get(accountScope) ?? 0) === generation;
  return {
    async load(key) {
      if (!allowed(key)) return null;
      await clearOperations.get(accountScope);
      return allowed(key) ? Storage.getItemAsync(key) : null;
    },
    async save(key, value) {
      if (!allowed(key)) return;
      await clearOperations.get(accountScope);
      if (allowed(key)) await trackWrite(accountScope, Storage.setItemAsync(key, value));
    },
    async remove(key) {
      if (!allowed(key)) return;
      await clearOperations.get(accountScope);
      if (allowed(key)) await trackWrite(accountScope, Storage.removeItemAsync(key).then(() => undefined));
    },
  };
}

export async function clearMobileConversationContinuity(region: LightVelaRegion, token: string): Promise<void> {
  const scope = await mobileAccountDisplayCache.scope(region, token);
  scopeGenerations.set(scope, (scopeGenerations.get(scope) ?? 0) + 1);
  blockedScopes.add(scope);
  const previousClear = clearOperations.get(scope);
  const operation = (async () => {
    if (previousClear) await previousClear;
    await Promise.allSettled([...(inFlightWrites.get(scope) ?? [])]);
    const draftPrefix = conversationDraftStoragePrefix(scope);
    const displayPrefix = conversationDisplayStoragePrefix(scope);
    const keys = await Storage.getAllKeysAsync();
    await Promise.all(keys.filter(key => key.startsWith(draftPrefix) || key.startsWith(displayPrefix))
      .map(key => Storage.removeItemAsync(key)));
    blockedScopes.delete(scope);
  })();
  clearOperations.set(scope, operation);
  try { await operation; }
  finally { if (clearOperations.get(scope) === operation) clearOperations.delete(scope); }
}
