import { ModelPolicyStore } from '@opencraft/model-usage-policy';
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore, ModelGatewayStore } from "@opencraft/account-pool-host";
import { OPENCRAFT_ATTACHMENT_STAGING_EXTENSION, OPENCRAFT_THREAD_LIFECYCLE_EXTENSION, OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_THREAD_START_DURABILITY_EXTENSION, OPENCRAFT_PERMISSION_MODES_EXTENSION } from "@opencraft/appserver-protocol";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { InterruptedTurnRecovery } from "@opencraft/host-recovery";
import { OpenCraftHostQueue } from "../../apps/opencraft-daemon/src/opencraft-host-queue.js";
import { LocalDesktopService } from "../../apps/local-agent-host/src/desktop/local-desktop-service.js";
import { OPENCRAFT_DESKTOP_ATTACH, OPENCRAFT_DESKTOP_RELEASE, OPENCRAFT_DESKTOP_EXTENSION } from "@opencraft/appserver-protocol/desktop";


for (const outcome of ["completed", "failed"] as const) test(`collaboration exact-Turn completion ${outcome} survives Host restart and newer Turn`, async () => {
  const root=await mkdtemp(join(tmpdir(),"codex-input-completion-")),frames:Array<Record<string,unknown>>=[];
  let adapter=createRoutingAdapter(root,frames);
  let sequence=0;
  const request=async(method:string,params:Record<string,unknown>,trusted=false)=>{
    const id="input-completion:"+(++sequence);
    await adapter.sendWithContext(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:"reader"}),
      {sender:null,...(trusted?{collaborationRequestId:"owned-request"}:{})});
    return await waitFor(frames,f=>f.id===id) as any;
  };
  try {
    await adapter.connect();await initializeClient(adapter,frames,"reader");
    const threadId=(await request("thread/start",{testNoServerRequest:true})).result.thread.id;
    const seed=()=>request("test/setHistory",{threadId,turns:[
      {id:"owned-turn",status:outcome,items:[{id:"owned-result",type:"agentMessage",text:"result for the owned input"}]},
      {id:"newer-turn",status:outcome === "completed" ? "failed" : "completed",items:[{id:"foreign-result",type:"agentMessage",text:"unrelated newer output"}]},
    ]});
    await seed();
    const queue=(adapter as any).queueStore() as OpenCraftHostQueue;
    const row=queue.add(threadId,"actor-input:owned-request",[{type:"text",text:"owned intent"}]);
    queue.claim(threadId,row.id,"owned-turn");queue.settle(threadId,row.id,"delivered");
    const legacy=(await request("thread/queue/collaborationReceipt",{threadId},true)).result.receipt;
    assert.deepEqual(legacy,{id:row.id,state:"delivered",targetTurnId:"owned-turn"});
    const denied=await request("thread/queue/collaborationReceipt",{threadId,includeCompletion:true});assert.ok(denied.error);
    const response=await request("thread/queue/collaborationReceipt",{threadId,includeCompletion:true},true);
    assert.ok(response.result,JSON.stringify(response.error));
    assert.deepEqual(response.result.receipt.completion,{version:1,turnId:"owned-turn",status:outcome,text:"result for the owned input",truncated:false});
    assert.equal(queue.findByClientId(threadId,"actor-input:owned-request")?.delivery?.execution,outcome);
    await adapter.close();frames.length=0;
    adapter=createRoutingAdapter(root,frames);await adapter.connect();await initializeClient(adapter,frames,"reader");await seed();
    const reopened=await request("thread/queue/collaborationReceipt",{threadId,includeCompletion:true},true);
    assert.ok(reopened.result,JSON.stringify(reopened.error));
    assert.deepEqual(reopened.result.receipt.completion,response.result.receipt.completion);
  } finally {await adapter.close();await rm(root,{recursive:true,force:true});}
});

test("human model gateway binds trusted admission before native execution and rejects an anonymous payer",async()=>{
 const root=await mkdtemp(join(tmpdir(),"codex-budget-admission-")),frames:Array<Record<string,unknown>>=[];
 const previous=process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE,path=join(root,"budget","gateway.sqlite");
 process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE=path;
 const store=new ModelGatewayStore(path);
 store.configure("human-a",{monthlyTokens:1000,requestTokens:100,concurrency:2},0,"admin");
 const adapter=createRoutingAdapter(root,frames,0,undefined,undefined,undefined,false,{serverId:"fixture",actor:c=>({id:c.actorId,kind:"human"})});
 let sequence=0;
 const request=async(method:string,params:Record<string,unknown>,human: boolean | string=false)=>{
  const id="gateway-admission:"+(++sequence),frame=JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:"viewer"});
  if(human)await adapter.sendWithContext(frame,{sender:null,actorContext:{actorId:typeof human === "string" ? human : "human-a",generation:1,credentialId:null,expiresAt:Date.now()+60000}});
  else await adapter.send(frame);
  return await waitFor(frames,f=>f.id===id) as any;
 };
 try{
  await adapter.connect();await initializeClient(adapter,frames,"viewer");
  const threadId=(await request("thread/start",{testNoServerRequest:true})).result.thread.id;
  store.prepareContribution("private", "human-a", "approved"); store.contributionState("private", "human-a", "shared");
  const denied=await request("turn/start",{threadId,input:[{type:"text",text:"synthetic"}],clientUserMessageId:"untrusted",actorId:"human-a",model:"configured/private/model"});
  assert.ok(denied.error);assert.equal(store.sponsor(threadId),null);
  const before=await request("test/readAcceptedInputs",{});assert.equal(before.result.data.length,0);
  const accepted=await request("turn/start",{threadId,input:[{type:"text",text:"synthetic"}],clientUserMessageId:"trusted",model:"configured/private/model"},true);
  assert.ok(accepted.result,JSON.stringify(accepted.error));assert.equal(store.execution(threadId)?.authorizer,"human-a");
  assert.equal((await request("test/readAcceptedInputs",{})).result.data.length,1);
  const reservation=store.reserve(threadId,"configured/private/model");store.dispatched(reservation.id,"configured/private/model");store.finish(reservation.id,1);
  for(const method of ["turn/start","turn/steer"]) {
    const foreign=await request(method,{threadId,input:[{type:"text",text:"foreign"}],clientUserMessageId:"foreign-"+method},"human-b");
    assert.ok(foreign.error);
  }
  assert.equal((await request("test/readAcceptedInputs",{})).result.data.length,1);

 }finally{
  await adapter.close();store.close();if(previous===undefined)delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;else process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE=previous;
  await rm(root,{recursive:true,force:true});
 }
});

