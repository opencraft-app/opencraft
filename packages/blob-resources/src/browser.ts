import type { BlobCacheStorage, BlobCacheEntry } from "./types";

/** Separate metadata store: LRU scans never materialize every cached Blob. */
export class IndexedDbBlobStorage implements BlobCacheStorage {
  private database?: Promise<IDBDatabase>;
  private closed = false;
  constructor(private readonly name = "opencraft-blobs-v1", private readonly maxBytes = 256 * 1024 * 1024,
    private readonly maxEntries = 512, private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error("Blob storage closed"));
    if (!this.database) this.database = new Promise((resolve, reject) => {
      if (!this.factory) { reject(new Error("IndexedDB unavailable")); return; }
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error("Blob database open timed out")); }, 2000);
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("blobs");
        request.result.createObjectStore("metadata", { keyPath: "key" });
      };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
      request.onblocked = () => { clearTimeout(timer); expired = true; reject(new Error("Blob database blocked")); };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (expired || this.closed) { request.result.close(); reject(new Error("Blob storage closed")); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    return this.database;
  }

  private async transaction<T>(action: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["blobs", "metadata"], "readwrite");
      let value: T;
      const timer = setTimeout(() => { try { tx.abort(); } catch {} reject(new Error("Blob cache transaction timed out")); }, 2000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(tx.error ?? new Error("Blob cache transaction failed")); };
      try { action(tx, next => { value = next; }); } catch (error) { clearTimeout(timer); tx.abort(); reject(error); }
    });
  }

  get(key: string): Promise<BlobCacheEntry | undefined> {
    return this.transaction((tx, result) => {
      const metadata = tx.objectStore("metadata");
      const request = metadata.get(key);
      request.onsuccess = () => {
        const entry = request.result;
        if (!entry || entry.expiresAt <= Date.now()) {
          metadata.delete(key); tx.objectStore("blobs").delete(key); result(undefined); return;
        }
        const blob = tx.objectStore("blobs").get(key);
        blob.onsuccess = () => {
          if (!(blob.result instanceof Blob)) { metadata.delete(key); tx.objectStore("blobs").delete(key); result(undefined); return; }
          entry.accessedAt = Date.now(); metadata.put(entry);
          result({ key, expiresAt: entry.expiresAt, accessedAt: entry.accessedAt, blob: blob.result });
        };
      };
    });
  }

  put(entry: BlobCacheEntry): Promise<void> {
    if (entry.blob.size > this.maxBytes || entry.expiresAt <= Date.now()) return Promise.resolve();
    return this.transaction((tx, result) => {
      const metadata = tx.objectStore("metadata");
      const blobs = tx.objectStore("blobs");
      blobs.put(entry.blob, entry.key);
      metadata.put({ key: entry.key, size: entry.blob.size, accessedAt: entry.accessedAt, expiresAt: entry.expiresAt });
      const scan = metadata.getAll();
      scan.onsuccess = () => {
        const rows = scan.result.sort((a, b) => a.accessedAt - b.accessedAt);
        let total = rows.reduce((sum, row) => sum + row.size, 0);
        let count = rows.length;
        for (const row of rows) {
          if (row.expiresAt <= Date.now() || total > this.maxBytes || count > this.maxEntries) {
            metadata.delete(row.key); blobs.delete(row.key); total -= row.size; count--;
          }
        }
        result(undefined);
      };
    });
  }

  delete(key: string): Promise<void> {
    return this.transaction((tx, result) => {
      tx.objectStore("blobs").delete(key); tx.objectStore("metadata").delete(key); result(undefined);
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.database?.then(db => db.close(), () => {});
  }
}

/** Active URL ownership is independent of cache eviction. */
export class BlobUrlManager {
  private entries = new WeakMap<Blob, { url: string; refs: number }>();
  acquire(blob: Blob): { source: string; release(): void } {
    let entry = this.entries.get(blob);
    if (!entry) { entry = { url: URL.createObjectURL(blob), refs: 0 }; this.entries.set(blob, entry); }
    entry.refs++;
    let released = false;
    return { source: entry.url, release: () => {
      if (released) return;
      released = true;
      if (--entry!.refs === 0) { URL.revokeObjectURL(entry!.url); this.entries.delete(blob); }
    } };
  }
}
