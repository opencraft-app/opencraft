import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SessionCapabilities } from "../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const tool = {name:"reply",description:"Reply",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}};
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
  assert.deepEqual(seen, [session.execution]);
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
