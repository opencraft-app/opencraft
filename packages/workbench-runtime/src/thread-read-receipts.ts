/** Account authority owns storage; clients only append exact Host/Thread/Turn receipts. */
export interface ThreadReadReceiptPort {
  /** Receipts to merge into the device's read set; an authority may return only those it has not yet returned for `scope`. */
  read(scope: string, signal: AbortSignal): Promise<readonly string[]>;
  /** Adds receipts and returns the ones the authority confirmed. Read state never moves backwards. */
  merge(scope: string, receipts: readonly string[], signal: AbortSignal): Promise<readonly string[]>;
}
/**
 * The server's own login authority for read receipts, used where no product account
 * contribution supplies `readReceipts`. `getScope` is the signed-in human Actor (null while
 * signed out); the server derives the Actor and only uses the scope as a fence.
 */
export interface ThreadReadReceiptSource {
  readonly id: string;
  readonly port: ThreadReadReceiptPort;
  getScope(): string | null;
  subscribe(listener: () => void): () => void;
  /**
   * The signed-in person's browser cache/outbox, owned by the source: it holds one person
   * only and is removed when the server reports that nobody is signed in. `read` is null
   * when nothing is cached for that person.
   */
  readonly cache: {
    read(actorId: string): string[] | null;
    write(actorId: string, receipts: readonly string[]): void;
  };
}
/** Largest batch a device sends in one merge. */
export const THREAD_READ_RECEIPT_MERGE_LIMIT = 128;
export function parseThreadReadReceipts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error("Invalid read receipts");
  return value.map(item => {
    if (typeof item !== "string" || item.length > 2048) throw new Error("Invalid read receipt");
    const parts: unknown = JSON.parse(item);
    if (!Array.isArray(parts) || parts.length !== 3 || parts.some(part => typeof part !== "string" || !part || part.length > 512)) throw new Error("Invalid read receipt identity");
    return JSON.stringify(parts);
  });
}
