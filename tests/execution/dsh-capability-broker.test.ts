import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DshCapabilityBroker, normalizeCapabilities } from "../../apps/local-agent-host/src/dsh-capability-broker.js";
import { DshCapabilityLink, verifyDshCapabilityRegistration } from "../../apps/local-agent-host/src/dsh-capability-link.js";
import { DshExecutionAuthority } from "../../apps/local-agent-host/src/dsh-execution-authority.js";
const a = { connectionId: "a", identity: { id: "local", username: "local" } };
const b = { connectionId: "b", identity: { id: "local", username: "local" } };
const specs = [{ type: "function", name: "browser_open", description: "Open owned browser", inputSchema: { type: "object", properties: { url: { type: "string" } } } }];

test("Host computes and propagates approval-aware deadlines, never trusting model configuration", () => {
  assert.equal(normalizeCapabilities(specs)[0].timeoutMs, 10000);
  assert.equal(normalizeCapabilities([{ type: "namespace", name: "connectors", description: "Connectors", tools: [{ ...specs[0], name: "call_tool", timeoutMs: 1 }] }])[0].timeoutMs, 150000);
  assert.equal(normalizeCapabilities([{ ...specs[0], name: "call_tool", timeoutMs: 1 }])[0].timeoutMs, 10000);
  assert.equal(normalizeCapabilities([{ type: "namespace", name: "other", description: "Other", tools: [{ ...specs[0], name: "call_tool" }] }])[0].timeoutMs, 10000);
});

test("capability registration and return are bound to the owning thread and connection", async () => {
  const broker = new DshCapabilityBroker();
  const frames: any[] = [];
  try {
    broker.register("s", a, specs, frame => frames.push(frame));
    assert.equal(broker.matches("s", a, specs), true);
    assert.equal(broker.matches("s", a, [{ ...specs[0], description: "changed" }]), false);
    assert.throws(() => broker.register("s", b, specs, () => {}), /another connection/);
    await assert.rejects(broker.invoke("s", "t", "browser_open", {}, new AbortController().signal, b), /owner/);
    await assert.rejects(broker.invoke("other", "t", "browser_open", {}, new AbortController().signal, a), /owner/);
    const result = broker.invoke("s", "t", "browser_open", { url: "about:blank" }, new AbortController().signal, a);
    assert.equal(frames[0].method, "item/tool/call");
    assert.equal(frames[0].params.threadId, "s");
    assert.equal(broker.respond(b, frames[0].id, { success: true }), false);
    assert.equal(broker.respond(a, frames[0].id, { success: true }), true);
    assert.deepEqual(await result, { success: true });
    assert.equal(broker.respond(a, frames[0].id, {}), false);
  } finally { broker.close(); }
});
test("cancel, timeout and disconnect revoke pending calls and reject late replies", async () => {
  const broker = new DshCapabilityBroker(15);
  const frames: any[] = [];
  try {
    broker.register("s", a, specs, frame => frames.push(frame));
    const abort = new AbortController();
    const cancelled = broker.invoke("s", "t", "browser_open", {}, abort.signal, a);
    const firstId = frames[0].id;
    abort.abort();
    await assert.rejects(cancelled, /cancelled/);
    assert.equal(broker.respond(a, firstId, {}), false);
    assert.equal(frames.at(-1).method, "serverRequest/resolved");
    await assert.rejects(broker.invoke("s", "t", "browser_open", {}, new AbortController().signal, a), /timed out/);
    const disconnected = broker.invoke("s", "t", "browser_open", {}, new AbortController().signal, a);
    broker.disconnect(a);
    await assert.rejects(disconnected, /disconnected/);
    assert.deepEqual(broker.list("s"), []);
  } finally { broker.close(); }
});

