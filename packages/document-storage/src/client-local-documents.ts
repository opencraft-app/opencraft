import { ClientResourceScopeChangedError, type ClientResourcePersistence, type ClientResourceKey } from "./client-resources.js";

export type ClientLocalDocumentName = "conversation-draft" | "composer-draft" | "conversation-outbox";

/** Named local originals over the same platform adapter as display resources.
 * Null is a revisioned tombstone: a failed legacy removal cannot resurrect input. */
export class ClientLocalDocuments {
  private revoked = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly revisions = new Map<string, number>();
  constructor(private readonly storage: Promise<ClientResourcePersistence>, readonly namespace: string, readonly name: ClientLocalDocumentName) {
    void storage.catch(() => undefined);
  }
  private key(id: string): ClientResourceKey { return { namespace: this.namespace, name: this.name, id, authority: "local" }; }
  private current() { if (this.revoked) throw new ClientResourceScopeChangedError(); }
  private run<T>(operation: (storage: ClientResourcePersistence) => Promise<T>): Promise<T> {
    this.current();
    const result = this.queue.then(async () => { this.current(); const storage = await this.storage; this.current(); return operation(storage); });
    this.queue = result.catch(() => undefined);
    return result;
  }
  /** Undefined means absent; null means intentionally removed. */
  read(id: string): Promise<string | null | undefined> {
    return this.run(async storage => {
      const row = await storage.read(this.key(id)); this.current();
      if (row && (row.version !== 1 || (row.value !== null && typeof row.value !== "string"))) throw new Error("Unsupported local document format");
      this.revisions.set(id, row?.revision ?? 0);
      return row ? row.value as string | null : undefined;
    });
  }
  write(id: string, value: string | null): Promise<void> {
    return this.run(async storage => {
      let revision = this.revisions.get(id);
      if (revision === undefined) {
        const row = await storage.read(this.key(id)); this.current();
        // An unread existing original is never an implicit write baseline. In
        // particular, a failed hydration must not later erase recovered input.
        if (row) throw new Error("Local document conflict; read before replacing saved input");
        revision = 0;
      }
      this.current();
      if (!await storage.compareAndSet(this.key(id), revision, { version: 1, savedAt: Date.now(), value })) throw new Error("Local document conflict; reload before merging");
      this.current(); this.revisions.set(id, revision + 1);
    });
  }
  keys(): Promise<readonly string[]> {
    return this.run(async storage => { const keys = await storage.listLocalKeys(this.namespace, this.name); this.current(); return keys.map(key => key.id); });
  }
  /** Synchronous revocation fences queued work; physical cleanup follows accepted writes. */
  revokeAndClear(): Promise<void> {
    if (this.revoked) return this.queue.then(() => undefined);
    this.revoked = true; this.revisions.clear();
    const cleanup = this.queue.then(async () => (await this.storage).clearLocalResource(this.namespace, this.name));
    this.queue = cleanup.catch(() => undefined);
    return cleanup;
  }
  flush(): Promise<void> { return this.queue.then(() => undefined); }
}
