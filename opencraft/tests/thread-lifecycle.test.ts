import assert from "node:assert/strict";
import test from "node:test";
import { ThreadCatalog } from "../apps/local-agent-host/src/thread-catalog.js";
import { ThreadLifecycle } from "../apps/local-agent-host/src/thread-lifecycle.js";
test("thread names survive stale engine summaries and publish only after persistence", async () => {
  const catalog = new ThreadCatalog(); const events: string[] = [];
  const service = new ThreadLifecycle(catalog, async () => ({ released: true }), (method) => events.push(method));
  const delegate = async () => ({ thread: { id: "thread", name: "Generated", turns: [] } });
  await service.dispatch("thread/name/set", { threadId: "thread", name: "User name" }, "client", delegate);
  assert.equal((await service.dispatch("thread/read", { threadId: "thread" }, "client", delegate)).thread.name, "User name");
  assert.deepEqual(events, ["thread/name/updated"]);
  await service.close();
});
test("archive/unarchive is persistent catalog state, not engine deletion or stale-list suppression alone", async () => {
  const catalog = new ThreadCatalog(); const service = new ThreadLifecycle(catalog, async () => ({ released: true }), () => {});
  const delegate = async (method: string) => method === "thread/list"
    ? { data: [{ id: "thread", name: "Generated", turns: [] }], nextCursor: null }
    : { thread: { id: "thread", name: "Generated", turns: [] } };
  await service.dispatch("thread/archive", { threadId: "thread" }, "client", delegate);
  assert.equal((await service.dispatch("thread/list", {}, "client", delegate)).data.length, 0);
  assert.equal((await service.dispatch("thread/list", { archived: true }, "client", delegate)).data.length, 1);
  assert.equal((await service.dispatch("thread/unarchive", { threadId: "thread" }, "client", delegate)).thread.id, "thread");
  await service.close();
});
test("a temporary thread is released only after its final logical subscriber leaves", async () => {
  const catalog = new ThreadCatalog(); let releases = 0;
  const service = new ThreadLifecycle(catalog, async () => { releases++; return { released: true }; }, () => {});
  const delegate = async () => ({ thread: { id: "child", name: "Temporary", turns: [], ephemeral: true } });
  await service.dispatch("thread/fork", { threadId: "parent", ephemeral: true }, "a", delegate);
  await service.dispatch("thread/resume", { threadId: "child" }, "b", delegate);
  assert.equal((await service.dispatch("thread/unsubscribe", { threadId: "child" }, "a", delegate)).status, "unsubscribed");
  assert.equal(releases, 0);
  await service.dispatch("thread/unsubscribe", { threadId: "child" }, "b", delegate);
  assert.equal(releases, 1); assert.equal(catalog.get("child"), null);
  assert.equal((await service.dispatch("thread/unsubscribe", { threadId: "child" }, "a", delegate)).status, "notLoaded");
  await service.close();
});
test("grace-period unload serializes against a new attachment", async () => {
  const catalog = new ThreadCatalog(); let finish!: () => void, releaseStarted!: () => void;
  const started = new Promise<void>(resolve => { releaseStarted = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const service = new ThreadLifecycle(catalog, async () => { releaseStarted(); await release; return { released: true }; }, () => {}, 1);
  let resumed = 0;
  const delegate = async () => { resumed++; return { thread: { id: "thread", turns: [] } }; };
  await service.dispatch("thread/resume", { threadId: "thread" }, "a", delegate);
  await service.dispatch("thread/unsubscribe", { threadId: "thread" }, "a", delegate);
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("unload did not start")), 1000))]);
  const attaching = service.dispatch("thread/resume", { threadId: "thread" }, "b", delegate);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(resumed, 1);
  finish(); await attaching; assert.equal(service.attachments.has("b", "thread"), true);
  await service.close();
});
test("closed temporary thread metadata cannot resurrect from a stale engine summary", async () => {
  const catalog = new ThreadCatalog(), service = new ThreadLifecycle(catalog, async () => ({ released: true }), () => {});
  const delegate = async () => ({ thread: { id: "child", name: "Temporary", turns: [], ephemeral: true } });
  await service.dispatch("thread/fork", { threadId: "parent", ephemeral: true }, "a", delegate);
  await service.dispatch("thread/unsubscribe", { threadId: "child" }, "a", delegate);
  await assert.rejects(service.dispatch("thread/read", { threadId: "child" }, "a", delegate), /closed/);
  await service.close();
});
test("engine restart expires temporary threads instead of persisting/recovering them", async () => {
  const catalog = new ThreadCatalog(), service = new ThreadLifecycle(catalog, async () => ({ released: true }), () => {});
  const delegate = async () => ({ thread: { id: "child", name: "Temporary", turns: [], ephemeral: true } });
  await service.dispatch("thread/fork", { threadId: "parent", ephemeral: true }, "a", delegate);
  service.expireTemporaryThreads();
  assert.equal(catalog.get("child"), null); assert.equal(service.attachments.isLoaded("child"), false);
  await assert.rejects(service.dispatch("thread/resume", { threadId: "child" }, "a", delegate), /closed/);
  await service.close();
});
test("fork records effective model and roots from the engine reply, not only caller overrides", async () => {
  const catalog = new ThreadCatalog(), service = new ThreadLifecycle(catalog, async () => ({ released: true }), () => {});
  await service.dispatch("thread/fork", { threadId: "parent" }, "a", async () => ({ thread: { id: "child", turns: [] }, model: "route:model", cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace", "/shared"] }));
  assert.equal(catalog.configuration("child").model, "route:model");
  assert.deepEqual(catalog.configuration("child").runtimeWorkspaceRoots, ["/workspace", "/shared"]);
  await service.close();
});
test("resume replays the saved model binding before an empty engine session can report its private default", async () => {
  const catalog = new ThreadCatalog(), service = new ThreadLifecycle(catalog, async () => ({ released: true }), () => {});
  try {
    await service.dispatch("thread/start", {}, "a", async () => ({ thread: { id: "thread", turns: [] }, model: "product:model" }));
    await service.dispatch("thread/resume", { threadId: "thread" }, "a", async (_method, params) => {
      assert.equal(params.model, "product:model");
      return { thread: { id: "thread", turns: [] }, model: params.model };
    });
    assert.equal(catalog.configuration("thread").model, "product:model");
  } finally { await service.close(); }
});
test("disconnect cleanup serializes temporary release against a new resume", async () => {
  const catalog = new ThreadCatalog(); let finish!: () => void, releaseStarted!: () => void;
  const started = new Promise<void>(resolve => { releaseStarted = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const service = new ThreadLifecycle(catalog, async () => { releaseStarted(); await release; return { released: true }; }, () => {});
  let resumed = 0;
  const delegate = async () => { resumed++; return { thread: { id: "child", turns: [], ephemeral: true } }; };
  try {
    await service.dispatch("thread/fork", { threadId: "parent", ephemeral: true }, "a", delegate);
    const disconnecting = service.disconnect("a"); await started;
    const attaching = service.dispatch("thread/resume", { threadId: "child" }, "b", delegate);
    // Attach a rejection observer before allowing release to finish.
    const rejected = assert.rejects(attaching, /closed/);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(resumed, 1);
    finish(); await disconnecting; await rejected;
    assert.equal(service.attachments.has("b", "child"), false);
  } finally { finish(); await service.close(); }
});
test("disconnect retries an active temporary thread after release is deferred", async () => {
  const catalog = new ThreadCatalog(); let attempts = 0;
  const service = new ThreadLifecycle(catalog, async () => ({ released: ++attempts > 1 }), () => {}, 1);
  try {
    await service.dispatch("thread/fork", { threadId: "parent", ephemeral: true }, "a", async () => ({ thread: { id: "child", turns: [], ephemeral: true } }));
    await service.disconnect("a");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(attempts, 2); assert.equal(catalog.get("child"), null);
  } finally { await service.close(); }
});
