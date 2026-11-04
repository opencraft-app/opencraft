import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SessionCapabilityMcp } from '../../packages/session-capabilities/src/mcp';
import { CapabilityError } from '../../packages/session-capabilities/src/index';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AuthenticatedMcpProvider, type McpCredential } from '../../packages/session-capabilities/src/authenticated-mcp';
import { SessionCapabilities, type CapabilitySession } from '../../packages/session-capabilities/src/index';

const secret = 'synthetic_service_secret';
const session: CapabilitySession = { serverId: 'server', threadId: 'thread', execution: { inputId: 'input', executionId: 'execution-1' } };
async function fixture(t: test.TestContext) {
 let current: McpCredential | null = { account: 'person-1', revision: 1, token: secret, executionId: 'execution-1' };
 let catalogs = 0, rejection = 0, failCall = false;
 let catalogHeld: Promise<void> | undefined, catalogEntered: (()=>void) | undefined;
 let calls = 0, reflect = false, redirect = false, held: Promise<void> | undefined, entered: (() => void) | undefined;
 const peers = new Set<Server>();
 const server = createServer((req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${secret}`);
  if (rejection) { res.writeHead(rejection).end(secret); return; }
  if (redirect) { res.writeHead(307, { location: '/other' }).end(); return; }
  const peer = new Server({ name: 'mock', version: '1' }, { capabilities: { tools: {} } }); peers.add(peer);
  peer.setRequestHandler(ListToolsRequestSchema, async () => { catalogs++; catalogEntered?.(); if(catalogHeld) await catalogHeld; return { tools: [{ name: 'current_user', description: reflect ? secret : 'Current user', inputSchema: { type: 'object' as const, properties: {} } }] }; });
  peer.setRequestHandler(CallToolRequestSchema, async () => { calls++; if (failCall) throw new Error(secret); entered?.(); if (held) await held; return { content: [{ type: 'text', text: reflect ? secret : 'person-1' }] }; });
  void (async () => { const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); await peer.connect(transport); await transport.handleRequest(req, res); })().catch(() => res.end()).finally(() => { void peer.close(); peers.delete(peer); });
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
 const restart = () => { const service = new SessionCapabilities(); service.register(new AuthenticatedMcpProvider({ id: 'service', prefix: 'service_', endpoint: `http://127.0.0.1:${address.port}/mcp`,
  resolve: (source, invocation) => source.serverId === 'server' && source.execution?.inputId === 'input' && (!invocation || source.execution.executionId === current?.executionId) ? current : null })); return service; };
 const service = restart();
 t.after(async () => { for (const peer of peers) await peer.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
 return { service, restart, holdCatalog: () => { let release!: ()=>void; catalogHeld=new Promise<void>(r=>{release=r;}); return {ready:new Promise<void>(r=>{catalogEntered=r;}),release}; }, catalogs: () => catalogs, reject: (status: number) => { rejection = status; }, failCall: () => { failCall = true; }, calls: () => calls, reflect: () => { reflect = true; }, redirect: () => { redirect = true; }, revoke: () => { current = null; }, replace: () => { current = { account: 'person-2', revision: 2, token: secret, executionId: 'execution-2' }; },
  hold: () => { let release!: () => void; held = new Promise<void>(r => { release = r; }); return { ready: new Promise<void>(r => { entered = r; }), release }; } };
}
test('authenticated MCP catalogs and reflected outputs are sanitized; unbound sessions have no tools', async t => {
 const f = await fixture(t); f.reflect(); await f.service.refresh(session);
 assert.equal(f.service.tools(session).length, 1); assert.equal(JSON.stringify(f.service.tools(session)).includes(secret), false);
 const result = await f.service.call(session, 'service_current_user', {}, AbortSignal.timeout(5000)); assert.equal(JSON.stringify(result).includes(secret), false);
 assert.equal(result.success, true); assert.deepEqual(f.service.tools({ serverId: 'server', threadId: 'thread' }), []);
 f.replace(); const before=f.calls(); await assert.rejects(f.service.call(session, 'service_current_user', {}, AbortSignal.timeout(5000))); assert.equal(f.calls(),before);
});
test('revocation cancels in-flight requests; redirects and transport errors never expose secrets', async t => {
 const f=await fixture(t); await f.service.refresh(session); const gate=f.hold();
 const operation=f.service.call(session,'service_current_user',{},AbortSignal.timeout(5000)); await gate.ready; f.revoke();
 await assert.rejects(operation,error=>error instanceof CapabilityError&&error.code==='capability_not_authorized'&&error.outcome==='unknown'&&!error.message.includes(secret)); gate.release();
 const other=await fixture(t); other.redirect(); await assert.rejects(other.service.refresh(session),error=>error instanceof Error&&!error.message.includes(secret));
});

async function gateway(t: test.TestContext, service: SessionCapabilities) {
 const root=await mkdtemp(join(tmpdir(),'authenticated-mcp-recovery-'));
 const descriptorPath=join(root,'endpoint.json');
 const bridge = new SessionCapabilityMcp(service, randomBytes(32),undefined,{descriptorPath}); await bridge.listen();
 // Simulate an already-running native execution: it knows the declaration and
 // authenticates to a replacement gateway without performing tools/list.
 const configuration = JSON.parse(await readFile(descriptorPath,'utf8')).url;
 const client = new Client({ name: 'surviving-host', version: '1' });
 await client.connect(new StreamableHTTPClientTransport(new URL(configuration), {
  requestInit: { headers: { Authorization: 'Bearer ' + bridge.token(session) } },
 }));
 t.after(async () => { await client.close(); await bridge.close(); await rm(root,{recursive:true,force:true}); });
 return client;
}
test('a surviving execution calls a cold replacement gateway without listing tools or replaying the invocation', async t => {
 const f=await fixture(t);
 await f.service.refresh(session); assert.equal(f.catalogs(),1);
 const client=await gateway(t,f.restart());
 assert.equal((await client.callTool({name:'service_current_user',arguments:{}})).isError,false);
 assert.equal(f.catalogs(),2); assert.equal(f.calls(),1);
 assert.equal((await client.callTool({name:'service_current_user',arguments:{}})).isError,false);
 assert.equal(f.catalogs(),2); assert.equal(f.calls(),2);
});
test('cold recovery preserves execution authorization and cancellation before dispatch', async t => {
 const f=await fixture(t); f.replace();
 await assert.rejects(f.service.call(session,'service_current_user',{},AbortSignal.timeout(5000)),
  error=>error instanceof CapabilityError&&error.code==='capability_not_authorized'&&error.outcome==='not_dispatched');
 assert.equal(f.calls(),0);
 const cancelled=AbortSignal.abort(secret);
 await assert.rejects(f.service.call(session,'service_current_user',{},cancelled),
  error=>error instanceof CapabilityError&&error.code==='capability_cancelled'&&!error.message.includes(secret));
 assert.equal(f.calls(),0);
});
test('gateway diagnostics distinguish local denial, catalog rejection and uncertain effects without reflecting raw errors', async t => {
 const f=await fixture(t); const client=await gateway(t,f.service); const logs: unknown[][]=[];
 t.mock.method(console,'error',(...args: unknown[])=>logs.push(args));
 const failure=async (name: string) => {
  const result=await client.callTool({name,arguments:{}});
  assert.equal(result.isError,true);
  assert.ok(Array.isArray(result.content)&&result.content[0]?.type==='text');
  return JSON.parse(result.content[0].text).error;
 };
 const denied=await failure('service_missing');
 assert.equal(denied.code,'capability_not_authorized'); assert.equal(denied.outcome,'not_dispatched');
 const other=await fixture(t); other.reject(403); const cold=await gateway(t,other.service);
 const rejected=await cold.callTool({name:'service_current_user',arguments:{}});
 assert.ok(Array.isArray(rejected.content)&&rejected.content[0]?.type==='text');
 const rejection=JSON.parse(rejected.content[0].text).error;
 assert.equal(rejection.code,'capability_upstream_rejected'); assert.equal(rejection.phase,'catalog');
 assert.equal(rejection.upstreamStatus,403); assert.equal(rejection.outcome,'not_dispatched'); assert.equal(other.calls(),0);
 f.failCall(); const uncertain=await failure('service_current_user');
 assert.equal(uncertain.code,'capability_outcome_unknown'); assert.equal(uncertain.phase,'invocation');
 assert.equal(uncertain.outcome,'unknown'); assert.equal(f.calls(),1,'failed external invocation must never be replayed');
 assert.notEqual(denied.requestId,uncertain.requestId);
 assert.equal(JSON.stringify({denied,rejection,uncertain,logs}).includes(secret),false);
 for (const result of [denied,rejection,uncertain]) assert.ok(logs.some(log=>log.some(value=>typeof value==='string'&&value.includes(result.requestId))));
});

test('revocation or cancellation during cold catalog recovery never reaches the external tool',async t=>{
 for(const cancel of [false,true]) {
  const f=await fixture(t), gate=f.holdCatalog(), controller=new AbortController();
  const operation=f.service.call(session,'service_current_user',{},controller.signal);
  const rejected=assert.rejects(operation,error=>error instanceof CapabilityError&&error.outcome==='not_dispatched'
   &&error.code===(cancel?'capability_cancelled':'capability_not_authorized'));
  await gate.ready;
  if(cancel) controller.abort(secret); else f.revoke();
  gate.release(); await rejected;
  assert.equal(f.calls(),0);
 }
});
