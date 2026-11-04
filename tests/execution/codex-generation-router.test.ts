import { operatorLeaseClaim } from "../../scripts/full-upgrade/operator-lease.mjs";
const operatorLease = await operatorLeaseClaim(30000);
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {startOrchestrationCallbackRelay} from '../../apps/codex-core/src/orchestration-callback-lane';
import { CodexRouterOwner } from "../../apps/codex-core/src/router-owner.js";
import { CodexGenerationRegistry, type GenerationTicket } from "../../apps/codex-core/src/generation-registry.js";
import { CodexGenerationRouter, startGenerationSocket, type GenerationRuntimeDirectory } from "../../apps/codex-core/src/generation-router.js";

async function fixture(callbacks:Record<string,boolean>={},replay=false,handoff=false) {
  const root = await mkdtemp(join(tmpdir(), "oc-gen-router-")), registry = new CodexGenerationRegistry(root);
  const servers: WebSocketServer[] = [], sockets: WebSocket[] = [];
  const relays=new Map<string,Awaited<ReturnType<typeof startOrchestrationCallbackRelay>>>(),fenced=new Set<string>();
  const threads = new Map<string, Map<string, any>>(), calls: { generation: string; method: string; params: any }[] = [];
  const holds = new Map<string, { method: string; entered: Promise<void>; release(): void }>();
  const replies: { generation: string; id: unknown; result: unknown }[] = [];
  for (const id of ["old", "new"]) {
    const directory = join(root, id); await mkdir(directory, { recursive: true, mode: 0o700 });
    const nativeSocket = join(directory, "native.sock"), server = new WebSocketServer({ path: "/", server: undefined, noServer: true });
    const http = (await import("node:http")).createServer(); http.on("upgrade", (r, s, h) => server.handleUpgrade(r, s, h, ws => server.emit("connection", ws)));
    await new Promise<void>(resolve => http.listen(nativeSocket, resolve)); servers.push(server);
    const table = new Map<string, any>(); threads.set(id, table);
    server.on("connection", ws => { sockets.push(ws); let dynamicReply: any; ws.on("message", async raw => {
      const m = JSON.parse(String(raw));
      if (!m.method && m.id !== undefined) { replies.push({ generation: id, id: m.id, result: m.result }); if (handoff) ws.send(JSON.stringify(dynamicReply ? { method: "item/completed", params: { threadId: dynamicReply.threadId, turnId: dynamicReply.turnId, item: { type: "dynamicToolCall", id: dynamicReply.callId, status: "completed", success: true } } } : { method: "serverRequest/resolved", params: { requestId: m.id } })); return; }
      if (m.id === undefined) return;
      const params = m.params ?? {}; calls.push({ generation: id, method: m.method, params });
      const gate = holds.get(id);
      if (gate?.method === m.method) { (gate as any).enteredResolve(); await (gate as any).done; holds.delete(id); }
      let result: any = {};
      if(m.method==='thread/start'&&params.fixtureRejectCreation){ws.send(JSON.stringify({id:m.id,error:{code:-32602,message:'Native creation rejected'}}));return;}
      if (m.method === "initialize") result = { userAgent: id };
      else if (m.method === "thread/start" || m.method === "thread/fork") {
        const tid = `${id}-${table.size + 1}`; const thread = { id: tid, createdAt: table.size + (id === "old" ? 1 : 100), updatedAt: table.size + (id === "old" ? 1 : 100), status: { type: "idle" }, turns: [] }; table.set(tid, thread); result = { thread }; ws.send(JSON.stringify({ method: "thread/started", params: { thread } }));
      } else if (m.method === "thread/read") {
        const thread = table.get(params.threadId);
        if (!thread) { ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: "Thread not found" } })); return; }
        result = { thread };
      } else if (m.method === "thread/list") {
        const all = [...table.values()].sort((a, b) => b.updatedAt - a.updatedAt), offset = Number(params.cursor ?? 0), size = params.limit ?? 100;
        result = { data: all.slice(offset, offset + size), nextCursor: offset + size < all.length ? String(offset + size) : null };
      } else if (m.method === "thread/loaded/list") result = { data: [...table.keys()] };
      else if (m.method === "fixture/dynamic") { dynamicReply = { threadId: params.threadId, turnId: "native-turn", callId: "native-call" }; ws.send(JSON.stringify({ id: 7, method: "item/tool/call", params: { ...dynamicReply, namespace: null, tool: "fixture_dynamic", arguments: {} } })); }
      else if (m.method === "fixture/approval") { ws.send(JSON.stringify({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: params.threadId, turnId: "turn" } })); }
      else if (m.method === "fixture/resolveApproval") { ws.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: params.threadId, requestId: 7 } })); }
      else if (m.method === "model/list") result = { data: [id] };
      else if (m.method === "turn/start") result = { turn: { id: `${id}-turn`, status: "inProgress" } };
      ws.send(JSON.stringify({ id: m.id, result }));
    }); });
    (server as any).closeHttp = () => new Promise<void>(resolve => http.close(() => resolve()));
    if(replay&&callbacks[id])relays.set(id,await startOrchestrationCallbackRelay(join(directory,'callback.sock'),nativeSocket));
    registry.register({ id, endpoint: join(directory, "control.sock"), runtimeDataDirectory: join(directory, "data"), executable: join(directory, "codex"), bundle: join(directory, "app-server.cjs"), node: process.execPath, cwd: root }); registry.ready(id);
  }
  registry.activate("old", 0);
  const owner = handoff ? new CodexRouterOwner(registry) : undefined;
  const runtime: GenerationRuntimeDirectory = { registry, owner,
    async ensure(id) { return { protocolVersion: 1, pid: 1, codexPid: 2, dataDirectory: root, proxyBaseUrl: "http://127.0.0.1:1", nativeSocket: join(root, id, replay&&callbacks[id]?"callback.sock":"native.sock"),...(callbacks[id]?{callbackProtocolVersion:1 as const,pendingCallbacks:0,pendingOrchestrationMutations:0}:{}) }; },
    admit(ticket: GenerationTicket) { assert.equal(registry.valid(ticket), true);if(fenced.has(ticket.generationId))throw Error('Generation retirement fenced');return () => {}; }, observe() {}, };
  const router = new CodexGenerationRouter(runtime), listener = await startGenerationSocket(join(root, "router.sock"), router);
  let client = new WebSocket(`ws+unix://${join(root, "router.sock")}:/${replay?'?opencraftLane=fixture-gateway':''}`);const messages: any[] = [];
  client.on("message", raw => messages.push(JSON.parse(String(raw)))); await new Promise<void>(resolve => client.once("open", resolve));
  let sequence = 0;
  async function rpc(method: string, params: unknown = {}) {
    const id = ++sequence; client.send(JSON.stringify({ id, method, params }));
    for (let n = 0; n < 600; n++) { const row = messages.find(m => m.id === id && !m.method); if (row) { if (row.error) throw new Error(row.error.message); return row.result; } await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("fixture RPC timeout");
  }
  await rpc("initialize", { clientInfo: { name: "test", version: "1" }, capabilities: { experimentalApi: true } });
  return { registry, owner, router, get client(){return client;}, messages, calls, replies, threads, rpc, relays,fence(id:string){fenced.add(id);},
    async reconnect(){client.terminate();await new Promise<void>(resolve=>client.once('close',()=>resolve()));client=new WebSocket(`ws+unix://${join(root,'router.sock')}:/?opencraftLane=fixture-gateway`);client.on('message',raw=>messages.push(JSON.parse(String(raw))));await new Promise<void>(resolve=>client.once('open',resolve));await rpc('initialize',{clientInfo:{name:'test',version:'1'},capabilities:{experimentalApi:true}});},
    notifyNative(id: string, message: unknown) { for (const socket of servers[id === "old" ? 0 : 1]!.clients) socket.send(JSON.stringify(message)); },
    crash(id: string) { for (const ws of servers[id === "old" ? 0 : 1]!.clients) ws.terminate(); },
    hold(id: string, method: string) {
      let enteredResolve!: () => void, finish!: () => void;
      const entered = new Promise<void>(resolve => { enteredResolve = resolve; }), done = new Promise<void>(resolve => { finish = resolve; });
      const value = { method, entered, enteredResolve, done, release: finish }; holds.set(id, value); return value;
    },
    async close() { for (const gate of holds.values()) gate.release(); client.terminate(); await listener.close();for(const relay of relays.values())await relay.close(); for (const socket of sockets) socket.terminate(); for (const server of servers) { server.close(); await (server as any).closeHttp(); } owner?.dispose(); registry.close(); await rm(root, { recursive: true, force: true }); } };
}

