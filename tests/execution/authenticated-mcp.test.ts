import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AuthenticatedMcpProvider, type McpCredential } from '../../packages/session-capabilities/src/authenticated-mcp';
import { SessionCapabilities, type CapabilitySession } from '../../packages/session-capabilities/src/index';

const secret = 'synthetic_service_secret';
const session: CapabilitySession = { serverId: 'server', threadId: 'thread', execution: { inputId: 'input', executionId: 'execution-1' } };
async function fixture(t: test.TestContext) {
 let current: McpCredential | null = { account: 'person-1', revision: 1, token: secret, executionId: 'execution-1' };
 let calls = 0, reflect = false, redirect = false, held: Promise<void> | undefined, entered: (() => void) | undefined;
 const peers = new Set<Server>();
 const server = createServer((req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${secret}`);
  if (redirect) { res.writeHead(307, { location: '/other' }).end(); return; }
  const peer = new Server({ name: 'mock', version: '1' }, { capabilities: { tools: {} } }); peers.add(peer);
  peer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'current_user', description: reflect ? secret : 'Current user', inputSchema: { type: 'object' as const, properties: {} } }] }));
  peer.setRequestHandler(CallToolRequestSchema, async () => { calls++; entered?.(); if (held) await held; return { content: [{ type: 'text', text: reflect ? secret : 'person-1' }] }; });
  void (async () => { const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); await peer.connect(transport); await transport.handleRequest(req, res); })().catch(() => res.end()).finally(() => { void peer.close(); peers.delete(peer); });
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
 const service = new SessionCapabilities(); service.register(new AuthenticatedMcpProvider({ id: 'service', prefix: 'service_', endpoint: `http://127.0.0.1:${address.port}/mcp`,
  resolve: (source, invocation) => source.serverId === 'server' && source.execution?.inputId === 'input' && (!invocation || source.execution.executionId === current?.executionId) ? current : null }));
 t.after(async () => { for (const peer of peers) await peer.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
 return { service, calls: () => calls, reflect: () => { reflect = true; }, redirect: () => { redirect = true; }, revoke: () => { current = null; }, replace: () => { current = { account: 'person-2', revision: 2, token: secret, executionId: 'execution-2' }; },
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
 await assert.rejects(operation,error=>error instanceof Error&&!error.message.includes(secret)); gate.release();
 const other=await fixture(t); other.redirect(); await assert.rejects(other.service.refresh(session),error=>error instanceof Error&&!error.message.includes(secret));
});
