/**
 * Keyed JSON state documents with atomic read-modify-write.
 * Runtime-neutral; see docs/architecture/platform/storage-ports.md.
 *
 * Business revisions, schema versions and validation stay inside the document
 * and its owning repository. This port only guarantees that one `update`
 * observes the latest committed document and that its replacement is atomic
 * and durable before the returned promise resolves.
 */

/** A change either leaves the document untouched or replaces it with `next`. */
export type StateChange<T> = { readonly result: T } | { readonly result: T; readonly next: unknown };

export interface StateDocumentStore {
  /** The committed document, or null when it has never been written. */
  read(key: string): Promise<unknown | null>;
  /**
   * Runs `change` against the latest committed document and commits `next`
   * atomically. `change` must be synchronous; throwing aborts without a write.
   * Updates to one key are serialized, including across processes for adapters
   * that share storage between processes.
   */
  update<T>(key: string, change: (current: unknown | null) => StateChange<T>): Promise<T>;
}

export class StateDocumentCorruptError extends Error {
  constructor(readonly key: string) {
    super(`State document ${key} is not valid JSON; the original was retained`);
    this.name = "StateDocumentCorruptError";
  }
}

export class StateAsyncChangeError extends Error {
  constructor() {
    super("State document changes must be synchronous");
    this.name = "StateAsyncChangeError";
  }
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export function validateStateKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !KEY.test(key) || key.includes(".."))
    throw new TypeError("Invalid state document key");
}

/** Applies a change result; returns the serialized next document or undefined when unchanged. */
export function stateChangeOutcome<T>(change: StateChange<T>): { result: T; json?: string } {
  if (change !== null && typeof change === "object" && typeof (change as { then?: unknown }).then === "function") {
    throw new StateAsyncChangeError();
  }
  if (!("next" in change)) return { result: change.result };
  if (change.next === null || change.next === undefined)
    throw new TypeError("State documents cannot be written as null");
  const json = JSON.stringify(change.next);
  if (json === undefined) throw new TypeError("State documents must be JSON");
  return { result: change.result, json };
}

/** In-process adapter: tests and runtimes without durable storage for a key space. */
export function memoryStateDocumentStore(): StateDocumentStore {
  const documents = new Map<string, string>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async read(key) {
      validateStateKey(key);
      const json = documents.get(key);
      return json === undefined ? null : JSON.parse(json);
    },
    update(key, change) {
      validateStateKey(key);
      const run = tail.then(() => {
        const json = documents.get(key);
        const outcome = stateChangeOutcome(change(json === undefined ? null : JSON.parse(json)));
        if (outcome.json !== undefined) documents.set(key, outcome.json);
        return outcome.result;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
