import assert from "node:assert/strict";
import test from "node:test";
import { SubmissionNotDispatchedError } from "@opencraft/chat-runtime";
import { createConversationKey } from "@opencraft/chat-core";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { createHarness, intent, waitForAuthoritative, waitForRequest } from "../fixtures/workbench-draft-harness";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(reentry?: "queued" | "started") {
  const turns = [{ id: "current-turn", status: "completed", itemsView: "full", items: [{ id: "current-item", type: "agentMessage", text: "current native history" }], error: null }];
  const h = createHarness(false, false, turns);
  let runtime!: ReturnType<typeof createAppServerWorkbenchRuntime>, armed = false, reentered = false;
  runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: h.transport, autoReconnect: false, requestTimeoutMs: 60_000,
    installClientHandlers: client => client.subscribeRequestLifecycle(event => {
      if (armed && event.method === "turn/start" && event.type === reentry) {
        armed = false; reentered = true; h.holdThreadReads(); void runtime.reconnect().catch(() => undefined);
      }
    }),
  });
  try {
    await runtime.connect(); const a = await runtime.acquireThread("thread-live"); a.setRecoveryVisibility(true); await waitForAuthoritative(a);
    const user = { ...intent({ type: "new-thread", draftId: "unused", execution: { hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } }),
      target: { type: "existing-thread" as const, key: createConversationKey("local", "thread-live") } };
    return { h, runtime, a, user, arm: () => { armed = true; }, reentered: () => reentered, count: (method: string) => h.requests.filter(request => request.method === method).length,
      async close() { h.releaseResume(); h.releaseThreadReads(); await runtime.dispose(); } };
  } catch (error) { await runtime.dispose(); throw error; }
}
async function until(check: () => boolean) { for (let i = 0; i < 40 && !check(); i++) await flush(); assert.equal(check(), true); }
function submit(f: Awaited<ReturnType<typeof fixture>>) { return f.a.submit(f.user).then(receipt => ({ receipt }), error => ({ error })); }
for (const releaseView of [false, true]) test(`read recovery precedes held user activation ACK${releaseView ? " after its View leaves" : ""}`, { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    const generation = f.runtime.getSnapshot().connectionGeneration, reads = f.count("thread/read");
    f.h.holdExecutionResume(); const pending = submit(f); await waitForRequest(f.h, "thread/resume");
    const params = f.h.requests.find(request => request.method === "thread/resume")!.params as Record<string, unknown>;
    assert.equal(params.excludeTurns, true); assert.equal(params.initialTurnsPage, undefined); assert.equal(params.historyPreviewToken, undefined);
    if (releaseView) { f.a.release(); assert.equal(f.runtime.getThreadResidency("thread-live")?.pendingCommandCount, 1); }
    await f.runtime.reconnect(); await until(() => f.count("thread/read") === reads + 1 && f.a.getSnapshot().authoritative);
    assert.equal(f.runtime.getSnapshot().phase, "ready"); assert.equal(f.runtime.getSnapshot().connectionGeneration, generation);
    assert.equal(f.count("initialize"), 1); assert.equal(f.count("turn/start"), 0);
    assert.match(JSON.stringify(f.a.getSnapshot()), /current native history/);
    f.h.releaseResume(); const outcome = await pending; assert.ok("receipt" in outcome, JSON.stringify(outcome));
    assert.equal(outcome.receipt.clientMessageId, f.user.clientMessageId); assert.equal(f.count("turn/start"), 1); assert.equal(f.count("thread/resume"), 1);
    assert.match(JSON.stringify(f.a.getSnapshot()), /current native history/); f.a.release();
  } finally { await f.close(); }
});
for (const reconnectAgain of [false, true]) test(`activation ACK cannot dispatch before the current read${reconnectAgain ? " across another logical loss" : ""}`, { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    f.h.holdExecutionResume(); const pending = submit(f); await waitForRequest(f.h, "thread/resume");
    const reads = f.count("thread/read"); f.h.holdThreadReads(); await f.runtime.reconnect(); await until(() => f.count("thread/read") === reads + 1);
    f.h.releaseResume(); for (let i = 0; i < 10; i++) await flush();
    assert.equal(f.count("turn/start"), 0, "a successful activation is not current history authority");
    assert.equal(f.a.getSnapshot().authoritative, false);
    if (reconnectAgain) { await f.runtime.reconnect(); await until(() => f.count("thread/read") === reads + 2); assert.equal(f.count("turn/start"), 0); }
    f.h.releaseThreadReads(); const outcome = await pending; assert.ok("receipt" in outcome, JSON.stringify(outcome));
    assert.equal(f.a.getSnapshot().authoritative, true); assert.equal(f.count("turn/start"), 1); assert.equal(f.count("thread/resume"), 1); f.a.release();
  } finally { await f.close(); }
});


for (const stage of ["queued", "started"] as const) test(`a synchronous ${stage} observer cannot dispatch through a revoked baseline`, { timeout: 5000 }, async () => {
  const f = await fixture(stage);
  try {
    f.arm(); const pending = submit(f); await until(f.reentered);
    for (let i = 0; i < 8; i++) await flush();
    assert.equal(f.count("turn/start"), 0, "no frame may be sent after the admission observer revokes current authority");
    const outcome = await pending; assert.ok("error" in outcome && outcome.error instanceof SubmissionNotDispatchedError);
    assert.match(JSON.stringify(f.a.getSnapshot()), /Build it/, "the unsent user input remains available");
    f.h.releaseThreadReads(); await until(() => f.a.getSnapshot().authoritative);
    const retried = await submit(f); assert.ok("receipt" in retried, JSON.stringify(retried));
    assert.equal(f.count("turn/start"), 1); assert.equal(retried.receipt.clientMessageId, f.user.clientMessageId); f.a.release();
  } finally { await f.close(); }
});
