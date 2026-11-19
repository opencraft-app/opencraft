import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SessionCapabilities, type CapabilityResult } from "../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp.js";
import { RemoteSessionCapabilities } from "../../packages/session-capabilities/src/remote.js";
import { capabilityResultFromMcp, capabilityResultToMcp } from "../../packages/session-capabilities/src/content.js";
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('MCP cancellation is isolated by authenticated client session even with equal request IDs', async t => {
  const capabilities = new SessionCapabilities(), entered = new Map<string, AbortSignal>();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  capabilities.register({ id: 'wait', refresh() {}, tools: () => [{ name: 'wait', description: 'Wait', inputSchema: { type: 'object' } }],
    async call(_session, _name, args, signal) {
      entered.set((args as any).label, signal);
      await Promise.race([gate, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }))]);
      return { success: true, contentItems: [] };
    }, formatResult: value => value as CapabilityResult });
  const gateway = new SessionCapabilityMcp(capabilities, randomBytes(32)); await gateway.listen();
  const config = gateway.config({ serverId: 'host', threadId: 'thread', execution: { turnId: 'turn' } }) as any;
  const clients: Client[] = [], transports: StreamableHTTPClientTransport[] = [], ids: unknown[] = [], returned: boolean[] = [];
  t.after(async () => { release(); await Promise.all(clients.map(client => client.close())); await gateway.close(); });
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: 'same-credential', version: '1' }); clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers },
      fetch: async (input, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (body?.method === 'tools/call') ids[index] = body.id;
        const response = await fetch(input, init);
        if (body?.method === 'tools/call') returned[index] = true;
        return response;
      } });
    transports.push(transport); await client.connect(transport);
  }
  assert.notEqual(transports[0].sessionId, transports[1].sessionId);
  const controller = new AbortController();
  const first = clients[0].callTool({ name: 'wait', arguments: { label: 'first' } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(first);
  const second = clients[1].callTool({ name: 'wait', arguments: { label: 'second' } });
  const deadline = Date.now() + 5000;
  while (entered.size !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(entered.size, 2); assert.equal(ids[0], ids[1], 'request IDs intentionally collide across clients');
  const duplicate = await fetch(config.url, { method: 'POST', headers: { ...config.http_headers, 'content-type': 'application/json',
    'mcp-session-id': transports[1].sessionId! }, body: JSON.stringify({ jsonrpc: '2.0', id: ids[1], method: 'tools/call', params: { name: 'wait', arguments: { label: 'duplicate' } } }) });
  assert.equal(duplicate.status, 409); assert.equal(entered.size, 2);
  const foreign = gateway.config({ serverId: 'host', threadId: 'foreign', execution: { turnId: 'turn' } }) as any;
  const denied = await fetch(config.url, { method: 'POST', headers: { ...foreign.http_headers, 'content-type': 'application/json',
    'mcp-session-id': transports[0].sessionId! }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: ids[0] } }) });
  assert.equal(denied.status, 403); assert.equal(entered.get('first')!.aborted, false);
  controller.abort(); await rejected;
  const cancelled = Date.now() + 5000;
  while ((!entered.get('first')!.aborted || !returned[0]) && Date.now() < cancelled) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(entered.get('first')!.aborted, true); assert.equal(entered.get('second')!.aborted, false);
  assert.equal(returned[0], true, 'cancelled JSON HTTP response must physically settle without closing the whole client');
  assert.equal(returned[1], undefined);
  release(); assert.equal((await second).isError, false);
  for (const transport of transports) await transport.terminateSession();
});

test('MCP batch admission fences duplicate IDs and retains completed members until the whole response settles', async t => {
  const capabilities = new SessionCapabilities(), calls: string[] = [];
  capabilities.register({ id: 'batch', refresh() {}, tools: () => [{ name: 'batch', description: 'Batch probe', inputSchema: { type: 'object' } }],
    async call(_session, _name, args, signal) {
      const label = (args as any).label; calls.push(label);
      if (label === 'slow') await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
      return { success: true, contentItems: [] };
    }, formatResult: value => value as CapabilityResult });
  const gateway = new SessionCapabilityMcp(capabilities, randomBytes(32)); await gateway.listen();
  const config = gateway.config({ serverId: 'host', threadId: 'thread', execution: { turnId: 'turn' } }) as any;
  const client = new Client({ name: 'batch-probe', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } });
  t.after(async () => { await client.close(); await gateway.close(); }); await client.connect(transport);
  const post = (body: unknown) => fetch(config.url, { method: 'POST', headers: { ...config.http_headers,
    'mcp-session-id': transport.sessionId!, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const call = (id: string | number, label: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'batch', arguments: { label } } });
  assert.equal((await post(Array.from({ length: 257 }, (_, index) => call('capacity-' + index, 'never-capacity')))).status, 429);
  assert.equal((await post([call('duplicate', 'never-one'), call('duplicate', 'never-two')])).status, 409);
  assert.deepEqual(calls, []);
  const batch = post([call('fast', 'fast'), call('slow', 'slow')]);
  const deadline = Date.now() + 5000;
  while (calls.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, ['fast', 'slow']);
  assert.equal((await post([call('new', 'never-new'), call('slow', 'never-held')])).status, 409);
  assert.equal((await post(call('fast', 'never-reused-before-batch-reply'))).status, 409);
  assert.deepEqual(calls, ['fast', 'slow']);
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow' } })).status, 202);
  const reply = await batch; assert.equal(reply.status, 200);
  const responses = await reply.json();
  assert.equal(responses.find((row: any) => row.id === 'fast').result.isError, false);
  assert.equal(responses.find((row: any) => row.id === 'slow').error.code, -32800);
  const reused = await post(call('fast', 'reused-after-physical-reply')); assert.equal(reused.status, 200); await reused.json();
  const typed = await post([call(1, 'number'), call('1', 'string')]); assert.equal(typed.status, 200);
  assert.deepEqual((await typed.json()).map((row: any) => typeof row.id).sort(), ['number', 'string']);
  assert.deepEqual(calls, ['fast', 'slow', 'reused-after-physical-reply', 'number', 'string']);
  await transport.terminateSession();
});

