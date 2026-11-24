import { dueOwnerWork, timeoutOwnerWake, type OwnerWake } from "@opencraft/owner-wake";

/** How long a settled workspace receipt stays readable before it is forgotten. */
export const RECEIPT_RETENTION_MS = 300_000;

/**
 * Forgets settled receipts {@link RECEIPT_RETENTION_MS} after they settled, waking the owner only when the oldest one
 * expires and not at all while none is settled. The owner stamps `settledAt` with {@link ReceiptRetention.now} and calls
 * {@link ReceiptRetention.settled} after stamping (and after removing a receipt itself).
 */
export interface ReceiptRetention {
  now(): number;
  settled(): void;
  close(): void;
}

export function receiptRetention<T>(
  receipts: Map<string, T>,
  settledAt: (receipt: T) => number | undefined,
  wake: OwnerWake = timeoutOwnerWake(),
): ReceiptRetention {
  const work = dueOwnerWork(
    wake,
    () => {
      let oldest: number | null = null;
      for (const receipt of receipts.values()) {
        const at = settledAt(receipt);
        if (at !== undefined && (oldest === null || at < oldest)) oldest = at;
      }
      return oldest === null ? null : oldest + RECEIPT_RETENTION_MS;
    },
    (now) => {
      for (const [token, receipt] of receipts) {
        const at = settledAt(receipt);
        if (at !== undefined && now - at >= RECEIPT_RETENTION_MS) receipts.delete(token);
      }
    },
  );
  return { now: () => wake.now(), settled: () => work.reschedule(), close: () => work.close() };
}