test("native routing keeps old work and accepted creations on their generation across atomic activation", async () => {
  const f = await fixture();
  try {
    const old = await f.rpc("thread/start");
    const held = f.hold("old", "thread/start"), accepted = f.rpc("thread/start"); await held.entered;
    f.registry.activate("new", 1); held.release();
    const admittedThread = (await accepted).thread; assert.match(admittedThread.id, /^old-/);
    assert.equal(f.registry.route(admittedThread.id)!.admissionEpoch, 1, "early Thread-started notification cannot stamp the new default epoch");
    const next = await f.rpc("thread/start"); assert.match(next.thread.id, /^new-/);
    await f.rpc("turn/start", { threadId: old.thread.id }); await f.rpc("turn/start", { threadId: next.thread.id });
    assert.deepEqual(f.calls.filter(c => c.method === "turn/start").map(c => c.generation), ["old", "new"]);
    assert.equal((await f.rpc("thread/read", { threadId: old.thread.id })).thread.id, old.thread.id);
  } finally { await f.close(); }
});

test("thread/read route diagnostics include failures before native RPC without Thread identifiers", async () => {
  const f = await fixture();
  const originalInfo = console.info;
  const events: string[] = [];
  console.info = (...args: unknown[]) => { if (args[0] === "[history-route-stages]") events.push(String(args[1])); };
  try {
    const created = await f.rpc("thread/start");
    f.fence("old");
    const requestId = "sensitive-request-id";
    f.client.send(JSON.stringify({ id: requestId, method: "thread/read", params: { threadId: created.thread.id } }));
    for (let n = 0; n < 600 && !f.messages.some(message => message.id === requestId && !message.method); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(f.messages.some(message => message.id === requestId && !message.method && message.error));
    assert.equal(events.length, 1);
    const event = JSON.parse(events[0]!);
    assert.equal(event.method, "thread/read");
    assert.equal(event.requestId, null);
    assert.equal(event.outcome, "failed");
    assert.equal(event.nativeRpcMs, null);
    assert.ok(typeof event.routeReadyMs === "number");
    assert.equal(JSON.stringify(event).includes(created.thread.id), false);
  } finally { console.info = originalInfo; await f.close(); }
});

test("directory pages merge native ordering and resume existing unmapped Threads on the owning generation", async () => {
  const f = await fixture();
  try {
    await f.rpc("thread/start"); await f.rpc("thread/start"); f.registry.activate("new", 1);
    await f.rpc("thread/start"); await f.rpc("thread/start");
    const first = await f.rpc("thread/list", { limit: 2 }); assert.deepEqual(first.data.map((r: any) => r.id), ["new-2", "new-1"]);
    const second = await f.rpc("thread/list", { limit: 2, cursor: first.nextCursor }); assert.deepEqual(second.data.map((r: any) => r.id), ["old-2", "old-1"]); assert.equal(second.nextCursor, null);
    f.threads.get("old")!.set("historical", { id: "historical", updatedAt: 0, createdAt: 0, status: { type: "idle" } });
    await f.rpc("turn/start", { threadId: "historical" }); assert.equal(f.calls.filter(c => c.method === "turn/start").at(-1)!.generation, "old");
  } finally { await f.close(); }
});

test("server requests from different generations retain their original identities and response destination", async () => {
  const f = await fixture();
  try {
    const a = await f.rpc("thread/start"); f.registry.activate("new", 1); const b = await f.rpc("thread/start");
    await f.rpc("fixture/approval", { threadId: a.thread.id }); await f.rpc("fixture/approval", { threadId: b.thread.id });
    const requests = f.messages.filter(m => m.method === "item/commandExecution/requestApproval");
    assert.equal(requests.length, 2); assert.notEqual(requests[0].id, requests[1].id);
    f.client.send(JSON.stringify({ id: requests[1].id, result: { decision: "accept" } }));
    f.client.send(JSON.stringify({ id: requests[0].id, result: { decision: "decline" } }));
    for (let n = 0; n < 100 && f.replies.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(f.replies.map(r => [r.generation, r.id, (r.result as any).decision]), [["new", 7, "accept"], ["old", 7, "decline"]]);
  } finally { await f.close(); }
});

test("late global responses are fenced by admission epoch while old Thread responses remain valid", async () => {
  const f = await fixture();
  try {
    const thread = await f.rpc("thread/start"); const gate = f.hold("old", "model/list"), pending = f.rpc("model/list");
    const rejected = assert.rejects(pending, /admission changed/); await gate.entered; f.registry.activate("new", 1); gate.release(); await rejected;
    assert.equal((await f.rpc("thread/read", { threadId: thread.thread.id })).thread.id, thread.thread.id);
  } finally { await f.close(); }
});


test("connection-scoped terminal handles stay on their original generation and reject active reuse", async () => {
  const f = await fixture();
  try {
    await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic-shell"], cwd: "/synthetic" });
    f.registry.activate("new", 1);
    await assert.rejects(f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic-shell"] }), /already active/);
    await f.rpc("process/writeStdin", { processHandle: "terminal", bytes: "c3ludGhldGlj" });
    await f.rpc("process/spawn", { processHandle: "new-terminal", command: ["synthetic-shell"], cwd: "/synthetic" });
    assert.deepEqual(f.calls.filter(c => c.method.startsWith("process/")).map(c => [c.method, c.generation]), [["process/spawn", "old"], ["process/writeStdin", "old"], ["process/spawn", "new"]]);
  } finally { await f.close(); }
});

test("a late Thread response from an obsolete runtime incarnation cannot enter the live connection", async () => {
  const f = await fixture();
  try {
    const thread = await f.rpc("thread/start"); f.registry.activate("new", 1);
    const gate = f.hold("old", "thread/read"), pending = f.rpc("thread/read", { threadId: thread.thread.id });
    const rejected = assert.rejects(pending, /Stale generation/); await gate.entered;
    f.registry.runtimeChanged("old"); gate.release(); await rejected;
    assert.equal(f.client.readyState, WebSocket.OPEN);
    assert.match((await f.rpc("thread/start")).thread.id, /^new-/);
  } finally { await f.close(); }
});


test("a generation disconnect leaves other tasks connected and releases only its terminal leases", async () => {
  const f = await fixture();
  try {
    const old = await f.rpc("thread/start"); await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic"] });
    f.registry.activate("new", 1); const fresh = await f.rpc("thread/start");
    await f.rpc("fixture/approval", { threadId: old.thread.id }); f.crash("old");
    for (let n = 0; n < 200 && !f.messages.some(m => m.method === "opencraft/codex/generation/lost"); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.client.readyState, WebSocket.OPEN);
    assert.equal((await f.rpc("thread/read", { threadId: fresh.thread.id })).thread.id, fresh.thread.id);
    await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic"] });
    assert.equal(f.calls.filter(c => c.method === "process/spawn").at(-1)!.generation, "new");
    assert.ok(f.messages.some(m => m.method === "serverRequest/resolved"));
  } finally { await f.close(); }
});


test("Native approval cancellation resolves the public identity and releases its retirement lease", async () => {
  const f = await fixture();
  try {
    const old = await f.rpc("thread/start"); await f.rpc("fixture/approval", { threadId: old.thread.id });
    const request = f.messages.find(m => m.method === "item/commandExecution/requestApproval"); assert.ok(request);
    await f.rpc("fixture/resolveApproval", { threadId: old.thread.id });
    const resolved = f.messages.find(m => m.method === "serverRequest/resolved"); assert.equal(resolved.params.requestId, request.id);
    f.client.send(JSON.stringify({ id: request.id, result: { decision: "accept" } })); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.replies.length, 0, "a cancelled request cannot later reply to Native");
  } finally { await f.close(); }
});

test("standalone command control stays on the accepted generation and successful mutations are never made retryable", async () => {
  const f = await fixture();
  try {
    const held = f.hold("old", "command/exec"), command = f.rpc("command/exec", { processId: "shell", command: ["synthetic"] }); await held.entered;
    f.registry.activate("new", 1);
    await f.rpc("command/exec/write", { processId: "shell", deltaBase64: "eA==" });
    await f.rpc("command/exec/resize", { processId: "shell", size: { rows: 24, cols: 80 } });
    await assert.rejects(f.rpc("command/exec", { processId: "shell", command: ["must-not-run"] }), /already active/);
    await f.rpc("command/exec/terminate", { processId: "shell" }); held.release(); assert.deepEqual(await command, {});
    assert.ok(f.calls.filter(c => c.method.startsWith("command/exec")).every(c => c.generation === "old"));
    const writing = f.hold("new", "config/value/write"), mutation = f.rpc("config/value/write", { keyPath: "synthetic", value: 1 }); await writing.entered;
    f.registry.activate("old", 2); writing.release(); assert.deepEqual(await mutation, {});
    assert.equal(f.calls.filter(c => c.method === "config/value/write").length, 1);
  } finally { await f.close(); }
});

test("path fork follows the actual source HOME and rejects a conflicting Thread ID", async () => {
  const f = await fixture();
  try {
    const source = await f.rpc("thread/start"), path = join(f.registry.get("old")!.runtimeDataDirectory, "runtime", "source.jsonl");
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: source.thread.id } }) + "\n");
    f.registry.activate("new", 1); const fresh = await f.rpc("thread/start");
    const fork = await f.rpc("thread/fork", { threadId: "", path }); assert.match(fork.thread.id, /^old-/);
    await assert.rejects(f.rpc("thread/fork", { threadId: fresh.thread.id, path }), /disagree/);
    assert.equal(f.calls.filter(c => c.method === "thread/fork").length, 1);
  } finally { await f.close(); }
});


