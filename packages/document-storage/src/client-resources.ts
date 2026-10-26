import { serializeDocumentValue, type DocumentValue } from "./contract.js";

export type ResourceAuthority = "local" | "remote";
export interface ClientResourceKey {
  readonly namespace: string;
  readonly name: string;
  readonly id: string;
  readonly authority: ResourceAuthority;
}
export interface ClientResourceRecord {
  readonly revision: number;
  readonly version: number;
  readonly savedAt: number;
  readonly value: DocumentValue;
}
export interface ClientResourcePersistence {
  read(key: ClientResourceKey): Promise<ClientResourceRecord | null>;
  compareAndSet(key: ClientResourceKey, revision: number, record: Omit<ClientResourceRecord, "revision">): Promise<boolean>;
  /** Only disposable remote copies may be removed by capacity policy. */
  clearRemoteNamespace(namespace: string): Promise<void>;
  close(): void | Promise<void>;
}

export const REMOTE_RESOURCE_LIMIT = 64;
export function resourceKey(key: ClientResourceKey): string {
  if (!key || typeof key.namespace !== "string" || key.namespace.length < 1 || key.namespace.length > 4096
    || typeof key.name !== "string" || !/^[a-z0-9.-]{1,96}$/u.test(key.name)
    || typeof key.id !== "string" || key.id.length < 1 || key.id.length > 2048
    || !["local", "remote"].includes(key.authority)) throw new TypeError("Invalid client resource identity");
  return JSON.stringify([key.namespace, key.name, key.id, key.authority]);
}
export function validateResourceRecord(record: Omit<ClientResourceRecord, "revision">, revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(record.version) || record.version < 1
    || !Number.isFinite(record.savedAt) || record.savedAt < 0) throw new TypeError("Invalid client resource record");
  serializeDocumentValue(record.value);
}

export interface ClientResourceSnapshot<T> {
  readonly value: T | null;
  readonly revision: number;
  readonly savedAt: number | null;
  readonly loading: boolean;
  readonly error: unknown;
}
export interface ClientResourceFence {
  readonly isCurrent: () => boolean;
}
export class ClientResourceScopeChangedError extends Error {
  constructor() { super("Client resource operation scope changed"); this.name = "ClientResourceScopeChangedError"; }
}
function assertFence(fence: ClientResourceFence): void {
  if (!fence.isCurrent()) throw new ClientResourceScopeChangedError();
}
export interface ClientResourceDefinition<T extends DocumentValue> {
  readonly name: string;
  readonly authority: ResourceAuthority;
  readonly version: number;
  /** Resource owner validates its own bounded projection, including on restore. */
  readonly parse: (value: DocumentValue) => T;
}
export interface ReadableClientResource<T> {
  getSnapshot(): ClientResourceSnapshot<T>;
  subscribe(listener: () => void): () => void;
  readonly ready: Promise<void>;
  reload(): Promise<void>;
}
export interface RemoteClientResource<T extends DocumentValue> extends ReadableClientResource<T> {
  /** Called only with a successful authoritative observation, never with a request error. */
  observe(value: T, fence: ClientResourceFence): Promise<void>;
}
export interface LocalClientResource<T extends DocumentValue> extends ReadableClientResource<T> {
  /** Caller retains its input until the selected adapter accepts the commit. A conflict requires an explicit re-read/merge. */
  commit(value: T, expectedRevision: number, fence: ClientResourceFence): Promise<void>;
}