test("fork inherits original function/namespace specs, with a separate child reply owner", async () => {
  const broker = new DshCapabilityBroker();
  const parentFrames: any[] = [], childFrames: any[] = [];
  const wire = [...specs, { type: "namespace", name: "browser", description: "Browser tools", tools: [
    { name: "read", description: "Read", inputSchema: { type: "object", properties: {} } },
  ] }];
  try {
    broker.register("parent", a, wire, frame => parentFrames.push(frame));
    assert.throws(() => broker.register("wrong", a, broker.list("parent"), () => {}), /Invalid dynamic tool/);
    assert.throws(() => broker.specs("parent", b), /another connection/);
    const inherited = broker.specs("parent", a)!;
    assert.deepEqual(inherited, wire);
    broker.register("child", a, inherited, frame => childFrames.push(frame));
    (inherited[0] as any).name = "mutation";
    assert.deepEqual(broker.specs("child", a), wire);
    const result = broker.invoke("child", "turn", "browser.read", {}, new AbortController().signal, a);
    assert.equal(parentFrames.length, 0);
    assert.equal(childFrames[0].params.threadId, "child");
    assert.equal(childFrames[0].params.namespace, "browser");
    assert.equal(broker.respond(b, childFrames[0].id, {}), false);
    broker.respond(a, childFrames[0].id, { success: true });
    assert.deepEqual(await result, { success: true });
    assert.equal(broker.specs("unknown", a), undefined);
    broker.register("empty", a, [], () => {});
    assert.deepEqual(broker.specs("empty", a), []);
  } finally { broker.close(); }
});

test("engine capability readiness accepts cold deferral only at display hydration", () => {
  assert.doesNotThrow(() => verifyDshCapabilityRegistration(3, { registered: 3 }));
  assert.doesNotThrow(() => verifyDshCapabilityRegistration(
    3,
    { registered: 0, deferred: true },
    { allowDeferred: true },
  ));
  assert.throws(
    () => verifyDshCapabilityRegistration(3, { registered: 0, deferred: true }),
    /registered 0 of 3 dynamic tools/u,
  );
  assert.throws(
    () => verifyDshCapabilityRegistration(3, { registered: 2 }),
    /registered 2 of 3 dynamic tools/u,
  );
  assert.throws(
    () => verifyDshCapabilityRegistration(3, { registered: 2, deferred: true }, { allowDeferred: true }),
    /registered 2 of 3 dynamic tools/u,
  );
});

