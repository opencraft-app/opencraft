/**
 * Runtime-neutral immutable object storage. See docs/architecture/platform/storage-ports.md.
 *
 * Objects are written once under a key and never modified; replacing content
 * means writing a new key and switching the reference in the owner's index
 * (usually SQL), then deleting the old key. Bodies are Web streams so the same
 * contract works in Node and workerd.
 */

export interface BlobStat {
  readonly key: string;
  readonly size: number;
}
/** Returned when an object is written. The owner's index keeps the digest; reads do not recompute it. */
export interface BlobInfo extends BlobStat {
  /** Lowercase hex SHA-256 of the stored bytes. */
  readonly sha256: string;
}

export interface BlobPutOptions {
  /** Hard size limit; larger bodies are rejected and nothing is stored. */
  readonly maxBytes: number;
  /** When given, a body with another digest is rejected and nothing is stored. */
  readonly sha256?: string;
}

export interface BlobRange {
  readonly offset: number;
  readonly length?: number;
}

export interface BlobObject extends BlobStat {
  /** Bytes of the requested range (the whole object without a range). */
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * A sequential upload whose bytes become visible only on `complete()`.
 * Abandoned uploads leave no object; `abort()` releases staged bytes early.
 */
export interface BlobUpload {
  write(chunk: Uint8Array): Promise<void>;
  complete(options?: { readonly sha256?: string }): Promise<BlobInfo>;
  abort(): Promise<void>;
}

export interface BlobStore {
  /**
   * Stores a new object. An existing key is rejected with BlobExistsError.
   * The guarantee covers committed objects and concurrent writes through one
   * owner; each key prefix has a single owner, so writes to the same key from
   * different owners are outside this contract.
   */
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, options: BlobPutOptions): Promise<BlobInfo>;
  /** Starts a sequential upload for a new key with the same limits as `put`. */
  upload(key: string, options: { readonly maxBytes: number }): Promise<BlobUpload>;
  get(key: string, range?: BlobRange): Promise<BlobObject | null>;
  head(key: string): Promise<BlobStat | null>;
  /** Deleting an absent key succeeds. */
  delete(key: string): Promise<void>;
}

export class BlobExistsError extends Error {
  constructor(readonly key: string) {
    super("Blob already exists");
    this.name = "BlobExistsError";
  }
}
export class BlobLimitError extends Error {
  constructor() {
    super("Blob exceeds its size limit");
    this.name = "BlobLimitError";
  }
}
export class BlobDigestError extends Error {
  constructor() {
    super("Blob digest does not match");
    this.name = "BlobDigestError";
  }
}

/** Keys are relative paths of safe segments, e.g. `artifacts/<id>`. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export function validateBlobKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length > 512) throw new TypeError("Invalid blob key");
  const segments = key.split("/");
  if (segments.length > 8 || segments.some((segment) => !SEGMENT.test(segment) || segment.includes("..")))
    throw new TypeError("Invalid blob key");
}
export function validateBlobLimit(maxBytes: unknown): asserts maxBytes is number {
  if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 0) throw new TypeError("Invalid blob size limit");
}
export function validateBlobRange(range: BlobRange | undefined): void {
  if (range === undefined) return;
  if (
    !Number.isSafeInteger(range.offset) ||
    range.offset < 0 ||
    (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0))
  )
    throw new TypeError("Invalid blob range");
}
export function validateSha256(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError("Invalid SHA-256 digest");
}