test("incarnation replacement expires old command/terminal/approval leases and observes loss without closing the front", async () => {
  const f = await fixture({}, false, true);
  try {
    const thread = await f.rpc("thread/start"); await f.rpc("fixture/approval", { threadId: thread.thread.id });
    const request = f.messages.find(m => m.method === "item/commandExecution/requestApproval");
    await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic"] });
    const held = f.hold("old", "command/exec"), running = f.rpc("command/exec", { processId: "command", command: ["synthetic"] });
    const rejected = assert.rejects(running, /unconfirmed/); await held.entered;
    const originalIncarnation = f.registry.get("old")!.incarnation;
    f.registry.runtimeChanged("old"); await f.rpc("thread/read", { threadId: thread.thread.id }); await rejected; held.release();
    const replaced = responsibilityRows(f.registry).filter(row => row.uncertainty?.["generation-replaced"]);
    assert.ok(replaced.length >= 3); assert.ok(replaced.every(row => row.generationId === "old" && row.incarnation === originalIncarnation));
    assert.ok(f.messages.some(m => m.method === "serverRequest/resolved" && m.params.requestId === request.id));
    assert.ok(f.messages.some(m => m.method === "opencraft/codex/generation/lost" && m.__opencraftGeneration.incarnation === 2));
    await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic"] });
    await f.rpc("command/exec", { processId: "command", command: ["synthetic"] }); assert.equal(f.client.readyState, WebSocket.OPEN);
  } finally { await f.close(); }
});