for (const outcome of ["ready", "failed", "disconnected"] as const) test(`reopening during execution tool preparation waits for its existing owner (${outcome})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-resume-preflight-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "viewer");
    const threadId = "fixture-thread-1", internals = adapter as any;
    internals.sessionMcpRetirements.set(threadId, { settings: { model: "preserved" }, phase: "retiring" });
    const preparation = gate.then(() => {
      internals.sessionMcpRefreshes.delete(threadId);
      if (outcome === "failed") throw new Error("synthetic preparation failure");
      internals.sessionMcpRetirements.delete(threadId);
    });
    void preparation.catch(() => {});
    internals.sessionMcpRefreshes.set(threadId, preparation);
    const reopening = adapter.send(JSON.stringify({ id: "reopen", method: "thread/resume", params: { threadId, excludeTurns: true }, [LOGICAL_CLIENT_FIELD]: "viewer" }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(frames.some(frame => frame.id === "reopen"), false, "no premature reconfiguration error");
    if (outcome === "disconnected") await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "viewer" }));
    release(); await reopening;
    if (outcome === "disconnected") assert.equal(frames.some(frame => frame.id === "reopen"), false);
    else {
      const reply = await waitFor(frames, frame => frame.id === "reopen");
      if (outcome === "ready") assert.equal(reply.error, undefined);
      else assert.equal((reply.error as any).data.submissionOutcome, "rejected");
    }
    await initializeClient(adapter, frames, "inspector");
    await adapter.send(JSON.stringify({ id: "counts-reopen", method: "test/readMethodCounts", params: {}, [LOGICAL_CLIENT_FIELD]: "inspector" }));
    const counts = (await waitFor(frames, frame => frame.id === "counts-reopen")).result as any;
    assert.equal(counts["thread/resume"] ?? 0, outcome === "ready" ? 1 : 0);
    assert.equal(counts["turn/start"] ?? 0, 0);
  } finally { release(); await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

function waitFor(frames: Array<Record<string, unknown>>, predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const existing = frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => { settled = true; reject(new Error("Timed out waiting for Codex adapter frame")); }, 2_000);
    const poll = () => {
      if (settled) return;
      const found = frames.find(predicate);
      if (found) { settled = true; clearTimeout(timeout); resolve(found); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function createRoutingAdapter(root: string, frames: Array<Record<string, unknown>>, nativeQueueSteerVersion: 0 | 1 | 2 = 0, steerResponse?: string, nativeSubscriptionGraceMs?: number, desktop?: LocalDesktopService, autoTitles = false, tokenUsage?:ConstructorParameters<typeof CodexEngineAdapter>[0]["tokenUsage"], sessionMcp?: ConstructorParameters<typeof CodexEngineAdapter>[0]["sessionMcp"], createSessionMcp?: ConstructorParameters<typeof CodexEngineAdapter>[0]["createSessionMcp"], diagnostic?: (event: Record<string, unknown>) => void, resourceMetadata?: ConstructorParameters<typeof CodexEngineAdapter>[0]["historyResourceMetadata"], finalizeNativeCreation?: ConstructorParameters<typeof CodexEngineAdapter>[0]["finalizeNativeCreation"]): CodexEngineAdapter {
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: root,
    dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "native-codex"),
    upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    fetch: async () => Response.json({ ok: true }),
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env: { ...env, ...(autoTitles ? { OPENCRAFT_TEST_AUTO_TITLES: "1" } : {}), ...(nativeQueueSteerVersion ? { OPENCRAFT_TEST_NATIVE_QUEUE_STEER: String(nativeQueueSteerVersion) } : {}), ...(steerResponse ? { OPENCRAFT_TEST_STEER_RESPONSE: steerResponse } : {}) }, stdio: ["pipe", "pipe", "pipe"] }),
    createMaintenanceClient: async () => { throw new Error("not used"); },
    logDiagnostic: event => diagnostic?.(event),
    nativeSubscriptionGraceMs,
    tokenUsage,
    sessionMcp,
    createSessionMcp,
    historyResourceMetadata: resourceMetadata,
    finalizeNativeCreation,
    desktop,
  });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  return adapter;
}

test("aborted Item hydration includes the active page phase in the terminal diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-history-abort-stage-")), frames: Array<Record<string, unknown>> = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false, undefined, undefined, undefined, event => diagnostics.push(event));
  const request = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "reader" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "reader");
    const threadId = ((await request("create", "thread/start", { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    await request("seed-history", "test/setHistory", { threadId, legacyItems: true, turns: [{ id: "history-turn", status: "completed", items: [{ id: "history-item", type: "userMessage", content: [{ type: "text", text: "synthetic" }] }] }] });
    await request("pause-items", "test/pauseItemReads", { paused: true });
    await adapter.send(JSON.stringify({ id: "read", method: "thread/read", params: { threadId, historyReadId: "read", initialTurnsPage: { limit: 1 } }, [LOGICAL_CLIENT_FIELD]: "reader" }));
    let itemReads = 0;
    for (let i = 0; i < 100; i++) {
      const counts = (await request(`item-counts-${i}`, "test/readMethodCounts", { threadId })).result as Record<string, number>;
      itemReads = counts["thread/items/list"] ?? 0;
      if (itemReads > 0) break;
    }
    assert.ok(itemReads > 0, "the read should reach lazy Item hydration before cancellation");
    await request("cancel", "thread/history/cancel", { threadId, historyReadId: "read" });
    for (let i = 0; i < 100 && !diagnostics.some(event => event.event === "history-read-stages"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const stage = diagnostics.find(event => event.event === "history-read-stages");
    assert.equal(stage?.outcome, "aborted");
    assert.equal(typeof stage?.pageMs, "number", "the terminal event must flush the still-active page timer");
    assert.ok(Number(stage?.pageMs) > 0);
  } finally {
    await adapter.send(JSON.stringify({ id: "unpause-items", method: "test/pauseItemReads", params: { paused: false }, [LOGICAL_CLIENT_FIELD]: "reader" })).catch(() => {});
    await adapter.close(); await rm(root, { recursive: true, force: true });
  }
});

test("slow cancellation freezes phase timing before resource metadata completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-history-abort-slow-stage-")), frames: Array<Record<string, unknown>> = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  let enterResources!: () => void, releaseResources!: () => void;
  const resourcesEntered = new Promise<void>(resolve => { enterResources = resolve; });
  const resourcesGate = new Promise<void>(resolve => { releaseResources = resolve; });
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false, undefined, undefined, undefined,
    event => diagnostics.push(event), async () => {
      enterResources(); await resourcesGate;
      const empty = { someAvg10: null, someAvg60: null, someAvg300: null, fullAvg10: null, fullAvg60: null, fullAvg300: null };
      return { status: "unavailable", loadAvg1m: null, loadAvg5m: null, loadAvg15m: null, cpuPsi: empty, ioPsi: empty, memoryPsi: empty };
    });
  const request = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "reader" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "reader");
    const threadId = ((await request("create", "thread/start", { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    await request("seed-history", "test/setHistory", { threadId, legacyItems: true, turns: [{ id: "history-turn", status: "completed", items: [{ id: "history-item", type: "userMessage", content: [{ type: "text", text: "synthetic" }] }] }] });
    await request("pause-items", "test/pauseItemReads", { paused: true });
    await adapter.send(JSON.stringify({ id: "read", method: "thread/read", params: { threadId, historyReadId: "read", initialTurnsPage: { limit: 1 } }, [LOGICAL_CLIENT_FIELD]: "reader" }));
    let itemReads = 0;
    for (let i = 0; i < 100; i++) {
      const counts = (await request(`item-counts-${i}`, "test/readMethodCounts", { threadId })).result as Record<string, number>;
      itemReads = counts["thread/items/list"] ?? 0;
      if (itemReads > 0) break;
    }
    assert.ok(itemReads > 0, "the read should enter Item hydration before the slow cancellation");
    await new Promise(resolve => setTimeout(resolve, 5_100));
    await request("cancel", "thread/history/cancel", { threadId, historyReadId: "read" });
    await resourcesEntered;
    await request("unpause-items", "test/pauseItemReads", { paused: false });
    await new Promise(resolve => setTimeout(resolve, 50));
    releaseResources();
    for (let i = 0; i < 100 && !diagnostics.some(event => event.event === "history-read-stages"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const stage = diagnostics.find(event => event.event === "history-read-stages");
    assert.equal(stage?.outcome, "aborted");
    assert.ok(Number(stage?.pageMs) > 0);
    assert.ok(Number(stage?.coreMs) > 5_000);
    assert.ok(Number(stage?.pageMs) <= Number(stage?.coreMs) + 50, `pageMs ${stage?.pageMs} must not be recounted after coreMs ${stage?.coreMs} is finalized`);
  } finally {
    releaseResources();
    await adapter.send(JSON.stringify({ id: "unpause-items-cleanup", method: "test/pauseItemReads", params: { paused: false }, [LOGICAL_CLIENT_FIELD]: "reader" })).catch(() => {});
    await adapter.close(); await rm(root, { recursive: true, force: true });
  }
});

test("a stop during the final asynchronous tool preparation prevents the automatic native send", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-final-recovery-admission-"));
  await mkdir(join(root, "data"));
  const seed = new InterruptedTurnRecovery(join(root, "data"), { serialize: async (_id, work) => work(), inspect: async () => "lost", continue: async () => null, changed() {} });
  seed.started("recovery-thread", "old-turn"); await seed.close();
  let prepares = 0, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false, undefined, async () => {
    if (++prepares === 2) { entered(); await gate; }
    return null;
  });
  const rpc = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    await rpc("seed-history", "test/setHistory", { threadId: "recovery-thread", turns: [{ id: "old-turn", status: "interrupted", items: [] }] });
    let timeout: ReturnType<typeof setTimeout>;
    await Promise.race([preparing, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Recovery did not reach final preparation")), 5000); })]).finally(() => clearTimeout(timeout!));
    await rpc("user-stop", "turn/interrupt", { threadId: "recovery-thread", turnId: "old-turn" });
    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    const response = await rpc("accepted", "test/readAcceptedInputs", {});
    assert.deepEqual((response.result as any).data, []);
    const notice = await rpc("notice", "opencraft/turn-recovery/read", { threadId: "recovery-thread" });
    assert.equal((notice.result as any).recovery, null);
  } finally { release(); await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

async function initializeClient(adapter: CodexEngineAdapter, frames: Array<Record<string, unknown>>, clientId: string): Promise<void> {
  await adapter.send(JSON.stringify({ id: `${clientId}:init`, method: "initialize", params: {}, [LOGICAL_CLIENT_FIELD]: clientId }));
  await waitFor(frames, frame => frame.id === `${clientId}:init`);
}

test("disconnect cancels a held cached history reader while the background Turn continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-history-reader-disconnect-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: object, clientId = "writer") => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer"); await initializeClient(adapter, frames, "reader");
    const threadId = ((await request("create-held", "thread/start", { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    await request("start-held", "turn/start", { threadId, input: [{ type: "text", text: "continue" }] });
    await request("pause-history", "test/pauseThreadReads", { paused: true });
    await adapter.send(JSON.stringify({ id: "held-history", method: "thread/read", params: { threadId, initialTurnsPage: { limit: 10 } }, [LOGICAL_CLIENT_FIELD]: "reader" }));
    assert.equal((adapter as any).cachedHistoryInFlight, 1);
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "reader" }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((adapter as any).cachedHistoryInFlight, 0);
    assert.equal((adapter as any).activeTurns.has(threadId), true);
    await request("release-history", "test/pauseThreadReads", { paused: false });
    assert.equal(frames.some(frame => frame.id === "held-history"), false);
    await request("complete-held", "test/completeTurn", { threadId });
    await waitFor(frames, frame => frame.method === "turn/completed" && (frame.params as any).threadId === threadId);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("duplicate history reads share native work and logical unsubscribe retires pending history", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-history-coalesce-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "reader" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "reader");
    const threadId = ((await request("create", "thread/start", { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    await request("pause", "test/pauseThreadReads", { paused: true });
    const params = { threadId, watch: true, includeTurns: false, initialTurnsPage: { limit: 10 } };
    for (const id of ["read-a", "read-b"]) await adapter.send(JSON.stringify({ id, method: "thread/read",
      params: id === "read-a" ? params : { initialTurnsPage: { limit: 10 }, includeTurns: false, watch: true, threadId },
      [LOGICAL_CLIENT_FIELD]: "reader" }));
    assert.equal((adapter as any).cachedHistoryInFlight, 1, "identical pending reads must use one native operation");
    await adapter.send(JSON.stringify({ id: "detach", method: "thread/unsubscribe", params: { threadId }, [LOGICAL_CLIENT_FIELD]: "reader" }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((adapter as any).cachedHistoryInFlight, 0, "detach retires history without waiting for native metadata");
    await request("unpause", "test/pauseThreadReads", { paused: false });
    const fresh = await request("fresh", "thread/read", params);
    assert.equal(fresh.error, undefined);
    for (const id of ["read-a", "read-b"]) assert.ok((await waitFor(frames, frame => frame.id === id)).error, "retired readers cannot return late success");
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const cancelPeer of [false, true]) test(`read cancellation is scoped to a subscriber and logical owner (last=${cancelPeer})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-history-token-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const send = async (id: string, method: string, params: object, clientId = "reader") => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
  };
  const rpc = async (id: string, method: string, params: object, clientId = "reader") => { await send(id, method, params, clientId); return waitFor(frames, f => f.id === id); };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "reader"); await initializeClient(adapter, frames, "other");
    const threadId = ((await rpc("create", "thread/start", { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    await rpc("pause", "test/pauseThreadReads", { paused: true });
    const params = { threadId, includeTurns: false, initialTurnsPage: { limit: 10 } };
    await send("a", "thread/read", { ...params, historyReadId: "a" });
    await send("b", "thread/read", { ...params, historyReadId: "b" });
    assert.equal((adapter as any).cachedHistoryInFlight, 1);
    assert.equal(((await rpc("foreign", "thread/history/cancel", { threadId, historyReadId: "a" }, "other")).result as any).cancelled, false);
    assert.equal(((await rpc("cancel-a", "thread/history/cancel", { threadId, historyReadId: "a" })).result as any).cancelled, true);
    assert.equal((adapter as any).cachedHistoryInFlight, 1, "peer still owns the native cut");
    if (cancelPeer) {
      await send("cancel-b", "thread/history/cancel", { threadId, historyReadId: "b" });
      // Immediate replacement cannot join an aborted flight, before its cleanup.
      await send("fresh", "thread/read", { ...params, historyReadId: "fresh" });
    }
    await rpc("unpause", "test/pauseThreadReads", { paused: false });
    const reply = await waitFor(frames, f => f.id === (cancelPeer ? "fresh" : "b"));
    assert.equal(reply.error, undefined);
    assert.ok(frames.find(f => f.id === "a")?.error);
    if (cancelPeer) assert.ok(frames.find(f => f.id === "b")?.error);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("a read admitted after cache invalidation cannot join the prior cut", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-history-invalidated-flight-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const send = async (id: string, method: string, params: object) => { await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "reader" })); };
  const rpc = async (id: string, method: string, params: object) => { await send(id, method, params); return waitFor(frames, f => f.id === id); };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "reader");
    const threadId = ((await rpc("create", "thread/start", { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    await rpc("pause", "test/pauseThreadReads", { paused: true });
    const params = { threadId, includeTurns: false, initialTurnsPage: { limit: 10 } };
    await send("old", "thread/read", params);
    await (adapter as any).transcriptCache.invalidate(threadId);
    await send("new", "thread/read", params);
    assert.equal((adapter as any).cachedHistoryInFlight, 2, "invalidation creates a distinct admission generation");
    await rpc("unpause", "test/pauseThreadReads", { paused: false });
    assert.ok((await waitFor(frames, f => f.id === "old")).error);
    assert.equal((await waitFor(frames, f => f.id === "new")).error, undefined);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("provider failures continue through the durable Host queue without replaying user input", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-capacity-retry-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, frame => frame.id === id);
    assert.equal(response.error, undefined);
    return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    assert.deepEqual((frames.find(frame => frame.id === "writer:init")?.result as any).capabilities.extensions["opencraft/capacity-retry"], { version: 1 });
    const threadId = (await request("capacity:create", "thread/start", { cwd: root, testNoServerRequest: true })).thread.id;
    await request("capacity:initial", "turn/start", { threadId, input: [{ type: "text", text: "Continue this task" }] });
    await request("capacity:fail", "test/completeTurn", { threadId, testSystemError: true, codexErrorInfo: "serverOverloaded" });
    (adapter as any).providerRetry.now = () => Date.now() + 240_000;
    await (adapter as any).providerRetry.recover();
    const retry = await waitFor(frames, frame => frame.method === "turn/started" && (frame.params as any).turn.id === "turn-2");
    assert.equal((retry.params as any).threadId, threadId);
    const accepted = (await request("capacity:inputs", "test/readAcceptedInputs", {})).data;
    assert.deepEqual(accepted.at(-1).params.input, []);
    assert.match(accepted.at(-1).params.clientUserMessageId, /^provider-retry:/);
    const usageDb=new DatabaseSync(join(root,"data","token-usage.sqlite"),{readOnly:true});
    try{
      const fact=usageDb.prepare("SELECT actor_id,actor_kind,source_kind,mode FROM token_usage_submissions WHERE server_id=? AND thread_id=? AND input_id=?").get("local-codex",threadId,accepted.at(-1).params.clientUserMessageId);
      assert.deepEqual({...fact},{actor_id:null,actor_kind:"session",source_kind:"system",mode:"start"});
    }finally{usageDb.close();}
    await request("capacity:fail-again", "test/completeTurn", { threadId, testSystemError: true, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } });
    assert.equal((await request("capacity:before-second-backoff", "test/readAcceptedInputs", {})).data.length, 2);
    (adapter as any).providerRetry.now = () => Date.now() + 480_000;
    await (adapter as any).providerRetry.recover();
    assert.equal((await request("capacity:second-retry", "test/readAcceptedInputs", {})).data.length, 3);
    await request("capacity:done", "test/completeTurn", { threadId });
    await (adapter as any).providerRetry.recover();
    assert.equal((await request("capacity:after-success", "test/readAcceptedInputs", {})).data.length, 3);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("new user input cancels a pending capacity continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-capacity-cancel-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, frame => frame.id === id);
    assert.equal(response.error, undefined);
    return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = (await request("cancel:create", "thread/start", { cwd: root, testNoServerRequest: true })).thread.id;
    await request("cancel:initial", "turn/start", { threadId, input: [{ type: "text", text: "First" }] });
    await request("cancel:fail", "test/completeTurn", { threadId, codexErrorInfo: "serverOverloaded" });
    await request("cancel:manual", "turn/start", { threadId, input: [{ type: "text", text: "New direction" }] });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal((await request("cancel:inputs", "test/readAcceptedInputs", {})).data.length, 2);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex Host titles a new conversation after its View disconnects, without leaking the inference Thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-auto-title-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, true);
  const request = async (id: string, method: string, params: Record<string, unknown>, client = "writer") => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    const result = await waitFor(frames, frame => frame.id === id); assert.equal(result.error, undefined); return result.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer"); await initializeClient(adapter, frames, "catalog-reader");
    const started = await request("auto:create", "thread/start", { cwd: root, testNoServerRequest: true });
    const threadId = started.thread.id;
    await request("auto:input", "turn/start", { threadId, input: [{ type: "text", text: "修复自动会话标题" }] });
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "writer" }));
    await waitFor(frames, frame => frame.method === "thread/name/updated" && frame[LOGICAL_CLIENT_FIELD] === "catalog-reader");
    const read = await request("auto:read", "thread/read", { threadId }, "catalog-reader");
    assert.equal(read.thread.name, "修复自动会话标题");
    assert.equal(read.thread.status.type, "active", "background title must not stop the user's turn");
    assert.equal(frames.some(frame => JSON.stringify(frame).includes("title-thread-")), false);
    assert.equal(frames.filter(frame => frame.method === "turn/completed").length, 0);
    assert.equal((await request("auto:list", "thread/list", {}, "catalog-reader")).data.length, 1);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("manual native rename during background generation survives and is returned by the catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-auto-title-manual-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, true);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const result = await waitFor(frames, frame => frame.id === id); assert.equal(result.error, undefined); return result.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const started = await request("manual:create", "thread/start", { cwd: root, testNoServerRequest: true });
    const threadId = started.thread.id;
    await request("manual:input", "turn/start", { threadId, input: [{ type: "text", text: "修复自动会话标题" }] });
    await request("manual:rename", "thread/name/set", { threadId, name: "用户保留的标题" });
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal((await request("manual:read", "thread/read", { threadId })).thread.name, "用户保留的标题");
    assert.equal(frames.some(frame => frame.method === "thread/name/updated" && (frame.params as any).threadName === "修复自动会话标题"), false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex Host stages ordinary files for its native process without forwarding the extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-attachment-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const clientId = "attachment-client";
  const request = {
    clientAttachmentId: "markdown-attachment",
    name: "notes.md",
    mimeType: "text/markdown",
    size: 11,
    source: { kind: "client-bytes", dataBase64: Buffer.from("hello world").toString("base64") },
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, clientId);
    const initialized = await waitFor(frames, frame => frame.id === `${clientId}:init`);
    assert.deepEqual((initialized.result as any).capabilities.extensions[OPENCRAFT_ATTACHMENT_STAGING_EXTENSION], {
      version: 1, chunkBytes: 64 * 1024, uploadRetry: "last-chunk-v1", sources: ["client-bytes"], locations: ["host-file"], maxBytes: 1024 * 1024 * 1024,
    });
    const upload = { uploadId: crypto.randomUUID(), clientAttachmentId: "chunked-notes", name: "chunked.md", mimeType: "text/markdown", size: 6 };
    const chunk = async (id: string, offset: number, text: string) => {
      await adapter.send(JSON.stringify({ id, method: "attachment/uploadChunk", params: { ...upload, offset, dataBase64: Buffer.from(text).toString("base64") }, [LOGICAL_CLIENT_FIELD]: clientId }));
      const response = await waitFor(frames, frame => frame.id === id);
      assert.equal(response[LOGICAL_CLIENT_FIELD], clientId);
      assert.equal(response.error, undefined);
      return response.result as any;
    };
    assert.deepEqual(await chunk("chunk-1", 0, "abc"), { receivedBytes: 3, ref: null });
    const uploaded = await chunk("chunk-2", 3, "def");
    assert.equal(uploaded.receivedBytes, 6);
    assert.equal(await readFile(uploaded.ref.location.path, "utf8"), "abcdef");
    await adapter.send(JSON.stringify({ id: "chunk-remove", method: "attachment/remove", params: { id: uploaded.ref.id }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.deepEqual((await waitFor(frames, frame => frame.id === "chunk-remove")).result, { removed: true });
    await adapter.send(JSON.stringify({ id: "stage-1", method: "attachment/stage", params: request, [LOGICAL_CLIENT_FIELD]: clientId }));
    const staged = await waitFor(frames, frame => frame.id === "stage-1");
    assert.equal(staged[LOGICAL_CLIENT_FIELD], clientId);
    const path = (staged.result as any).ref.location.path as string;
    assert.ok(path.startsWith(join(root, "data", "attachments") + "/"));
    assert.equal((await readFile(path)).toString("utf8"), "hello world");
    await adapter.send(JSON.stringify({ id: "stage-replay", method: "attachment/stage", params: request, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.deepEqual((await waitFor(frames, frame => frame.id === "stage-replay")).result, staged.result);
    await adapter.send(JSON.stringify({ id: "thread-1", method: "thread/start", params: {}, [LOGICAL_CLIENT_FIELD]: clientId }));
    const threadId = (await waitFor(frames, frame => frame.id === "thread-1")).result as any;
    const actualThreadId = threadId.thread.id as string;
    await adapter.send(JSON.stringify({ id: "turn-1", method: "turn/start", params: {
      threadId: actualThreadId, clientUserMessageId: "with-file", input: [
        { type: "text", text: "What is in this file?" }, { type: "mention", name: "notes.md", path },
      ],
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const turn = await waitFor(frames, frame => frame.id === "turn-1");
    assert.ok(turn.result);
    await adapter.send(JSON.stringify({ id: "items-1", method: "thread/items/list", params: { threadId: actualThreadId }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const items = (await waitFor(frames, frame => frame.id === "items-1")).result as any;
    const content = items.data[0].item.content;
    assert.equal(content[0].text, "What is in this file?");
    assert.match(content[1].text, /notes\.md/);
    const executionPath=JSON.parse(/readable path on this Host is (".*?")\. Read/.exec(content[1].text)![1]!);
    assert.notEqual(executionPath,path);
    assert.equal(await readFile(executionPath,'utf8'),'hello world');
    assert.equal(content[1].text_elements[0].placeholder, "opencraft:staged-file:v1");
    assert.deepEqual(content[2], { type: "mention", name: "notes.md", path });
    assert.deepEqual(items.data[0].item.attachments, [{
      id: request.clientAttachmentId, name: "notes.md", mimeType: "text/markdown",
      size: 11, path,
    }]);
    await adapter.send(JSON.stringify({ id: "queue-add", method: "thread/queue/add", params: {
      threadId: actualThreadId, clientUserMessageId: "queued-file", input: [{ type: "mention", name: "notes.md", path }],
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const queued = (await waitFor(frames, frame => frame.id === "queue-add")).result as any;
    await adapter.send(JSON.stringify({ id: "queue-steer", method: "thread/queue/steer", params: {
      threadId: actualThreadId, queuedSubmissionId: queued.queuedSubmission.id,
      expectedTurnId: (turn.result as any).turn.id,
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.ok((await waitFor(frames, frame => frame.id === "queue-steer")).result);
    await adapter.send(JSON.stringify({ id: "items-2", method: "thread/items/list", params: { threadId: actualThreadId }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const steeredItems = (await waitFor(frames, frame => frame.id === "items-2")).result as any;
    assert.ok(steeredItems.data[1].item.content[0].text.includes(executionPath));
    assert.deepEqual(steeredItems.data[1].item.content[1], { type: "mention", name: "notes.md", path });
    assert.deepEqual(steeredItems.data[1].item.attachments, items.data[0].item.attachments);
    await adapter.send(JSON.stringify({ id: "remove-1", method: "attachment/remove", params: { id: request.clientAttachmentId }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.equal(((await waitFor(frames, frame => frame.id === "remove-1")).error as any).code, -32602);
    assert.equal((await readFile(path)).toString("utf8"), "hello world");
    await adapter.send(JSON.stringify({ id: "stage-unsent", method: "attachment/stage", params: {
      ...request, clientAttachmentId: "unsent-file",
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const unsentPath = ((await waitFor(frames, frame => frame.id === "stage-unsent")).result as any).ref.location.path as string;
    await adapter.send(JSON.stringify({ id: "remove-unsent", method: "attachment/remove", params: { id: "unsent-file" }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.deepEqual((await waitFor(frames, frame => frame.id === "remove-unsent")).result, { removed: true });
    await assert.rejects(() => readFile(unsentPath));
    await adapter.send(JSON.stringify({ id: "stale-file", method: "turn/steer", params: {
      threadId: actualThreadId, expectedTurnId: (turn.result as any).turn.id,
      clientUserMessageId: "stale-file", input: [{ type: "mention", name: "notes.md", path: unsentPath }],
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.equal(((await waitFor(frames, frame => frame.id === "stale-file")).error as any).code, -32602);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex desktop authorization reads the engine Thread and retires logical Client grants", async t => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-desktop-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let inspections = 0;
  const desktop = new LocalDesktopService({ serverId: "backend-server", environmentId: "backend-machine", principalId: "local-owner",
    observer: { inspect: async () => { inspections++; return "a".repeat(64); }, open: async () => { throw new Error("not needed"); } } });
  t.after(() => desktop.close());
  const revoked: string[] = [], release: string[] = [];
  const originalRevoke = desktop.revoke.bind(desktop), originalRelease = desktop.release.bind(desktop);
  desktop.revoke = key => { revoked.push(key); originalRevoke(key); };
  desktop.release = (key, id) => { release.push(key); originalRelease(key, id); };
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, desktop);
  t.after(() => adapter.close());
  await adapter.connect();
  await initializeClient(adapter, frames, "client-a");
  const init = frames.find(frame => frame.id === "client-a:init")!;
  assert.deepEqual((init.result as any).capabilities.extensions[OPENCRAFT_DESKTOP_EXTENSION], desktop.capability());
  const request = async (id: string, method: string, params: unknown, client = "client-a") => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    return waitFor(frames, frame => frame.id === id);
  };
  assert.ok((await request("not-durable", OPENCRAFT_DESKTOP_ATTACH, { threadId: "missing-thread" })).error);
  assert.equal(inspections, 0, "native observer must not run for nonexistent/ephemeral Thread");
  await request("resume-desktop", "thread/resume", { threadId: "desktop-thread" });
  assert.ok((await request("forged-instance", OPENCRAFT_DESKTOP_ATTACH, { threadId: "desktop-thread", instanceId: "attacker" })).error);
  await adapter.send(JSON.stringify({ id: "uninitialized", method: OPENCRAFT_DESKTOP_ATTACH,
    params: { threadId: "desktop-thread" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
  assert.equal(((await waitFor(frames, frame => frame.id === "uninitialized")).error as any).code, -32600);
  assert.equal(inspections, 0);
  const attached = await request("grant", OPENCRAFT_DESKTOP_ATTACH, { threadId: "desktop-thread" });
  const credential = attached.result as any;
  assert.equal(credential.target.conversationId, "desktop-thread");
  assert.equal(credential.target.serverId, "backend-server");
  assert.equal(credential.instanceId, "backend-machine");
  // A bridge Thread is read by its native session and bound under its public identity.
  adapter.bridgeOwners().bindThreadIdentities({ toNative: id => id === "bridge:codex:public" ? "desktop-thread" : undefined, toPublic: () => undefined });
  const bridged = (await request("bridge-grant", OPENCRAFT_DESKTOP_ATTACH, { threadId: "bridge:codex:public" })).result as any;
  assert.equal(bridged.target.conversationId, "bridge:codex:public");
  await initializeClient(adapter, frames, "client-b");
  await request("foreign-release", OPENCRAFT_DESKTOP_RELEASE, { attachmentId: credential.attachmentId }, "client-b");
  const foreignKey = release.at(-1)!;
  await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
  assert.notEqual(revoked.at(-1), foreignKey);
  const oldKey = revoked.at(-1);
  // Reusing the same Client ID is a different authorization epoch.
  frames.splice(0);
  await initializeClient(adapter, frames, "client-a");
  await request("new-grant", OPENCRAFT_DESKTOP_ATTACH, { threadId: "desktop-thread" });
  await adapter.close();
  assert.ok(revoked.some(key => key !== oldKey && key !== foreignKey));
});

test("Codex Engine shares one physical initialize and restores logical client routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-engine-"));
  const nativeCodexHomeDirectory = join(root, "native-codex");
  const accessToken = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    email: "native@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "chatgpt-native" },
  })).toString("base64url")}.signature`;
  await mkdir(nativeCodexHomeDirectory, { recursive: true });
  await writeFile(join(nativeCodexHomeDirectory, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: accessToken, refresh_token: "refresh-native", account_id: "chatgpt-native" },
  }));
  const frames: Array<Record<string, unknown>> = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: root,
    dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory,
    upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    fetch: async input => String(input).includes("/wham/usage")
      ? Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } } })
      : Response.json({ ok: true }),
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
    createMaintenanceClient: async () => { throw new Error("not used"); },
    logDiagnostic: event => diagnostics.push(event),
  });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  try {
    await adapter.connect();
    await Promise.all([
      adapter.send(JSON.stringify({ id: "a:init", method: "initialize", params: { clientInfo: { name: "a", version: "1" } }, [LOGICAL_CLIENT_FIELD]: "client-a" })),
      adapter.send(JSON.stringify({ id: "b:init", method: "initialize", params: { clientInfo: { name: "b", version: "1" } }, [LOGICAL_CLIENT_FIELD]: "client-b" })),
    ]);
    const first = await waitFor(frames, frame => frame.id === "a:init");
    const second = await waitFor(frames, frame => frame.id === "b:init");
    assert.equal(first[LOGICAL_CLIENT_FIELD], "client-a");
    assert.equal(second[LOGICAL_CLIENT_FIELD], "client-b");
    assert.equal((first.result as any).serverInfo.version, "1");
    assert.equal((second.result as any).serverInfo.version, "1");
    assert.deepEqual(
      (first.result as any).capabilities.extensions[OPENCRAFT_THREAD_START_DURABILITY_EXTENSION],
      { version: 1, durableAfter: "first-turn-accepted" },
    );
    assert.deepEqual(
      (first.result as any).capabilities.extensions[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION],
      { version: 1, fork: true, ephemeral: true, injectItems: false, sideChatSettings: true, rename: true, archive: true, unsubscribe: true },
    );
    assert.deepEqual((first.result as any).capabilities.extensions[OPENCRAFT_THREAD_QUEUE_EXTENSION],
      { version: 2, reorder: true, atomicSteer: true, unconfirmedSteerDiscard: true, unconfirmedDeliveryRetry: true, perItemPause: false });

    await adapter.send(JSON.stringify({ id: "a:start", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:start");
    const started = await waitFor(frames, frame => frame.method === "thread/started");
    assert.equal(started[LOGICAL_CLIENT_FIELD], "client-a");
    await adapter.send(JSON.stringify({ id: "a:interrupt", method: "turn/interrupt", params: {
      threadId: "thread-a", turnId: "turn-a", prompt: "must not be logged",
    }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-b" }));
    assert.ok(diagnostics.some(event => event.event === "appserver-start" && typeof event.pid === "number"));
    assert.deepEqual(diagnostics.find(event => event.event === "turn-interrupt"), {
      component: "codex-engine-adapter", at: diagnostics.find(event => event.event === "turn-interrupt")?.at,
      event: "turn-interrupt", clientId: "client-a", requestId: diagnostics.find(event => event.event === "turn-interrupt")?.requestId,
      threadId: "thread-a", turnId: "turn-a", pid: diagnostics.find(event => event.event === "appserver-start")?.pid,
    });
    assert.match(String(diagnostics.find(event => event.event === "turn-interrupt")?.requestId), /^opencraft:\d+$/);
    assert.ok(diagnostics.some(event => event.event === "client-disconnect" && event.clientId === "client-b"));
    assert.ok(diagnostics.some(event => event.event === "client-initialize" && event.clientId === "client-a" && event.outcome === "succeeded"));
    assert.doesNotMatch(JSON.stringify(diagnostics), /must not be logged/);
    const serverRequest = await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    assert.equal(serverRequest[LOGICAL_CLIENT_FIELD], "client-a");
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const resolved = await waitFor(frames, frame => frame.method === "serverRequest/resolved");
    assert.equal(resolved[LOGICAL_CLIENT_FIELD], "client-a");
    await adapter.send(JSON.stringify({ id: "a:resume", method: "thread/resume", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:resume");
    assert.ok(diagnostics.some(event => event.event === "thread-resume-start" && event.clientId === "client-a" && event.threadId === "fixture-thread-1"));
    assert.ok(diagnostics.some(event => event.event === "thread-resume-finish" && event.clientId === "client-a" && event.threadId === "fixture-thread-1" && event.outcome === "succeeded"));
    const resumeRequestId = diagnostics.find(event => event.event === "thread-resume-start")?.requestId;
    const resumeEvents = diagnostics.filter(event => event.requestId === resumeRequestId);
    assert.ok(resumeEvents.some(event => event.event === "thread-resume-stage" && event.stage === "native-dispatch" && event.outcome === "written"));
    assert.ok(resumeEvents.some(event => event.event === "thread-resume-finish" && event.outcome === "succeeded"));

    await adapter.send(JSON.stringify({ id: "b:accounts", method: "opencraft/codex/accounts/list", params: {}, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const accounts = await waitFor(frames, frame => frame.id === "b:accounts");
    assert.equal(accounts[LOGICAL_CLIENT_FIELD], "client-b");
    assert.deepEqual(accounts.result, { accounts: [] });

    await adapter.send(JSON.stringify({ id: "b:import", method: "opencraft/codex/accounts/import", params: {}, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const imported = await waitFor(frames, frame => frame.id === "b:import");
    assert.equal((imported.result as any).account.email, "native@example.com");
    assert.equal((imported.result as any).account.credentialSource, "external-file");
    assert.doesNotMatch(JSON.stringify(imported), /refresh-native|Bearer/);
    let refreshed: Record<string, any> | null = null;
    for (let attempt = 0; attempt < 20 && refreshed === null; attempt += 1) {
      const id = `b:accounts:${attempt}`;
      await adapter.send(JSON.stringify({ id, method: "opencraft/codex/accounts/list", params: {}, [LOGICAL_CLIENT_FIELD]: "client-b" }));
      const listed = await waitFor(frames, frame => frame.id === id);
      if ((listed.result as any).accounts[0]?.subscriptionType === "pro") refreshed = listed as Record<string, any>;
      else await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((refreshed?.result as any).accounts[0].credentialSource, "external-file");
    assert.equal((refreshed?.result as any).accounts[0].subscriptionType, "pro");
    assert.equal((refreshed?.result as any).accounts[0].limitWindows[0].utilization, 0.1);
  } finally {
    await adapter.close();
    assert.ok(diagnostics.some(event => event.event === "appserver-exit" && event.intentional === true));
    await rm(root, { recursive: true, force: true });
  }
});

test("one logical unsubscribe cannot revoke another Client's shared native Thread stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-multi-subscribe-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (clientId: string, id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    const started = await request("client-a", "a:start", "thread/start", { cwd: root });
    const threadId = (started.result as any).thread.id as string;
    await request("client-b", "b:resume", "thread/resume", { threadId });

    const before = frames.length;
    await request("client-a", "a:probe-1", "test/emitThreadNotification", { threadId });
    await waitFor(frames, frame => frames.indexOf(frame) >= before && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-b");
    assert.deepEqual(new Set(frames.slice(before).filter(frame => frame.method === "thread/status/changed")
      .map(frame => frame[LOGICAL_CLIENT_FIELD])), new Set(["client-a", "client-b"]));

    const detached = await request("client-b", "b:unsubscribe", "thread/unsubscribe", { threadId });
    assert.deepEqual(detached.result, { status: "unsubscribed" });
    assert.deepEqual((await request("client-b", "b:unsubscribe-again", "thread/unsubscribe", { threadId })).result,
      { status: "notSubscribed" });
    const afterDetach = frames.length;
    const probe = await request("client-a", "a:probe-2", "test/emitThreadNotification", { threadId });
    assert.deepEqual(probe.result, { nativeSubscribed: true });
    await waitFor(frames, frame => frames.indexOf(frame) >= afterDetach && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-a");
    assert.equal(frames.slice(afterDetach).some(frame => frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-b"), false);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("joining Client receives Thread events before its delayed resume acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-joining-subscribe-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await adapter.send(JSON.stringify({ id: "a:start", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:start");
    await adapter.send(JSON.stringify({ id: "b:resume", method: "thread/resume", params: { threadId: "fixture-thread-1", testDelayMs: 50 }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const before = frames.length;
    await adapter.send(JSON.stringify({ id: "a:probe", method: "test/emitThreadNotification", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:probe");
    const joinedEvent = await waitFor(frames, frame => frames.indexOf(frame) >= before && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-b");
    assert.ok(joinedEvent);
    assert.equal(frames.some(frame => frame.id === "b:resume"), false);
    await waitFor(frames, frame => frame.id === "b:resume");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Client that detaches during resume cannot regain notifications or interaction ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-detached-join-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const send = (clientId: string, id: string, method: string, params: Record<string, unknown>) =>
    adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await send("client-a", "a:start", "thread/start", { cwd: root });
    await waitFor(frames, frame => frame.id === "a:start");
    const threadId = "fixture-thread-1";
    await send("client-b", "b:resume", "thread/resume", { threadId, testDelayMs: 50 });
    await send("client-b", "b:detach", "thread/unsubscribe", { threadId });
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:detach")).result, { status: "notSubscribed" });
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "b:resume"), false);
    const before = frames.length;
    await send("client-a", "a:probe", "test/emitThreadNotification", { threadId });
    await waitFor(frames, frame => frame.id === "a:probe");
    await waitFor(frames, frame => frames.indexOf(frame) >= before && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-a");
    assert.equal(frames.slice(before).some(frame => frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-b"), false);
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await send("client-b", "b:emit", "test/emitServerRequest", { threadId });
    const emitted = await waitFor(frames, frame => frame.id === "b:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);
    await initializeClient(adapter, frames, "client-c");
    await send("client-c", "c:resume", "thread/resume", { threadId });
    await waitFor(frames, frame => frame.id === "c:resume");
    assert.equal((await waitFor(frames, frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"))[LOGICAL_CLIENT_FIELD], "client-c");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reused logical Client ID cannot inherit the previous connection's late resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-reused-client-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const send = (clientId: string, id: string, method: string, params: Record<string, unknown>) =>
    adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await send("client-a", "a:start", "thread/start", { cwd: root });
    await waitFor(frames, frame => frame.id === "a:start");
    const threadId = "fixture-thread-1";
    await send("client-a", "a:old-resume", "thread/resume", { threadId, testDelayMs: 50 });
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await initializeClient(adapter, frames, "client-a");
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "a:old-resume"), false);
    const before = frames.length;
    await send("client-b", "b:probe", "test/emitThreadNotification", { threadId });
    await waitFor(frames, frame => frame.id === "b:probe");
    assert.equal(frames.slice(before).some(frame => frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-a"), false);
    await send("client-a", "a:fresh-resume", "thread/resume", { threadId });
    await waitFor(frames, frame => frame.id === "a:fresh-resume");
    const afterJoin = frames.length;
    await send("client-b", "b:probe-after-join", "test/emitThreadNotification", { threadId });
    await waitFor(frames, frame => frame.id === "b:probe-after-join");
    await waitFor(frames, frame => frames.indexOf(frame) >= afterJoin && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-a");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("late empty thread/start retains its native subscription until the first Turn can be submitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-late-start-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, 10);
  const send = (clientId: string, id: string, method: string, params: Record<string, unknown>) =>
    adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await send("client-a", "a:start", "thread/start", { cwd: root, testDelayMs: 50, testNoServerRequest: true });
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "a:start"), false);
    await new Promise(resolve => setTimeout(resolve, 60));
    await send("client-b", "b:probe", "test/emitThreadNotification", { threadId: "fixture-thread-1" });
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:probe")).result, { nativeSubscribed: true });
    await send("client-b", "b:resume", "thread/resume", { threadId: "fixture-thread-1" });
    await waitFor(frames, frame => frame.id === "b:resume");
    await send("client-b", "b:probe-after-resume", "test/emitThreadNotification", { threadId: "fixture-thread-1" });
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:probe-after-resume")).result, { nativeSubscribed: true });
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Host archives and restores through the native Thread catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-archive-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const clientId = "archive-client";
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, clientId);
    const initialized = await waitFor(frames, frame => frame.id === `${clientId}:init`);
    assert.equal((initialized.result as any).capabilities.extensions[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION].archive, true);

    const started = await request("archive:start", "thread/start", { cwd: root });
    const threadId = (started.result as any).thread.id;
    const archived = await request("archive:write", "thread/archive", { threadId });
    assert.deepEqual(archived.result, {});
    assert.equal(archived[LOGICAL_CLIENT_FIELD], clientId);
    const archivedList = await request("archive:list", "thread/list", { archived: true });
    assert.deepEqual((archivedList.result as any).data.map((thread: any) => thread.id), [threadId]);

    const restored = await request("archive:restore", "thread/unarchive", { threadId });
    assert.equal((restored.result as any).thread.id, threadId);
    const afterRestore = await request("archive:after-restore", "thread/list", { archived: true });
    assert.deepEqual((afterRestore.result as any).data, []);
    const activeList = await request("archive:active-list", "thread/list", {});
    assert.deepEqual((activeList.result as any).data.map((thread: any) => thread.id), [threadId]);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Host renames a Thread through native AppServer and reads its name back", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-rename-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const clientId = "rename-client";
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, clientId);
    const initialized = await waitFor(frames, frame => frame.id === `${clientId}:init`);
    assert.equal((initialized.result as any).capabilities.extensions[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION].rename, true);

    const started = await request("rename:start", "thread/start", { cwd: root });
    const threadId = (started.result as any).thread.id;
    const renamed = await request("rename:write", "thread/name/set", { threadId, name: "A useful title" });
    assert.deepEqual(renamed.result, {});
    assert.equal(renamed[LOGICAL_CLIENT_FIELD], clientId);
    const listed = await request("rename:list", "thread/list", {});
    assert.equal((listed.result as any).data[0].name, "A useful title");
    const read = await request("rename:read", "thread/read", { threadId, includeTurns: false });
    assert.equal((read.result as any).thread.name, "A useful title");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Host queue Steer capability does not depend on a patched native marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-native-queue-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 2);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    const initialized = await waitFor(frames, frame => frame.id === "client-a:init");
    assert.deepEqual(
      (initialized.result as any).capabilities.extensions[OPENCRAFT_THREAD_QUEUE_EXTENSION],
      { version: 2, reorder: true, atomicSteer: true, unconfirmedSteerDiscard: true, unconfirmedDeliveryRetry: true, perItemPause: false },
    );
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Host marks only verified built-in profiles as portable modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-permission-catalog-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    const initialized = await waitFor(frames, frame => frame.id === "client-a:init");
    assert.deepEqual((initialized.result as any).capabilities.extensions[OPENCRAFT_PERMISSION_MODES_EXTENSION], { version: 1 });
    await adapter.send(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: "client-a", id: "catalog", method: "permissionProfile/list", params: { cursor: null, limit: 100 } }));
    const response = await waitFor(frames, frame => frame.id === "catalog");
    assert.deepEqual((response.result as any).data.map((entry: any) => entry.openCraftMode ?? null), [
      "read-only", "accept-edits", "full", null,
    ]);
    assert.equal((response.result as any).data[1].id, "opencraft:permission-mode:accept-edits");
    assert.equal((response.result as any).data[1].openCraftNativeProfileId, ":workspace");
    assert.equal((response.result as any).data[3].id, "team-custom");
    await adapter.send(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: "client-a", id: "create-with-mode", method: "thread/start", params: { cwd: root, permissions: "opencraft:permission-mode:accept-edits" } }));
    const created = await waitFor(frames, frame => frame.id === "create-with-mode");
    assert.equal((created.result as any).testNativePermission, ":workspace");
    await adapter.send(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: "client-a", id: "create-unsupported-auto", method: "thread/start", params: { cwd: root, permissions: "opencraft:permission-mode:auto" } }));
    const unsupported = await waitFor(frames, frame => frame.id === "create-unsupported-auto");
    assert.equal((unsupported.error as any).code, -32602);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("older native queue marker does not change Host queue capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-native-queue-v1-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 1);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    const initialized = await waitFor(frames, frame => frame.id === "client-a:init");
    assert.deepEqual(
      (initialized.result as any).capabilities.extensions[OPENCRAFT_THREAD_QUEUE_EXTENSION],
      { version: 2, reorder: true, atomicSteer: true, unconfirmedSteerDiscard: true, unconfirmedDeliveryRetry: true, perItemPause: false },
    );
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host-owned Codex queue admits a second steer before the first appears in history", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-queue-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, "defer-history");
  const client = "client-a";
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, client);
    await request("thread", "thread/start", { cwd: root });
    const started = await request("turn", "turn/start", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const activeTurnId = (started.result as any).turn.id;
    const added = await request("add", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "follow up" }], clientUserMessageId: "queued-1",
    });
    const queuedId = (added.result as any).queuedSubmission.id;
    const secondAdded = await request("add-2", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "another follow up" }], clientUserMessageId: "queued-2",
    });
    const secondQueuedId = (secondAdded.result as any).queuedSubmission.id;
    const queued = await request("list-1", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.equal((queued.result as any).data[0].id, queuedId);
    const steered = await request("steer", "thread/queue/steer", {
      threadId: "fixture-thread-1", queuedSubmissionId: queuedId, expectedTurnId: activeTurnId,
    });
    assert.equal((steered.result as any).turnId,activeTurnId);
    assert.equal((steered.result as any).delivery.custody,"accepted");
    const afterSteer = await request("list-2", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.equal((afterSteer.result as any).data[0].id, secondQueuedId);
    assert.equal((afterSteer.result as any).steering[0].clientUserMessageId, "queued-1");
    const secondSteer = await request("steer-2", "thread/queue/steer", {
      threadId: "fixture-thread-1", queuedSubmissionId: secondQueuedId, expectedTurnId: activeTurnId,
    });
    assert.equal((secondSteer.result as any).turnId,activeTurnId);
    const afterSecondSteer = await request("list-3", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.deepEqual((afterSecondSteer.result as any).data, []);
    assert.deepEqual((afterSecondSteer.result as any).steering.map((item: any) => item.clientUserMessageId), ["queued-1", "queued-2"]);
    await request("complete", "test/completeTurn", { threadId: "fixture-thread-1" });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await request(`list-final-${attempt}`, "thread/queue/list", { threadId: "fixture-thread-1" });
      if ((listed.result as any).steering.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const settled = await request("settled", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.deepEqual((settled.result as any).steering, []);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous admission retains custody; terminal receipt releases later input without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-unknown-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, "ambiguous");
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "client-a");
    await request("thread", "thread/start", { cwd: root });
    const turn = await request("turn", "turn/start", { threadId: "fixture-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first" });
    const threadId = "fixture-thread-1", targetTurnId = (turn.result as any).turn.id;
    const added = await request("add", "thread/queue/add", { threadId, input: [{ type: "text", text: "retry me" }], clientUserMessageId: "retry-message" });
    const queuedId = (added.result as any).queuedSubmission.id;
    const next = await request("add-next", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "must wait" }], clientUserMessageId: "next-1",
    });
    const steer = await request("steer", "thread/queue/steer", {
      threadId: "fixture-thread-1", queuedSubmissionId: queuedId, expectedTurnId: targetTurnId,
    });
    assert.ok(steer.error);
    const unknown = await request("unknown", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.equal((unknown.result as any).steering[0].pausedReason, "steer-delivery-unconfirmed");
    const queue=(adapter as any).queueStore();
    assert.equal(queue.find(threadId,queuedId)?.state,"unknown");
    assert.equal(queue.firstAwaitingAdmission(threadId)?.id,(next.result as any).queuedSubmission.id,"later input owns independent admission; unknown old work is never replayed");
    const stillQueued = await request("still-queued", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.equal((stillQueued.result as any).data[0].clientUserMessageId, "next-1");
    await request("complete", "test/completeTurn", { threadId: "fixture-thread-1" });
    const settled = await request("settled", "thread/queue/list", { threadId: "fixture-thread-1" });
    const receipt=(settled.result as any).steering.find((r:any)=>r.id===queuedId);
    assert.equal(receipt.delivery.custody,"accepted");
    assert.equal(receipt.delivery.nativeAdmission,"unknown");
    assert.equal(receipt.delivery.context,"unobserved");
    assert.equal(receipt.delivery.execution,"completed");
    assert.equal(receipt.pausedReason,null);
    const later=await request("later", "thread/read", {threadId:"fixture-thread-1",includeTurns:true});
    assert.equal((later.result as any).thread.turns.length,2,"later queued input proceeds once, without replaying the old attempt");

  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const lateReceipt of [false, true]) test(`unconfirmed input retries only on request after final reconciliation (late receipt: ${lateReceipt})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-queue-retry-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, lateReceipt ? "defer-history" : "ambiguous");
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    return waitFor(frames, frame => frame.id === id).catch(error => { throw new Error(`Retry fixture request ${id} (${method}) did not settle`, {cause:error}); });
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "client-a");
    await request("thread", "thread/start", { cwd: root });
    const turn = await request("turn", "turn/start", { threadId: "fixture-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first" });
    const threadId = "fixture-thread-1", targetTurnId = (turn.result as any).turn.id;
    const added = await request("add", "thread/queue/add", { threadId, input: [{ type: "text", text: "retry me" }], clientUserMessageId: "retry-message" });
    const queuedId = (added.result as any).queuedSubmission.id;
    await request("steer", "thread/queue/steer", { threadId, queuedSubmissionId: queuedId, expectedTurnId: targetTurnId });
    const queue = (adapter as any).queueStore();
    if (lateReceipt) queue.settle(threadId, queuedId, "unknown", "steer-delivery-unconfirmed");
    const next = await request("add-next", "thread/queue/add", { threadId, input: [{ type: "text", text: "next" }], clientUserMessageId: "next-message" });
    const nextId = (next.result as any).queuedSubmission.id;
    assert.equal(queue.firstAwaitingAdmission(threadId)?.id, nextId, "unknown input must not block later messages");
    assert.equal((await request("reorder", "thread/queue/reorder", { threadId, queuedSubmissionIds: [nextId] })).error, undefined);
    await request("remove-next", "thread/queue/delete", { threadId, queuedSubmissionId: nextId });
    const wrong = await request("wrong", "thread/queue/retry", { threadId, queuedSubmissionId: queuedId, expectedTurnId: "wrong-turn" });
    assert.ok(wrong.error);
    for (const id of ["retry", "retry-again"]) {
      const reply = await request(id, "thread/queue/retry", { threadId, queuedSubmissionId: queuedId, expectedTurnId: targetTurnId });
      assert.equal(reply.error, undefined, "retry during an active Turn is accepted without an error dialog");
    }
    assert.equal(queue.find(threadId, queuedId)?.pausedReason, lateReceipt ? "steer-delivery-unconfirmed" : "delivery-retry-requested");
    const before = (await request("before", "test/readAcceptedInputs", {})).result as any;
    assert.equal(before.data.filter((row: any) => row.params.clientUserMessageId === "retry-message").length, 1);
    await request("complete", "test/completeTurn", { threadId });
    await waitFor(frames, () => (queue.find(threadId, queuedId)?.state === "delivered" || lateReceipt && queue.find(threadId, queuedId)?.state === "closed")).catch(error => { throw new Error(`Retry fixture final delivery: ${JSON.stringify(queue.find(threadId,queuedId))}`, {cause:error}); });
    const after = (await request("after", "test/readAcceptedInputs", {})).result as any;
    const inputs = after.data.filter((row: any) => row.params.clientUserMessageId === "retry-message");
    assert.equal(inputs.length, lateReceipt ? 1 : 2, "late original acceptance prevents replay; otherwise exactly one explicit retry");
    if (!lateReceipt) assert.equal(inputs[1].method, "turn/start");
    assert.equal((await request("retry-delivered", "thread/queue/retry", { threadId, queuedSubmissionId: queuedId, expectedTurnId: targetTurnId })).error, undefined);
    const final = (await request("final", "test/readAcceptedInputs", {})).result as any;
    assert.equal(final.data.length, after.data.length, "a lost retry receipt is idempotent");
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("Host queue starts the next turn after completion without sending a native queue RPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-drain-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await request("thread", "thread/start", { cwd: root });
    const first = await request("turn", "turn/start", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const firstTurnId = (first.result as any).turn.id;
    await request("add", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "next" }], clientUserMessageId: "next",
    });
    await request("complete", "test/completeTurn", { threadId: "fixture-thread-1" });
    const second = await waitFor(frames, frame => frame.method === "turn/started" && (frame.params as any).turn.id !== firstTurnId);
    assert.ok((second.params as any).turn.id);
    const listed = await request("listed", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.deepEqual((listed.result as any).data, []);
    assert.deepEqual((listed.result as any).steering, []);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("last viewer leaving preserves background turns and queued work until the Host can safely release native subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-background-subscription-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, 10);
  let sequence = 0;
  const request = async (clientId: string, method: string, params: Record<string, unknown>) => {
    const id = `request-${++sequence}`;
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  const threadId = "fixture-thread-1";
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await request("client-a", "thread/start", { cwd: root });
    await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.method === "serverRequest/resolved");
    await request("client-a", "turn/start", { threadId, input: [{ type: "text", text: "first" }], clientUserMessageId: "first" });
    await request("client-a", "thread/queue/add", { threadId, input: [{ type: "text", text: "second" }], clientUserMessageId: "second" });
    await request("client-a", "thread/unsubscribe", { threadId });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual((await request("client-b", "test/emitThreadNotification", { threadId })).result, { nativeSubscribed: true });
    await request("client-b", "test/completeTurn", { threadId });
    let queueDrained = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await request("client-b", "thread/queue/list", { threadId });
      if ((listed.result as any).data.length === 0 && (listed.result as any).steering.length === 0) {
        queueDrained = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(queueDrained, true);
    const running = await request("client-b", "thread/read", { threadId, includeTurns: false, watch: true });
    assert.equal((running.result as any).thread.status.type, "active");
    assert.deepEqual((await request("client-b", "test/emitThreadNotification", { threadId })).result, { nativeSubscribed: true });
    await request("client-b", "test/completeTurn", { threadId });
    let released = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const probe = await request("client-b", "test/emitThreadNotification", { threadId });
      if ((probe.result as any).nativeSubscribed === false) { released = true; break; }
    }
    assert.equal(released, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a closed client releases its thread subscriptions and native Codex context", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-disconnect-release-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, 10);
  const threadId = "fixture-thread-1";
  let sequence = 0;
  const request = async (clientId: string, method: string, params: Record<string, unknown>) => {
    const id = `disconnect-${++sequence}`;
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await request("client-a", "thread/start", { cwd: root });
    await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.method === "serverRequest/resolved");
    assert.deepEqual((await request("client-a", "test/emitThreadNotification", { threadId })).result, { nativeSubscribed: true });
    await request("client-a", "turn/start", { threadId, input: [{ type: "text", text: "accepted" }], clientUserMessageId: "disconnect-input" });
    await request("client-a", "test/completeTurn", { threadId });
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    let released = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const probe = await request("client-b", "test/emitThreadNotification", { threadId });
      if ((probe.result as { nativeSubscribed?: boolean }).nativeSubscribed === false) { released = true; break; }
    }
    assert.equal(released, true, "the disconnected client no longer retains the native Thread subscription");
    assert.equal(frames.some(frame => frame[LOGICAL_CLIENT_FIELD] === "client-a"
      && frame.method === "thread/started"), true, "the prior subscription remains observable history");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("definitive Codex steer rejection releases the Host claim without losing the queued item", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-reject-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await request("thread", "thread/start", { cwd: root });
    await request("turn", "turn/start", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const added = await request("add", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "follow" }], clientUserMessageId: "follow",
    });
    const queuedId = (added.result as any).queuedSubmission.id;
    const rejected = await request("steer", "thread/queue/steer", {
      threadId: "fixture-thread-1", queuedSubmissionId: queuedId, expectedTurnId: "stale-turn",
    });
    assert.ok(rejected.error);
    const listed = await request("listed", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.equal((listed.result as any).data[0].id, queuedId);
    assert.deepEqual((listed.result as any).steering, []);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restart preserves an unconfirmed input without blocking the next queued turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-restart-"));
  const dataRoot = join(root, "data");
  await mkdir(dataRoot);
  const queue = new OpenCraftHostQueue(dataRoot);
  const uncertain = queue.add("fixture-thread-1", "uncertain", [{ type: "text", text: "maybe" }]);
  queue.claim("fixture-thread-1", uncertain.id, "turn-old");
  queue.add("fixture-thread-1", "later", [{ type: "text", text: "later" }]);
  queue.close();
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await adapter.send(JSON.stringify({ id: "list", method: "thread/queue/list", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const listed = await waitFor(frames, frame => frame.id === "list");
    assert.equal((listed.result as any).steering[0].id, uncertain.id);
    assert.equal((listed.result as any).steering[0].pausedReason, "steer-delivery-unconfirmed");
    // Maintenance can already have dispatched this row before list returns.
    // Verify durable identity and actual one-time native delivery, not a stale queued snapshot.
    assert.equal((adapter as any).queueStore().findByClientId("fixture-thread-1", "later")?.clientUserMessageId, "later");
    await waitFor(frames, () => (adapter as any).queueStore().findByClientId("fixture-thread-1", "later")?.state === "delivered");
    assert.equal((adapter as any).queueStore().find("fixture-thread-1", uncertain.id)?.state, "unknown");
    await adapter.send(JSON.stringify({ id: "accepted", method: "test/readAcceptedInputs", params: {}, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const accepted = (await waitFor(frames, frame => frame.id === "accepted")).result as any;
    assert.deepEqual(accepted.data.map((input: any) => input.params.clientUserMessageId), ["later"]);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host resumes an unloaded Codex thread and drains a durable queued message without a browser subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-background-"));
  const dataRoot = join(root, "data");
  await mkdir(dataRoot);
  const queue = new OpenCraftHostQueue(dataRoot);
  queue.add("fixture-thread-1", "background", [{ type: "text", text: "continue" }]);
  queue.close();
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    let cleared = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const id = `list-${attempt}`;
      await adapter.send(JSON.stringify({ id, method: "thread/queue/list", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
      const listed = await waitFor(frames, frame => frame.id === id);
      if ((listed.result as any).data.length === 0 && (listed.result as any).steering.length === 0) { cleared = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(cleared, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Fork subscribes only its requester to the child and late disconnected responses cannot reclaim it", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-fork-routing-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await adapter.send(JSON.stringify({ id: "a:start", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:start");
    await adapter.send(JSON.stringify({ id: "a:fork", method: "thread/fork", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const forked = await waitFor(frames, frame => frame.id === "a:fork");
    assert.equal((forked.result as any).thread.id, "fixture-fork-1");
    const childStarted = await waitFor(frames, frame => frame.method === "thread/started" && (frame.params as any).thread.id === "fixture-fork-1");
    assert.equal(childStarted[LOGICAL_CLIENT_FIELD], "client-a");
    assert.equal(frames.some(frame => frame.method === "thread/started" && (frame.params as any).thread.id === "fixture-fork-1" && frame[LOGICAL_CLIENT_FIELD] === "client-b"), false);
    await adapter.send(JSON.stringify({ id: "a:failed-fork", method: "thread/fork", params: { threadId: "fixture-thread-1", testFail: true }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const rejected = await waitFor(frames, frame => frame.id === "a:failed-fork");
    assert.match((rejected.error as { message: string }).message, /fork rejected/);
    assert.equal(frames.filter(frame => frame.method === "thread/started" && (frame.params as any).thread.id !== "fixture-thread-1").length, 1);
    await adapter.send(JSON.stringify({ id: "b:late-fork", method: "thread/fork", params: { threadId: "fixture-thread-1", testDelayMs: 50 }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "b:late-fork"), false);
    await adapter.send(JSON.stringify({ id: "a:emit", method: "test/emitServerRequest", params: { threadId: "fixture-fork-late" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const emitted = await waitFor(frames, frame => frame.id === "a:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending Codex server requests follow the resumed Thread owner, not an arbitrary connected client", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-routing-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, 10);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await adapter.send(JSON.stringify({ id: "a:start", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:start");
    const original = await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    assert.equal(original[LOGICAL_CLIENT_FIELD], "client-a");

    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await new Promise(resolve => setTimeout(resolve, 40));
    await adapter.send(JSON.stringify({ id: "b:probe", method: "test/emitThreadNotification", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:probe")).result, { nativeSubscribed: true });
    await adapter.send(JSON.stringify({ id: "b:emit", method: "test/emitServerRequest", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const emitted = await waitFor(frames, frame => frame.id === "b:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await adapter.send(JSON.stringify({ id: requestId, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-b" }));

    await initializeClient(adapter, frames, "client-c");
    await adapter.send(JSON.stringify({ id: "c:resume", method: "thread/resume", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-c" }));
    await waitFor(frames, frame => frame.id === "c:resume");
    const replayedOriginal = frames.filter(frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    assert.deepEqual(replayedOriginal.map(frame => frame[LOGICAL_CLIENT_FIELD]), ["client-a", "client-c"]);
    const replayedNew = frames.filter(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput");
    assert.deepEqual(replayedNew.map(frame => frame[LOGICAL_CLIENT_FIELD]), ["client-c"]);
    assert.equal(frames.some(frame => frame.method === "serverRequest/resolved"), false);

    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-c" }));
    await adapter.send(JSON.stringify({ id: requestId, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-c" }));
    await waitFor(frames, frame => frame.method === "serverRequest/resolved" && (frame.params as any).requestId === requestId);
    const resolved = frames.filter(frame => frame.method === "serverRequest/resolved");
    assert.deepEqual(resolved.map(frame => (frame.params as any).requestId), [900, requestId]);
    assert.ok(resolved.every(frame => frame[LOGICAL_CLIENT_FIELD] === "client-c"));
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a late Thread resume response cannot reclaim ownership for a disconnected client", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-late-resume-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await adapter.send(JSON.stringify({ id: "a:resume", method: "thread/resume", params: { threadId: "fixture-thread-1", testDelayMs: 50 }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "a:resume"), false);
    await adapter.send(JSON.stringify({ id: "b:emit", method: "test/emitServerRequest", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const emitted = await waitFor(frames, frame => frame.id === "b:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);

    await adapter.send(JSON.stringify({ id: "b:wrong-resume", method: "thread/resume", params: { threadId: "fixture-thread-1", testWrongThreadId: true }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await waitFor(frames, frame => frame.id === "b:wrong-resume");
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);

    await adapter.send(JSON.stringify({ id: "b:resume", method: "thread/resume", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await waitFor(frames, frame => frame.id === "b:resume");
    const request = await waitFor(frames, frame => frame.id === requestId && frame.method === "item/tool/requestUserInput");
    assert.equal(request[LOGICAL_CLIENT_FIELD], "client-b");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("enabling a Codex account returns before background subscription usage refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-enable-"));
  const dataDirectory = join(root, "data");
  const store = new AccountPoolStore({
    databasePath: join(dataDirectory, "account-pool.sqlite"),
    secretsDirectory: join(dataDirectory, "secrets"),
  });
  store.addAccount({
    id: "account-a",
    provider: "codex",
    label: "A",
    upstreamAccountId: "chatgpt-a",
    priority: 1,
    enabled: false,
  }, { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: null });
  store.close();
  let releaseUsage!: (response: Response) => void;
  const usage = new Promise<Response>(resolve => { releaseUsage = resolve; });
  const frames: Array<Record<string, unknown>> = [];
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: root,
    dataDirectory,
    nativeCodexHomeDirectory: join(root, "native-codex"),
    upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    fetch: async input => String(input).includes("/wham/usage") ? usage : Response.json({ ok: true }),
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
    createMaintenanceClient: async () => { throw new Error("not used"); },
  });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  try {
    await adapter.connect();
    await adapter.send(JSON.stringify({
      id: "enable",
      method: "opencraft/codex/accounts/setEnabled",
      params: { accountId: "account-a", enabled: true },
      [LOGICAL_CLIENT_FIELD]: "client-a",
    }));
    const response = await waitFor(frames, frame => frame.id === "enable");
    assert.equal((response.result as any).accounts[0].enabled, true);
    assert.equal((response.result as any).accounts[0].status, "ready");
    const refreshing = adapter.send(JSON.stringify({
      id: "quota-refresh", method: "opencraft/codex/accounts/refresh", params: { accountId: "account-a" },
      [LOGICAL_CLIENT_FIELD]: "client-a",
    }));
    releaseUsage(Response.json({ plan_type: "pro", rate_limit_reset_credits: { available_count: 3 },
      rate_limit: { primary_window: { used_percent: 5 } } }));
    await refreshing;
    const refreshed = await waitFor(frames, frame => frame.id === "quota-refresh");
    assert.equal((refreshed.result as any).accounts[0].resetCredits.availableCount, 3);
    assert.ok((refreshed.result as any).accounts[0].resetCredits.observedAt > 0);
    assert.doesNotMatch(JSON.stringify(refreshed), /access-a|refresh-a/);
  } finally {
    releaseUsage(Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 5 } } }));
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host binds each submission to its trusted sender and keeps queued authors through another client's dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-message-senders-integration-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const a = { kind: "employee" as const, loginName: "employee.a" };
  const b = { kind: "employee" as const, loginName: "employee.b" };
  let seq = 0;
  const request = async (client: string, method: string, params: Record<string, unknown>, sender = a, validUntil = Date.now() + 60_000) => {
    const id = `sender-${++seq}`;
    await adapter.sendWithContext(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }), { sender, validUntil, executionPrincipal: { provider: "employee", subject: sender === a ? "staff-A" : "staff-B", loginName: sender.loginName } });
    return await waitFor(frames, frame => frame.id === id) as any;
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "a"); await initializeClient(adapter, frames, "b");
    const threadId = (await request("a", "thread/start", { testNoServerRequest: true })).result.thread.id;
    const first = await request("a", "turn/start", { threadId, clientUserMessageId: "first", input: [{ type: "text", text: "one" }], sender: b });
    assert.deepEqual(first.result.__opencraftSubmissionSender, { clientMessageId: "first", sender: a });
    const turnId = first.result.turn.id;
    const steered = await request("b", "turn/steer", { threadId, expectedTurnId: turnId, clientUserMessageId: "second", input: [{ type: "text", text: "two" }] }, b);
    assert.deepEqual(steered.result.__opencraftSubmissionSender, { clientMessageId: "second", sender: b });
    const added = await request("a", "thread/queue/add", { threadId, clientUserMessageId: "third", input: [{ type: "text", text: "three" }] });
    assert.deepEqual(added.result.queuedSubmission.sender, a);
    assert.deepEqual(added.result.__opencraftSubmissionSender, { clientMessageId: "third", sender: a });
    // A repeat ID from another employee must not change authorship or reach native Codex.
    const collision = await request("b", "turn/steer", { threadId, expectedTurnId: turnId, clientUserMessageId: "first", input: [{ type: "text", text: "overwrite" }] }, b);
    assert.match(collision.error.message, /another sender/);
    const expired = await request("a", "turn/steer", { threadId, expectedTurnId: turnId, clientUserMessageId: "expired", input: [{ type: "text", text: "expired" }] }, a, Date.now() - 1);
    assert.match(expired.error.message, /expired/);
    // Explicit queue steer is initiated by B, while the queued message remains A's.
    assert.ok((await request("b", "thread/queue/steer", { threadId, expectedTurnId: turnId, queuedSubmissionId: added.result.queuedSubmission.id }, b)).result);
    const history = (await request("b", "thread/items/list", { threadId }, b)).result.data;
    assert.deepEqual(history.map((entry: any) => entry.item.sender), [a, b, a]);
    const native = (await request("a", "test/readAcceptedInputs", {})).result.data;
    assert.deepEqual(native.map((entry: any) => entry.params.input[0].text), ["one", "two", "three"]);
    assert.doesNotMatch(JSON.stringify(native), /employee\.|loginName|staffId|"sender"/);
    const state = new DatabaseSync(join(root, "data/opencraft-host-state.sqlite"), { readOnly: true });
    try {
      const leases = state.prepare("SELECT l.turn_id,s.principal_json FROM execution_leases l JOIN execution_submissions s USING(thread_id,input_id) WHERE l.thread_id=?").all(threadId);
      assert.equal(leases.length, 1); assert.equal(leases[0].turn_id, turnId);
      assert.equal(JSON.parse(String(leases[0].principal_json)).subject, "staff-A", "B steer cannot replace running A execution");
      assert.equal(JSON.parse(String(state.prepare("SELECT principal_json FROM execution_submissions WHERE thread_id=? AND input_id='second'").get(threadId)!.principal_json)).subject, "staff-B");
      assert.equal(JSON.parse(String(state.prepare("SELECT principal_json FROM execution_submissions WHERE thread_id=? AND input_id='third'").get(threadId)!.principal_json)).subject, "staff-A");
    } finally { state.close(); }
    const withoutId = await request("a", "turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "no id" }] });
    assert.match(withoutId.error.message, /Message identity/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("product permission modes bind native sandbox and approvals on create, update, resume, fork and turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-permission-policy-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  let sequence = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = `permissions:${++sequence}`;
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, frame => frame.id === id);
    assert.equal(response.error, undefined); return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = (await request("thread/start", { cwd: root, testNoServerRequest: true,
      permissions: "opencraft:permission-mode:full" })).thread.id;
    await request("thread/settings/update", { threadId, permissions: "opencraft:permission-mode:accept-edits" });
    await request("thread/resume", { threadId, permissions: "opencraft:permission-mode:full" });
    await request("thread/settings/update", { threadId, permissions: "opencraft:permission-mode:read-only" });
    await request("thread/fork", { threadId, permissions: "opencraft:permission-mode:full" });
    await request("turn/start", { threadId, input: [{ type: "text", text: "test" }],
      permissions: "opencraft:permission-mode:full" });
    await request("thread/settings/update", { threadId, permissions: "team-custom", approvalPolicy: "on-request" });
    await request("thread/settings/update", { threadId, permissions: ":danger-full-access", approvalPolicy: "on-request" });
    const rows = (await request("test/readPermissionRequests", {})).data;
    assert.deepEqual(rows.map((row: any) => [row.method, row.params.permissions, row.params.approvalPolicy]), [
      ["thread/start", ":danger-full-access", "never"],
      ["thread/settings/update", ":workspace", "on-request"],
      ["thread/resume", ":danger-full-access", "never"],
      ["thread/settings/update", ":read-only", "on-request"],
      ["thread/fork", ":danger-full-access", "never"],
      ["turn/start", ":danger-full-access", "never"],
      ["thread/settings/update", "team-custom", "on-request"],
      ["thread/settings/update", ":danger-full-access", "on-request"],
    ]);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("scheduled permission snapshots reach native Codex and survive adapter recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-schedule-permissions-"));
  let frames: Array<Record<string, unknown>> = [], adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, frame => frame.id === id);
    assert.equal(response.error, undefined); return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = (await request("schedule:create", "thread/start", { cwd: root, testNoServerRequest: true })).thread.id;
    const view = await request("schedule:read", "opencraft/schedules/read", { threadId });
    assert.ok(view.permissionProfiles.some((profile: any) => profile.id === "opencraft:permission-mode:full" && profile.allowed));
    await request("schedule:save", "opencraft/schedules/save", { threadId, expectedRevision: 0, prompt: "scheduled check",
      nextRunAt: Date.now() + 60000, intervalMinutes: 60, timeZone: "UTC", permissions: "opencraft:permission-mode:full" });
    await adapter.close(); frames = []; adapter = createRoutingAdapter(root, frames);
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const restored = await request("schedule:restored", "opencraft/schedules/read", { threadId });
    assert.equal(restored.schedule.permissions, "opencraft:permission-mode:full");
    await request("schedule:now", "opencraft/schedules/action", { threadId, expectedRevision: restored.schedule.revision, action: "run-now" });
    let inputs: any[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      inputs = (await request(`schedule:inputs:${attempt}`, "test/readAcceptedInputs", {})).data;
      if (inputs.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(inputs.length, 1);
    assert.equal(inputs.at(-1).params.permissions, ":danger-full-access");
    assert.equal(inputs.at(-1).params.approvalPolicy, "never");
    assert.match(inputs.at(-1).params.clientUserMessageId, /^schedule:/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});



test("native auth rejection fails initialization before a logical client becomes ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-native-auth-reject-"));
  const frames: Record<string, unknown>[] = [];
  const adapter = new CodexEngineAdapter({ executable: process.execPath, runtimeDirectory: root,
    dataDirectory: join(root, "data"), nativeCodexHomeDirectory: join(root, "native"),
    fetch: async () => Response.json({}), logDiagnostic: () => undefined,
    createMaintenanceClient: async () => { throw new Error("not used"); },
    spawnAppServer: ({ cwd, env }) => {
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_API_KEY, undefined);
      return spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname],
        { cwd, env: { ...env, OPENCRAFT_TEST_REJECT_POOL_AUTH: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    },
  });
  adapter.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  try {
    await adapter.connect();
    await adapter.send(JSON.stringify({ id: "native-auth", method: "initialize", params: {
      clientInfo: { name: "test", version: "1" }, capabilities: { experimentalApi: true },
    }, [LOGICAL_CLIENT_FIELD]: "client" }));
    const result = await waitFor(frames, frame => frame.id === "native-auth");
    assert.equal(result.result, undefined);
    assert.equal((result.error as any).message, "Codex initialization failed");
    assert.equal(adapter.status.state, "failed");
    assert.doesNotMatch(JSON.stringify(frames), /accessToken|eyJhbGci/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});



test("native input waits for the durable usage attempt",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-usage-durable-forward-")),frames:Array<Record<string,unknown>>=[];
 const adapter=createRoutingAdapter(root,frames);let release!:()=>void,entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const durable=new Promise<void>(resolve=>{release=resolve;});
 const request=async(id:string,method:string,params:Record<string,unknown>)=>{
  await adapter.send(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:"writer"}));return await waitFor(frames,f=>f.id===id) as any;
 };
 try{
  await adapter.connect();await initializeClient(adapter,frames,"writer");
  const threadId=(await request("durable-thread","thread/start",{testNoServerRequest:true})).result.thread.id;
  const runtime=(adapter as any).tokenUsage,original=runtime.attempt.bind(runtime);
  runtime.attempt=(...args:any[])=>{entered();return durable.then(()=>original(...args));};
  const sending=adapter.send(JSON.stringify({id:"durable-input",method:"turn/start",params:{threadId,clientUserMessageId:"durable-input",input:[{type:"text",text:"synthetic"}]},[LOGICAL_CLIENT_FIELD]:"writer"}));
  await started;await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await request("before-durable","test/readAcceptedInputs",{})).result.data.length,0);
  release();await sending;
  assert.ok((await waitFor(frames,f=>f.id==="durable-input") as any).result);
  assert.equal((await request("after-durable","test/readAcceptedInputs",{})).result.data.length,1);
  const retiredThread=(await request("retire-thread","thread/start",{testNoServerRequest:true})).result.thread.id;
  let releaseRetired!:()=>void,enteredRetired!:()=>void;
  const retiredEntered=new Promise<void>(resolve=>{enteredRetired=resolve;});
  runtime.attempt=(...args:any[])=>{enteredRetired();return new Promise<void>(resolve=>{releaseRetired=()=>{original(...args);resolve();};});};
  const retired=adapter.send(JSON.stringify({id:"retired-input",method:"turn/start",params:{threadId:retiredThread,clientUserMessageId:"retired-input",input:[{type:"text",text:"synthetic"}]},[LOGICAL_CLIENT_FIELD]:"writer"}));
  await Promise.race([retiredEntered,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Retired input did not reach usage attempt")),2000))]);(adapter as any).disconnectClient("writer");releaseRetired();await retired;
  await initializeClient(adapter,frames,"observer");
  await adapter.send(JSON.stringify({id:"after-retired",method:"test/readAcceptedInputs",params:{},[LOGICAL_CLIENT_FIELD]:"observer"}));
  assert.equal((await waitFor(frames,f=>f.id==="after-retired") as any).result.data.length,1);
  assert.equal(runtime.ledger.state.database.prepare("SELECT outcome FROM token_usage_attempts WHERE input_id='retired-input'").get().outcome,"rejected");
 }finally{release?.();await adapter.close();await rm(root,{recursive:true,force:true});}
});

test("usage attempts follow the actual queue dispatcher and retain definitive rejection outcomes",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-usage-attempt-host-")),frames:Array<Record<string,unknown>>=[];
 const adapter=createRoutingAdapter(root,frames,0,undefined,undefined,undefined,false,{serverId:"fixture",queryWorkerEntry:new URL("../../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url).pathname,actor:context=>({id:context.actorId,kind:"human"}),submission:(threadId,inputId)=>inputId.startsWith("queued-")?{threadId,inputId,actorId:"A",actorKind:"human",mode:"start",sourceKind:"human",submittedAt:1000}:null});
 let seq=0;
 const request=async(actorId:string,method:string,params:Record<string,unknown>)=>{
  const id="usage-attempt:"+(++seq);
  await adapter.sendWithContext(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:actorId}),{sender:null,actorContext:{actorId,generation:1,credentialId:null,expiresAt:Date.now()+60000}});
  return await waitFor(frames,f=>f.id===id) as any;
 };
 try{
  await adapter.connect();await initializeClient(adapter,frames,"A");await initializeClient(adapter,frames,"B");
  const threadId=(await request("A","thread/start",{testNoServerRequest:true})).result.thread.id;
  const turnId=(await request("A","turn/start",{threadId,clientUserMessageId:"start-A",input:[{type:"text",text:"synthetic"}]})).result.turn.id;
  const queued=(await request("A","thread/queue/add",{threadId,clientUserMessageId:"queued-A",input:[{type:"text",text:"synthetic"}]})).result.queuedSubmission;
  assert.ok((await request("B","thread/queue/steer",{threadId,queuedSubmissionId:queued.id,expectedTurnId:turnId})).result);
  const rejected=await request("B","turn/steer",{threadId,clientUserMessageId:"rejected-B",expectedTurnId:"different-turn",input:[{type:"text",text:"synthetic"}]});
  assert.equal(rejected.result.disposition,"queued","definitive stale-Turn rejection retains Host custody for a fresh Turn");
  const db=new DatabaseSync(join(root,"data","token-usage.sqlite"),{readOnly:true});
  try{
   // Native ACK presentation and the ordered metadata commit are asynchronous.
   // Wait for the latest durable outcome before comparing final accounting.
   const outcomeDeadline=Date.now()+2000;
   while(Date.now()<outcomeDeadline&&db.prepare("SELECT outcome FROM token_usage_attempts WHERE input_id='rejected-B'").get()?.outcome!=="rejected")await new Promise(resolve=>setTimeout(resolve,5));
   const dispatched=db.prepare("SELECT actor_id,mode,outcome,turn_id FROM token_usage_attempts WHERE input_id='queued-A'").get()!;
   assert.deepEqual({...dispatched},{actor_id:"B",mode:"steer",outcome:"accepted",turn_id:turnId});
   assert.equal(db.prepare("SELECT actor_id FROM token_usage_submissions WHERE input_id='queued-A'").get()!.actor_id,"B");
   assert.equal(db.prepare("SELECT outcome FROM token_usage_attempts WHERE input_id='rejected-B'").get()!.outcome,"rejected");
   assert.equal(db.prepare("SELECT count(*) AS n FROM token_usage_admissions WHERE input_id='rejected-B'").get()!.n,0);
   const fallback=(await request("A","thread/queue/add",{threadId,clientUserMessageId:"queued-fallback",input:[{type:"text",text:"synthetic"}]})).result.queuedSubmission;
   assert.ok((await request("B","thread/queue/steer",{threadId,queuedSubmissionId:fallback.id,expectedTurnId:"different-turn"})).error);
   await request("A","test/completeTurn",{threadId});
   await waitFor(frames,f=>f.method==='turn/started'&&(f.params as any)?.turn?.id!==turnId);
   // The stale direct steer is now retained as an earlier queued intention.
   // Finish that newly admitted Turn before the later fallback can run.
   await request("A","test/completeTurn",{threadId});
   const deadline=Date.now()+3000;
   while(Date.now()<deadline&&!db.prepare("SELECT 1 FROM token_usage_attempts WHERE input_id='queued-fallback' AND outcome='accepted'").get())await new Promise(resolve=>setTimeout(resolve,10));
   const attempts=db.prepare("SELECT actor_id,mode,outcome FROM token_usage_attempts WHERE input_id='queued-fallback' ORDER BY submitted_ms,attempt_id").all();
   assert.equal(attempts.length,2);
   assert.ok(attempts.some(row=>row.actor_id==="B"&&row.mode==="steer"&&row.outcome==="rejected"));
   assert.ok(attempts.some(row=>row.actor_id==="A"&&row.mode==="start"&&row.outcome==="accepted"));
   assert.equal(db.prepare("SELECT count(*) AS n FROM token_usage_input_conflicts WHERE input_id='queued-fallback'").get()!.n,0);
  }finally{db.close();}
 }finally{await adapter.close();await rm(root,{recursive:true,force:true});}
});

test("ambiguous native rejection remains unknown and exposes a recovery gap",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-usage-unknown-host-")),frames:Array<Record<string,unknown>>=[];
 const adapter=createRoutingAdapter(root,frames,0,"ambiguous");let seq=0;
 const request=async(method:string,params:Record<string,unknown>)=>{
  const id="usage-unknown:"+(++seq);await adapter.send(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:"writer"}));return await waitFor(frames,f=>f.id===id) as any;
 };
 try{
  await adapter.connect();await initializeClient(adapter,frames,"writer");
  // Keep background replay from opening a source-replaced gap for the fixture's
  // synthetic rollout path before the ambiguous submission is observed.
  await request("test/pauseThreadReads",{paused:true});
  const threadId=(await request("thread/start",{testNoServerRequest:true})).result.thread.id;
  const turnId=(await request("turn/start",{threadId,clientUserMessageId:"initial",input:[{type:"text",text:"synthetic"}]})).result.turn.id;
  const before=new DatabaseSync(join(root,"data","token-usage.sqlite"),{readOnly:true});
  try{assert.equal(before.prepare("SELECT count(*) AS n FROM token_usage_gaps WHERE thread_id=? AND ends_ms IS NULL").get(threadId)!.n,0);}
  finally{before.close();}
  assert.ok((await request("turn/steer",{threadId,expectedTurnId:turnId,clientUserMessageId:"uncertain",input:[{type:"text",text:"synthetic"}]})).error);
  const db=new DatabaseSync(join(root,"data","token-usage.sqlite"),{readOnly:true});
  try{
   assert.equal(db.prepare("SELECT outcome FROM token_usage_attempts WHERE input_id='uncertain'").get()!.outcome,"unknown");
   assert.equal(db.prepare("SELECT count(*) AS n FROM token_usage_admissions WHERE input_id='uncertain'").get()!.n,0);
   assert.ok(Number(db.prepare("SELECT count(*) AS n FROM token_usage_gaps WHERE thread_id=? AND ends_ms IS NULL").get(threadId)!.n)>0);
  }finally{db.close();}
  await request("test/pauseThreadReads",{paused:false});
 }finally{await adapter.close();await rm(root,{recursive:true,force:true});}
});

test("scheduled Codex completion is observed from native events without a history read", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-schedule-events-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames); let seq = 0, inspections = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = `schedule-event:${++seq}`; await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, f => f.id === id); assert.equal(response.error, undefined); return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = (await request("thread/start", { cwd: root, testNoServerRequest: true })).thread.id;
    (adapter as any).findScheduledTurn = async () => { inspections++; throw new Error("completion must not read history"); };
    await request("opencraft/schedules/save", { threadId, expectedRevision: 0, prompt: "work", nextRunAt: Date.now(), intervalMinutes: null, timeZone: "UTC" });
    await (adapter as any).schedules.tick();
    const active = await request("opencraft/schedules/read", { threadId }); assert.equal(active.runs[0].state, "running");
    await request("test/completeTurn", { threadId }); await (adapter as any).schedules.tick();
    const done = await request("opencraft/schedules/read", { threadId }); assert.equal(done.runs[0].state, "completed");
    assert.equal(inspections, 0); assert.equal((await request("test/readAcceptedInputs", {})).data.length, 1);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [legacyItems, smallHistoryBudget, unsupportedItems] of [[false, false, false], [true, false, false], [true, true, false], [false, false, true], [false, true, true]]) test(`cached Codex history opens without Resume, models, or ownership (legacy Items=${legacyItems}, small budget=${smallHistoryBudget}, unsupported Items=${unsupportedItems})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-read-cache-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  let sequence = 0;
  const call = async (method: string, params: object) => {
    const id = `read-cache-${++sequence}`;
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "reader" }));
    const reply = await waitFor(frames, frame => frame.id === id);
    assert.equal(reply.error, undefined); return reply.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "reader");
    const nativeHome = (frames.find(frame => frame.id === "reader:init")!.result as any).codexHome;
    const path = join(nativeHome, "history.jsonl"), threadId = "cached-thread";
    await mkdir(nativeHome, { recursive: true });
    const turns = Array.from({ length: 12 }, (_, n) => ({ id: `cached-turn-${n}`, status: "completed", items: [{ id: `answer-${n}`, type: "agentMessage", text: `Historical reply ${n}` }] }));
    await writeFile(path, turns.map(turn => JSON.stringify({ type: "turn_context", payload: { turn_id: turn.id } }) + "\n").join(""));
    await call("test/setHistory", { threadId, path, turns, legacyItems, smallHistoryBudget, unsupportedItems });
    const read = () => call("thread/read", { threadId, watch: true, includeTurns: false, initialTurnsPage: { limit: 10 } });
    const cold = await read(), warm = await read();
    const metadata = await call("thread/read", { threadId, includeTurns: false });
    assert.deepEqual(metadata.thread.id, threadId);
    assert.match(metadata.__opencraftHistoryTiming.pairId, /^[a-f0-9-]{36}$/);
    assert.notEqual(metadata.__opencraftHistoryTiming.pairId, cold.__opencraftHistoryTiming.pairId);
    assert.equal(metadata.__opencraftHistoryTiming.nativeRpcCount, 1);
    assert.equal(metadata.__opencraftHistoryTiming.metadataMs, metadata.__opencraftHistoryTiming.nativeRpcMs);
    assert(metadata.__opencraftHistoryTiming.coreMs >= metadata.__opencraftHistoryTiming.nativeRpcMs);
    assert.equal(metadata.__opencraftHistoryTiming.queueMs, undefined, "direct native reads do not invent cache queue time");
    assert.deepEqual(warm.initialTurnsPage, cold.initialTurnsPage);
    assert.match(cold.__opencraftHistoryTiming.pairId, /^[a-f0-9-]{36}$/);
    assert.notEqual(cold.__opencraftHistoryTiming.pairId, warm.__opencraftHistoryTiming.pairId);
    assert(cold.__opencraftHistoryTiming.nativeRpcCount >= 2);
    assert.equal(warm.__opencraftHistoryTiming.nativeRpcCount, 1);
    for (const key of ["coreMs", "metadataMs", "queueMs", "sourceMs", "reconcileMs", "pageMs", "projectionMs", "nativeRpcMs"]) {
      assert(Number.isFinite(cold.__opencraftHistoryTiming[key]), key);
      assert(cold.__opencraftHistoryTiming[key] >= 0, key);
    }
    assert.deepEqual(cold.initialTurnsPage.data.map((t:any) => ({...t,itemsView:undefined})), turns.slice(-10).reverse().map(t=>({...t,itemsView:undefined})));
    const counts = await call("test/readMethodCounts", {});
    assert.equal(counts["thread/resume"] ?? 0, 0);
    assert.equal(counts["model/list"] ?? 0, 0);
    if (unsupportedItems && smallHistoryBudget) assert.ok(counts["thread/turns/list"] > 2, "legacy full pages shrink to their supported byte budget");
    else assert.equal(counts["thread/turns/list"], unsupportedItems ? 2 : 1, "unsupported Items rebuild through full Turns; supported Items avoid the oversized full page");
    assert.deepEqual((await call("test/emitThreadNotification", { threadId })).nativeSubscribed, false);
    await call("thread/resume", { threadId, excludeTurns: true });
    assert.equal((await call("test/readMethodCounts", {}))["thread/resume"], 1);
    const rows = () => {
      const db = new DatabaseSync(join(root, "data", "cache", "transcript-index.sqlite"), { readOnly: true });
      try { return (db.prepare("SELECT count(*) AS n FROM opencraft_cache_meta").get() as any).n; }
      finally { db.close(); }
    };
    for (const method of ["thread/archived", "thread/deleted"]) {
      await call("test/emitThreadNotification", { threadId, method });
      for (let n = 0; n < 100 && rows(); n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(rows(), 0);
      await read();
    }
    await call("thread/archive", { threadId });
    assert.equal(rows(), 0, "successful archive is reported only after derived cleanup");
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex provider retry classifies terminal native failures and respects stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-retry-native-policy-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  let sequence = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const id = `policy-${++sequence}`;
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, frame => frame.id === id);
    assert.equal(response.error, undefined); return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    for (const code of ["internalServerError", { responseTooManyFailedAttempts: { httpStatusCode: 502 } }, "unauthorized", "sandboxError", "contextWindowExceeded", "usageLimitExceeded"]) {
      const threadId = (await rpc("thread/start", { cwd: root, testNoServerRequest: true })).thread.id;
      const before = (await rpc("test/readAcceptedInputs", {})).data.length;
      await rpc("turn/start", { threadId, input: [{ type: "text", text: "Original task" }] });
      await rpc("test/completeTurn", { threadId, codexErrorInfo: code });
      // Rate-limit discovery runs inside the per-thread lane; wait for that lane to settle.
      await (adapter as any).withThreadOperation(threadId, async () => {});
      const result = await rpc("opencraft/turn-recovery/read", { threadId });
      const expected = code === "internalServerError" || typeof code === "object";
      assert.equal(result.recovery?.state === "scheduled", expected);
      if (expected) {
        await rpc("turn/interrupt", { threadId, turnId: "already-failed" });
        (adapter as any).providerRetry.now = () => Date.now() + 1_000_000;
        await (adapter as any).providerRetry.recover();
        const inputs = (await rpc("test/readAcceptedInputs", {})).data.filter((entry: any) => entry.params.threadId === threadId);
        assert.equal(inputs.length, before + 1, "stop must revoke the automatic continuation");
      }
    }
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex gateway RPC and owner-internal goal/recovery admission both enforce the latest policy", async () => {
 const root=await mkdtemp(join(tmpdir(),"codex-model-policy-"));
 const path=join(root,"policy.sqlite"),store=new ModelPolicyStore(path),frames:Record<string,any>[]=[];
 const adapter=createRoutingAdapter(root,frames);
 (adapter as any).options.modelPolicyPath=path;
 try {
  await adapter.connect();await initializeClient(adapter,frames,"policy-client");
  store.write(0,[{engine:"codex",model:"blocked"}],"admin");
  await adapter.send(JSON.stringify({id:"blocked-turn",method:"turn/start",params:{threadId:"t",model:"blocked",input:[{type:"text",text:"blocked"}]},[LOGICAL_CLIENT_FIELD]:"policy-client"}));
  const denied=await waitFor(frames,f=>f.id==="blocked-turn");assert.equal((denied.error as any).data.code,"model_usage_restricted");
  await assert.rejects((adapter as any).requestPhysical("turn/start",{threadId:"t",model:"blocked",input:[]}),/Contact|restricted/);
  await assert.rejects((adapter as any).requestPhysical("thread/goal/set",{threadId:"t",status:"active"}),/Contact|restricted/);
  await assert.rejects((adapter as any).requestPhysical("turn/start",{threadId:"t",model:"allowed",collaborationMode:{mode:"default",settings:{model:"blocked",reasoning_effort:"high"}},input:[]}),/Contact|restricted/);
  const queued=(adapter as any).queueStore().add("t","policy-queue",[{type:"text",text:"retained"}]);
  await assert.rejects((adapter as any).dispatchQueuedStart("t",queued.id),/Contact|restricted/);
  assert.equal((adapter as any).queueStore().find("t",queued.id).state,"queued");
  assert.equal((adapter as any).queueStore().find("t",queued.id).pausedReason,"model-restricted");
 } finally {await adapter.close();store.close();await rm(root,{recursive:true,force:true});}
});

test("client creation installs MCP and its first input binds execution without a native resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-first-mcp-")), frames: Array<Record<string, unknown>> = [];
  const bound: string[][] = []; let cancelled = 0;
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false, undefined,
    async () => { throw new Error("First input must use its creation credential"); },
    () => ({ configuration: { url: "http://fixture/mcp" }, bind: (...args) => { bound.push(args); }, cancel() { cancelled++; } }));
  const request = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const created = await request("create-mcp", "thread/start", { cwd: root, testNoServerRequest: true });
    const threadId = (created.result as any).thread.id;
    const started = await request("first-input", "turn/start", { threadId, clientUserMessageId: "first-input", input: [{ type: "text", text: "synthetic" }] });
    assert.equal(started.error, undefined);
    assert.ok(bound.length > 0); assert.equal(bound[0]![0], threadId); assert.equal(bound[0]![1], "first-input"); assert.ok(bound[0]![2]);
    const counts = await request("mcp-counts", "test/readMethodCounts", {});
    assert.equal((counts.result as any)["thread/resume"] ?? 0, 0);
    const inputs = await request("mcp-inputs", "test/readAcceptedInputs", {});
    assert.equal((inputs.result as any).data.length, 1);
  } finally { await adapter.close(); assert.equal(cancelled, 1); await rm(root, { recursive: true, force: true }); }
});


test("a disconnected creator cannot leak its pending MCP reservation or send a late thread/start", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-retired-mcp-")), frames: Array<Record<string, unknown>> = [];
  let entered!: () => void, release!: () => void, cancelled = 0;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false, undefined, async () => null,
    async () => { entered(); await gate; return { configuration: { url: "http://fixture/mcp" }, bind() {}, cancel() { cancelled++; } }; });
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const creation = adapter.send(JSON.stringify({ id: "retired-create", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "writer" }));
    await preparing; (adapter as any).disconnectClient("writer"); release(); await assert.rejects(creation, /revoked before native submission/);
    assert.equal(cancelled, 1);
    await initializeClient(adapter, frames, "reader");
    await adapter.send(JSON.stringify({ id: "retired-counts", method: "test/readMethodCounts", params: {}, [LOGICAL_CLIENT_FIELD]: "reader" }));
    const counts = await waitFor(frames, frame => frame.id === "retired-counts");
    assert.equal((counts.result as any)["thread/start"] ?? 0, 0);
  } finally { release(); await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const method of ["thread/start", "thread/fork"] as const) test(`temporary ${method} sends consecutive turns without durable session tools`, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-side-chat-tools-")), frames: Array<Record<string, unknown>> = [];
  let preparations = 0, reservations = 0;
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false, undefined,
    async () => { preparations++; throw new Error("durable provider must not run for temporary chats"); },
    async () => { reservations++; throw new Error("temporary creation must not reserve durable tools"); });
  const rpc = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const created = await rpc("temporary", method, { threadId: "parent", cwd: root, ephemeral: true, testNoServerRequest: true });
    assert.equal(created.error, undefined);
    const threadId = (created.result as any).thread.id;
    for (let index = 0; index < 2; index++) {
      const reply = await rpc(`send-${index}`, "turn/start", { threadId, clientUserMessageId: `side-${index}`, input: [{ type: "text", text: "question" }] });
      assert.equal(reply.error, undefined); assert.ok((reply.result as any).turn.id);
      await rpc(`complete-${index}`, "test/completeTurn", { threadId });
    }
    assert.equal(preparations, 0); assert.equal(reservations, 0);
    const counts = (await rpc("counts", "test/readMethodCounts", {})).result as any;
    assert.equal(counts["turn/start"], 2);
    // Fork reads the parent's choices; the temporary child must never resume
    // from disk or retire its runtime to refresh durable tools.
    assert.equal(counts["thread/resume"] ?? 0, method === "thread/fork" ? 1 : 0);
    assert.equal(counts["thread/unsubscribe"] ?? 0, 0);
    const childCounts = (await rpc("child-counts", "test/readMethodCounts", { threadId })).result as any;
    assert.equal(childCounts["turn/start"], 2);
    assert.equal(childCounts["thread/resume"] ?? 0, 0);
    assert.equal(childCounts["thread/unsubscribe"] ?? 0, 0);
    const parentCounts = (await rpc("parent-counts", "test/readMethodCounts", { threadId: "parent" })).result as any;
    assert.equal(parentCounts["thread/resume"] ?? 0, method === "thread/fork" ? 1 : 0);
    const rejected = await rpc("durable-send", "turn/start", { threadId: "durable", input: [{ type: "text", text: "question" }] });
    assert.equal((rejected.error as any).data.code, "SESSION_TOOLS_UNAVAILABLE"); assert.equal(preparations, 1);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("busy session tools report the actual state and correlate the rejected input without native dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-busy-tools-diagnostics-"));
  const frames: Array<Record<string, unknown>> = [], diagnostics: Array<Record<string, unknown>> = [];
  let configuration: Record<string, unknown> | null = null;
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false, undefined,
    async () => configuration, undefined, event => diagnostics.push(event));
  const rpc = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = ((await rpc("create", "thread/start", { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    assert.equal((await rpc("first", "turn/start", { threadId, clientUserMessageId: "first", input: [] })).error, undefined);
    configuration = { url: "http://fixture/mcp", http_headers: { Authorization: "Bearer fixture-secret" } };
    const rejected = (await rpc("second", "turn/start", { threadId, clientUserMessageId: "second", input: [] })).error as any;
    assert.match(rejected.message, /previous turn is still active/);
    assert.equal(rejected.data.stage, "check-idle");
    assert.equal(rejected.data.reason, "thread-busy");
    assert.equal(rejected.data.nativeStatus, "active");
    assert.equal(rejected.data.submissionOutcome, "rejected");
    const event = diagnostics.find(event => event.diagnosticId === rejected.data.diagnosticId)!;
    assert.equal(event.event, "session-mcp-preparation-failed");
    assert.equal(event.threadId, threadId); assert.equal(event.inputId, "second");
    assert.match(rejected.message, new RegExp(rejected.data.diagnosticId));
    const accepted = (await rpc("inputs", "test/readAcceptedInputs", {})).result as any;
    assert.equal(accepted.data.length, 1);
    assert.equal(JSON.stringify({ rejected, diagnostics }).includes("fixture-secret"), false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [method, stage] of [["thread/read", "read-thread"], ["thread/unsubscribe", "unsubscribe"],
  ["thread/resume", "apply-tools"], ["thread/settings/update", "restore-settings"]] as const)
  test(`session tools preserve a safe native failure at ${stage}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-tools-native-diagnostics-"));
    const diagnostics: Array<Record<string, unknown>> = [];
    const adapter = createRoutingAdapter(root, [], 0, undefined, undefined, undefined, false, undefined,
      async () => ({ url: "http://fixture/mcp" }), undefined, event => diagnostics.push(event));
    const internals = adapter as any;
    let unloaded = false;
    internals.requestPhysical = async (called: string, params: any) => {
      if (called === method && (method !== "thread/resume" || params.config))
        throw Object.assign(new Error("Bearer fixture-secret /private/path"), { code: -32005 });
      if (called === "thread/read") return { thread: { status: { type: unloaded ? "notLoaded" : "idle" } } };
      if (called === "thread/unsubscribe") { unloaded = true; return {}; }
      return { model: "fixture-model", sandbox: { type: "readOnly" } };
    };
    try {
      let failure: unknown;
      try { await internals.prepareSessionMcp("thread", "input", "execution"); } catch (cause) { failure = cause; }
      assert.ok(failure);
      const error = internals.sessionMcpFailure(failure);
      assert.equal(error.data.stage, stage); assert.equal(error.data.reason, "native-rpc-failed");
      assert.equal(error.data.nativeCode, -32005); assert.equal(error.data.submissionOutcome, "rejected");
      const diagnostic = diagnostics.find(event => event.event === "session-mcp-preparation-failed")!;
      assert.equal(diagnostic.diagnosticId, error.data.diagnosticId);
      assert.equal(diagnostic.rpcMethod, method);
      assert.equal(diagnostic.rpcTransport, "child-stdio");
      assert.equal(diagnostic.connectionGeneration, 0);
      assert.equal(diagnostic.nativeErrorHint, "redacted");
      assert.ok(Number.isSafeInteger(diagnostic.rpcElapsedMs) && Number(diagnostic.rpcElapsedMs) >= 0);
      assert.equal(error.data.rpcMethod, undefined, "extra diagnostic context is server-only");
      assert.equal(JSON.stringify({ error, diagnostics }).includes("fixture-secret"), false);
      assert.equal(JSON.stringify({ error, diagnostics }).includes("/private/path"), false);
    } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
  });

for (const [message, expectedHint] of [
  ["list_turns is not supported yet", "turn-history-unsupported"],
  ["Method not found", "method-not-found"],
  ["Unknown method: thread/resume", "method-not-found"],
  ["No client handler for account/chatgptAuthTokens/refresh", "client-handler-missing"],
  ["experimental API is not enabled", "experimental-api-unavailable"],
  ["Bearer fixture-secret /private/path\nrequest payload fixture-prompt", "redacted"],
  ["list_turns is not supported yet: Bearer fixture-secret", "redacted"],
] as const) test(`capture-settings RPC logs only a safe hint: ${expectedHint} (${message.slice(0, 18)})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tools-capture-diagnostics-"));
  const diagnostics: Array<Record<string, unknown>> = [], calls: string[] = [];
  const adapter = createRoutingAdapter(root, [], 0, undefined, undefined, undefined, false, undefined,
    async () => ({ url: "http://fixture/mcp", http_headers: { Authorization: "Bearer fixture-secret" } }),
    undefined, event => diagnostics.push(event));
  const internals = adapter as any;
  const nativeError = Object.assign(new Error(message), { code: -32601,
    data: { credential: "fixture-secret", cwd: "/private/path", input: "fixture-prompt" } });
  internals.requestPhysical = async (method: string, params: any) => {
    calls.push(method);
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    assert.equal(method, "thread/resume");
    assert.equal(params.config, undefined, "failure is settings capture, before tool application");
    throw nativeError;
  };
  try {
    let failure: any;
    try { await internals.prepareSessionMcp("thread", "input", "execution"); } catch (cause) { failure = cause; }
    assert.ok(failure); assert.equal(failure.cause, nativeError, "logging preserves the original cause");
    const error = internals.sessionMcpFailure(failure);
    assert.equal(error.data.stage, "capture-settings");
    assert.equal(error.data.reason, "native-rpc-failed");
    assert.equal(error.data.nativeCode, -32601);
    assert.equal(error.data.submissionOutcome, "rejected");
    assert.deepEqual(calls, ["thread/read", "thread/resume"], "no replay, unsubscribe or input dispatch");
    const events = diagnostics.filter(event => event.event === "session-mcp-preparation-failed");
    assert.equal(events.length, 1, "reuse the existing failure event rather than adding success traffic");
    const event = events[0];
    assert.equal(event.diagnosticId, error.data.diagnosticId);
    assert.equal(event.threadId, "thread"); assert.equal(event.inputId, "input");
    assert.equal(event.nativeStatus, "idle");
    assert.equal(event.rpcMethod, "thread/resume");
    assert.equal(event.nativeErrorHint, expectedHint);
    assert.ok(Number.isSafeInteger(event.rpcElapsedMs) && Number(event.rpcElapsedMs) >= 0);
    assert.equal(error.data.nativeErrorHint, undefined, "native hint is not sent to the browser");
    assert.doesNotMatch(JSON.stringify({ error, diagnostics }), /fixture-secret|fixture-prompt|private\/path|Authorization|credential|stack/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const configured of [false, true]) test(`session refresh refuses unsupported environment handoff even when configured=${configured}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tools-unsupported-environment-"));
  const adapter = createRoutingAdapter(root, [], 0, undefined, undefined, undefined, false, undefined, async () => null);
  const internals = adapter as any, calls: string[] = [];
  internals.options.executionEnvironment = { execution: () => ({}), prepare: async () => ({ toJSON: () => ({ configured }) }), redact: (value: unknown) => value };
  internals.canInjectEnvironment = async () => false;
  internals.requestPhysical = async (method: string) => { calls.push(method); return {}; };
  try {
    let failure: any;
    try { await internals.prepareSessionMcp("thread", "input", "execution"); } catch (cause) { failure = cause; }
    assert.ok(failure, "an empty requested environment cannot attest the Native owner has no retained credentials");
    const error = internals.sessionMcpFailure(failure);
    assert.equal(error.data.stage, "resolve-environment");
    assert.equal(error.data.reason, "environment-handoff-required");
    assert.match(error.message, /contact the host administrator/i);
    assert.equal(error.data.submissionOutcome, "rejected");
    assert.deepEqual(calls, []);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ["unloaded", "missing", "null"] as const) test(`session refresh refuses unknown sandbox permissions: ${scenario}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tools-unknown-sandbox-"));
  const adapter = createRoutingAdapter(root, [], 0, undefined, undefined, undefined, false, undefined,
    async () => ({ url: "http://fixture/mcp" }));
  const internals = adapter as any, calls: string[] = [];
  internals.requestPhysical = async (method: string, params: any) => {
    calls.push(method + (params.config ? ":apply" : ""));
    if (method === "thread/read") return { thread: { status: { type: scenario === "unloaded" ? "notLoaded" : "idle" } } };
    if (method === "thread/resume" && !params.config) return scenario === "null" ? { sandbox: null } : {};
    return {};
  };
  try {
    let failure: any;
    try { await internals.prepareSessionMcp("thread", "input", "execution"); } catch (cause) { failure = cause; }
    assert.ok(failure, "unknown original permission must reject before configuration can change");
    const error = internals.sessionMcpFailure(failure);
    assert.equal(error.data.stage, "preserve-permissions");
    assert.match(error.message, /permissions cannot be verified/i);
    assert.equal(error.data.retryable, false);
    assert.equal(error.data.submissionOutcome, "rejected");
    assert.deepEqual(calls, scenario === "unloaded" ? ["thread/read"] : ["thread/read", "thread/resume"]);
    assert.equal(internals.sessionMcpConfigurations.has("thread"), false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("session tool preparation waits for asynchronous native retirement without an environment provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tools-delayed-retirement-"));
  const adapter = createRoutingAdapter(root, [], 0, undefined, undefined, undefined, false, undefined,
    async () => ({ url: "http://fixture/mcp" }));
  const internals = adapter as any;
  let retired = false, readsAfterRetirement = 0, applied = 0, unsubscribes = 0;
  internals.requestPhysical = async (method: string, params: any) => {
    if (method === "thread/read") return { thread: { status: { type:
      retired && ++readsAfterRetirement >= 2 ? "notLoaded" : "idle" } } };
    if (method === "thread/unsubscribe") { retired = true; unsubscribes++; return {}; }
    if (method === "thread/resume" && params.config) {
      assert.ok(readsAfterRetirement >= 2, "must observe native unload before applying tools");
      applied++;
    }
    return { model: "fixture-model", sandbox: { type: "readOnly" } };
  };
  try {
    await internals.prepareSessionMcp("thread", "input", "execution");
    assert.equal(unsubscribes, 1);
    assert.equal(applied, 1);
    assert.equal(internals.sessionMcpRetirements.has("thread"), false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const state of ["not-found", "archived", "recovering"] as const)
  test(`session tool diagnostic wrapping preserves ${state} classification`, async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-tools-classification-"));
    const adapter = createRoutingAdapter(root, [], 0, undefined, undefined, undefined, false, undefined,
      async () => ({ url: "http://fixture/mcp" }));
    const internals = adapter as any;
    let retired = false;
    internals.requestPhysical = async (method: string) => {
      if (method === "thread/read") {
        if (state !== "recovering") throw Object.assign(new Error(state === "archived"
          ? "Thread fixture is archived /private/path" : "no rollout found for thread id fixture /private/path"), { code: -32600 });
        return { thread: { status: { type: retired ? "active" : "idle" } } };
      }
      if (method === "thread/unsubscribe") retired = true;
      if (method === "thread/resume") return { sandbox: { type: "readOnly" } };
      return {};
    };
    try {
      let failure: unknown;
      try { await internals.prepareSessionMcp("thread", "input", "execution"); } catch (cause) { failure = cause; }
      assert.ok(failure);
      const error = internals.sessionMcpFailure(failure);
      assert.equal(error.data.code, state === "archived" ? "THREAD_ARCHIVED" : state === "not-found" ? "THREAD_NOT_FOUND" : "SESSION_TOOLS_RECOVERING");
      assert.equal(error.data.retryable, state === "recovering");
      assert.equal(error.data.reason, state === "recovering" ? "reconfiguration-pending" : `thread-${state}`);
      assert.equal(error.data.submissionOutcome, "rejected");
      assert.equal(JSON.stringify(error).includes("/private/path"), false);
    } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
  });

for (const transient of [true, false]) test(`queued tool-preflight rejection retains known custody (transient=${transient})`, { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-queue-tools-retry-")), frames: Array<Record<string, unknown>> = [];
  let preparations = 0;
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false, undefined, async () => {
    if (++preparations === 1 || !transient) throw new Error(transient ? "Codex AppServer closed" : "synthetic permanent configuration failure");
    return null;
  });
  const rpc = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = ((await rpc("create", "thread/start", { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    const queued = (await rpc("enqueue", "thread/queue/add", { threadId, clientUserMessageId: "same-input", input: [{ type: "text", text: "看看" }] })).result as any;
    const id = queued.queuedSubmission.id;
    await waitFor(frames, f => f.method === "thread/queue/changed" &&
      (f.params as any).threadId === threadId && (adapter as any).queueStore().find(threadId, id)?.pausedReason ===
      (transient ? "session-tools-recovering" : "session-tools-unavailable"));
    assert.equal((adapter as any).queueStore().find(threadId, id).state, "queued");
    assert.equal(((await rpc("before", "test/readAcceptedInputs", {})).result as any).data.length, 0);
    if (transient) {
      await waitFor(frames, f => f.method === "turn/started");
      const inputs = ((await rpc("after", "test/readAcceptedInputs", {})).result as any).data;
      assert.equal(inputs.length, 1); assert.equal(inputs[0].params.clientUserMessageId, "same-input");
      assert.ok(preparations >= 2);
    } else {
      assert.equal((adapter as any).queuePreparationRetries.size, 0);
      await (adapter as any).maintainQueue(threadId);
      assert.equal(preparations, 1);
    }
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("queue admission during native recovery proves it did not persist or dispatch input", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-queue-admission-recovery-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    (adapter as any).assertDurableQueueThread = async () => { throw new Error("Codex AppServer is not initialized"); };
    await adapter.send(JSON.stringify({ id: "enqueue", method: "thread/queue/add", params: {
      threadId: "fixture", clientUserMessageId: "same-input", input: [{ type: "text", text: "看看" }],
    }, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const reply = await waitFor(frames, f => f.id === "enqueue");
    assert.deepEqual((reply.error as any).data, { code: "QUEUE_NOT_READY", submissionOutcome: "rejected", retryable: true });
    assert.deepEqual((adapter as any).queueStore().list("fixture"), []);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("a queued native send with a lost acknowledgement remains unknown and never schedules a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-queue-unknown-no-replay-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  let sends = 0;
  const rpc = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = ((await rpc("create", "thread/start", { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    const request = (adapter as any).requestPhysical.bind(adapter);
    (adapter as any).requestPhysical = async (method: string, ...args: any[]) => {
      if (method === "turn/start" && ++sends === 1) throw new Error("Native acknowledgement was lost");
      return request(method, ...args);
    };
    const queued = (await rpc("enqueue", "thread/queue/add", { threadId, clientUserMessageId: "uncertain", input: [{ type: "text", text: "one" }] })).result as any;
    await waitFor(frames, f => f.method === "thread/queue/changed" &&
      (adapter as any).queueStore().find(threadId, queued.queuedSubmission.id)?.state === "unknown");
    assert.equal(sends, 1); assert.equal((adapter as any).queuePreparationRetries.size, 0);
    const next = (await rpc("next", "thread/queue/add", { threadId, clientUserMessageId: "subsequent", input: [{ type: "text", text: "two" }] })).result as any;
    await waitFor(frames, () => (adapter as any).queueStore().find(threadId, next.queuedSubmission.id)?.state === "delivered");
    assert.equal(sends, 2, "subsequent input dispatches without retrying the unknown input");
    assert.equal((adapter as any).queueStore().find(threadId, queued.queuedSubmission.id)?.state, "unknown");
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("execution preflight refusal preserves queue custody as unsent and later dispatches the input once", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-preflight-unsent-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames); let sequence = 0;
  const rpc = async (method: string, params: object = {}) => {
    const id = `unsent:${++sequence}`; await adapter.send(JSON.stringify({id, method, params, [LOGICAL_CLIENT_FIELD]: "viewer"}));
    const reply = await waitFor(frames, frame => frame.id === id); assert.equal(reply.error, undefined); return reply.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "viewer"); await rpc("thread/start");
    await rpc("test/refuseExecution", {enabled: true});
    await rpc("thread/queue/add", {threadId: "fixture-thread-1", clientUserMessageId: "new", input: [{type: "text", text: "new"}]});
    let queue: any;
    for (let n = 0; n < 100; n++) {
      const counts = await rpc("test/readMethodCounts"); queue = await rpc("thread/queue/list", {threadId: "fixture-thread-1"});
      if (counts["turn/start"] && queue.data.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(queue.data.length, 1); assert.equal(queue.steering?.length ?? 0, 0);
    assert.equal((await rpc("test/readAcceptedInputs")).data.length, 0);
    await rpc("test/refuseExecution", {enabled: false});
    await rpc("thread/queue/start", {threadId: "fixture-thread-1"});
    let inputs: any[] = [];
    for (let n = 0; n < 200; n++) {inputs = (await rpc("test/readAcceptedInputs")).data; if (inputs.length) break; await new Promise(resolve => setTimeout(resolve, 10));}
    assert.deepEqual(inputs.map(row => row.params.clientUserMessageId), ["new"]);
  } finally {await adapter.close(); await rm(root, {recursive: true, force: true});}
});

test("execution preflight refusal of a queued steer retains the unsent input and its rejection proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-steer-preflight-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames); let sequence = 0;
  const rpc = async (method: string, params: object = {}) => {
    const id = `steer-unsent:${++sequence}`; await adapter.send(JSON.stringify({id, method, params, [LOGICAL_CLIENT_FIELD]: "viewer"}));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "viewer"); await rpc("thread/start");
    const start = await rpc("turn/start", {threadId: "fixture-thread-1", clientUserMessageId: "old", input: [{type: "text", text: "old"}]});
    const queued = await rpc("thread/queue/add", {threadId: "fixture-thread-1", clientUserMessageId: "new", input: [{type: "text", text: "new"}]});
    const params = {threadId: "fixture-thread-1", queuedSubmissionId: (queued.result as any).queuedSubmission.id, expectedTurnId: (start.result as any).turn.id};
    await rpc("test/refuseExecution", {enabled: true});
    const rejected = await rpc("thread/queue/steer", params);
    assert.equal((rejected.error as any).data.notSubmitted, true);
    const list = (await rpc("thread/queue/list", {threadId: "fixture-thread-1"})).result as any;
    assert.equal(list.data[0].id, params.queuedSubmissionId); assert.equal(list.steering?.length ?? 0, 0);
    await rpc("test/refuseExecution", {enabled: false});
    assert.equal((await rpc("thread/queue/steer", params)).error, undefined);
    const inputs = (await rpc("test/readAcceptedInputs")).result as any;
    assert.deepEqual(inputs.data.map((row: any) => row.params.clientUserMessageId), ["old", "new"]);
  } finally {await adapter.close(); await rm(root, {recursive: true, force: true});}
});

for (const [message, expectedHint] of [
  ["list_turns is not supported yet", "turn-history-unsupported"],
  ["Method not found", "method-not-found"],
  ["Unknown method: thread/resume", "method-not-found"],
  ["No client handler for account/chatgptAuthTokens/refresh", "client-handler-missing"],
  ["experimental API is not enabled", "experimental-api-unavailable"],
  ["Bearer fixture-secret /private/path\nrequest payload fixture-prompt", "redacted"],
  ["list_turns is not supported yet: Bearer fixture-secret", "redacted"],
] as const) test(`capture-settings RPC logs only a safe hint: ${expectedHint} (${message.slice(0, 18)})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tools-capture-diagnostics-"));
  const diagnostics: Array<Record<string, unknown>> = [], calls: string[] = [];
  const adapter = createRoutingAdapter(root, [], 0, undefined, undefined, undefined, false, undefined,
    async () => ({ url: "http://fixture/mcp", http_headers: { Authorization: "Bearer fixture-secret" } }),
    undefined, event => diagnostics.push(event));
  const internals = adapter as any;
  const nativeError = Object.assign(new Error(message), { code: -32601,
    data: { credential: "fixture-secret", cwd: "/private/path", input: "fixture-prompt" } });
  internals.requestPhysical = async (method: string, params: any) => {
    calls.push(method);
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    assert.equal(method, "thread/resume");
    assert.equal(params.config, undefined, "failure is settings capture, before tool application");
    throw nativeError;
  };
  try {
    let failure: any;
    try { await internals.prepareSessionMcp("thread", "input", "execution"); } catch (cause) { failure = cause; }
    assert.ok(failure); assert.equal(failure.cause, nativeError, "logging preserves the original cause");
    const error = internals.sessionMcpFailure(failure);
    assert.equal(error.data.stage, "capture-settings");
    assert.equal(error.data.reason, "native-rpc-failed");
    assert.equal(error.data.nativeCode, -32601);
    assert.equal(error.data.submissionOutcome, "rejected");
    assert.deepEqual(calls, ["thread/read", "thread/resume"], "no replay, unsubscribe or input dispatch");
    const events = diagnostics.filter(event => event.event === "session-mcp-preparation-failed");
    assert.equal(events.length, 1, "reuse the existing failure event rather than adding success traffic");
    const event = events[0];
    assert.equal(event.diagnosticId, error.data.diagnosticId);
    assert.equal(event.threadId, "thread"); assert.equal(event.inputId, "input");
    assert.equal(event.nativeStatus, "idle");
    assert.equal(event.rpcMethod, "thread/resume");
    assert.equal(event.nativeErrorHint, expectedHint);
    assert.ok(Number.isSafeInteger(event.rpcElapsedMs) && Number(event.rpcElapsedMs) >= 0);
    assert.equal(error.data.nativeErrorHint, undefined, "native hint is not sent to the browser");
    assert.doesNotMatch(JSON.stringify({ error, diagnostics }), /fixture-secret|fixture-prompt|private\/path|Authorization|credential|stack/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("tool reconfiguration retains original settings until restoration succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-settings-custody-"));
  const adapter = createRoutingAdapter(root, [], 0, undefined, undefined, undefined, false, undefined,
    async () => ({ url: "http://fixture/mcp" }));
  const a = adapter as any;
  let status = "idle", fail = true, unsubscribes = 0, applies = 0;
  let live: Record<string, unknown> = { sandbox: { type: "readOnly" }, model: "fixture", reasoningEffort: "high", collaborationMode: { mode: "plan" } };
  const settings: any[] = [];
  a.requestPhysical = async (method: string, params: any) => {
    if (method === "thread/read") return { thread: { status: { type: status } } };
    if (method === "thread/unsubscribe") { unsubscribes++; status = "notLoaded"; return {}; }
    if (method === "thread/resume") {
      if (params.config) { applies++; status = "idle"; live = { model: "fixture" }; }
      return structuredClone(live);
    }
    if (method === "thread/settings/update") {
      settings.push(structuredClone(params));
      if (fail) { fail = false; throw new Error("fixture settings failure"); }
    }
    return {};
  };
  try {
    await assert.rejects(a.prepareSessionMcp("thread", "input", "execution"));
    assert.equal(a.sessionMcpRetirements.has("thread"), true);
    await a.prepareSessionMcp("thread", "input", "execution");
    assert.deepEqual(settings[1], settings[0]);
    assert.equal(settings[1].effort, "high");
    assert.equal(unsubscribes, 1); assert.equal(applies, 1);
    assert.equal(a.sessionMcpRetirements.has("thread"), false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});


test('internal orchestration creation persists an unowned environment before its first input',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-internal-environment-')),frames:Array<Record<string,unknown>>=[];
 const {EmployeeGitVaultStore}=await import('@opencraft/execution-environment/employee-git-vault-store');
 const {ExecutionEnvironmentRuntime}=await import('@opencraft/execution-environment');
 const {AccountEnvironment}=await import('@opencraft/execution-environment/account-environment');
 const vault=await EmployeeGitVaultStore.open(root),runtime=new ExecutionEnvironmentRuntime(root,vault),adapter=createRoutingAdapter(root,frames),internal=adapter as any;
 internal.options.executionEnvironment=runtime;
 internal.options.spawnAppServer=({cwd,env}:any)=>spawn(process.execPath,[new URL('../fixtures/fake-codex-stdio-appserver.mjs',import.meta.url).pathname],{cwd,env:{...env,OPENCRAFT_TEST_UNLOAD_ON_UNSUBSCRIBE:'1'},stdio:['pipe','pipe','pipe']});
 new AccountEnvironment(vault).replace('employee:alice',{projectId:null},0,[{name:'SERVICE_KEY',value:'synthetic-parent-secret',secret:true}]);
 try{
  await adapter.connect();await initializeClient(adapter,frames,'viewer');
  const created=await internal.requestPhysical('thread/start',{cwd:root,projectId:'delegated-project',testNoServerRequest:true}),threadId=created.thread.id;
  assert.equal(runtime.project('local-codex',threadId),'delegated-project');
  assert.deepEqual(runtime.creator('local-codex',threadId),{account:null});
  assert.ok(internal.provisionalThreads.get(threadId).environmentOwner);
  internal.initialEnvironmentThreads.clear();internal.executionEnvironments.clear();
  await internal.prepareSessionMcp(threadId,'first-input','execution');
  assert.equal(runtime.scope({sender:null,executionPrincipal:{provider:'employee',subject:'alice'},validUntil:Date.now()+60_000},'local-codex',{threadId}).account,'employee:alice');
  assert.deepEqual(runtime.creator('local-codex',threadId),{account:null});
  assert.deepEqual(runtime.snapshot(runtime.execution('local-codex',threadId)).overlay(),{});
  await adapter.send(JSON.stringify({id:'first-input',method:'turn/start',params:{threadId,input:[{type:'text',text:'synthetic delegated work'}],clientUserMessageId:'first-input'},[LOGICAL_CLIENT_FIELD]:'viewer'}));
  const reply=await waitFor(frames,frame=>frame.id==='first-input');assert.ok(reply.result,JSON.stringify(reply.error));
 }finally{await adapter.close();runtime.close();vault.close();await rm(root,{recursive:true,force:true});}
});

for (const lostTerminal of [false,true]) test(`stopped deferred follow-up keeps custody and unobserved context; next intention starts once (lost event=${lostTerminal})`, async()=>{
  const root=await mkdtemp(join(tmpdir(),'codex-input-lifecycle-')),frames:Array<Record<string,unknown>>=[];
  const adapter=createRoutingAdapter(root,frames,0,'defer-history');
  const request=async(id:string,method:string,params:Record<string,unknown>)=>{
    await adapter.send(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'lifecycle-client'}));
    return waitFor(frames,f=>f.id===id);
  };
  try {
    await adapter.connect();await initializeClient(adapter,frames,'lifecycle-client');
    await request('thread','thread/start',{cwd:root});
    const started=await request('start','turn/start',{threadId:'fixture-thread-1',clientUserMessageId:'first',input:[{type:'text',text:'first'}]});
    const turnId=(started.result as any).turn.id;
    const ack=await request('follow','turn/steer',{threadId:'fixture-thread-1',expectedTurnId:turnId,clientUserMessageId:'follow',input:[{type:'text',text:'continue'}]});
    assert.equal((ack.result as any).turnId,turnId);
    await request('stop','test/completeTurn',{threadId:'fixture-thread-1',status:'interrupted',dropDeferredInput:true,suppressNotification:lostTerminal});
    const listed=await request('list','thread/queue/list',{threadId:'fixture-thread-1',receiptTurnIds:[turnId]});
    const received=(listed.result as any).steering.find((x:any)=>x.clientUserMessageId==='follow');
    assert.equal(received.delivery.nativeAdmission,'accepted');
    assert.equal(received.delivery.context,'unobserved');
    assert.equal(received.delivery.execution,'interrupted');
    assert.equal(received.pausedReason,null);
    const later=await request('new-intention',lostTerminal?'turn/steer':'thread/queue/add',{threadId:'fixture-thread-1',expectedTurnId:turnId,clientUserMessageId:'next',input:[{type:'text',text:'continue now'}]});
    if(lostTerminal)assert.equal((later.result as any).disposition,'queued','an exact closed target queues the new intention without native dispatch');
    await waitFor(frames,f=>f.method==='turn/started' && (f.params as any)?.turn?.id!==turnId);
    const turns=await request('turns','thread/turns/list',{threadId:'fixture-thread-1',itemsView:'full'});
    assert.equal((turns.result as any).data.length,2,'one new Turn, never an automatic replay of the old follow-up');
    const duplicate=await request('duplicate','turn/steer',{threadId:'fixture-thread-1',expectedTurnId:turnId,clientUserMessageId:'follow',input:[{type:'text',text:'continue'}]});
    assert.equal((duplicate.result as any).delivery.execution,'interrupted','same delivery identity returns its closed receipt');
    const scoped=await request('scope','thread/queue/list',{threadId:'fixture-thread-1',receiptTurnIds:[]});
    assert.equal((scoped.result as any).steering.some((x:any)=>x.clientUserMessageId==='follow'),false);
  } finally {await adapter.close();await rm(root,{recursive:true,force:true});}
});

test('completed MCP media outputs enter the shared artifact catalog through engine notifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-artifact-output-')), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect(); await initializeClient(adapter, frames, 'viewer');
    const item = { type: 'mcpToolCall', id: 'media-output', status: 'completed', result: { content: [
      { type: 'audio', mimeType: 'audio/wav', data: Buffer.from('audio').toString('base64') },
      { type: 'resource', resource: { mimeType: 'video/mp4', blob: Buffer.from('video').toString('base64') } },
      { type: 'resource', resource: { mimeType: 'application/pdf', blob: Buffer.from('document').toString('base64') } },
    ] } };
    const internals = adapter as any;
    internals.receivePhysicalLine(JSON.stringify({ method: 'item/completed', params: { threadId: 'fixture-thread-1', turnId: 'turn', item } }));
    await Promise.all([...internals.artifactOutputs]);
    const catalog = internals.attachmentStaging.catalog;
    for (const [index, bytes] of ['audio', 'video', 'document'].entries()) {
      const artifact = catalog.get(catalog.id({ scope: 'codex-generated', key: JSON.stringify(['generation', 'fixture-thread-1', item.id, `content:${index}`]) }));
      assert.ok(artifact); assert.equal(await readFile(artifact.path, 'utf8'), bytes);
    }
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('paginated history recovers generated documents without a new generation notification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-artifact-history-')), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'reader' }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, 'reader');
    const threadId = ((await request('create-artifact-history', 'thread/start', { cwd: root, testNoServerRequest: true })).result as any).thread.id;
    const item = { id: 'historical-document', type: 'mcpToolCall', status: 'completed', server: 'fixture', tool: 'document', arguments: {}, result: { content: [{ type: 'resource', resource: { mimeType: 'application/pdf', blob: Buffer.from('history document').toString('base64') } }] } };
    await request('seed-artifact-history', 'test/setHistory', { threadId, legacyItems: true, turns: [{ id: 'history-turn', status: 'completed', items: [item] }] });
    const reply = await request('read-artifact-history', 'thread/read', { threadId, initialTurnsPage: { limit: 1 } });
    assert.equal(reply.error, undefined);
    const internals = adapter as any;
    await Promise.all([...internals.artifactOutputs]);
    const catalog = internals.attachmentStaging.catalog;
    const artifact = catalog.get(catalog.id({ scope: 'codex-generated', key: JSON.stringify(['generation', threadId, item.id, 'content:0']) }));
    assert.ok(artifact); assert.equal(await readFile(artifact.path, 'utf8'), 'history document');
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [nativeMessage, reason, hint] of [
  ["failed to load rules: /private/fixture-secret/.codex/rules: Permission denied (os error 13)", "workspace-access-denied", /Restore workspace permissions/],
  ["exec-server /private/fixture-secret: No such file or directory (os error 2)", "execution-start-unavailable", /workspace mounts/],
] as const) test(`session tools classify ${reason} without exposing native paths or suggesting reconnect`, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tools-filesystem-"));
  const diagnostics: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, [], 0, undefined, undefined, undefined, false, undefined,
    async () => ({ url: "http://fixture/mcp" }), undefined, event => diagnostics.push(event));
  const internals = adapter as any;
  let unloaded = false;
  internals.requestPhysical = async (method: string, params: any) => {
    if (method === "thread/resume" && params.config) throw Object.assign(new Error(nativeMessage), { code: -32000 });
    if (method === "thread/read") return { thread: { status: { type: unloaded ? "notLoaded" : "idle" } } };
    if (method === "thread/unsubscribe") { unloaded = true; return {}; }
    return { model: "fixture-model", sandbox: { type: "readOnly" } };
  };
  try {
    let failure: unknown;
    try { await internals.prepareSessionMcp("thread", "input", "execution"); } catch (cause) { failure = cause; }
    assert.ok(failure);
    const error = internals.sessionMcpFailure(failure);
    assert.equal(error.data.stage, "apply-tools"); assert.equal(error.data.reason, reason);
    assert.equal(error.data.submissionOutcome, "rejected"); assert.equal(error.data.retryable, false);
    assert.match(error.message, hint); assert.doesNotMatch(error.message, /Reconnect/);
    assert.equal(JSON.stringify({ error, diagnostics }).includes("fixture-secret"), false);
    assert.equal(JSON.stringify({ error, diagnostics }).includes("/private/"), false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

async function sharedCredentialAdapter(t: test.TestContext, withMcp = false) {
  const root = await mkdtemp(join(tmpdir(), 'codex-shared-credentials-')), frames: Array<Record<string, unknown>> = [];
  const { EmployeeGitVaultStore } = await import('@opencraft/execution-environment/employee-git-vault-store');
  const { ExecutionEnvironmentRuntime } = await import('@opencraft/execution-environment');
  const { AccountEnvironment } = await import('@opencraft/execution-environment/account-environment');
  const vault = await EmployeeGitVaultStore.open(root), runtime = new ExecutionEnvironmentRuntime(root, vault);
  for (const user of ['alice', 'bob']) new AccountEnvironment(vault).replace('employee:' + user, { projectId: null }, 0, [{ name: 'SERVICE_KEY', value: 'synthetic-' + user, secret: true }]);
  const reservations = { bound: 0, cancelled: 0 };
  const reservation = { configuration: { url: 'http://fixture/creation' }, bind() { reservations.bound++; }, cancel() { reservations.cancelled = 1; } };
  const adapter = createRoutingAdapter(root, frames, 2, undefined, undefined, undefined, false, undefined,
    withMcp ? async (threadId, inputId) => ({ url: 'http://fixture/' + runtime.execution('local-codex', threadId, inputId).account }) : undefined,
    withMcp ? () => reservation : undefined), internal = adapter as any, writes: any[] = [];
  internal.options.executionEnvironment = runtime; internal.options.sharedTurnInput = true; internal.options.dataDirectory = join(root, 'codex');
  internal.options.spawnAppServer = ({ cwd, env }: any) => spawn(process.execPath,
    [new URL('../fixtures/fake-codex-stdio-appserver.mjs', import.meta.url).pathname],
    { cwd, env: { ...env, OPENCRAFT_TEST_NATIVE_QUEUE_STEER: '2', OPENCRAFT_TEST_UNLOAD_ON_UNSUBSCRIBE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const write = internal.writePhysical.bind(internal);
  internal.writePhysical = async (message: any, ...args: any[]) => { writes.push(structuredClone(message)); return write(message, ...args); };
  let sequence = 0;
  const request = async (method: string, params: Record<string, unknown>, user: string | null = null) => {
    const id = 'credential-case:' + ++sequence;
    await adapter.sendWithContext(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'viewer' }),
      { sender: null, ...(user ? { executionPrincipal: { provider: 'employee', subject: user }, validUntil: Date.now() + 60_000 } : {}) });
    return await waitFor(frames, row => row.id === id) as any;
  };
  await adapter.connect(); await initializeClient(adapter, frames, 'viewer');
  t.after(async () => { await adapter.close(); runtime.close(); vault.close(); await rm(root, { recursive: true, force: true }); });
  return { request, runtime, writes, internal, root, frames, reservations, reservation };
}

test('unsupported empty environment rejects a shared participant before Native receives input', async t => {
  const f = await sharedCredentialAdapter(t);
  const threadId = (await f.request('thread/start', { cwd: f.root, testNoServerRequest: true }, 'alice')).result.thread.id;
  f.internal.canInjectEnvironment = async () => false;
  const response = await f.request('turn/start', { threadId, input: [{ type: 'text', text: 'synthetic input' }], clientUserMessageId: 'charlie-first' }, 'charlie');
  assert.equal(response.error?.data?.reason, 'environment-handoff-required');
  assert.equal(response.error?.data?.submissionOutcome, 'rejected');
  assert.equal(f.writes.filter(row => row.method === 'turn/start').length, 0);
  assert.equal(((await f.request('test/readAcceptedInputs', {})).result as any).data.length, 0);
});

for (const creator of ['alice', null]) for (const restored of [false, true])
  test(`shared participant safely replaces creation environment before first input (creator=${creator}, restored=${restored})`, async t => {
    const f = await sharedCredentialAdapter(t, true);
    const threadId = (await f.request('thread/start', { cwd: f.root, testNoServerRequest: true }, creator)).result.thread.id;
    if (restored) { f.internal.initialEnvironmentThreads.clear(); f.internal.executionEnvironments.clear(); f.internal.sessionMcpInitial.clear(); f.internal.options.restoreSessionMcp = () => f.reservations.cancelled ? null : f.reservation; }
    const first = await f.request('turn/start', { threadId, input: [{ type: 'text', text: 'synthetic first input' }], clientUserMessageId: 'bob-first' }, 'bob');
    assert.ok(first.result, JSON.stringify(first.error));
    const config = f.writes.filter(row => row.method === 'thread/resume' && row.params.config).at(-1)?.params.config;
    assert.deepEqual(config?.['shell_environment_policy.set'], { SERVICE_KEY: 'synthetic-bob' });
    assert.equal(config?.['mcp_servers.opencraft_session']?.url, 'http://fixture/employee:bob');
    assert.equal(f.reservations.bound, 0); assert.equal(f.reservations.cancelled, 1);
    assert.deepEqual(f.runtime.creator('local-codex', threadId), { account: creator ? 'employee:' + creator : null });
    assert.equal(f.internal.executionLeases.getSubmission(threadId, 'bob-first').principal.subject, 'bob');
  });

test('shared participants steer and edit queued input without changing execution ownership', async t => {
  const f = await sharedCredentialAdapter(t);
  const threadId = (await f.request('thread/start', { cwd: f.root, testNoServerRequest: true }, 'alice')).result.thread.id;
  const started = await f.request('turn/start', { threadId, input: [{ type: 'text', text: 'synthetic alice work' }], clientUserMessageId: 'alice-start' }, 'alice');
  assert.ok(started.result, JSON.stringify(started.error));
  const before = f.writes.filter(row => row.method === 'turn/steer').length;
  const environmentBefore = f.internal.executionEnvironments.get(threadId);
  const configurationsBefore = f.writes.filter(row => row.method === 'thread/resume' && row.params.config).length;
  const steered = await f.request('turn/steer', { threadId, expectedTurnId: started.result.turn.id, input: [{ type: 'text', text: 'synthetic bob steer' }], clientUserMessageId: 'bob-steer' }, 'bob');
  assert.ok(steered.result, JSON.stringify(steered.error));
  assert.equal(f.writes.filter(row => row.method === 'turn/steer').length, before + 1);
  assert.equal(f.internal.executionEnvironments.get(threadId), environmentBefore);
  assert.equal(environmentBefore.account, 'employee:alice');
  assert.equal(f.writes.filter(row => row.method === 'thread/resume' && row.params.config).length, configurationsBefore);

  const shell = await f.request('thread/shellCommand', { threadId, command: 'synthetic-command' }, 'bob');
  assert.equal(shell.error?.data?.submissionOutcome, 'rejected');
  assert.equal(f.writes.some(row => row.method === 'thread/shellCommand'), false);
  const queued = await f.request('thread/queue/add', { threadId, input: [{ type: 'text', text: 'synthetic bob queued work' }], clientUserMessageId: 'bob-queued' }, 'bob');
  assert.ok(queued.result, JSON.stringify(queued.error));
  const id = queued.result.queuedSubmission.id;
  const changed = await f.request('thread/queue/update', { threadId, queuedSubmissionId: id, input: [{ type: 'text', text: 'synthetic alice replacement' }] }, 'alice');
  assert.ok(changed.result, JSON.stringify(changed.error));
  const preserved = f.internal.queueStore().find(threadId, id);
  assert.equal(preserved.input[0].text, 'synthetic alice replacement');
  assert.equal(preserved.executionSubmission.principal.subject, 'bob');
  await f.request('test/completeTurn', { threadId });
  const next = await waitFor(f.frames, row => row.method === 'turn/started' && (row.params as any)?.threadId === threadId
    && (row.params as any)?.turn?.id !== started.result.turn.id) as any;
  const configuration = f.writes.filter(row => row.method === 'thread/resume' && row.params.config).at(-1)?.params.config;
  assert.deepEqual(configuration?.['shell_environment_policy.set'], { SERVICE_KEY: 'synthetic-bob' });
  assert.equal(f.writes.filter(row => row.method === 'turn/start').at(-1).params.input[0].text, 'synthetic alice replacement');
  const formerOwner = await f.request('turn/steer', { threadId, expectedTurnId: next.params.turn.id,
    input: [{ type: 'text', text: 'synthetic alice steer' }], clientUserMessageId: 'alice-steer-bob' }, 'alice');
  assert.ok(formerOwner.result, JSON.stringify(formerOwner.error));
  assert.equal(f.internal.executionEnvironments.get(threadId).account, 'employee:bob');
  const sameOwner = await f.request('turn/steer', { threadId, expectedTurnId: next.params.turn.id,
    input: [{ type: 'text', text: 'synthetic bob continuation' }], clientUserMessageId: 'bob-own-steer' }, 'bob');
  assert.ok(sameOwner.result, JSON.stringify(sameOwner.error));
  const peerQueued = await f.request('thread/queue/add', { threadId, input: [{ type: 'text', text: 'shared queued steer' }], clientUserMessageId: 'alice-queued-steer' }, 'alice');
  const queuedSteer = await f.request('thread/queue/steer', { threadId, queuedSubmissionId: peerQueued.result.queuedSubmission.id, expectedTurnId: next.params.turn.id }, 'alice');
  assert.ok(queuedSteer.result, JSON.stringify(queuedSteer.error));
  assert.equal(f.internal.executionEnvironments.get(threadId).account, 'employee:bob');
  const stale = await f.request('turn/steer', { threadId, expectedTurnId: 'stale-turn', input: [{ type: 'text', text: 'stale' }], clientUserMessageId: 'alice-stale' }, 'alice');
  assert.equal(stale.result?.disposition, 'queued', 'exact native rejection retains input without retargeting another Turn');
  assert.equal(f.writes.filter(row => row.method === 'turn/steer').at(-1).params.expectedTurnId, 'stale-turn');
  assert.equal(f.internal.executionEnvironments.get(threadId).account, 'employee:bob');
});

for (const reconnected of [false, true]) test(`a failed first-input handoff never restores creator credentials by assumption (reconnected=${reconnected})`, async t => {
  const f = await sharedCredentialAdapter(t);
  const threadId = (await f.request('thread/start', { cwd: f.root, testNoServerRequest: true }, 'alice')).result.thread.id;
  const write = f.internal.writePhysical.bind(f.internal); let failed = false;
  f.internal.writePhysical = async (message: any, ...args: any[]) => {
    if (!failed && message.method === 'thread/settings/update') { failed = true; throw Error('synthetic handoff interruption'); }
    return write(message, ...args);
  };
  const first = await f.request('turn/start', { threadId, input: [{ type: 'text', text: 'synthetic bob work' }], clientUserMessageId: 'bob-failed' }, 'bob');
  assert.equal(first.error?.data?.submissionOutcome, 'rejected');
  assert.equal(f.writes.some(row => row.method === 'turn/start'), false);
  assert.equal(f.writes.filter(row => row.params?.config?.['shell_environment_policy.set']).at(-1)?.params.config['shell_environment_policy.set'].SERVICE_KEY, 'synthetic-bob');
  if (reconnected) { f.internal.executionEnvironments.clear(); f.internal.initialEnvironmentThreads.clear(); f.internal.sessionMcpRetirements.clear(); }
  const second = await f.request('turn/start', { threadId, input: [{ type: 'text', text: 'synthetic alice work' }], clientUserMessageId: 'alice-after-failure' }, 'alice');
  assert.ok(second.result, JSON.stringify(second.error));
  assert.equal(f.writes.filter(row => row.params?.config?.['shell_environment_policy.set']).at(-1)?.params.config['shell_environment_policy.set'].SERVICE_KEY, 'synthetic-alice');
  assert.deepEqual(f.runtime.creator('local-codex', threadId), { account: 'employee:alice' });
});

test('failed environment switching on an existing conversation revokes the previous owner until complete restoration', async t => {
  const f = await sharedCredentialAdapter(t);
  const threadId = (await f.request('thread/start', { cwd: f.root, testNoServerRequest: true }, 'alice')).result.thread.id;
  assert.ok((await f.request('turn/start', { threadId, input: [{ type: 'text', text: 'synthetic alice work' }], clientUserMessageId: 'alice-established' }, 'alice')).result);
  await f.request('test/completeTurn', { threadId });
  const write = f.internal.writePhysical.bind(f.internal); let failed = false;
  f.internal.writePhysical = async (message: any, ...args: any[]) => {
    if (!failed && message.method === 'thread/settings/update') { failed = true; throw Error('synthetic restore interruption'); }
    return write(message, ...args);
  };
  const interrupted = await f.request('turn/start', { threadId, input: [{ type: 'text', text: 'synthetic bob work' }], clientUserMessageId: 'bob-interrupted' }, 'bob');
  assert.equal(interrupted.error?.data?.submissionOutcome, 'rejected');
  assert.equal(f.writes.filter(row => row.params?.config?.['shell_environment_policy.set']).at(-1)?.params.config['shell_environment_policy.set'].SERVICE_KEY, 'synthetic-bob');
  const stale = await f.request('thread/shellCommand', { threadId, command: 'synthetic-command' }, 'alice');
  assert.equal(stale.error?.data?.submissionOutcome, 'rejected');
  assert.equal(f.writes.some(row => row.method === 'thread/shellCommand'), false);
  const steerBefore = f.writes.filter(row => row.method === 'turn/steer').length;
  const unfenced = await f.request('turn/steer', { threadId, expectedTurnId: 'unconfirmed-turn', input: [{ type: 'text', text: 'unconfirmed' }], clientUserMessageId: 'unconfirmed-steer' }, 'alice');
  assert.equal(unfenced.error?.data?.submissionOutcome, 'rejected');
  assert.equal(f.writes.filter(row => row.method === 'turn/steer').length, steerBefore);
  const retried = await f.request('turn/start', { threadId, input: [{ type: 'text', text: 'synthetic bob retry' }], clientUserMessageId: 'bob-restored' }, 'bob');
  assert.ok(retried.result, JSON.stringify(retried.error));
  assert.equal(f.internal.executionEnvironments.get(threadId).account, 'employee:bob');
  assert.deepEqual(f.runtime.creator('local-codex', threadId), { account: 'employee:alice' });
});


test('shared steer retains the active model sponsor and refuses a changed execution at physical admission', async t => {
  const f = await sharedCredentialAdapter(t);
  const threadId = (await f.request('thread/start', { cwd: f.root, testNoServerRequest: true }, 'alice')).result.thread.id;
  const started = await f.request('turn/start', { threadId, input: [{ type: 'text', text: 'alice work' }], clientUserMessageId: 'sponsored-alice' }, 'alice');
  assert.ok(started.result);
  const { ModelGatewayStore } = await import('../../packages/account-pool-host/src/model-gateway-store.js');
  const path = join(f.root, 'model-gateway.sqlite'), store = new ModelGatewayStore(path);
  const prior = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = path;
  t.after(() => { if (prior === undefined) delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE; else process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = prior; store.close(); });
  f.internal.options.collaboration = { started() {}, modelExecutionAuthority: () => ({ authorizer: 'human-bob', executor: null, expiresAt: Date.now() + 60_000 }) };
  store.beginExecution(threadId, { id: 'active-alice', authorizer: 'human-alice', executor: null, model: 'fixture-model', expiresAt: Date.now() + 60_000 });
  const before = store.execution(threadId);
  f.internal.executionEnvironments.clear();
  const reply = await f.request('turn/steer', { threadId, expectedTurnId: started.result.turn.id, input: [{ type: 'text', text: 'bob follow-up' }], clientUserMessageId: 'sponsored-bob' }, 'bob');
  assert.ok(reply.result, JSON.stringify(reply.error));
  assert.deepEqual(store.execution(threadId), before);
  assert.equal(f.internal.executionEnvironments.size, 0);
  await f.internal.admitModelExecution('steer', { threadId, clientUserMessageId: 'pending-steer' });
  const check = f.internal.gatewayChecks.get(JSON.stringify([threadId, 'pending-steer']));
  store.endExecution(threadId, 'active-alice');
  store.beginExecution(threadId, { id: 'later-bob', authorizer: 'human-bob', executor: null, model: 'fixture-model', expiresAt: Date.now() + 60_000 });
  assert.throws(check, /execution_changed/);
  assert.equal(store.execution(threadId).id, 'later-bob');
});

test('deferred private allocation does not hydrate before Core can receive its stable identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-private-bootstrap-')),frames:Array<Record<string,unknown>>=[];
 const adapter=createRoutingAdapter(root,frames),internal=adapter as any;
 const original=internal.provisionalThreads;
 let reads=0;
 internal.provisionalThreads={get:()=>({phase:'created'})};
 internal.requestPhysical=async(method:string)=>{reads++;assert.equal(method,'thread/read');throw Error('Conversation not found or unavailable');};
 const result={thread:{id:'private-child',path:join(root,'not-persisted.jsonl')}};
 try{
   await internal.materializeCreation(result,{__opencraftDeferPublication:true});
   assert.equal(reads,0,'private creation must return its identity without an ordinary read');
   await assert.rejects(internal.materializeCreation(result,{}),/Conversation not found/);
   assert.equal(reads,1,'ordinary materialization still verifies native persistence');
 }finally{internal.provisionalThreads=original;await adapter.close();await rm(root,{recursive:true,force:true});}
});

test('native allocation replay restores its original capability instead of rebinding a new credential',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-creation-mcp-replay-')),adapter=createRoutingAdapter(root,[]),internal=adapter as any;
 let cancelled=0,bindings=0,lookups=0;
 const restored={configuration:{mcpServers:{original:{}}},bind(){},cancel(){throw Error('must retain original credential');}};
 const fresh={configuration:{mcpServers:{fresh:{}}},bind(){},bindThread(){bindings++;throw Error('duplicate Thread capability');},cancel(){cancelled++;}};
 internal.options.restoreSessionMcp=async(id:string)=>{assert.equal(id,'original-thread');lookups++;return restored;};
 try{
   await internal.adoptCreationMcp('original-thread',fresh,true);
   assert.equal(bindings,0);assert.equal(cancelled,1);assert.equal(lookups,1);
   assert.equal(internal.sessionMcpInitial.get('original-thread').reservation,restored);
 }finally{internal.sessionMcpInitial.clear();await adapter.close();await rm(root,{recursive:true,force:true});}
});

for(const fail of ['bind','restore'] as const)test(`creation capability ${fail} failure rejects the original request as unknown without throwing from the native callback`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-creation-mcp-failure-')),adapter=createRoutingAdapter(root,[]),internal=adapter as any;
 let cancelled=0;
 const creation={configuration:{},bind(){},bindThread(){if(fail==='bind')throw Error('synthetic SQL binding conflict');},cancel(){cancelled++;}};
 internal.options.restoreSessionMcp=async()=>{if(fail==='restore')throw Error('synthetic storage failure');return null;};
 let resolve!: (v:unknown)=>void,reject!: (e:unknown)=>void;
 const result=new Promise((a,b)=>{resolve=a;reject=b;});
 // Register the same in-flight response state used by the physical transport.
 const id='capability-response';
 internal.internalRequests.set(id,{method:'thread/start',params:{__opencraftOrchestrationOperation:'original-operation',__opencraftDeferPublication:true},threadId:'',resolve,reject,timer:setTimeout(()=>reject(Error('fixture timeout')),3000)});
 internal.sessionMcpCreations.set(id,creation);
 try{
   assert.doesNotThrow(()=>internal.receivePhysicalLine(JSON.stringify({id,result:{thread:{id:'original-thread'}}})));
   await assert.rejects(result,(error:any)=>error.code===-32000&&error.data.resultUnknown===true);
   assert.equal(cancelled,0,'uncertain native credentials are not revoked as cleanup');
   assert.equal(internal.internalRequests.has(id),false);
   assert.equal(internal.sessionMcpInitial.has('original-thread'),false);
 }finally{await adapter.close();await rm(root,{recursive:true,force:true});}
});


for (const available of [true, false]) test(`first admitted input awaits Git readiness, not a creation grant (ready=${available})`, async t => {
  const f = await sharedCredentialAdapter(t);
  const { ExecutionEnvironmentSnapshot } = await import('@opencraft/execution-environment');
  const snapshot = f.runtime.snapshot.bind(f.runtime);
  let resolve!: () => void, reject!: (error: Error) => void, waiting = false;
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void ready.catch(() => {});
  const seen: any[] = [];
  f.runtime.snapshot = (scope: any, options?: any) => {
    const original = snapshot(scope, options);
    if (options?.creation) return new ExecutionEnvironmentSnapshot(scope, original.overlay(), undefined, true);
    seen.push(scope);
    return new ExecutionEnvironmentSnapshot(scope, original.overlay(), {
      get ready() { waiting = true; return ready; },
      environment: { OPENCRAFT_GIT_CAPABILITY: 'synthetic-execution-grant' },
      bindThread() {}, bindExecution() {},
    });
  };
  const threadId = (await f.request('thread/start', { cwd: f.root, testNoServerRequest: true }, 'alice')).result.thread.id;
  assert.equal(f.internal.executionEnvironments.get(threadId)?.needsGitAdmission, true);
  assert.equal(f.writes.some(row => row.params?.config?.['shell_environment_policy.set']?.OPENCRAFT_GIT_CAPABILITY), false);
  const first = f.request('turn/start', { threadId, input: [{ type: 'text', text: 'first admitted input' }], clientUserMessageId: 'git-first' }, 'alice');
  for (let i = 0; !waiting && i < 200; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(waiting, true);
  assert.equal(f.writes.some(row => row.method === 'turn/start'), false);
  assert.equal(f.writes.some(row => row.method === 'thread/resume' && row.params.config), false);
  assert.equal(seen.at(-1).inputId, 'git-first');
  assert.equal(seen.at(-1).account, 'employee:alice');
  assert.ok(seen.at(-1).executionId);
  assert.ok(seen.at(-1).leaseGeneration > 0);
  if (available) resolve(); else reject(Error('synthetic broker not ready'));
  const reply = await first;
  if (available) {
    assert.ok(reply.result, JSON.stringify(reply.error));
    const config = f.writes.filter(row => row.method === 'thread/resume' && row.params.config).at(-1)?.params.config;
    assert.equal(config?.['shell_environment_policy.set']?.OPENCRAFT_GIT_CAPABILITY, 'synthetic-execution-grant');
  } else {
    assert.equal(reply.error?.data?.submissionOutcome, 'rejected');
    assert.equal(f.writes.some(row => row.method === 'turn/start'), false);
  }
});

for (const outcome of ["confirmed", "rejected", "closed"] as const) test(`workspace creation publication waits for durable owner (${outcome})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workspace-publication-")), frames: Array<Record<string, unknown>> = [];
  let release!: () => void, entered!: () => void, calls = 0;
  let nativeResult: unknown;
  const gate = new Promise<void>(resolve => release = resolve), ready = new Promise<void>(resolve => entered = resolve);
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, async input => {
      calls++; nativeResult = input.result;
      assert.equal((input.result as any).thread.id, "fixture-thread-1");
      assert.equal(input.params.testNoServerRequest, true);
      assert.equal(input.context.sender, null);
      entered(); await gate;
      if (outcome === "rejected") throw Error("private storage or credential failure must not leak");
    });
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    await adapter.send(JSON.stringify({ id: "workspace-create", method: "thread/start", params: { testNoServerRequest: true }, [LOGICAL_CLIENT_FIELD]: "writer" }));
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("publication hook not reached")), 2000); timer.unref(); })]);
    const physical = [...(adapter as any).pending.entries()].find(([, value]: any) => value.originalId === "workspace-create")?.[0];
    assert.ok(physical);
    (adapter as any).receivePhysicalLine(JSON.stringify({ id: physical, result: nativeResult }));
    assert.equal(calls, 1);
    // Force a later Native event and wait for its RPC reply, not an arbitrary delay.
    await adapter.send(JSON.stringify({ id: "before-confirmation", method: "test/emitThreadNotification", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "writer" }));
    await waitFor(frames, f => f.id === "before-confirmation");
    assert.equal(frames.some(f => f.id === "workspace-create"), false);
    assert.equal(frames.some(f => f.method === "thread/started" || f.method === "thread/status/changed"), false);
    if (outcome === "closed") await adapter.close();
    release();
    if (outcome === "closed") {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(frames.some(f => f.id === "workspace-create" && "result" in f), false);
    } else {
      const reply = await waitFor(frames, f => f.id === "workspace-create");
      if (outcome === "rejected") {
        assert.equal((reply.error as any).data.resultUnknown, true);
        assert.equal((reply.error as any).data.threadId, "fixture-thread-1");
        assert.equal(JSON.stringify(reply).includes("private storage"), false);
      } else assert.equal((reply.result as any).thread.id, "fixture-thread-1");
      await adapter.send(JSON.stringify({ id: "after-confirmation", method: "test/emitThreadNotification", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "writer" }));
      await waitFor(frames, f => f.id === "after-confirmation");
      if (outcome === "confirmed") await waitFor(frames, f => f.method === "thread/status/changed");
      else assert.equal(frames.some(f => f.method === "thread/status/changed"), false);
    }
    assert.equal(calls, 1);
  } finally { release(); await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const cleanup of ["confirmed", "uncertain"] as const) test(`workspace Native rejection waits for cleanup (${cleanup})`, async () => {
 const root=await mkdtemp(join(tmpdir(),"codex-creation-reject-")),frames:Array<Record<string,unknown>>=[];
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const adapter=createRoutingAdapter(root,frames,0,undefined,undefined,undefined,false,undefined,undefined,undefined,undefined,undefined,async input=>{
  assert.equal(typeof input.requestId,"string");assert.equal(input.result,undefined);assert.equal((input.error as any).code,-32602);
  entered();await gate;if(cleanup==="uncertain")throw Error("private cleanup failure");
 });
 try{
  await adapter.connect();await initializeClient(adapter,frames,"view");
  await adapter.send(JSON.stringify({id:"rejected",method:"thread/start",params:{testRejectCreation:true},[LOGICAL_CLIENT_FIELD]:"view"}));
  await ready;assert.equal(frames.some(f=>f.id==="rejected"),false);release();
  const reply=await waitFor(frames,f=>f.id==="rejected");
  if(cleanup==="confirmed")assert.equal((reply.error as any).code,-32602);
  else{assert.equal((reply.error as any).data.resultUnknown,true);assert.equal(JSON.stringify(reply).includes("private cleanup"),false)}
  assert.equal(frames.some(f=>f.method==="thread/started"),false);
 }finally{release();await adapter.close();await rm(root,{recursive:true,force:true})}
});


test("scheduled lost acknowledgement recovers only an exact native client ID without dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "schedule-exact-recovery-"));
  const adapter = createRoutingAdapter(root, []), a = adapter as any;
  try {
    await adapter.connect();
    const queue = a.queueStore();
    const run = { id: "schedule:plan:123", threadId: "schedule-thread", state: "unknown", turnId: null };
    const row = queue.add(run.threadId, run.id, [{ type: "text", text: "scheduled" }]);
    queue.claim(run.threadId, row.id, "unknown"); queue.settle(run.threadId, row.id, "unknown", "steer-delivery-unconfirmed");
    let match = false, turnReads = 0;
    a.requestPhysical = async (method: string) => {
      if (method === "thread/items/list") return { data: [{ turnId: "exact-turn", item: { type: "userMessage", clientId: match ? run.id : "different-input" } }], nextCursor: null };
      if (method === "thread/turns/list") { turnReads++; return { data: [{ id: "exact-turn", status: "completed" }], nextCursor: null }; }
      throw new Error(`Unexpected recovery mutation: ${method}`);
    };
    assert.deepEqual(await a.inspectScheduledRun(run), { state: "unknown" });
    assert.equal(turnReads, 0); assert.equal(queue.find(run.threadId, row.id).state, "unknown");
    match = true;
    assert.deepEqual(await a.inspectScheduledRun({ ...run, turnId: "conflicting-turn" }), { state: "unknown" });
    match = true;
    assert.deepEqual(await a.inspectScheduledRun(run), { state: "completed", turnId: "exact-turn" });
    assert.equal(queue.find(run.threadId, row.id).state, "delivered");
    assert.equal(queue.find(run.threadId, row.id).targetTurnId, "exact-turn");
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

for (const outcome of ['confirmed', 'unconfirmed', 'stale-generation', 'missing-mode', 'null-mode', 'peer-turn'] as const)
  test(`metadata-only paginated creation rechecks its index on recovery (${outcome})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-index-recovery-'));
    const path = join(root, 'rollout.jsonl');
    const thread = { id: 'created-before-index', path, historyMode: 'paginated', ephemeral: false,
      projectId: 'original-project', status: { type: 'idle' }, turns: [] };
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: thread.id } }) + '\n');
    const creation = { phase: 'created', result: { thread } };
    const calls: string[] = [];
    let indexed = false;
    const adapter: any = Object.create(CodexEngineAdapter.prototype);
    Object.assign(adapter, {
      sessionMcpGeneration: 1,
      provisionalThreads: { get: () => creation },
      async requestPhysical(method: string, params: Record<string, unknown>) {
        calls.push(method);
        if (method === 'thread/loaded/list') return { data: [thread.id] };
        if (method === 'thread/read') {
          assert.equal(params.includeTurns, false);
          return { thread: { ...thread, ...(outcome === 'missing-mode' ? { historyMode: undefined } : outcome === 'null-mode' ? { historyMode: null } : {}) } };
        }
        if (method === 'thread/turns/list') {
          if (!indexed) throw Object.assign(new Error('list_turns is not supported yet'), { code: -32601 });
          return { data: outcome === 'peer-turn' ? [{ id: 'concurrent-native-turn' }] : [], nextCursor: null };
        }
        assert.equal(method, 'thread/metadata/update', 'no resume, execution or credential mutation during index recovery');
        assert.deepEqual(params, { threadId: thread.id, projectId: thread.projectId });
        indexed = outcome !== 'unconfirmed';
        if (outcome === 'stale-generation') adapter.sessionMcpGeneration++;
        return { thread };
      },
    });
    try {
      if (outcome === 'confirmed') {
        assert.equal((await adapter.provisionalResult(thread.id))?.thread.creationPhase, 'created');
        assert.equal(indexed, true, 'metadata-only persistence must not bypass index confirmation');
        assert.equal(calls.filter(method => method === 'thread/turns/list').length, 2);
      } else {
        await assert.rejects(adapter.provisionalResult(thread.id),
          outcome === 'unconfirmed' ? /list_turns is not supported yet/ : outcome === 'peer-turn' ? /already has turns/
            : outcome === 'missing-mode' || outcome === 'null-mode' ? /cannot safely confirm its index/ : /Native creation owner changed/);
      }
      assert.equal(calls.filter(method => method === 'thread/metadata/update').length, outcome === 'missing-mode' || outcome === 'null-mode' ? 0 : 1);
      assert.equal(await readFile(path, 'utf8'), JSON.stringify({ type: 'session_meta', payload: { id: thread.id } }) + '\n');
      assert.equal(creation.phase, 'created');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test("a delegated title cannot reach native after revocation while waiting to write", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-title-admission-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "viewer" }));
    return (await waitFor(frames, frame => frame.id === id)).result as any;
  };
  const gate = Promise.withResolvers<void>();
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "viewer");
    const { thread } = await request("create", "thread/start", { cwd: root, testNoServerRequest: true });
    const hold = (adapter as any).withThreadOperation(thread.id, () => gate.promise);
    let allowed = true;
    const rename = adapter.sendWithContext(JSON.stringify({
      id: "delegated-title", method: "thread/name/set", params: { threadId: thread.id, name: "Denied title" },
      [LOGICAL_CLIENT_FIELD]: "viewer",
    }), { sender: null, orchestrationOperationId: "title-operation", orchestrationCanAdmit: () => allowed });
    allowed = false;
    gate.resolve();
    await hold;
    await assert.rejects(rename, /Orchestration delegation was revoked/);
    const counts = await request("counts", "test/readMethodCounts", {});
    assert.equal(counts["thread/name/set"] ?? 0, 0);
  } finally {
    gate.resolve();
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
