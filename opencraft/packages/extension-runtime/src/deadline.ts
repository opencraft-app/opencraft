export class ExtensionDeadlineError extends Error {
  readonly code = "OPENCRAFT_EXTENSION_TIMEOUT";

  constructor(readonly phase: string, readonly timeoutMs: number) {
    super(`Extension ${phase} exceeded ${timeoutMs} ms`);
    this.name = "ExtensionDeadlineError";
  }
}

export function withExtensionDeadline<T>(work: PromiseLike<T>, phase: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExtensionDeadlineError(phase, timeoutMs)), timeoutMs);
    Promise.resolve(work).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export function extensionTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError("Extension timeout must be positive and finite");
  return timeout;
}
