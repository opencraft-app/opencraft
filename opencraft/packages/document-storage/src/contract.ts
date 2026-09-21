export type DocumentValue = null | boolean | number | string | readonly DocumentValue[] | { readonly [key: string]: DocumentValue };

/** Platform-internal document port. Each adapter binds its own authority and scope. */
export interface DocumentRecord {
  readonly revision: number;
  readonly version: number;
  readonly value: DocumentValue;
}
export type DocumentCommit = { readonly updated: boolean; readonly record: DocumentRecord | null };
export class DocumentVersionConflictError extends Error {
  constructor() { super("Document format downgrade is not supported"); }
}
export function validateDocumentTransition(current: DocumentRecord | null, version: number): void {
  if (current && version < current.version) throw new DocumentVersionConflictError();
}
export interface DocumentPersistence {
  read(scope: string): Promise<DocumentRecord | null>;
  compareAndSet(scope: string, revision: number, version: number, value: DocumentValue): Promise<DocumentCommit>;
  subscribe(listener: (scope: string) => void): () => void;
  close(): void | Promise<void>;
}

export const DOCUMENT_MAX_BYTES = 1024 * 1024;
export function validateDataScope(scope: unknown): asserts scope is string {
  if (typeof scope !== "string" || !/^[a-zA-Z0-9._:/-]{1,256}$/.test(scope)) throw new TypeError("Invalid extension storage scope");
}
export function validateDataRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER) throw new TypeError("Invalid extension storage revision");
}
export function validateDataVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError("Invalid extension storage version");
}
export function serializeDocumentValue(value: unknown): string {
  const ancestors = new Set<object>();
  function visit(input: unknown, depth: number): void {
    if (depth > 32) throw new TypeError("Extension storage nesting limit exceeded");
    if (input === null || typeof input === "string" || typeof input === "boolean") return;
    if (typeof input === "number" && Number.isFinite(input)) return;
    if (typeof input !== "object" || ancestors.has(input)) throw new TypeError("Extension storage requires JSON data");
    const proto = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && proto !== Object.prototype && proto !== null) throw new TypeError("Extension storage requires plain JSON objects");
    ancestors.add(input);
    for (const item of Array.isArray(input) ? input : Object.values(input)) visit(item, depth + 1);
    ancestors.delete(input);
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > DOCUMENT_MAX_BYTES) throw new RangeError("Extension storage quota exceeded");
  return json;
}

export function parseDocumentRecord(input: unknown): DocumentRecord | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("Unsupported stored extension record; original data retained");
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some(key => !["revision", "version", "value"].includes(key))) throw new Error("Unsupported stored extension record; original data retained");
  validateDataRevision(row.revision); validateDataVersion(row.version);
  if (row.revision === 0) throw new Error("Invalid stored extension revision");
  const value = JSON.parse(serializeDocumentValue(row.value)) as DocumentValue;
  return { revision: row.revision, version: row.version, value };
}

export class MemoryDocumentPersistence implements DocumentPersistence {
  private readonly rows = new Map<string, DocumentRecord>();
  private readonly listeners = new Set<(scope: string) => void>();
  private closed = false;
  async read(scope: string) { this.assertOpen(); validateDataScope(scope); return structuredClone(this.rows.get(scope) ?? null); }
  async compareAndSet(scope: string, revision: number, version: number, value: DocumentValue): Promise<DocumentCommit> {
    this.assertOpen(); validateDataScope(scope); validateDataRevision(revision); validateDataVersion(version);
    const json = serializeDocumentValue(value);
    const current = this.rows.get(scope) ?? null;
    if ((current?.revision ?? 0) !== revision) return { updated: false, record: structuredClone(current) };
    validateDocumentTransition(current, version);
    const record = { revision: revision + 1, version, value: JSON.parse(json) as DocumentValue };
    this.rows.set(scope, record);
    for (const listener of this.listeners) { try { listener(scope); } catch { /* Observers cannot fail a commit. */ } }
    return { updated: true, record: structuredClone(record) };
  }
  subscribe(listener: (scope: string) => void) { this.assertOpen(); this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() { this.closed = true; this.listeners.clear(); }
  private assertOpen() { if (this.closed) throw new Error("Extension persistence closed"); }
}
