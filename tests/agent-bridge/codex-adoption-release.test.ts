import assert from "node:assert/strict";
import test from "node:test";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";

test("the local Codex Host releases only an idle Thread for adoption, and stops observing it", async () => {
  const calls: unknown[] = [];
  const adapter: any = Object.create(CodexEngineAdapter.prototype);
  Object.assign(adapter, {
    closeOperation: null,
    nativeSubscribedThreads: new Set(["idle", "busy"]),
    withThreadOperation: (_id: string, work: () => Promise<unknown>) => work(),
    // The Host's own hold on a Thread: turns, queue, goals, retries, recovery, titles, schedules,
    // approvals and admissions in flight.
    threadHeldForAdoption: (id: string) => id === "busy" || id === "recovering",
    requestPhysical: async (method: string, params: unknown) => {
      calls.push([method, params]);
      return {};
    },
  });
  assert.equal(await adapter.releaseForAdoption("busy"), false);
  assert.equal(await adapter.releaseForAdoption("recovering"), false);
  assert.deepEqual(calls, [], "a declined Thread is left exactly as it was");
  assert.equal(await adapter.releaseForAdoption("idle"), true);
  assert.deepEqual(calls, [["thread/unsubscribe", { threadId: "idle" }]]);
  assert.equal(adapter.nativeSubscribedThreads.has("idle"), false);
  assert.equal(await adapter.releaseForAdoption("never-loaded"), true, "an unloaded Thread needs no unsubscribe");
  assert.equal(calls.length, 1);
  adapter.closeOperation = Promise.resolve();
  assert.equal(await adapter.releaseForAdoption("idle"), false, "a closing Host releases nothing");
  adapter.closeOperation = null;
  adapter.coreBridge = {};
  assert.equal(
    await adapter.releaseForAdoption("never-loaded"),
    false,
    "a pass-through to Core cannot vouch for idleness",
  );
});
