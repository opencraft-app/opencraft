import test from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SessionCapabilities } from "../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const tool = {name:"reply",description:"Reply",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}};
test('independent MCP clients sharing an execution never reuse an invocation identity', async () => {
 const service=new SessionCapabilities(),seen:any[]=[];
 service.register({id:'identity',tools:()=>[tool],async call(session){seen.push(session.execution);return 'ok';}});
 const mcp=new SessionCapabilityMcp(service,randomBytes(32)),clients:Client[]=[];await mcp.listen();
 const session={serverId:'server',threadId:'thread',execution:{inputId:'input',turnId:'turn',callId:'native-call'}},config=mcp.config(session) as any;
 try {
  for(let i=0;i<2;i++){
   const client=new Client({name:'independent',version:'1'});clients.push(client);
   await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.http_headers}}));
   await client.callTool({name:'reply',arguments:{text:'call-'+i}});
  }
  assert.notEqual(seen[0].callId,seen[1].callId);
  for(const execution of seen){const [parent,id]=JSON.parse(execution.callId);assert.equal(parent,'native-call');assert.match(id,/^[0-9a-f-]{36}$/);assert.equal(execution.inputId,'input');assert.equal(execution.turnId,'turn');}
  assert.equal(session.execution.callId,'native-call');
 }finally{await Promise.all(clients.map(client=>client.close()));await mcp.close();}
});
test("native and MCP share session policy; calls recheck revocation",async t=>{
 const service=new SessionCapabilities();let enabled=true,calls=0;
 service.register({id:"fixture",tools:s=>enabled&&s.serverId==="server"&&s.threadId==="one"?[tool]:[],async call(s,_n,args){assert.equal(s.threadId,"one");calls++;return args;}});
 const mcp=new SessionCapabilityMcp(service,randomBytes(32));await mcp.listen();t.after(()=>mcp.close());
 const one={serverId:"server",threadId:"one"},two={serverId:"server",threadId:"two"},config=mcp.config(one) as any;
 const client=new Client({name:"fixture",version:"1"});await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.http_headers}}));t.after(()=>client.close());
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name),["reply"]);
 assert.equal((await client.callTool({name:"reply",arguments:{text:"hello"}})).isError,false);
 assert.equal((await service.scoped("server").call("one","reply",{},new AbortController().signal)).success,true);assert.equal(calls,2);
 await assert.rejects(service.call(two,"reply",{},new AbortController().signal),/authorized/);
 const other=new Client({name:"other",version:"1"});await other.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:{Authorization:"Bearer "+mcp.token(two)}}}));t.after(()=>other.close());
 assert.deepEqual((await other.listTools()).tools,[]);assert.equal((await other.callTool({name:"reply",arguments:{threadId:"one"}})).isError,true);
 enabled=false;assert.deepEqual((await client.listTools()).tools,[]);assert.equal((await client.callTool({name:"reply",arguments:{}})).isError,true);assert.equal(calls,2);
 assert.equal((await fetch(config.url,{method:"POST",body:"{}"})).status,401);
 assert.equal((await fetch(config.url,{method:"POST",headers:{...config.http_headers,Origin:"https://untrusted.example"},body:"{}"})).status,403);
});
test("ambiguous owners fail closed",()=>{const s=new SessionCapabilities();for(const id of ["a","b"])s.register({id,tools:()=>[tool],async call(){return null;}});assert.throws(()=>s.tools({serverId:"s",threadId:"t"}),/conflict/);});

