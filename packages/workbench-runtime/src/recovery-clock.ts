/** Elapsed recovery time, separate from wall-clock timestamps in diagnostics.
 * Browser performance time advances while JS is frozen and ignores clock edits.
 * Platforms without it retain a nondecreasing wall-clock fallback. Custom clocks
 * must supply the same elapsed-time contract (including simulated suspension).
 */
export function createRecoveryNow(
  read: () => number = typeof globalThis.performance?.now === "function"
    ? () => globalThis.performance.now() : () => Date.now(),
): () => number {
  let previous = read();
  let elapsed = 0;
  return () => {
    const current = read();
    // Rebase even on reversal so a fallback clock edit cannot stall its future.
    elapsed += Math.max(0, current - previous);
    previous = current;
    return elapsed;
  };
}

export const recoveryNow = createRecoveryNow();
