import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { IDBFactory } from "fake-indexeddb";
import { BlobResourceService, type BlobResourceConfig } from "@opencraft/blob-resources";
import { IndexedDbBlobStorage, BlobUrlManager } from "@opencraft/blob-resources/browser";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup(config: BlobResourceConfig = {}) {
  const ctx = new Context(); const fiber = ctx.plugin(BlobResourceService, config); await fiber;
  return { service: ctx.blobResources, close: () => fiber.dispose() };
}
const resource = (path: string, scope = "account/host", version?: string) => ({ path, scope, version });

test("Cordis service coalesces readers and isolates individual cancellation", async () => {
  const { service, close } = await setup();
  let calls = 0; let finish!: (blob: Blob) => void; let signal!: AbortSignal;
  const loader = async (_: unknown, abort: AbortSignal) => { calls++; signal = abort; return new Promise<Blob>(resolve => { finish = resolve; }); };
  const a = service.acquire(resource("a"), loader); const b = service.acquire(resource("a"), loader);
  await tick(); a.release(); await assert.rejects(a.promise, { name: "AbortError" });
  assert.equal(signal.aborted, false); assert.equal(calls, 1);
  finish(new Blob(["data"])); assert.equal(await (await b.promise).text(), "data");
  b.release(); await close();
});

test("bounded scheduler prioritizes queued work, cancels the last reader, and bypasses IO for memory hits", async () => {
  const { service, close } = await setup({ concurrency: 1 });
  const cached = service.acquire(resource("cached"), async () => new Blob(["cached"])); await cached.promise; cached.release();
  let aborted = false;
  const first = service.acquire(resource("first"), (_, signal) => new Promise<Blob>((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); });
  }));
  await tick();
  const order: string[] = [];
  const low = service.acquire(resource("low"), async () => { order.push("low"); return new Blob(); });
  const high = service.acquire(resource("high"), async () => { order.push("high"); return new Blob(); }, { priority: 2 });
  const hit = service.acquire(resource("cached"), async () => { throw new Error("must hit cache"); });
  assert.equal(await (await hit.promise).text(), "cached"); hit.release();
  first.release(); await assert.rejects(first.promise); await Promise.all([high.promise, low.promise]);
  assert.equal(aborted, true); assert.deepEqual(order, ["high", "low"]);
  high.release(); low.release(); await close();
});

test("scope/version isolation, invalidation, expiry and memory eviction", async () => {
  const { service, close } = await setup({ memoryBytes: 4 });
  let calls = 0;
  const read = async (path: string, scope = "account/host", version?: string, maxAgeMs = 10_000) => {
    const lease = service.acquire(resource(path, scope, version), async () => { calls++; return new Blob(["1234"]); }, { maxAgeMs });
    await lease.promise; lease.release();
  };
  await read("a"); await read("a"); assert.equal(calls, 1);
  await read("a", "other"); await read("a", "other", "v2"); assert.equal(calls, 3);
  await read("a"); assert.equal(calls, 4);
  await service.invalidate(resource("a")); await read("a", undefined, undefined, 0); await read("a");
  assert.equal(calls, 6); await close();
});

test("IndexedDB stores Blob separately from LRU metadata and survives recreation", async () => {
  const factory = new IDBFactory();
  const store = new IndexedDbBlobStorage("test", 5, 2, factory);
  const entry = (key: string, text: string, accessedAt: number) => ({ key, blob: new Blob([text]), accessedAt, expiresAt: Date.now() + 10_000 });
  await store.put(entry("a", "aaa", 1)); await store.put(entry("b", "bb", 2));
  assert.equal(await (await store.get("a"))?.blob.text(), "aaa");
  await store.put(entry("c", "cc", Date.now() + 1));
  assert.equal(await store.get("b"), undefined);
  store.close();
  const reopened = new IndexedDbBlobStorage("test", 5, 2, factory);
  assert.equal(await (await reopened.get("a"))?.blob.text(), "aaa");
  await reopened.delete("a"); assert.equal(await reopened.get("a"), undefined); reopened.close();
});

test("quota/read errors degrade to fresh content and URLs live until the last release", async () => {
  const { service, close } = await setup({ storage: {
    async get() { throw new Error("unavailable"); }, async put() { throw new Error("quota"); }, async delete() {}, close() {},
  } });
  const lease = service.acquire(resource("a"), async () => new Blob(["image"]), { persistent: true });
  const blob = await lease.promise;
  const urls = new BlobUrlManager(); const a = urls.acquire(blob); const b = urls.acquire(blob);
  assert.equal(a.source, b.source); a.release();
  assert.equal(await (await fetch(b.source)).text(), "image");
  b.release(); b.release(); await assert.rejects(fetch(b.source));
  lease.release(); await close();
  assert.throws(() => service.acquire(resource("a"), async () => blob), /disposed/);
});