test("new native sessions list reserved declarations but cannot call until bound; binding survives restart",async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {CapabilityBindings}=await import('../../packages/session-capabilities/src/bindings.js');
 const dir=await mkdtemp(join(tmpdir(),'capability-bindings-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'bindings.sqlite'),key=randomBytes(32);
 let store=new CapabilityBindings(path),service=new SessionCapabilities(),calls=0;
 service.register({id:'fixture',tools:s=>s.threadId==='new'?[tool]:[],async call(){calls++;return 'ok';}});
 let gateway=new SessionCapabilityMcp(service,key,store);await gateway.listen();const reserved=gateway.prepare([tool]),configuration=reserved.configuration as any;
 const client=new Client({name:'pending',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(configuration.url),{requestInit:{headers:configuration.http_headers}}));
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['reply']);assert.equal((await client.callTool({name:'reply',arguments:{text:'before binding'}})).isError,true);assert.equal(calls,0);
 reserved.bind({serverId:'s',threadId:'new'});assert.throws(()=>reserved.bind({serverId:'s',threadId:'other'}));
 assert.equal((gateway.config({serverId:'s',threadId:'new'}) as any).http_headers.Authorization,configuration.http_headers.Authorization);
 assert.equal((await client.callTool({name:'reply',arguments:{text:'after binding'}})).isError,false);await client.close();await gateway.close();store.close();
 store=new CapabilityBindings(path);gateway=new SessionCapabilityMcp(service,key,store);await gateway.listen();
 t.after(async()=>{await gateway.close();store.close();});const next=gateway.config({serverId:'s',threadId:'new'}) as any;
 assert.equal(next.http_headers.Authorization,configuration.http_headers.Authorization);
 const reopened=new Client({name:'reopened',version:'1'});await reopened.connect(new StreamableHTTPClientTransport(new URL(next.url),{requestInit:{headers:next.http_headers}}));t.after(()=>reopened.close());
 assert.equal((await reopened.callTool({name:'reply',arguments:{text:'restored'}})).isError,false);assert.equal(calls,2);assert.deepEqual(store.get('made-up'),null);
});

test("domain preauthorization is per tool, survives reservation binding, and never grants a call",async t=>{
 const service=new SessionCapabilities();let admitted=false,calls=0;
 const reply={...tool,approval:"preauthorized" as const},ordinary={...tool,name:"other"};
 service.register({id:"fixture",tools:s=>admitted&&s.threadId==="one"?[reply,ordinary]:[],async call(){calls++;return "ok";}});
 const mcp=new SessionCapabilityMcp(service,randomBytes(32));await mcp.listen();t.after(()=>mcp.close());
 const reserved=mcp.prepare([reply,ordinary]),config=reserved.configuration as any;
 assert.deepEqual(config.tools,{reply:{approval_mode:"approve"}});
 assert.equal(config.default_tools_approval_mode,undefined);
 const client=new Client({name:"fixture",version:"1"});await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.http_headers}}));t.after(()=>client.close());
 assert.ok((await client.listTools()).tools.every(t=>!("approval" in t)));
 assert.equal((await client.callTool({name:"reply",arguments:{text:"before binding"}})).isError,true);
 reserved.bind({serverId:"s",threadId:"one"});
 assert.equal((await client.callTool({name:"reply",arguments:{text:"before admission"}})).isError,true);
 admitted=true;
 assert.deepEqual((mcp.config({serverId:"s",threadId:"one"}) as any).tools,config.tools);
 assert.equal((await client.callTool({name:"reply",arguments:{text:"admitted"}})).isError,false);
 admitted=false;
 assert.equal((await client.callTool({name:"reply",arguments:{text:"revoked"}})).isError,true);
 assert.equal(calls,1);assert.equal(mcp.config({serverId:"s",threadId:"one"}),null);
 const defaults=mcp.prepare([ordinary]).configuration as any;assert.equal(defaults.tools,undefined);
});


