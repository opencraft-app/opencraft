import assert from "node:assert/strict";
import test from "node:test";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";
function fixture(source: Record<string, unknown>) {
  const writes: any[] = [], reads: any[] = [];
  const adapter: any = Object.create(CodexEngineAdapter.prototype);
  Object.assign(adapter, { environmentCreations: new Map(), options: { kind: "remote", transport: { async send(wire: string) { writes.push(JSON.parse(wire)); } } },
    async requestPhysical(method: string, params: unknown) { reads.push({ method, params }); return source; } });
  return { adapter, writes, reads };
}
test("Codex fork inherits execution choices without copying source tools or permissions", async () => {
  for (const ephemeral of [false, true]) {
    const f = fixture({ model: "chosen", modelProvider: "provider", reasoningEffort: "high", serviceTier: "priority", approvalPolicy: "never", config: { secret: "synthetic" } });
    await f.adapter.writePhysical({ id: "fork", method: "thread/fork", params: { threadId: "parent", ephemeral, lastTurnId: "turn" } });
    assert.deepEqual(f.reads, [{ method: "thread/resume", params: { threadId: "parent", excludeTurns: true } }]);
    assert.deepEqual(f.writes[0].params, { threadId: "parent", ephemeral, lastTurnId: "turn", model: "chosen", modelProvider: "provider", serviceTier: "priority", config: { model_reasoning_effort: "high" } });
  }
});
test("fork overrides including null win; unrelated config is retained", async () => {
  const f = fixture({ model: "parent", modelProvider: "provider", reasoningEffort: "high", serviceTier: "priority" });
  const params = { threadId: "parent", model: "child", modelProvider: null, serviceTier: null, config: { model_reasoning_effort: "low", other: true } };
  await f.adapter.writePhysical({ id: "fork", method: "thread/fork", params }); assert.deepEqual(f.writes[0].params, params);
});
test("path forks do not inherit from an ignored threadId", async () => {
  const f = fixture({ model: "wrong-parent" }); const params = { threadId: "ignored", path: "/fixture/rollout" };
  await f.adapter.writePhysical({ id: "fork", method: "thread/fork", params }); assert.equal(f.reads.length, 0); assert.deepEqual(f.writes[0].params, params);
});
test("failed source snapshot cannot create a fork with silently reset choices", async () => {
  const f = fixture({}); f.adapter.requestPhysical = async () => { throw Error("unavailable"); };
  await assert.rejects(f.adapter.writePhysical({ id: "fork", method: "thread/fork", params: { threadId: "parent" } }), /unavailable/); assert.equal(f.writes.length, 0);
});
