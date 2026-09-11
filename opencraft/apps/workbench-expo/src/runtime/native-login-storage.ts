interface Storage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

/** One process-wide owner serializes writes and compare/delete across account instances.
 * A retiring browser transaction may only remove the exact record it created.
 */
export function createNativeLoginStorage(storage: Storage) {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    read: () => run(() => storage.read()),
    write: (value: string) => run(() => storage.write(value)),
    remove: (expected: string) => run(async () => {
      if (await storage.read() === expected) await storage.remove();
    }),
  };
}