test("creation MCP waits for one execution binding and never authorizes a staged or replaced execution", async t => {
  const service = new SessionCapabilities(), seen: unknown[] = [];
  service.register({ id: "execution-fixture", tools: session => session.execution?.inputId === "first" ? [tool] : [],
    async call(session) { seen.push(session.execution); return "ok"; } });
  const mcp = new SessionCapabilityMcp(service, randomBytes(32)); await mcp.listen(); t.after(() => mcp.close());
  const reservation = mcp.prepareExecution(), config = reservation.configuration as any;
  const client = new Client({ name: "creation", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } }));
  t.after(() => client.close());
  assert.equal((await client.callTool({ name: "reply", arguments: {} })).isError, true);
  let completed = false; const listing = client.listTools().then(result => { completed = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(completed, false);
  const session = { serverId: "server", threadId: "new", execution: { inputId: "first", executionId: "execution-first" } };
  reservation.bind(session); reservation.bind(session);
  assert.deepEqual((await listing).tools.map(tool => tool.name), ["reply"]);
  assert.throws(() => reservation.bind({ ...session, execution: { inputId: "second", executionId: "execution-second" } }), /already bound/);
  assert.equal((await client.callTool({ name: "reply", arguments: {} })).isError, false);
  assert.equal((await client.callTool({ name: "reply", arguments: {} })).isError, false);
  assert.deepEqual(seen.map(value => { const { callId, ...execution } = value as any; assert.equal(typeof callId, 'string'); return execution; }), [session.execution, session.execution]);
  assert.notEqual((seen[0] as any).callId, (seen[1] as any).callId);
  assert.equal(Object.hasOwn(session.execution, 'callId'), false);
  reservation.cancel();
  await assert.rejects(client.listTools());
});

test("a creation reservation keeps its endpoint and binds its first execution after listener replacement", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { CapabilityBindings } = await import("../../packages/session-capabilities/src/bindings.js");
  const root = await mkdtemp(join(tmpdir(), "creation-capabilities-"));
  const path = join(root, "bindings.sqlite"), key = randomBytes(32), options = { descriptorPath: join(root, "endpoint.json"), retainEndpoint: true };
  const service = new SessionCapabilities(); let calls = 0;
  service.register({ id: "first", tools: session => session.execution?.inputId === "first" ? [tool] : [],
    async call(session) { assert.equal(session.execution?.executionId, "native-first"); calls++; return {}; } });
  let bindings = new CapabilityBindings(path), mcp = new SessionCapabilityMcp(service, key, bindings, options);
  t.after(async () => { await mcp.close(); bindings.close(); await rm(root, { recursive: true, force: true }); });
  await mcp.listen();
  const scope = { serverId: "server", threadId: "new" }, original = mcp.prepareExecution();
  original.bindThread(scope);
  const config = original.configuration as any;
  await mcp.close(); bindings.close();
  bindings = new CapabilityBindings(path); mcp = new SessionCapabilityMcp(service, key, bindings, options);
  await mcp.listen();
  const restored = mcp.restoreExecution(scope); assert.ok(restored);
  assert.deepEqual(restored.configuration, config, "the original native thread keeps its installed MCP configuration");
  assert.equal(mcp.restoreExecution({ ...scope, threadId: "other" }), null);
  restored.bind({ ...scope, execution: { inputId: "first", executionId: "native-first" } });
  assert.throws(() => restored.bind({ ...scope, execution: { inputId: "second", executionId: "other" } }), /already bound/);
  const client = new Client({ name: "creation-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } }));
  try { assert.equal((await client.callTool({ name: "reply", arguments: { text: "synthetic" } })).isError, false); }
  finally { await client.close(); }
  assert.equal(calls, 1);
  restored.cancel(); assert.equal(mcp.restoreExecution(scope), null);
});

test("upgrading a v1 binding database preserves its existing session identity", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { openManagedDatabase } = await import("@opencraft/sqlite-node");
  const { CapabilityBindings } = await import("../../packages/session-capabilities/src/bindings.js");
  const root = await mkdtemp(join(tmpdir(), "capability-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "bindings.sqlite");
  const old = openManagedDatabase({ path, migrations: [{ version: 1, name: "session-capability-bindings",
    sql: "CREATE TABLE capability_bindings(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,thread_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(server_id,thread_id)) STRICT;" }] });
  old.database.prepare("INSERT INTO capability_bindings VALUES('old','server','original',1)").run(); old.database.close();
  const upgraded = new CapabilityBindings(path);
  try {
    assert.deepEqual(upgraded.get("old"), { serverId: "server", threadId: "original" });
    upgraded.prepareExecution("new", { serverId: "server", threadId: "created" });
    assert.equal(upgraded.executionId({ serverId: "server", threadId: "created" }), "new");
  } finally { upgraded.close(); }
});

test('bridge memory reservations never touch persistent bindings, including calls after revoke',async t=>{
  const service=new SessionCapabilities();let calls=0;
  service.register({id:'first-execution',tools:session=>session.execution?[tool]:[],async call(){calls++;return {};}});
  const bindings=new Proxy({},{get(){return ()=>{throw Error('Synchronous binding I/O forbidden');};}}) as any;
  const mcp=new SessionCapabilityMcp(service,randomBytes(32),bindings);
  await mcp.listen();t.after(()=>mcp.close());
  const reservation=mcp.prepareExecution({memoryOnly:true}),config=reservation.configuration as any;
  reservation.bindThread({serverId:'server',threadId:'first'});
  const client=new Client({name:'bridge-memory',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.http_headers}}));
  t.after(()=>client.close());
  assert.equal((await client.callTool({name:'reply',arguments:{}})).isError,true);
  assert.equal(calls,0);
  const scope={serverId:'server',threadId:'first',execution:{inputId:'first',executionId:'first'}};
  reservation.bind(scope);
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['reply']);
  assert.equal((await client.callTool({name:'reply',arguments:{}})).isError,false);
  assert.equal(calls,1);assert.ok(mcp.config(scope));
  reservation.resetBeforeStart();
  assert.equal((await client.callTool({name:'reply',arguments:{}})).isError,true);assert.equal(calls,1);
  reservation.bind({...scope,execution:{inputId:'replacement-before-start',executionId:'replacement-before-start'}});
  assert.equal((await client.callTool({name:'reply',arguments:{}})).isError,false);assert.equal(calls,2);
  reservation.cancel();await assert.rejects(client.listTools());assert.equal(calls,2);
});