class Resource<T extends DocumentValue> implements RemoteClientResource<T>, LocalClientResource<T> {
  private snapshot: ClientResourceSnapshot<T> = { value: null, revision: 0, savedAt: null, loading: true, error: null };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private revoked = false;
  readonly ready: Promise<void>;
  constructor(private readonly owner: ClientResources, readonly key: ClientResourceKey,
    private readonly definition: ClientResourceDefinition<T>) {
    this.ready = this.restore();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: ClientResourceSnapshot<T>) {
    this.snapshot = next;
    for (const listener of this.listeners) { try { listener(); } catch { /* A view cannot fail storage. */ } }
  }
  private assertCurrent() { if (this.revoked) throw new Error("Client resource scope revoked"); }
  private async restore() {
    const generation = this.generation;
    try {
      const stored = await this.owner.run(async storage => { this.assertCurrent(); return storage.read(this.key); });
      if (this.revoked || generation !== this.generation) return;
      if (stored && stored.version !== this.definition.version) throw new Error("Unsupported client resource version; original retained");
      this.publish({ value: stored ? this.definition.parse(stored.value) : null,
        revision: stored?.revision ?? 0, savedAt: stored?.savedAt ?? null, loading: false, error: null });
    } catch (error) {
      if (!this.revoked && generation === this.generation) this.publish({ ...this.snapshot, loading: false, error });
    }
  }
  reload(): Promise<void> { this.assertCurrent(); ++this.generation; return this.restore(); }
  async observe(value: T, fence: ClientResourceFence): Promise<void> {
    this.assertCurrent();
    assertFence(fence);
    if (this.key.authority !== "remote") throw new Error("Local originals require an accepted adapter commit");
    const parsed = this.definition.parse(value);
    // Validate before changing memory; every adapter enforces the same byte budget.
    const record = { version: this.definition.version, savedAt: Date.now(), value: parsed };
    validateResourceRecord(record, 0);
    const operation = ++this.generation;
    assertFence(fence);
    this.publish({ ...this.snapshot, value: parsed, savedAt: record.savedAt, loading: false, error: null });
    try {
      if (operation !== this.generation) return;
      await this.owner.run(async storage => {
        this.assertCurrent();
        assertFence(fence);
        if (operation !== this.generation) return;
        const current = await storage.read(this.key);
        this.assertCurrent();
        assertFence(fence);
        if (operation !== this.generation) return;
        if (current && current.version > record.version) throw new Error("Client resource format downgrade rejected");
        if (current && current.savedAt > record.savedAt) return;
        if (!await storage.compareAndSet(this.key, current?.revision ?? 0, record)) throw new Error("Client resource conflict");
        assertFence(fence);
        if (!this.revoked && operation === this.generation && this.snapshot.value === parsed) this.publish({ ...this.snapshot, revision: (current?.revision ?? 0) + 1 });
      });
    } catch (error) {
      if (!(error instanceof ClientResourceScopeChangedError) && !this.revoked && operation === this.generation && this.snapshot.value === parsed) this.publish({ ...this.snapshot, error });
      // A disposable cache failure must not turn a successful network read into an error.
    }
  }
  async commit(value: T, expectedRevision: number, fence: ClientResourceFence): Promise<void> {
    this.assertCurrent();
    assertFence(fence);
    if (this.key.authority !== "local") throw new Error("Remote copies require an authoritative observation");
    await this.ready;
    this.assertCurrent();
    assertFence(fence);
    const record = { version: this.definition.version, savedAt: Date.now(), value: this.definition.parse(value) };
    validateResourceRecord(record, expectedRevision);
    try {
      await this.owner.run(async storage => {
        this.assertCurrent();
        assertFence(fence);
        if (!await storage.compareAndSet(this.key, expectedRevision, record)) throw new Error("Client resource conflict; reload before merging");
        assertFence(fence);
        if (!this.revoked) this.publish({ value: record.value, revision: expectedRevision + 1, savedAt: record.savedAt, loading: false, error: null });
      });
    } catch (error) {
      if (!(error instanceof ClientResourceScopeChangedError) && !this.revoked) this.publish({ ...this.snapshot, error });
      throw error;
    }
  }
  revoke() {
    this.revoked = true; ++this.generation;
    this.publish({ value: null, revision: 0, savedAt: null, loading: false, error: null });
    this.listeners.clear();
  }
}

/** Application-owned data semantics. Network fetching remains with each domain's query owner.
 * A single queue orders in-flight writes before scope cleanup; late owners cannot resurrect data. */
export class ClientResources {
  private readonly resources = new Map<string, Resource<DocumentValue>>();
  private queue: Promise<unknown> = Promise.resolve();
  private namespace: string;
  private closed = false;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly storage: Promise<ClientResourcePersistence>, namespace: string) {
    this.namespace = namespace;
    // Opening storage is deliberately outside the critical startup path.
    void storage.catch(() => undefined);
  }
  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  remote<T extends DocumentValue>(definition: ClientResourceDefinition<T>, id: string): RemoteClientResource<T> {
    return this.open(definition, id, "remote");
  }
  local<T extends DocumentValue>(definition: ClientResourceDefinition<T>, id: string): LocalClientResource<T> {
    return this.open(definition, id, "local");
  }
  private open<T extends DocumentValue>(definition: ClientResourceDefinition<T>, id: string, authority: ResourceAuthority): Resource<T> {
    if (this.closed) throw new Error("Client resources closed");
    if (definition.authority !== authority) throw new Error("Client resource authority mismatch");
    const key = { namespace: this.namespace, name: definition.name, id, authority };
    const identity = resourceKey(key);
    let resource = this.resources.get(identity);
    if (!resource) {
      resource = new Resource(this, key, definition) as Resource<DocumentValue>;
      this.resources.set(identity, resource);
    }
    return resource as Resource<T>;
  }
  run<T>(operation: (storage: ClientResourcePersistence) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Client resources closed"));
    const result = this.queue.then(async () => operation(await this.storage));
    this.queue = result.catch(() => undefined);
    return result;
  }
  setNamespace(namespace: string): void {
    if (namespace === this.namespace || this.closed) return;
    const previous = this.namespace;
    this.namespace = namespace;
    for (const resource of this.resources.values()) resource.revoke();
    this.resources.clear();
    // Local originals remain protected: their domain owner decides deletion/export.
    void this.run(storage => storage.clearRemoteNamespace(previous)).catch(() => undefined);
    ++this.revision;
    for (const listener of this.listeners) listener();
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const resource of this.resources.values()) resource.revoke();
    this.resources.clear(); this.listeners.clear();
    await this.queue;
    await (await this.storage).close();
  }
}