test("successful delete without a notification removes only the cold-history requirement", async () => {
  const f = await fixture();
  try {
    const thread = await f.rpc("thread/start"); await f.rpc("thread/delete", { threadId: thread.thread.id });
    assert.equal(f.registry.route(thread.thread.id)!.generationId, "old"); assert.equal(f.registry.durableThreadIds("old").includes(thread.thread.id), false);
  } finally { await f.close(); }
});


test("mixed APP capabilities filter new tools and private metadata for legacy Threads",async()=>{
  const f=await fixture({new:true});
  try{
    const tools=[{name:"read_thread"},{name:"thread_spawn"},{name:"thread_tell"},{name:"thread_inspect"},{name:"thread_wait"}];
    await f.rpc("thread/start",{dynamicTools:tools});
    assert.deepEqual(f.calls.filter(call=>call.method==="thread/start").at(-1)!.params.dynamicTools,[{name:"read_thread"}]);
    f.registry.activate("new",1);await f.rpc("thread/start",{dynamicTools:tools});
    assert.equal(f.calls.filter(call=>call.method==="thread/start").at(-1)!.params.dynamicTools.length,5);
    await f.rpc("turn/start",{threadId:"old-1",__opencraftDelegationId:"private",input:[]});
    assert.equal(f.calls.filter(call=>call.method==="turn/start").at(-1)!.params.__opencraftDelegationId,undefined);
  }finally{await f.close();}
});