test('retiring an execution credential aborts only its pending providers and retains physical reply custody', async t => {
  const service = new SessionCapabilities(); let release!: () => void, started!: () => void, signal!: AbortSignal;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  service.register({ id: 'retirement', tools: () => [tool], async call(_session, _name, args, current) {
    if (args.text === 'other') return 'other remains live';
    signal = current; started(); await gate; current.throwIfAborted(); return 'late';
  } });
  const mcp = new SessionCapabilityMcp(service, randomBytes(32)); await mcp.listen();
  const reservation = mcp.prepareExecution({ memoryOnly: true });
  reservation.bind({ serverId: 'server', threadId: 'cancelled', execution: { inputId: 'input', executionId: 'execution' } });
  const first = new Client({ name: 'cancelled-owner', version: '1' }), second = new Client({ name: 'other-owner', version: '1' });
  t.after(async () => { release(); await first.close(); await second.close(); await mcp.close(); });
  const config = reservation.configuration as any, other = mcp.config({ serverId: 'server', threadId: 'other' }) as any;
  await first.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } }));
  await second.connect(new StreamableHTTPClientTransport(new URL(other.url), { requestInit: { headers: other.http_headers } }));
  let completed = false;
  const calling = first.callTool({ name: 'reply', arguments: { text: 'wait' } });
  const rejected = assert.rejects(calling, /cancelled/).then(() => { completed = true; });
  void rejected.catch(() => {});
  await entered; reservation.cancel();
  for (let index = 0; !signal.aborted && index < 100; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(signal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(completed, false);
  assert.equal((await second.callTool({ name: 'reply', arguments: { text: 'other' } })).isError, false);
  release(); await rejected;
});

