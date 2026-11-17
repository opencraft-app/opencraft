import assert from "node:assert/strict";
import test from "node:test";
import { readSettingsAgentDirectory, readSettingsAgentModels } from "../../apps/workbench-web/src/runtime/settings-agent-directory";

test("remote Agent discovery is metadata-only and does not wait for a model catalog", async () => {
  const calls: string[] = [];
  const result = await readSettingsAgentDirectory({ ensureReady: async id => { assert.equal(id, "remote"); return {} as never; },
    request: (async (id, method) => { assert.equal(id, "remote"); calls.push(method); return { agents: [{ id: "codex", installed: true }] }; }) as never }, "remote", new AbortController().signal);
  assert.deepEqual(calls, ["opencraft/agents/onboarding/history-agents"]);
  assert.equal(result.native?.agents[0]?.id, "codex");
});

test("a cancelled Host selection never starts its directory read", async () => {
  const abort = new AbortController(); let reads = 0;
  await assert.rejects(readSettingsAgentDirectory({ ensureReady: async () => { abort.abort(); return {} as never; }, request: (async () => { reads++; }) as never }, "old", abort.signal));
  assert.equal(reads, 0);
});

test("only an unsupported metadata method admits the older status reader", async () => {
  const calls: string[] = [];
  const access = { ensureReady: async () => ({} as never), request: (async (_host: string, method: string) => { calls.push(method); if (method.endsWith("history-agents")) throw Object.assign(new Error("unsupported"), { code: -32601 }); return { agents: [] }; }) as never };
  await readSettingsAgentDirectory(access, "old", new AbortController().signal);
  assert.deepEqual(calls, ["opencraft/agents/onboarding/history-agents", "opencraft/agents/onboarding/status"]);
  access.request = (async () => { throw new Error("offline"); }) as never;
  await assert.rejects(readSettingsAgentDirectory(access, "old", new AbortController().signal), /offline/);
});

test("the model directory remains Host scoped and rejects repeated page cursors", async () => {
  const calls: unknown[] = [];
  const access = { ensureReady: async () => ({} as never), request: (async (host: string, _method: string, params: unknown) => { calls.push([host, params]); return { data: [], nextCursor: "again" }; }) as never };
  await assert.rejects(readSettingsAgentModels(access, "remote", new AbortController().signal), /Repeated/);
  assert.equal(calls.length, 2); assert.equal((calls[0] as unknown[])[0], "remote");
});


test("older DSH envelopes admit only the exact unsupported-directory fallback", async () => {
  const calls: string[] = [];
  const access = { ensureReady: async () => ({} as never), request: (async (_host: string, method: string) => {
    calls.push(method);
    if (method.endsWith("history-agents")) throw Object.assign(new Error("Method not supported by OpenCraft DSH host: opencraft/agents/onboarding/history-agents"), { code: -32603 });
    return { agents: [] };
  }) as never };
  await readSettingsAgentDirectory(access, "old", new AbortController().signal);
  assert.equal(calls.length, 2);
  access.request = (async () => { throw Object.assign(new Error("database unavailable"), { code: -32603 }); }) as never;
  await assert.rejects(readSettingsAgentDirectory(access, "old", new AbortController().signal), /database/);
});
