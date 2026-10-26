/** Elapsed time, separate from wall-clock timestamps in diagnostics.
 * Browser performance time advances while JS is frozen and ignores clock edits.
 * Platforms without it retain a nondecreasing wall-clock fallback. Custom clocks
 * must supply the same elapsed-time contract (including simulated suspension).
 */
export function createElapsedNow(
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

export const elapsedNow = createElapsedNow();


/** Elapsed-time budget port. Retired callbacks may still be delivered. */
export interface ElapsedClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}
export const elapsedClock: ElapsedClock = {
  now: elapsedNow,
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: timer => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
};