test("a Native rejected creation replays its original failure after Gateway death before Broker finish",async()=>{
  const f=await fixture({old:true},true);
  try{
    const params={__opencraftOrchestrationOperation:"rejected",fixtureRejectCreation:true};
    await assert.rejects(f.rpc("thread/start",params),/Native creation rejected/);await f.reconnect();await assert.rejects(f.rpc("thread/start",params),/Native creation rejected/);
    assert.equal(f.calls.filter(call=>call.method==="thread/start").length,1);
    assert.equal((await f.rpc("opencraft/orchestration/ack",{operationId:"rejected"})).acknowledged,true);assert.equal(f.relays.get("old")!.pendingMutations,0);
  }finally{await f.close();}
});

test("delegated spawn follows its capable source across legacy default rollback and rejects forged or fenced source",async()=>{
  const f=await fixture({new:true},true);
  try{
    f.registry.activate("new",1);const source=(await f.rpc("thread/start")).thread;f.registry.activate("old",2);
    const params={__opencraftOrchestrationOperation:"delegated",__opencraftOrchestrationSourceThreadId:source.id,__opencraftOrchestrationIncarnation:f.relays.get("new")!.incarnation,dynamicTools:[{name:"thread_spawn"},{name:"thread_tell"}]};
    const child=(await f.rpc("thread/start",params)).thread;assert.equal(f.registry.route(child.id)!.generationId,"new");assert.equal(f.calls.filter(call=>call.method==="thread/start").at(-1)!.params.dynamicTools.length,2);
    await assert.rejects(f.rpc("thread/start",{...params,__opencraftOrchestrationOperation:"forged",__opencraftOrchestrationIncarnation:undefined}),/source callback identity/);
    f.fence("new");await assert.rejects(f.rpc("thread/start",{...params,__opencraftOrchestrationOperation:"fenced"}),/unconfirmed/);
    assert.equal(f.calls.filter(call=>call.method==="thread/start").length,2);
  }finally{await f.close();}
});

