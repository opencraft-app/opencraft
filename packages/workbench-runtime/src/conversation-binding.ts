import {
  asHostId,
  createConversationKey,
  encodeConversationKey,
  equalConversationKey,
  type ConversationKey,
  type HostId,
  type OpaqueId,
} from "@opencraft/chat-core";

/** Stable client identity that exists before a server Thread is created. */
export type ConversationScopeId = OpaqueId<"ConversationScopeId">;

export function asConversationScopeId(value: string): ConversationScopeId {
  const normalized = value.trim();
  if (normalized.length === 0) throw new RangeError("Conversation Scope ID must not be empty");
  return normalized as ConversationScopeId;
}

export interface ConversationBinding {
  readonly scopeId: ConversationScopeId;
  readonly hostId: HostId;
  readonly conversationKey: ConversationKey | null;
}

export interface ConversationBindingSnapshot {
  readonly revision: number;
  readonly bindings: readonly ConversationBinding[];
}

export interface PersistedConversationBinding {
  readonly scopeId: string;
  readonly hostId: string;
  readonly threadId: string | null;
}

export interface ConversationBindingPersistence {
  load(): readonly PersistedConversationBinding[];
  save(bindings: readonly PersistedConversationBinding[]): void;
}

export interface ConversationBindingStore {
  getSnapshot(): ConversationBindingSnapshot;
  subscribe(listener: () => void): () => void;
  register(
    scopeId: ConversationScopeId,
    hostId: HostId,
    options?: { readonly persistent?: boolean },
  ): ConversationBinding;
  bind(scopeId: ConversationScopeId, key: ConversationKey): ConversationBinding;
  resolve(scopeId: ConversationScopeId): ConversationBinding | null;
  findScope(key: ConversationKey): ConversationScopeId | null;
  remove(scopeId: ConversationScopeId): boolean;
  dispose(): void;
}

export interface ConversationBindingStoreConfig {
  readonly persistence?: ConversationBindingPersistence;
}

/**
 * Application-owned, bidirectional identity table. One Conversation Scope may
 * be presented by many Route Scopes, but its Host and canonical Thread binding
 * are immutable. Promotion persists the alias before a page reload can occur.
 */
export function createConversationBindingStore(
  config: ConversationBindingStoreConfig = {},
): ConversationBindingStore {
  const listeners = new Set<() => void>();
  const byScope = new Map<ConversationScopeId, ConversationBinding>();
  const byConversation = new Map<string, ConversationScopeId>();
  const transientScopes = new Set<ConversationScopeId>();
  let disposed = false;
  let revision = 0;
  let snapshot: ConversationBindingSnapshot = { revision, bindings: [] };

  const ensureOpen = () => {
    if (disposed) throw new Error("Conversation binding store is disposed");
  };
  const serialize = (): readonly PersistedConversationBinding[] =>
    [...byScope.values()].filter((binding) => !transientScopes.has(binding.scopeId)).map((binding) => ({
      scopeId: binding.scopeId,
      hostId: binding.hostId,
      threadId: binding.conversationKey?.threadId ?? null,
    }));
  const publish = (persist = true) => {
    revision += 1;
    snapshot = { revision, bindings: [...byScope.values()] };
    if (persist) {
      try {
        config.persistence?.save(serialize());
      } catch {
        // This table is a client-side activation accelerator, never the
        // authoritative Thread store. Storage quota/privacy failures cannot
        // invalidate an already committed in-memory identity transaction.
      }
    }
    for (const listener of listeners) listener();
  };
  const insert = (binding: ConversationBinding) => {
    const encoded = binding.conversationKey === null
      ? null
      : encodeConversationKey(binding.conversationKey);
    if (byScope.has(binding.scopeId)) return;
    if (encoded !== null && byConversation.has(encoded)) return;
    byScope.set(binding.scopeId, binding);
    if (encoded !== null) byConversation.set(encoded, binding.scopeId);
  };

  for (const persisted of config.persistence?.load() ?? []) {
    try {
      const scopeId = asConversationScopeId(persisted.scopeId);
      const hostId = asHostId(persisted.hostId);
      const conversationKey = persisted.threadId === null
        ? null
        : createConversationKey(hostId, persisted.threadId);
      insert(Object.freeze({ scopeId, hostId, conversationKey }));
    } catch {
      // Ignore corrupt client aliases. They are never authoritative history.
    }
  }
  snapshot = { revision, bindings: [...byScope.values()] };

  const register = (
    scopeId: ConversationScopeId,
    hostId: HostId,
    options: { readonly persistent?: boolean } = {},
  ): ConversationBinding => {
    ensureOpen();
    const existing = byScope.get(scopeId);
    if (existing !== undefined) {
      if (existing.hostId !== hostId) {
        throw new Error(`Conversation Scope ${scopeId} already belongs to Host ${existing.hostId}`);
      }
      return existing;
    }
    const binding = Object.freeze({ scopeId, hostId, conversationKey: null });
    byScope.set(scopeId, binding);
    if (options.persistent === false) transientScopes.add(scopeId);
    publish();
    return binding;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      ensureOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register,
    bind(scopeId, key) {
      ensureOpen();
      const current = byScope.get(scopeId) ?? register(scopeId, key.hostId);
      if (current.hostId !== key.hostId) {
        throw new Error(
          `Conversation Scope ${scopeId} belongs to Host ${current.hostId}, not ${key.hostId}`,
        );
      }
      if (current.conversationKey !== null) {
        if (equalConversationKey(current.conversationKey, key)) return current;
        throw new Error(`Conversation Scope ${scopeId} is already bound to another Thread`);
      }
      const encoded = encodeConversationKey(key);
      const owner = byConversation.get(encoded);
      if (owner !== undefined && owner !== scopeId) {
        throw new Error(`Thread ${encoded} is already bound to Conversation Scope ${owner}`);
      }
      const binding = Object.freeze({ scopeId, hostId: current.hostId, conversationKey: key });
      byScope.set(scopeId, binding);
      byConversation.set(encoded, scopeId);
      publish();
      return binding;
    },
    resolve: (scopeId) => byScope.get(scopeId) ?? null,
    findScope: (key) => byConversation.get(encodeConversationKey(key)) ?? null,
    remove(scopeId) {
      ensureOpen();
      const current = byScope.get(scopeId);
      if (current === undefined) return false;
      byScope.delete(scopeId);
      transientScopes.delete(scopeId);
      if (current.conversationKey !== null) {
        byConversation.delete(encodeConversationKey(current.conversationKey));
      }
      publish();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  };
}
