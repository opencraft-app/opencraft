import { SqliteDocumentStore } from "@opencraft/document-storage/sqlite";
import { serializeDocumentValue, validateDataScope, validateDataRevision, validateDataVersion, DocumentVersionConflictError } from "@opencraft/document-storage";
import { HOST_STORAGE, HOST_STORAGE_CAPABILITIES, type HostDocumentChanged } from "@opencraft/appserver-protocol/host-storage";
import { isAbsolute } from "node:path";

export class HostDocumentFault extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** Lives behind the Host's authenticated, single-user session. No plugin loader or SQL RPC. */
export class HostDocumentService {
  private database: SqliteDocumentStore | undefined;
  private closed = false;
  private readonly listeners = new Set<(change: HostDocumentChanged) => void>();
  constructor(private readonly path: string | null, database?: SqliteDocumentStore) { this.database = database; }
  subscribe(listener: (change: HostDocumentChanged) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  handle(method: string, input: unknown): unknown {
    if (this.closed) throw new HostDocumentFault(-32040, "Host document storage unavailable");
    if (!this.path || !isAbsolute(this.path)) throw new HostDocumentFault(-32601, "Host document storage has no configured data directory");
    if (method !== HOST_STORAGE.capabilities && method !== HOST_STORAGE.read && method !== HOST_STORAGE.compareAndSet) throw new HostDocumentFault(-32601, "Unsupported Host document method");
    const params = input ?? {};
    if (typeof params !== "object" || Array.isArray(params)) throw new HostDocumentFault(-32602, "Invalid Host document request");
    const value = params as Record<string, unknown>;
    const allowed = method === HOST_STORAGE.capabilities ? [] : method === HOST_STORAGE.read ? ["scope"] : ["scope", "revision", "version", "value"];
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new HostDocumentFault(-32602, "Invalid Host document request");
    if (method === HOST_STORAGE.capabilities) return HOST_STORAGE_CAPABILITIES;
    try {
      validateDataScope(value.scope);
      if (method === HOST_STORAGE.compareAndSet) { validateDataRevision(value.revision); validateDataVersion(value.version); serializeDocumentValue(value.value); }
    } catch (error) {
      throw new HostDocumentFault(error instanceof RangeError ? -32041 : -32602,
        error instanceof RangeError ? "Host document size limit exceeded" : "Invalid Host document request");
    }
    try {
      const db = this.database ??= new SqliteDocumentStore(this.path);
      if (method === HOST_STORAGE.read) return db.read(value.scope);
      const result = db.compareAndSet(value.scope, value.revision, value.version, value.value);
      if (result.updated && result.record) {
        for (const listener of this.listeners) {
          try { listener({ scope: String(value.scope), revision: result.record.revision }); } catch { /* Already committed; observer errors do not undo writes. */ }
        }
      }
      return result;
    } catch (error) {
      if (error instanceof DocumentVersionConflictError) throw new HostDocumentFault(-32042, "Host document requires a newer data format");
      throw new HostDocumentFault(-32040, "Host document storage unavailable");
    }
  }
  close() { if (this.closed) return; this.closed = true; this.listeners.clear(); this.database?.close(); }
}
