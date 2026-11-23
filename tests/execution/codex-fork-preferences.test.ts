import assert from "node:assert/strict";
import test from "node:test";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";
import { ExecutionEnvironmentSnapshot } from "@opencraft/execution-environment";
function fixture(source: Record<string, unknown>) {
  const writes: any[] = [], reads: any[] = [];
  const adapter: any = Object.create(CodexEngineAdapter.prototype);
  Object.assign(adapter, { environmentCreations: new Map(), environmentLaunchCreations: new Map(), sessionMcpCreations: new Map(), options: { kind: "remote", transport: { async send(wire: string) { writes.push(JSON.parse(wire)); } } },
    executionBlocked() { return false; },
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
test("fork replaces the source environment with its own creator snapshot, including an empty snapshot", async () => {
  for (const values of [{ SERVICE_KEY: 'synthetic-copy-owner' }, {}]) {
    const f = fixture({ model: 'parent', config: { 'shell_environment_policy.set': { SERVICE_KEY: 'synthetic-parent' } } });
    f.adapter.environmentCreations.set('fork', new ExecutionEnvironmentSnapshot({ account: 'employee:bob', hostId: 'local-codex', threadId: null, projectId: null }, values));
    await f.adapter.writePhysical({ id: 'fork', method: 'thread/fork', params: { threadId: 'parent', config: { 'shell_environment_policy.set': { SERVICE_KEY: 'synthetic-forged' } } } });
    assert.deepEqual(f.writes[0].params.config['shell_environment_policy.set'], values);
    assert.equal(JSON.stringify(f.writes).includes('synthetic-parent'), false);
    assert.equal(JSON.stringify(f.writes).includes('synthetic-forged'), false);
  }
});

test("fork metadata resume retains its trusted original request context", async () => {
 const f=fixture({model:"parent"}),context={sender:null,actorContext:{actorId:"human://fixture"}};
 f.adapter.pending=new Map([["fork",{nativeAdmission:{context:()=>context}}]]);f.adapter.internalRequests=new Map();
 f.adapter.requestPhysical=async (...args:unknown[])=>{assert.strictEqual(args[6],context);return {model:"parent"};};
 await f.adapter.writePhysical({id:"fork",method:"thread/fork",params:{threadId:"parent",workspaceFork:{kind:"side-chat",intentId:"intent"}}});
 assert.equal(Object.hasOwn(f.writes[0].params,"workspaceFork"),false);
});
