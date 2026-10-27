/** Account authority owns storage; clients only append exact Host/Thread/Turn receipts. */
export interface ThreadReadReceiptPort {
  read(scope: string, signal: AbortSignal): Promise<readonly string[]>;
  merge(scope: string, receipts: readonly string[], signal: AbortSignal): Promise<readonly string[]>;
}
export function parseThreadReadReceipts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error("Invalid read receipts");
  return value.map(item => {
    if (typeof item !== "string" || item.length > 2048) throw new Error("Invalid read receipt");
    const parts: unknown = JSON.parse(item);
    if (!Array.isArray(parts) || parts.length !== 3 || parts.some(part => typeof part !== "string" || !part || part.length > 512)) throw new Error("Invalid read receipt identity");
    return JSON.stringify(parts);
  });
}
