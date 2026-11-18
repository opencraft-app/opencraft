export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The deployment owns discovery even with no clients connected. Installation
 * remains an explicit, authenticated action owned by the existing updater. */
export function createUpdateChecker({check, canCheck, intervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS, initialDelayMs = 1000}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647
    || !Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0) throw new Error('Invalid automatic update check interval');
  let timer = null, nextCheckAt = null, closed = false, started = false;
  function schedule(delay) {
    if (closed || intervalMs === 0) return;
    nextCheckAt = new Date(Date.now() + delay).toISOString();
    timer = setTimeout(async () => {
      timer = null; nextCheckAt = null;
      try { if (!closed && canCheck()) await check(); }
      catch { /* Discovery failure is presented by the update owner's status. */ }
      finally { schedule(intervalMs); }
    }, delay);
    timer.unref?.();
  }
  return {
    start() { if (!started) { started = true; schedule(initialDelayMs); } },
    snapshot() { return {enabled:intervalMs > 0, intervalMs, nextCheckAt}; },
    close() { closed = true; clearTimeout(timer); timer = null; nextCheckAt = null; },
  };
}
