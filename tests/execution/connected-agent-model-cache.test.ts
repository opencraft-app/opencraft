import test from "node:test";
import assert from "node:assert/strict";
import { ConnectedAgentHost } from "../../apps/local-agent-host/src/connected-agents.js";

function catalogFixture() {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let probes = 0, creates = 0;
  const forwarded: { method: string; params: any }[] = [];
  const onboarding = { async status() { probes++; await blocked; return { agents: [{ id: "cursor", authenticated: true }] }; } };
  const host = new ConnectedAgentHost(onboarding as never, "/unused", "/workspace", {} as never);
  for (const id of ["codex", "cursor", "claude-code", "codebuddy"]) {
    (host as any).engines.set(id, {
      ownsModel: (model: string) => model.startsWith(id + ":"),
      async request(method: string, params: any) {
        forwarded.push({ method, params });
        if (method === "model/list") return { data: id === "codex" ? [{ id: "codex:one", displayName: "One" }] : [] };
        if (method === "thread/start") { creates++; throw new Error("Synthetic unavailable peer"); }
        return {};
      }, async close() {},
    });
  }
  return { host, release, probes: () => probes, creates: () => creates, forwarded };
}

test("persisted model declarations return while an unrelated CLI login probe is blocked", async () => {
  const f = catalogFixture();
  try {
    const models = await f.host.models();
    assert.deepEqual(models.map(m => m.id), ["codex:one"]);
    assert.equal(f.probes(), 1); assert.equal(f.creates(), 0);
    const again = await f.host.models();
    assert.deepEqual(again.map(m => m.id), ["codex:one"]);
    assert.equal(f.probes(), 1, "concurrent reads share background discovery");
  } finally { f.release(); await f.host.close(); }
});
test("a native conversation catalog excludes other Agent and API model identities", async () => {
  const f = catalogFixture();
  try {
    assert.deepEqual((await f.host.models("cursor_thread")).map(m => m.id), []);
    assert.deepEqual((await f.host.models("codex_thread")).map(m => m.id), ["codex:one"]);
  } finally { f.release(); await f.host.close(); }
});

test("legacy unqualified model IDs are normalized only when the owning Agent declared that exact model", async () => {
  const f = catalogFixture();
  try {
    await f.host.dispatch("turn/start", { threadId: "codex_thread", model: "one", input: [] });
    assert.equal(f.forwarded.find(call => call.method === "turn/start")?.params.model, "codex:one");
    await f.host.dispatch("turn/start", { threadId: "codex_thread", model: "other:one", input: [] });
    assert.equal(f.forwarded.filter(call => call.method === "turn/start").at(-1)?.params.model, "other:one", "an explicit other Agent is never silently relabeled");
  } finally { f.release(); await f.host.close(); }
});


test("a native Pi catalog with no usable models never offers an unexecutable current-model placeholder",async()=>{
 const f=catalogFixture();
 try{(f.host as any).discovered.set('pi',[]);assert.equal((await f.host.models()).some(m=>m.id==='pi:current'),false);}finally{f.release();await f.host.close();}
});

test("connected Codex forwards only explicit permissions and discovery does not grant Full access", async () => {
  const f = catalogFixture();
  try {
    for(const params of [{agentId:"codex",model:"codex:one"},{agentId:"codex",model:"codex:one",permissions:"opencraft:permission-mode:full",sandbox:"danger-full-access",approvalPolicy:"never"}]) {
      await assert.rejects(f.host.dispatch("thread/start",params),/Synthetic unavailable peer/);
    }
    const calls=f.forwarded.filter(call=>call.method==="thread/start");
    assert.equal(calls[0].params.permissions,undefined);assert.equal(calls[0].params.sandbox,undefined);assert.equal(calls[0].params.approvalPolicy,undefined);
    assert.equal(calls[1].params.permissions,"opencraft:permission-mode:full");assert.equal(calls[1].params.sandbox,"danger-full-access");
    await assert.rejects(f.host.listAgentModels("codex"),/Synthetic unavailable peer/);
    assert.equal(f.forwarded.filter(call=>call.method==="thread/start").at(-1)?.params.permissions,undefined);
  } finally { f.release(); await f.host.close(); }
});
