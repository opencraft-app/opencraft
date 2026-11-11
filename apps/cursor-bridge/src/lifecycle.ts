/** After the run has stopped, terminating its Worker is the local close boundary.
 * SDK disposal is best effort; a failed termination remains retryable. */
export function localOwnerClose(dispose: () => Promise<unknown>, terminate: () => Promise<void>): () => Promise<void> {
  let attempted = false;
  let closing: Promise<void> | undefined;
  return () => closing ??= (async () => {
    if (!attempted) { attempted = true; try { await dispose(); } catch { /* Worker termination still owns cleanup. */ } }
    await terminate();
  })().catch((error) => { closing = undefined; throw error; });
}