test("an active native replay keeps its public request identity and resolved ID reuse gets a fresh identity", async () => {
 const f=await fixture();
 try {
  const thread=(await f.rpc('thread/start')).thread.id;
  await f.rpc('fixture/approval',{threadId:thread});await f.rpc('fixture/approval',{threadId:thread});
  const requests=f.messages.filter(m=>m.method==='item/commandExecution/requestApproval');assert.equal(requests.length,2);assert.equal(requests[0].id,requests[1].id);
  await f.rpc('fixture/resolveApproval',{threadId:thread});await f.rpc('fixture/approval',{threadId:thread});
  const fresh=f.messages.filter(m=>m.method==='item/commandExecution/requestApproval').at(-1);assert.notEqual(fresh.id,requests[0].id);
  f.client.send(JSON.stringify({id:requests[0].id,result:{decision:'accept'}}));
  f.client.send(JSON.stringify({id:fresh.id,result:{decision:'decline'}}));
  for(let n=0;n<100&&!f.replies.length;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(f.replies.map(r=>[r.id,(r.result as any).decision]),[[7,'decline']]);
 } finally {await f.close();}
});

test("router handoff counts all native server requests and preserves uncertainty when their consumer disappears", async () => {
  const f = await fixture({}, false, true);
  try {
    const { thread } = await f.rpc("thread/start");
    await f.rpc("fixture/approval", { threadId: thread.id });
    assert.equal(f.router.handoffCounts().connectionTools, 1, "native server requests must count even without an APP callback counter");
    f.client.terminate(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.owner!.snapshot().uncertain, true, "disconnect cannot turn an unresolved native callback into idle");
    assert.throws(() => new CodexRouterOwner(f.registry), /unconfirmed/);
  } finally { await f.close(); }
});

test("fenced router accepts only the original callback reply and drains its durable native lease", async () => {
  const f = await fixture({}, false, true);
  try {
    const { thread } = await f.rpc("thread/start"); await f.rpc("fixture/approval", { threadId: thread.id });
    assert.ok(f.owner!.snapshot().pending!.length, "callback dispatch must survive a router crash as unconfirmed admission");
    assert.throws(() => new CodexRouterOwner(f.registry), /unconfirmed/);
    const input = () => ({ expectedOwner: f.owner!.owner, expectedEpoch: f.owner!.snapshot().epoch, operationId: "callback", fence: "fence" });
    f.owner!.fence({ ...input(), operatorLease }); await assert.rejects(f.rpc("thread/start"), /fenced/);
    const callback = f.messages.find(m => m.method === "item/commandExecution/requestApproval");
    f.client.send(JSON.stringify({ id: callback.id, result: { decision: "accept" } }));
    for (let n = 0; n < 100 && f.router.handoffCounts().connectionTools; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.replies.length, 1); assert.equal(f.router.handoffCounts().connectionTools, 0);
    assert.deepEqual(f.owner!.snapshot().pending, []); assert.equal(f.owner!.snapshot().phase, "fenced");
    f.client.terminate(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.owner!.snapshot().uncertain, false);
    const counts = f.router.handoffCounts(); const observation = { coverage: "complete" as const, counts, activeCount: Object.values(counts).reduce((a,b) => a+b,0), historicalCount: 1 };
    const proof = f.owner!.inspect(input(), observation); assert.equal(proof.activeCount, 0);
    f.owner!.release({ ...input(), proof: proof.identity }, observation, "configuration");
    assert.equal(f.owner!.snapshot().phase, "released");
  } finally { await f.close(); }
});

test("native callback cancellation cannot erase a possibly dispatched Host operation", async () => {
  const f = await fixture({}, false, true);
  try {
    const { thread } = await f.rpc("thread/start"); await f.rpc("fixture/approval", { threadId: thread.id });
    await f.rpc("fixture/resolveApproval", { threadId: thread.id });
    assert.equal(f.owner!.snapshot().uncertain, true);
    assert.ok(responsibilityRows(f.registry).some(row => row.threadId === thread.id && row.turnId === "turn" && row.uncertainty?.["native-resolved-before-reply"]));
    const input = { expectedOwner: f.owner!.owner, expectedEpoch: f.owner!.snapshot().epoch, operationId: "cancelled", fence: "fence" };
    f.owner!.fence({ ...input, operatorLease });
    const counts = f.router.handoffCounts();
    const proof = f.owner!.inspect({ ...input, expectedEpoch: input.expectedEpoch + 1 }, { coverage: "complete", counts, activeCount: Object.values(counts).reduce((a,b)=>a+b,0), historicalCount: 1 });
    assert.equal(proof.coverage, "unknown"); assert.equal(proof.activeCount, null);
  } finally { await f.close(); }
});

test("native dynamic-tool item completion is an exact callback receipt scoped to its thread and turn", async () => {
  const f = await fixture({}, false, true);
  try {
    const { thread } = await f.rpc("thread/start"); await f.rpc("fixture/dynamic", { threadId: thread.id });
    const callback = f.messages.find(m => m.method === "item/tool/call");
    f.notifyNative("old", { method: "item/completed", params: { threadId: thread.id, turnId: "other-turn", item: { type: "dynamicToolCall", id: "native-call", status: "completed" } } });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.router.handoffCounts().connectionTools, 1);
    const input = { expectedOwner: f.owner!.owner, expectedEpoch: f.owner!.snapshot().epoch, operationId: "dynamic", fence: "fence" };
    f.owner!.fence({ ...input, operatorLease }); f.client.send(JSON.stringify({ id: callback.id, result: { success: true, contentItems: [] } }));
    for (let n=0;n<100&&(f.router.handoffCounts().connectionTools || !f.messages.some(m=>m.method==="serverRequest/resolved"&&m.params.requestId===callback.id));n++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(f.replies.length,1); assert.equal(f.router.handoffCounts().connectionTools,0);
    assert.deepEqual(f.owner!.snapshot().pending,[]); assert.equal(f.owner!.snapshot().uncertain,false);
    assert.ok(f.messages.some(m=>m.method==="serverRequest/resolved"&&m.params.requestId===callback.id));
  } finally { await f.close(); }
});

function responsibilityRows(registry: CodexGenerationRegistry): any[] {
  const snapshot = registry.coldSnapshot() as any;
  return snapshot.tables.find((t: any) => t.name === "routing_metadata").rows
    .filter((row: any) => row.key.startsWith("router-lease:")).map((row: any) => JSON.parse(row.value));
}
test("consumer loss durably identifies the exact native callback without recording its arguments", async () => {
  const f = await fixture({}, false, true);
  try {
    const { thread } = await f.rpc("thread/start"); await f.rpc("fixture/approval", { threadId: thread.id });
    const before = responsibilityRows(f.registry).find(row => row.kind === "native-callback");
    assert.equal(before.method, "item/commandExecution/requestApproval"); assert.equal(before.generationId, "old");
    assert.equal(before.threadId, thread.id); assert.equal(before.turnId, "turn"); assert.equal(before.nativeRequestId, "7");
    assert.ok(before.connectionId && before.rpcId.startsWith("ocg:"));
    f.client.terminate();
    for (let i = 0; i < 100 && !f.owner!.snapshot().uncertain; i++) await new Promise(r => setTimeout(r, 5));
    const after = f.registry.metadata(`router-lease:${before.id}`) as any;
    assert.ok(after.uncertainty["consumer-disconnected"].firstAt); assert.equal(after.threadId, thread.id);
    assert.ok(f.owner!.snapshot().pending?.includes(before.id));
  } finally { await f.close(); }
});
test("native loss attributes both RPC and process leases with protocol IDs and preserves unknown after late replies", async () => {
  const f = await fixture({}, false, true);
  try {
    await f.rpc("process/spawn", { processHandle: "terminal-1", command: ["PRIVATE_SCRIPT"], env: { KEY: "PRIVATE_ENV" } });
    const gate = f.hold("old", "command/exec"), running = f.rpc("command/exec", { processId: "command-1", command: ["PRIVATE_COMMAND"] }).catch(() => undefined);
    await gate.entered; f.crash("old"); await running; gate.release();
    const unknown = responsibilityRows(f.registry).filter(row => row.uncertainty);
    const process = unknown.find(row => row.kind === "connection-tool" && row.processHandle === "terminal-1");
    const command = unknown.find(row => row.kind === "connection-tool" && row.processId === "command-1");
    assert.ok(process?.uncertainty["native-disconnected"]); assert.ok(command?.uncertainty["native-disconnected"]);
    assert.equal(process.method, "process/spawn"); assert.equal(command.method, "command/exec");
    assert.equal(command.generationId, "old"); assert.ok(command.parentLeaseId);
    const rpc = unknown.find(row => row.id === command.parentLeaseId); assert.equal(rpc.method, "command/exec");
    assert.ok(rpc.uncertainty["native-result-unknown"]); assert.equal(rpc.connectionId, command.connectionId);
    assert.ok(rpc.nativeRequestId); assert.equal(rpc.nativeRequestId, command.nativeRequestId); assert.ok(command.sentAt);
    assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE_|arguments|command":|env":/u);
    assert.ok(f.owner!.snapshot().uncertain);
  } finally { await f.close(); }
});
test("ambiguous native terminal events preserve evidence for every matching call instead of choosing a successful one", async () => {
  const f = await fixture({}, false, true);
  try {
    const { thread } = await f.rpc("thread/start");
    for (const id of [41, 42]) f.notifyNative("old", { id, method: "item/tool/call", params: { threadId: thread.id, turnId: "turn-ambiguous", callId: "shared-call", arguments: { key: "PRIVATE_ARGUMENT" } } });
    for (let i = 0; i < 100 && f.router.handoffCounts().connectionTools < 2; i++) await new Promise(r => setTimeout(r, 5));
    f.notifyNative("old", { method: "item/completed", params: { threadId: thread.id, turnId: "turn-ambiguous", item: { type: "dynamicToolCall", id: "shared-call", status: "completed" } } });
    for (let i = 0; i < 100 && !f.owner!.snapshot().uncertain; i++) await new Promise(r => setTimeout(r, 5));
    const records = responsibilityRows(f.registry).filter(row => row.uncertainty?.["ambiguous-native-completion"]);
    assert.equal(records.length, 2); assert.deepEqual(records.map(row => row.nativeRequestId).sort(), ["41", "42"]);
    assert.ok(records.every(row => row.threadId === thread.id && row.turnId === "turn-ambiguous" && row.callId === "shared-call"));
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_ARGUMENT|arguments/u);
    assert.equal(f.router.handoffCounts().connectionTools, 2);
  } finally { await f.close(); }
});
test("evidence write failure at the native send boundary prevents the mutation from reaching native", async () => {
  const f = await fixture({}, false, true);
  try {
    const { thread } = await f.rpc("thread/start");
    const write = f.registry.setMetadata.bind(f.registry);
    f.registry.setMetadata = (key, value) => {
      const record = value as any;
      if (key.startsWith("router-lease:") && record.method === "turn/start" && record.phase === "sent") throw Error("fixture send-evidence failure");
      write(key, value);
    };
    await assert.rejects(f.rpc("turn/start", { threadId: thread.id }), /unconfirmed/);
    assert.equal(f.calls.filter(row => row.method === "turn/start").length, 0);
    assert.equal(f.owner!.isOpen(), false); assert.equal(f.owner!.snapshot().persistence, "unknown");
  } finally { await f.close(); }
});
