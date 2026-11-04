import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { BlobResourceService, ResourceStore } from "@opencraft/blob-resources";
const resource = { scope: "runtime/host/generation", path: "/image.png" };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("ready snapshots survive view subscriptions and share one preparation", async () => {
  let reads = 0, disposed = 0;
  const store = new ResourceStore(async () => { reads++; return { value: "image-url", sizeBytes: 3, dispose: () => disposed++ }; });
  assert.strictEqual(store.getSnapshot(resource), store.getSnapshot(resource));
  assert.equal(reads, 0, "reading a cold resource must not start IO");
  const first = store.subscribe(resource, () => {}), second = store.subscribe(resource, () => {});
  await tick(); const ready = store.getSnapshot(resource);
  assert.equal(ready.value, "image-url"); assert.equal(reads, 1);
  first(); second();
  assert.strictEqual(store.getSnapshot(resource), ready, "returning view has ready data before subscribing");
  const third = store.subscribe(resource, () => {}); await tick();
  assert.equal(reads, 1); assert.equal(disposed, 0);
  third(); store.close(); assert.equal(disposed, 1);
});

test("one reader leaving does not cancel peers; final cancellation disposes late results", async () => {
  let signal!: AbortSignal, finish!: (value: any) => void, disposed = 0;
  const store = new ResourceStore((_, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); });
  const a = store.subscribe(resource, () => {}), b = store.subscribe(resource, () => {});
  await tick(); a(); assert.equal(signal.aborted, false); b(); assert.equal(signal.aborted, true);
  finish({ value: "old", sizeBytes: 1, dispose: () => disposed++ }); await tick();
  assert.equal(disposed, 1); assert.equal(store.getSnapshot(resource).status, "loading"); store.close();
});

test("idle expiry, LRU byte budget and authority changes do not reuse results", async () => {
  let disposed = 0;
  const store = new ResourceStore(async r => ({ value: r.scope + r.path, sizeBytes: 4, dispose: () => disposed++ }), { maxAgeMs: 30, memoryBytes: 4 });
  const a = store.subscribe(resource, () => {}); await tick(); a();
  const other = { ...resource, scope: "different-authority" };
  assert.equal(store.getSnapshot(other).status, "loading");
  const b = store.subscribe(other, () => {}); await tick();
  assert.equal(store.getSnapshot(resource).status, "loading", "idle resource evicted for budget");
  assert.equal(store.getSnapshot(other).status, "ready"); b();
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(store.getSnapshot(other).status, "loading"); assert.equal(disposed, 2); store.close();
});

test("invalidation replaces active results and rejects old async generations", async () => {
  const finishes: ((value: any) => void)[] = []; let disposed = 0;
  const store = new ResourceStore(() => new Promise(resolve => finishes.push(resolve)));
  const off = store.subscribe(resource, () => {}); await tick();
  store.invalidate(resource); await tick();
  finishes[0]({ value: "old", sizeBytes: 1, dispose: () => disposed++ }); await tick();
  assert.equal(store.getSnapshot(resource).status, "loading");
  finishes[1]({ value: "new", sizeBytes: 1, dispose: () => disposed++ }); await tick();
  assert.equal(store.getSnapshot(resource).value, "new"); assert.equal(disposed, 1);
  off(); store.close(); assert.equal(disposed, 2);
});

test("application disposal and file invalidation reach prepared resources", async () => {
  const ctx = new Context(), fiber = ctx.plugin(BlobResourceService); await fiber;
  let reads = 0, disposed = 0;
  const store = ctx.blobResources.createResourceStore(async () => ({ value: ++reads, sizeBytes: 1, dispose: () => disposed++ }));
  const off = store.subscribe(resource, () => {}); await tick();
  await ctx.blobResources.invalidate(resource); await tick();
  assert.equal(store.getSnapshot(resource).value, 2); assert.equal(disposed, 1);
  await fiber.dispose(); assert.equal(disposed, 2); assert.equal(store.getSnapshot(resource).status, "unavailable"); off();
});