test("capability bridge failures expose only known codes, never exception text", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/events") {
      response.end(JSON.stringify({ events: [] }));
      return;
    }
    response.writeHead(400).end(JSON.stringify({
      code: "CAPABILITY_CONFLICT",
      error: `tool already registered\n${"x".repeat(500)}`,
      ignoredRequestPayload: "must-not-surface",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const broker = new DshCapabilityBroker();
  const authority = new DshExecutionAuthority(":memory:");
  const link = new DshCapabilityLink("x".repeat(64), broker, authority);
  link.attach(`http://127.0.0.1:${address.port}`);
  try {
    await assert.rejects(link.validate([]), (error: Error) => {
      assert.equal(error.message, "DSH capability bridge request failed: 400 (CAPABILITY_CONFLICT)");
      assert.doesNotMatch(error.message, /tool already registered/u);
      assert.doesNotMatch(error.message, /must-not-surface/u);
      assert.ok(error.message.length < 380);
      return true;
    });
  } finally {
    await link.close();
    broker.close();
    authority.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("revoked capability owner cannot resurrect through a late registration", () => {
  const broker = new DshCapabilityBroker();
  try {
    broker.register("s", a, specs, () => {});
    broker.disconnect(a);
    assert.throws(() => broker.register("s", a, specs, () => {}), /disconnected/u);
    assert.doesNotThrow(() => broker.register("s", b, specs, () => {}));
    assert.equal(broker.release("s", a), false);
    assert.equal(broker.list("s").length, 1);
  } finally { broker.close(); }
});

test("Host tools coexist with browser leases and survive browser disconnect",async()=>{
 let enabled=true,calls=0;
 const broker=new DshCapabilityBroker(undefined,{tools:id=>enabled&&id==="s"?[{name:"im_reply",description:"Reply",inputSchema:{type:"object"}}]:[],async call(id,name){assert.equal(id,"s");assert.equal(name,"im_reply");calls++;return {success:true,contentItems:[]};}});
 broker.register("s",a,specs,()=>{});assert.deepEqual(broker.list("s").map(t=>t.name),["im_reply","browser_open"]);
 assert.throws(()=>broker.register("s",a,[{...specs[0],name:"im_reply"}],()=>{}),/reserved/);broker.disconnect(a);assert.deepEqual(broker.list("s").map(t=>t.name),["im_reply"]);
 await broker.invoke("s","turn","im_reply",{},new AbortController().signal,b);assert.equal(calls,1);enabled=false;await assert.rejects(broker.invoke("s","turn","im_reply",{},new AbortController().signal,b));broker.close();
});

test("DSH coalesces native tool registration, retries failures and fences a replaced bridge", async t => {
  const calls: any[] = []; let release!: () => void, entered!: () => void, hold = false, fail = false;
  let entry = new Promise<void>(r => { entered = r; });
  const server = createServer(async (request, response) => {
    if (request.url === "/events") { response.end('{"events":[]}'); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const params = JSON.parse(body || "{}"); calls.push({ path: request.url, params });
    if (hold && request.url === "/register") { hold = false; entered(); await new Promise<void>(r => { release = r; }); }
    response.setHeader("content-type", "application/json");
    if (fail) { response.writeHead(500).end('{"code":"ENGINE_OPERATION_FAILED"}'); return; }
    response.end(JSON.stringify({ registered: params.capabilities?.length ?? 0 }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const declaration = { name: "reply", description: "v1", inputSchema: { type: "object", properties: { text: { type: "string" } } } };
  const broker = new DshCapabilityBroker(undefined, { tools: () => [declaration], async call() { return {}; } });
  const authority = new DshExecutionAuthority(":memory:"), link = new DshCapabilityLink("x".repeat(64), broker, authority);
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`; link.attach(endpoint);
  t.after(async () => { release?.(); await link.close(); broker.close(); authority.close(); await new Promise<void>(r => server.close(() => r())); });
  hold = true; const first = link.register("s"); await entry; const second = link.register("s"); release();
  await Promise.all([first, second]); assert.equal(calls.filter(c => c.path === "/register").length, 1);
  declaration.inputSchema.properties.text.type = "number"; await link.register("s");
  assert.deepEqual(calls.map(c => c.path), ["/register", "/unregister", "/register"]);
  assert.equal(calls[0].params.capabilities[0].inputSchema.properties.text.type, "string");
  declaration.description = "v2"; fail = true; await assert.rejects(link.register("s"));
  fail = false; declaration.description = "v1"; await link.register("s");
  assert.equal(calls.at(-1).path, "/register", "failed mutation must invalidate the previous confirmed cache");
  entry = new Promise<void>(r => { entered = r; }); hold = true; declaration.description = "v3";
  const stale = link.register("s"); await entry; link.attach(endpoint + "/successor"); release();
  await assert.rejects(stale, /generation changed/);
  link.attach(endpoint); await link.register("s");
  assert.equal(calls.at(-1).params.capabilities[0].description, "v3");
});

test('DSH generation tools compare native coordinates and reject retired native sessions and turns', async t => {
 const {DshSessionRouting}=await import('../../apps/local-agent-host/src/dsh-session-routing.js');
 const routing=new DshSessionRouting(':memory:');routing.publish('logical',{logicalId:'logical',nativeId:'generation-one',generation:1,seedThroughSeq:10,seedThroughTurn:2,previousLastSeq:30,previousLastTurn:8});
 const authority=new DshExecutionAuthority(':memory:');const claim=authority.claim('logical',a,'request');authority.nativeStarted(claim,'dsh-turn-logical-9','9');
 let calls=0;const broker=new DshCapabilityBroker(undefined,{tools:()=>[{name:'reply',description:'Reply',inputSchema:{type:'object'}}],async call(_thread,_name,_args,_signal,execution){assert.equal(execution?.turnId,'dsh-turn-logical-9');calls++;return {success:true,contentItems:[]};}});
 let events=[{type:'capability-request',id:'good',sessionId:'generation-one',nativeTurnId:'3',capabilityId:'reply',arguments:{}},{type:'capability-request',id:'old-turn',sessionId:'generation-one',nativeTurnId:'2',capabilityId:'reply',arguments:{}},{type:'capability-request',id:'old-native',sessionId:'logical',nativeTurnId:'9',capabilityId:'reply',arguments:{}}];
 const results:any[]=[];let ready!:()=>void;const completed=new Promise<void>(resolve=>{ready=resolve;});
 const server=createServer(async(req,res)=>{if(req.url==='/events'){const batch=events;events=[];res.end(JSON.stringify({events:batch}));return;}let body='';for await(const chunk of req)body+=chunk;results.push(JSON.parse(body));res.end('{}');if(results.length===3)ready();});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const link=new DshCapabilityLink('x'.repeat(64),broker,authority,routing);link.attach(`http://127.0.0.1:${(server.address() as any).port}`);
 t.after(async()=>{await link.close();broker.close();authority.close();routing.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('tool IPC timed out')),3000))]);
 assert.equal(calls,1);assert.ok(results.find(r=>r.id==='good').result);assert.equal(results.find(r=>r.id==='old-turn').error,true);assert.equal(results.find(r=>r.id==='old-native').error,true);
});

test('DSH clears native Host tools when the next execution has an empty catalog',async t=>{
 const {prepareDshExecutionCapabilities}=await import('../../apps/local-agent-host/src/dsh-capability-link.js');
 let enabled=false;const native:string[][]=[];
 const host={async refresh(_thread:string,input?:{inputId?:string}){enabled=input?.inputId==='bound';},tools:()=>enabled?[{name:'reply',description:'Reply',inputSchema:{type:'object'}}]:[],async call(){return {success:true,contentItems:[]};}};
 const broker=new DshCapabilityBroker(undefined,host),authority=new DshExecutionAuthority(':memory:');
 const server=createServer(async(req,res)=>{if(req.url==='/events'){res.end('{"events":[]}');return;}let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');if(req.url==='/register'){native.push(body.capabilities.map((t:any)=>t.name));res.end(JSON.stringify({registered:body.capabilities.length}));}else res.end('{}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const link=new DshCapabilityLink('x'.repeat(64),broker,authority);link.attach(`http://127.0.0.1:${(server.address() as any).port}`);
 t.after(async()=>{await link.close();broker.close();authority.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 await prepareDshExecutionCapabilities('thread','bound',host,broker,link);await prepareDshExecutionCapabilities('thread','unbound',host,broker,link);assert.deepEqual(native,[['reply'],[]]);
});


test('editing an active DSH goal retains tools of its native execution owner',async t=>{
 const {prepareDshExecutionCapabilities}=await import('../../apps/local-agent-host/src/dsh-capability-link.js');
 let visible=false;const contexts:unknown[]=[];const registrations:string[][]=[];
 const host={async refresh(_thread:string,context?:{inputId?:string;turnId?:string}){contexts.push(context);visible=context?.inputId==='original-input'||context?.turnId==='native-owner-turn';},tools:()=>visible?[{name:'reply',description:'Reply',inputSchema:{type:'object'}}]:[],async call(){return {success:true,contentItems:[]};}};
 const broker=new DshCapabilityBroker(undefined,host),authority=new DshExecutionAuthority(':memory:');
 const server=createServer(async(req,res)=>{if(req.url==='/events'){res.end('{"events":[]}');return;}let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');if(req.url==='/register'){registrations.push(body.capabilities.map((t:any)=>t.name));res.end(JSON.stringify({registered:body.capabilities.length}));}else res.end('{}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const link=new DshCapabilityLink('x'.repeat(64),broker,authority);link.attach(`http://127.0.0.1:${(server.address() as any).port}`);
 t.after(async()=>{await link.close();broker.close();authority.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 await prepareDshExecutionCapabilities('thread','original-input',host,broker,link);
 const claim=authority.claim('thread',a,'request');authority.nativeStarted(claim,'native-owner-turn','1');
 await prepareDshExecutionCapabilities('thread',undefined,host,broker,link,authority.table.get('thread')!.turnId);
 assert.deepEqual(registrations,[['reply']],'a goal edit does not replace tools of an active execution');
 assert.deepEqual(contexts,[{inputId:'original-input'},{turnId:'native-owner-turn'}]);
});