const result: CapabilityResult = { success: true, contentItems: [
  { type: "inputText", text: "Screenshot" },
  { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
] };

test("capability wire preserves mixed content, order and error status", () => {
  for (const success of [true, false]) {
    const source = { ...result, success };
    const wire = capabilityResultToMcp(source);
    assert.deepEqual(wire.content, [{ type: "text", text: "Screenshot" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    assert.deepEqual(capabilityResultFromMcp(wire), source);
  }
  const screenshot = "A".repeat(4 * 1024 * 1024);
  assert.equal(capabilityResultFromMcp({ content: [{ type: "image", mimeType: "image/jpeg", data: screenshot }] }).contentItems.length, 1);
});

test("unsupported, remote, malformed and oversized content fails explicitly", () => {
  for (const imageUrl of ["https://example.test/private", "data:image/svg+xml;base64,YQ==", "data:image/png;base64,A===", "data:image/png;base64,YQ", "data:image/png;base64,YQ==\n"]) {
    assert.throws(() => capabilityResultToMcp({ success: true, contentItems: [{ type: "inputImage", imageUrl }] }));
  }
  for (const content of [[{ type: "resource_link", uri: "file:///private" }], [{ type: "image", mimeType: "image/png", data: "=AAA" }],
    Array.from({ length: 257 }, () => ({ type: "text", text: "" })), [{ type: "text", text: "a".repeat(24 * 1024 * 1024 + 1) }]]) {
    assert.throws(() => capabilityResultFromMcp({ content }));
  }
  assert.throws(() => capabilityResultToMcp({ success: true, contentItems: [{ type: "inputAudio", audioUrl: "data:audio/wav;base64,YQ==" }] }));
});

test("independent host MCP roundtrip delivers image bytes and checks session revocation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "capability-images-"));
  const key = randomBytes(32), capabilities = new SessionCapabilities(); let enabled = true, calls = 0;
  capabilities.register({ id: "browser-fixture", tools: session => enabled && session.serverId === "host" && session.threadId === "thread"
    ? [{ name: "screenshot", description: "Screenshot", inputSchema: { type: "object" } }] : [],
    async call() { calls++; return result; }, formatResult: value => value as CapabilityResult });
  await writeFile(join(directory, "session-capabilities.key"), key, { mode: 0o600 });
  const gateway = new SessionCapabilityMcp(capabilities, key, undefined, { descriptorPath: join(directory, "session-capabilities.json") });
  t.after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  await gateway.listen();
  const host = new RemoteSessionCapabilities(directory, "host"), signal = new AbortController().signal;
  await host.refresh("thread"); assert.equal(host.tools("thread").length, 1);
  assert.deepEqual(await host.call("thread", "screenshot", {}, signal), result);
  const foreign = await host.call("other", "screenshot", { threadId: "thread" }, signal);
  assert.equal(foreign.success, false);
  enabled = false;
  assert.equal((await host.call("thread", "screenshot", {}, signal)).success, false);
  assert.equal(calls, 1);
});

test("cancelled provider completion cannot deliver a late result", async () => {
  const capabilities = new SessionCapabilities(), controller = new AbortController();
  capabilities.register({ id: "late", tools: () => [{ name: "late", description: "Late", inputSchema: {} }],
    async call() { controller.abort(new Error("execution cancelled")); return result; }, formatResult: value => value as CapabilityResult });
  await assert.rejects(capabilities.call({ serverId: "s", threadId: "t" }, "late", {}, controller.signal), /execution cancelled/);
});

test('independent Host preserves signed native call identity across new MCP connections', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-capability-identity-'));
  const key = randomBytes(32), capabilities = new SessionCapabilities(), seen: unknown[] = [];
  capabilities.register({ id: 'native', tools: () => [{ name: 'input', description: 'Input', inputSchema: { type: 'object' } }],
    async call(session) { seen.push(session.execution); return 'ok'; } });
  await writeFile(join(directory, 'session-capabilities.key'), key, { mode: 0o600 });
  const gateway = new SessionCapabilityMcp(capabilities, key, undefined, { descriptorPath: join(directory, 'session-capabilities.json') });
  t.after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  await gateway.listen();
  const execution = { inputId: 'human', turnId: 'turn', callId: 'native-call' };
  for (let i = 0; i < 2; i++) {
    const host = new RemoteSessionCapabilities(directory, 'host');
    await host.call('thread', 'input', { callId: 'model-cannot-replace-native-id' }, new AbortController().signal, execution);
  }
  assert.deepEqual(seen, [execution, execution]);
  const { nativeToolCapabilityToken } = await import('../../packages/session-capabilities/src/credentials.js');
  const config = gateway.config({ serverId: 'host', threadId: 'thread', execution }) as any;
  const denied = await fetch(new URL('/admission', config.url), { method: 'POST',
    headers: { Authorization: 'Bearer ' + nativeToolCapabilityToken(key, { serverId: 'host', threadId: 'thread', execution }), 'content-type': 'application/json' },
    body: JSON.stringify({ inputId: 'human' }) });
  assert.equal(denied.status, 401, 'native tool token is not an input admission credential');
});
