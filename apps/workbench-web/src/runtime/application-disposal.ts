export async function disposeOwnedSteps(
  steps: readonly (() => void | Promise<void>)[],
  message: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, message);
}


/** All callers observe the same completed cleanup, including its failures. */
export function createApplicationDisposer(
  steps: readonly (() => void | Promise<void>)[],
  message: string,
): () => Promise<void> {
  let disposal: Promise<void> | undefined;
  return () => disposal ??= Promise.resolve().then(() => disposeOwnedSteps(steps, message));
}
