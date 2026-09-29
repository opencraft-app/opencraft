/** A catalog refresh is not a prerequisite for opening an acknowledged fork. */
export async function forkAndOpenThread(input: {
  readonly routeScopeId: () => string | null;
  readonly fork: () => Promise<string>;
  readonly refreshThreads: () => Promise<unknown>;
  readonly openThread: (threadId: string) => Promise<unknown>;
}): Promise<void> {
  const origin = input.routeScopeId();
  const childId = await input.fork();
  void input.refreshThreads().catch(() => undefined);
  if (input.routeScopeId() === origin) await input.openThread(childId);
}
