/** The archive receipt settles the action; catalog revalidation continues in the background. */
export async function archiveThread(input: {
  readonly archive: () => Promise<void>;
  readonly refreshThreads: () => Promise<unknown>;
}): Promise<void> {
  try { await input.archive(); }
  finally { void input.refreshThreads().catch(() => undefined); }
}
