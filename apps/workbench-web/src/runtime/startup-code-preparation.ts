/** Code preparation is concurrent and has no activation authority. Every module
 * is still loaded/activated through its existing owner, which reports failures. */
export function prepareStartupCode(loaders: readonly (() => Promise<unknown>)[], signal: AbortSignal): void {
  for (const load of loaders)
    void Promise.resolve()
      .then(() => {
        if (!signal.aborted) return load();
      })
      .catch(() => {
        /* The required activation path owns retry/error presentation. */
      });
}
