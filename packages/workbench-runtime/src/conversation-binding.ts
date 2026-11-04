import { asHostId, createConversationKey, encodeConversationKey, equalConversationKey, type ConversationKey, type HostId, type OpaqueId, } from "@opencraft/chat-core";
/** Stable client identity that exists before a server Thread is created. */
export type ConversationScopeId = OpaqueId<"ConversationScopeId">;
export function asConversationScopeId(value: string): ConversationScopeId {
    const normalized = value.trim();
    if (normalized.length === 0)
        throw new RangeError("Conversation Scope ID must not be empty");
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
    load?(): readonly PersistedConversationBinding[];
    save?(bindings: readonly PersistedConversationBinding[]): void;
    records?: {
        load(): readonly PersistedConversationBinding[];
        put(binding: PersistedConversationBinding): void;
        remove(scopeId: string): void;
    };
}
export interface ConversationBindingChange {
    readonly scopeId: ConversationScopeId;
    readonly previous: ConversationBinding | null;
    readonly current: ConversationBinding | null;
}
export interface ConversationBindingStore {
    restore(): void;
    getSnapshot(): ConversationBindingSnapshot;
    subscribe(listener: (change: ConversationBindingChange | null) => void): () => void;
    subscribeScope(scopeId: ConversationScopeId, listener: () => void): () => void;
    hostIds(): readonly HostId[];
    register(scopeId: ConversationScopeId, hostId: HostId, options?: {
        readonly persistent?: boolean;
    }): ConversationBinding;
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
export function createConversationBindingStore(config: ConversationBindingStoreConfig = {}): ConversationBindingStore {
    const listeners = new Set<(change: ConversationBindingChange | null) => void>();
    const scopeListeners = new Map<ConversationScopeId, Set<() => void>>();
    const hosts = new Map<HostId, number>();
    const dirty = new Map<ConversationScopeId, ConversationBinding | null>();
    const derived = new Map<ConversationScopeId, ConversationBinding>();
    const byScope = new Map<ConversationScopeId, ConversationBinding>();
    const byConversation = new Map<string, ConversationScopeId>();
    const aliasesByConversation = new Map<string, Set<ConversationScopeId>>();
    const transientScopes = new Set<ConversationScopeId>();
    let disposed = false;
    let revision = 0;
    let snapshot: ConversationBindingSnapshot = { revision, bindings: [] };
    const ensureOpen = () => {
        if (disposed)
            throw new Error("Conversation binding store is disposed");
    };
    const serialize = (): readonly PersistedConversationBinding[] => [...byScope.values()].filter((binding) => !transientScopes.has(binding.scopeId)).map((binding) => ({
        scopeId: binding.scopeId,
        hostId: binding.hostId,
        threadId: binding.conversationKey?.threadId ?? null,
    }));
    const persistDirty = (only?: ConversationScopeId) => {
        const records = config.persistence?.records;
        if (!records)
            return;
        for (const [scopeId, binding] of only ? (dirty.has(only) ? [[only, dirty.get(only)!]] as const : []) : dirty) {
            try {
                if (binding)
                    records.put({ scopeId, hostId: binding.hostId, threadId: binding.conversationKey?.threadId ?? null });
                else
                    records.remove(scopeId);
                dirty.delete(scopeId);
            }
            catch { /* Admission may still be pending; retry this entity on restore. */ }
        }
    };
    const publish = (change: ConversationBindingChange | null, persist = true) => {
        revision += 1;
        if (persist && change) {
            if (config.persistence?.records) {
                if (!transientScopes.has(change.scopeId))
                    dirty.set(change.scopeId, change.current);
                persistDirty(change.scopeId);
            }
            else
                try {
                    config.persistence?.save?.(serialize());
                }
                catch { }
        }
        if (change)
            for (const listener of scopeListeners.get(change.scopeId) ?? [])
                listener();
        else
            for (const set of scopeListeners.values())
                for (const listener of set)
                    listener();
        for (const listener of listeners)
            listener(change);
    };
    const insert = (binding: ConversationBinding) => {
        const encoded = binding.conversationKey === null
            ? null
            : encodeConversationKey(binding.conversationKey);
        if (byScope.has(binding.scopeId))
            return;
        byScope.set(binding.scopeId, binding);
        derived.delete(binding.scopeId);
        if (binding.conversationKey && binding.scopeId === `conversation:${encodeConversationKey(binding.conversationKey)}`)
            transientScopes.add(binding.scopeId);
        hosts.set(binding.hostId, (hosts.get(binding.hostId) ?? 0) + 1);
        if (encoded !== null) {
            const aliases = aliasesByConversation.get(encoded) ?? new Set<ConversationScopeId>();
            aliases.add(binding.scopeId); aliasesByConversation.set(encoded, aliases);
            if (!byConversation.has(encoded)) byConversation.set(encoded, binding.scopeId);
        }
    };
    const restore = () => {
        ensureOpen();
        for (const persisted of config.persistence?.records?.load() ?? config.persistence?.load?.() ?? []) {
            try {
                const scopeId = asConversationScopeId(persisted.scopeId);
                const hostId = asHostId(persisted.hostId);
                const conversationKey = persisted.threadId === null
                    ? null
                    : createConversationKey(hostId, persisted.threadId);
                insert(Object.freeze({ scopeId, hostId, conversationKey }));
            }
            catch {
                // Ignore corrupt client aliases. They are never authoritative history.
            }
        }
    };
    restore();
    snapshot = { revision, bindings: [...byScope.values()] };
    const register = (scopeId: ConversationScopeId, hostId: HostId, options: {
        readonly persistent?: boolean;
    } = {}): ConversationBinding => {
        ensureOpen();
        const existing = byScope.get(scopeId);
        if (existing !== undefined) {
            if (existing.hostId !== hostId) {
                throw new Error(`Conversation Scope ${scopeId} already belongs to Host ${existing.hostId}`);
            }
            return existing;
        }
        const binding = Object.freeze({ scopeId, hostId, conversationKey: null });
        derived.delete(scopeId);
        byScope.set(scopeId, binding);
        hosts.set(hostId, (hosts.get(hostId) ?? 0) + 1);
        if (options.persistent === false)
            transientScopes.add(scopeId);
        publish({ scopeId, previous: null, current: binding });
        return binding;
    };
    return {
        restore() { restore(); persistDirty(); publish(null, false); },
        getSnapshot: () => {
            if (snapshot.revision !== revision)
                snapshot = { revision, bindings: [...byScope.values()] };
            return snapshot;
        },
        hostIds: () => [...hosts.keys()],
        subscribeScope(scopeId, listener) {
            const set = scopeListeners.get(scopeId) ?? new Set<() => void>();
            set.add(listener);
            scopeListeners.set(scopeId, set);
            return () => { set.delete(listener); if (!set.size)
                scopeListeners.delete(scopeId); };
        },
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
                throw new Error(`Conversation Scope ${scopeId} belongs to Host ${current.hostId}, not ${key.hostId}`);
            }
            if (current.conversationKey !== null) {
                if (equalConversationKey(current.conversationKey, key))
                    return current;
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
            const aliases = aliasesByConversation.get(encoded) ?? new Set<ConversationScopeId>();
            aliases.add(scopeId); aliasesByConversation.set(encoded, aliases);
            publish({ scopeId, previous: current, current: binding });
            return binding;
        },
        resolve(scopeId) {
            const current = byScope.get(scopeId) ?? derived.get(scopeId);
            if (current)
                return current;
            if (!scopeId.startsWith('conversation:'))
                return null;
            try {
                const parts: unknown = JSON.parse(scopeId.slice('conversation:'.length));
                if (!Array.isArray(parts) || parts.length !== 2 || parts.some(part => typeof part !== 'string'))
                    return null;
                const key = createConversationKey(parts[0], parts[1]);
                if (scopeId !== `conversation:${encodeConversationKey(key)}`)
                    return null;
                const binding = Object.freeze({ scopeId, hostId: key.hostId, conversationKey: key });
                derived.set(scopeId, binding);
                return binding;
            }
            catch {
                return null;
            }
        },
        findScope: (key) => byConversation.get(encodeConversationKey(key)) ?? null,
        remove(scopeId) {
            ensureOpen();
            const current = byScope.get(scopeId);
            if (current === undefined)
                return false;
            byScope.delete(scopeId);
            const transient = transientScopes.has(scopeId);
            const count = (hosts.get(current.hostId) ?? 1) - 1;
            if (count)
                hosts.set(current.hostId, count);
            else
                hosts.delete(current.hostId);
            if (current.conversationKey !== null) {
                const encoded=encodeConversationKey(current.conversationKey), aliases=aliasesByConversation.get(encoded);
                aliases?.delete(scopeId);
                if(byConversation.get(encoded)===scopeId){
                    const next=aliases?.values().next().value;
                    if(next)byConversation.set(encoded,next);else byConversation.delete(encoded);
                }
                if(!aliases?.size)aliasesByConversation.delete(encoded);
            }
            publish({ scopeId, previous: current, current: null }, !transient);
            transientScopes.delete(scopeId);
            return true;
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            listeners.clear();
            scopeListeners.clear();
            dirty.clear();
            derived.clear();
        },
    };
}