for (const initialized of [false, true]) test(`retired execution cannot dispatch a slow HTTP body (${initialized ? 'initialized' : 'stateless'})`, async t => {
  const service = new SessionCapabilities(); let calls = 0;
  service.register({ id: 'slow-retirement', tools: () => [tool], async call() { calls++; return 'unexpected'; } });
  const mcp = new SessionCapabilityMcp(service, randomBytes(32)); await mcp.listen();
  const reservation = mcp.prepareExecution({ memoryOnly: true });
  reservation.bind({ serverId: 'server', threadId: 'thread', execution: { inputId: 'input', executionId: 'execution' } });
  const config = reservation.configuration as any, client = new Client({ name: 'slow-body', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } });
  t.after(async () => { await client.close(); await mcp.close(); });
  if (initialized) await client.connect(transport);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'reply', arguments: { text: 'old input' } } });
  const entered = new Promise<void>(resolve => (mcp as any).server.once('request', () => resolve()));
  let finish!: () => void;
  const result = new Promise<number>((resolve, reject) => {
    const req = httpRequest(config.url, { method: 'POST', headers: { ...config.http_headers,
      ...(transport.sessionId ? { 'mcp-session-id': transport.sessionId } : {}), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode!));
    });
    req.once('error', reject); t.after(() => req.destroy()); req.write(body.slice(0, -1)); finish = () => req.end(body.slice(-1));
  });
  await entered; reservation.cancel(); finish();
  assert.equal(await result, 401); assert.equal(calls, 0);
});

test('retiring a credential cancels an admitted stateless provider without releasing its physical reply early', async t => {
  const service = new SessionCapabilities(); let release!: () => void, entered!: () => void, signal!: AbortSignal;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  service.register({ id: 'stateless-retirement', tools: () => [tool], async call(_session, _name, _args, current) {
    signal = current; entered(); await gate; current.throwIfAborted(); return 'late';
  } });
  const mcp = new SessionCapabilityMcp(service, randomBytes(32)); await mcp.listen();
  const reservation = mcp.prepareExecution({ memoryOnly: true });
  reservation.bind({ serverId: 'server', threadId: 'stateless', execution: { inputId: 'input', executionId: 'execution' } });
  t.after(async () => { release(); await mcp.close(); });
  const config = reservation.configuration as any;
  let completed = false;
  const calling = fetch(config.url, { method: 'POST', headers: { ...config.http_headers,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'stateless', method: 'tools/call', params: { name: 'reply', arguments: {} } })
  }).then(async response => { const body = await response.json() as any; completed = true; return body; });
  await started; reservation.cancel();
  assert.equal(signal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(completed, false);
  release(); const reply = await calling;
  assert.equal(reply.result.isError, true);
  assert.equal(reply.id, 'stateless');
  assert.equal((mcp as any).credentialInvocations.size, 0);
});


test('MCP failures correlate their safe phase without logging arguments or exception text', async t => {
 const service=new SessionCapabilities();service.register({id:'diagnostic',tools:()=>[tool],async call(){throw Error('private-url-and-credential')}});
 const mcp=new SessionCapabilityMcp(service,randomBytes(32));await mcp.listen();
 const config=mcp.config({serverId:'private-server',threadId:'private-thread'}) as any;
 const client=new Client({name:'diagnostic',version:'1'});const records:string[]=[];
 t.mock.method(console,'warn',(...args:any[])=>{records.push(args.join(' '))});
 try {
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.http_headers}}));
  const result=await client.callTool({name:'reply',arguments:{text:'private-input'}});
  assert.equal(result.isError,true);const log=JSON.parse(records.find(row=>row.startsWith('[session-capability]'))!.slice('[session-capability] '.length));
  assert.equal(log.stage,'dispatch');assert.match(log.diagnosticId,/^[a-f0-9-]{36}$/);
  assert(JSON.stringify(result).includes(log.diagnosticId));
  for(const privateValue of ['private-url-and-credential','private-input','private-server','private-thread'])assert(!records.join('').includes(privateValue));
  for(let i=0;i<110;i++)(mcp as any).diagnoseFailure('dispatch');assert.equal(records.length,100);
 }finally{await client.close();await mcp.close()}
});
