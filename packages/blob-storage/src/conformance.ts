import { BlobDigestError, BlobExistsError, BlobLimitError, type BlobStore } from "./contract.js";

/** Runtime-neutral cases; the caller supplies a fresh, empty store per case. */
export interface BlobConformanceCase {
  readonly name: string;
  run(store: BlobStore): Promise<void>;
}
class ConformanceFailure extends Error {
  constructor(message: string) { super(message); this.name = "BlobConformanceFailure"; }
}
const equal = (actual: unknown, expected: unknown, what: string) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new ConformanceFailure(`${what}: expected ${e}, received ${a}`);
};
async function rejects(action: () => Promise<unknown>, what: string, check: (error: unknown) => boolean) {
  try { await action(); } catch (error) { if (check(error)) return; throw new ConformanceFailure(`${what}: unexpected ${String(error)}`); }
  throw new ConformanceFailure(`${what}: expected a rejection`);
}
const bytes = (text: string) => new TextEncoder().encode(text);
async function text(body: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}
const stream = (...parts: string[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(bytes(part)); controller.close(); } });
// SHA-256("hello world")
const HELLO = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

export const BLOB_CONFORMANCE_CASES: readonly BlobConformanceCase[] = [
  {
    name: "put stores bytes and reports size and digest; reads return the same bytes",
    async run(store) {
      equal(await store.head("a/one"), null, "absent");
      const info = await store.put("a/one", stream("hello", " ", "world"), { maxBytes: 64 });
      equal(info, { key: "a/one", size: 11, sha256: HELLO }, "info");
      equal(await store.head("a/one"), { key: "a/one", size: 11 }, "head");
      const object = (await store.get("a/one"))!;
      equal([object.size, await text(object.body)], [11, "hello world"], "get");
    },
  },
  {
    name: "ranges return the requested bytes and clamp at the end",
    async run(store) {
      await store.put("r", bytes("hello world"), { maxBytes: 64 });
      equal(await text((await store.get("r", { offset: 6 }))!.body), "world", "suffix");
      equal(await text((await store.get("r", { offset: 2, length: 3 }))!.body), "llo", "middle");
      equal(await text((await store.get("r", { offset: 20, length: 3 }))!.body), "", "past end");
    },
  },
  {
    name: "objects are immutable: a second put to the key is rejected",
    async run(store) {
      await store.put("k", bytes("one"), { maxBytes: 64 });
      await rejects(() => store.put("k", bytes("two"), { maxBytes: 64 }), "overwrite", (error) => error instanceof BlobExistsError);
      equal(await text((await store.get("k"))!.body), "one", "retained");
    },
  },
  {
    name: "size limits and digest mismatches store nothing",
    async run(store) {
      await rejects(() => store.put("big", bytes("0123456789"), { maxBytes: 9 }), "limit", (error) => error instanceof BlobLimitError);
      await rejects(() => store.put("bad", bytes("hello world"), { maxBytes: 64, sha256: "0".repeat(64) }), "digest", (error) => error instanceof BlobDigestError);
      equal([await store.head("big"), await store.head("bad")], [null, null], "nothing stored");
      equal(await store.put("ok", bytes("hello world"), { maxBytes: 11, sha256: HELLO }), { key: "ok", size: 11, sha256: HELLO }, "exact limit");
    },
  },
  {
    name: "uploads become visible only on complete; aborted uploads leave nothing",
    async run(store) {
      const upload = await store.upload("u", { maxBytes: 64 });
      await upload.write(bytes("hello "));
      equal(await store.head("u"), null, "invisible while staging");
      await upload.write(bytes("world"));
      equal(await upload.complete({ sha256: HELLO }), { key: "u", size: 11, sha256: HELLO }, "completed");
      equal(await text((await store.get("u"))!.body), "hello world", "visible");
      const abandoned = await store.upload("v", { maxBytes: 64 });
      await abandoned.write(bytes("x"));
      await abandoned.abort();
      equal(await store.head("v"), null, "aborted");
      const over = await store.upload("w", { maxBytes: 3 });
      await rejects(() => over.write(bytes("four")), "upload limit", (error) => error instanceof BlobLimitError);
      equal(await store.head("w"), null, "over limit");
    },
  },
  {
    name: "delete removes objects and is idempotent; unsafe keys are rejected",
    async run(store) {
      await store.put("d", bytes("x"), { maxBytes: 8 });
      await store.delete("d");
      await store.delete("d");
      equal(await store.get("d"), null, "deleted");
      for (const key of ["../x", "/abs", "a//b", ".staging/x", "a/../b", ""])
        await rejects(() => store.head(key), `key ${JSON.stringify(key)}`, (error) => error instanceof TypeError);
    },
  },
];
