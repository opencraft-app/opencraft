/**
 * Structural subset of the workerd Durable Object storage and R2 bindings that
 * these adapters consume. Deployment assembly passes the real `ctx.storage`
 * and R2 bucket bindings; the shapes follow the Cloudflare Workers runtime API.
 */

export type DurableObjectSqlValue = ArrayBuffer | string | number | null;

export interface DurableObjectSqlCursor extends Iterable<Record<string, DurableObjectSqlValue>> {
  next(): IteratorResult<Record<string, DurableObjectSqlValue>>;
  toArray(): Record<string, DurableObjectSqlValue>[];
  one(): Record<string, DurableObjectSqlValue>;
}

export interface DurableObjectSqlStorage {
  exec(query: string, ...bindings: unknown[]): DurableObjectSqlCursor;
}

export interface DurableObjectSyncKv {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
}

/** `ctx.storage` of a SQLite-backed Durable Object. */
export interface DurableObjectStorage {
  readonly sql: DurableObjectSqlStorage;
  readonly kv: DurableObjectSyncKv;
  transactionSync<T>(closure: () => T): T;
  /** Resolves once previously issued writes are durable. */
  sync(): Promise<void>;
}

export interface R2Conditional {
  readonly etagDoesNotMatch?: string;
}
export interface R2Object {
  readonly key: string;
  readonly size: number;
}
export interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream<Uint8Array>;
}
export interface R2UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}
export interface R2MultipartUpload {
  uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<R2Object>;
  abort(): Promise<void>;
}
export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: { range?: { offset: number; length?: number } }): Promise<R2ObjectBody | null>;
  put(key: string, value: Uint8Array, options?: { onlyIf?: R2Conditional; sha256?: string }): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string): Promise<R2MultipartUpload>;
}

/** workerd's incremental digest (`crypto.DigestStream`). */
export interface DigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
}
export type DigestStreamConstructor = new (algorithm: "SHA-256") => DigestStream;
