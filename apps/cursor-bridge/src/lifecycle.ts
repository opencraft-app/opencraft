const SDK_DISPOSAL_GRACE_MS = 3_000;

/** After the run has stopped, terminating its Worker is the local close boundary.
 * SDK disposal is best effort; a failed termination remains retryable. */
export function localOwnerClose(dispose: () => Promise<unknown>, terminate: () => Promise<void>): () => Promise<void> {
  let attempted = false;
  let closing: Promise<void> | undefined;
  return () => closing ??= (async () => {
    if (!attempted) {
      attempted = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<void>(resolve => {
          timer = setTimeout(resolve, SDK_DISPOSAL_GRACE_MS);
        });
        await Promise.race([dispose(), deadline]);
      } catch {
        // The Worker still needs to be terminated after a disposal failure.
      } finally {
        clearTimeout(timer);
      }
    }
    await terminate();
  })().catch((error) => { closing = undefined; throw error; });
}
