import { StateAsyncChangeError, StateDocumentCorruptError, type StateDocumentStore } from "./state.js";

/**
 * Runtime-neutral cases every StateDocumentStore adapter must pass. The caller
 * supplies a fresh, empty store per case; `corrupt` (when the adapter can
 * hold non-JSON bytes) stores unparsable content under a key.
 */
export interface StateDocumentConformanceCase {
  readonly name: string;
  run(store: StateDocumentStore, corrupt?: (key: string) => Promise<void>): Promise<void>;
}

class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateDocumentConformanceFailure";
  }
}
const equal = (actual: unknown, expected: unknown, what: string) => {
  const a = JSON.stringify(actual),
    e = JSON.stringify(expected);
  if (a !== e) throw new ConformanceFailure(`${what}: expected ${e}, received ${a}`);
};
async function rejects(action: () => Promise<unknown>, what: string, check: (error: unknown) => boolean) {
  try {
    await action();
  } catch (error) {
    if (!check(error)) throw new ConformanceFailure(`${what}: unexpected error ${String(error)}`);
    return;
  }
  throw new ConformanceFailure(`${what}: expected a rejection`);
}
class Marker extends Error {}

export const STATE_DOCUMENT_CONFORMANCE_CASES: readonly StateDocumentConformanceCase[] = [
  {
    name: "an unwritten document reads as null and is created by update",
    async run(store) {
      equal(await store.read("a.json"), null, "missing");
      const result = await store.update("a.json", (current) => ({
        result: current,
        next: { revision: 1, items: ["x"] },
      }));
      equal(result, null, "change saw no document");
      equal(await store.read("a.json"), { revision: 1, items: ["x"] }, "created");
    },
  },
  {
    name: "a change without next leaves the document untouched",
    async run(store) {
      await store.update("a.json", () => ({ result: 0, next: { v: 1 } }));
      equal(await store.update("a.json", (current) => ({ result: (current as { v: number }).v })), 1, "result");
      equal(await store.read("a.json"), { v: 1 }, "unchanged");
    },
  },
  {
    name: "a throwing change aborts without a write and rethrows",
    async run(store) {
      await store.update("a.json", () => ({ result: 0, next: { v: 1 } }));
      await rejects(
        () =>
          store.update("a.json", () => {
            throw new Marker("stop");
          }),
        "throwing change",
        (error) => error instanceof Marker,
      );
      equal(await store.read("a.json"), { v: 1 }, "retained");
    },
  },
  {
    name: "an asynchronous change is rejected without a write",
    async run(store) {
      await rejects(
        () => store.update("a.json", (() => Promise.resolve({ result: 0, next: { v: 2 } })) as never),
        "async change",
        (error) => error instanceof StateAsyncChangeError,
      );
      equal(await store.read("a.json"), null, "not written");
    },
  },
  {
    name: "concurrent updates to one key are serialized",
    async run(store) {
      await Promise.all(
        Array.from({ length: 16 }, () =>
          store.update("n.json", (current) => {
            const n = ((current as { n?: number } | null)?.n ?? 0) + 1;
            return { result: n, next: { n } };
          }),
        ),
      );
      equal(await store.read("n.json"), { n: 16 }, "count");
    },
  },
  {
    name: "keys are independent and path-like keys are rejected",
    async run(store) {
      await store.update("a.json", () => ({ result: 0, next: { a: true } }));
      await store.update("b.json", () => ({ result: 0, next: { b: true } }));
      equal([await store.read("a.json"), await store.read("b.json")], [{ a: true }, { b: true }], "independent");
      for (const key of ["../x", "a/b", "", ".hidden", "a..b"])
        await rejects(
          () => store.read(key),
          `key ${JSON.stringify(key)}`,
          (error) => error instanceof TypeError,
        );
    },
  },
  {
    name: "null and non-JSON replacements are rejected",
    async run(store) {
      await rejects(
        () => store.update("a.json", () => ({ result: 0, next: null })),
        "null",
        (error) => error instanceof TypeError,
      );
      await rejects(
        () => store.update("a.json", () => ({ result: 0, next: undefined })),
        "undefined",
        (error) => error instanceof TypeError,
      );
      equal(await store.read("a.json"), null, "not written");
    },
  },
  {
    name: "a corrupt document fails reads and updates and is retained",
    async run(store, corrupt) {
      if (!corrupt) return;
      await corrupt("c.json");
      await rejects(
        () => store.read("c.json"),
        "read",
        (error) => error instanceof StateDocumentCorruptError,
      );
      await rejects(
        () => store.update("c.json", () => ({ result: 0, next: { v: 1 } })),
        "update",
        (error) => error instanceof StateDocumentCorruptError,
      );
      await rejects(
        () => store.read("c.json"),
        "still corrupt",
        (error) => error instanceof StateDocumentCorruptError,
      );
    },
  },
];