test("a failed resource can be retried by a later view without an automatic loop", async () => {
  let reads = 0;
  const store = new ResourceStore(async () => { if (++reads === 1) throw new Error("offline"); return { value: "ok", sizeBytes: 1 }; });
  const a = store.subscribe(resource, () => {}); await tick();
  assert.equal(store.getSnapshot(resource).status, "unavailable"); assert.equal(reads, 1); a();
  const b = store.subscribe(resource, () => {}); await tick(); assert.equal(store.getSnapshot(resource).value, "ok"); b(); store.close();
});

test("prepared results do not extend an underlying cache expiry", async () => {
  const expiresAt = Date.now() + 30;
  let disposed = 0;
  const store = new ResourceStore(async () => ({ value: "cached", sizeBytes: 1, expiresAt, dispose: () => disposed++ }), { maxAgeMs: 60_000 });
  const off = store.subscribe(resource, () => {}); await tick(); off();
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(store.getSnapshot(resource).status, "loading"); assert.equal(disposed, 1); store.close();
});

test("refresh keeps successful data while fetching and after failure, then replaces it atomically", async () => {
  const finishes: { resolve(value: any): void; reject(error: unknown): void }[] = [];
  let disposed = 0;
  const store = new ResourceStore<string>(() => new Promise((resolve, reject) => finishes.push({ resolve, reject })));
  const off = store.subscribe(resource, () => {}); await tick();
  finishes[0].resolve({ value: "old", sizeBytes: 1, dispose: () => {
    assert.equal(store.getSnapshot(resource).value, "new", "publish replacement before releasing old value"); disposed++;
  } }); await tick();
  store.refresh(resource); await tick();
  assert.equal(store.getSnapshot(resource).value, "old"); assert.equal(store.getSnapshot(resource).isFetching, true);
  const error = new Error("refresh offline"); finishes[1].reject(error); await tick();
  assert.equal(store.getSnapshot(resource).status, "ready"); assert.equal(store.getSnapshot(resource).error, error);
  assert.equal(store.getSnapshot(resource).isFetching, false); assert.equal(disposed, 0);
  store.refresh(resource); await tick(); finishes[2].resolve({ value: "new", sizeBytes: 1 }); await tick();
  assert.equal(store.getSnapshot(resource).value, "new"); assert.equal(store.getSnapshot(resource).error, null);
  assert.equal(disposed, 1); off(); store.close();
});

test("last reader cancels a refresh and late results cannot overwrite the retained value", async () => {
  let signal!: AbortSignal, resolve!: (value: any) => void, calls = 0, lateDisposed = 0;
  const store = new ResourceStore<string>((_, s) => {
    calls++;
    if (calls === 1) return Promise.resolve({ value: "old", sizeBytes: 1 });
    signal = s; return new Promise(r => { resolve = r; });
  });
  const off = store.subscribe(resource, () => {}); await tick(); store.refresh(resource); await tick();
  off(); assert.equal(signal.aborted, true);
  assert.equal(store.getSnapshot(resource).value, "old"); assert.equal(store.getSnapshot(resource).isFetching, false);
  resolve({ value: "late", sizeBytes: 1, dispose: () => lateDisposed++ }); await tick();
  assert.equal(lateDisposed, 1); assert.equal(store.getSnapshot(resource).value, "old"); store.close();
});

test("explicit invalidation still removes old data during a refresh", async () => {
  let calls = 0, disposed = 0;
  const store = new ResourceStore<string>(async () => {
    if (++calls === 1) return { value: "old", sizeBytes: 1, dispose: () => disposed++ };
    return new Promise(() => {});
  });
  const off = store.subscribe(resource, () => {}); await tick(); store.refresh(resource); await tick();
  store.invalidate(resource);
  assert.equal(store.getSnapshot(resource).value, null); assert.equal(store.getSnapshot(resource).status, "loading");
  assert.equal(disposed, 1); off(); store.close();
});
