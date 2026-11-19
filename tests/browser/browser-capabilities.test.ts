import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { SessionCapabilities } from '../../packages/session-capabilities/src/index.js';
import { SessionCapabilityMcp } from '../../packages/session-capabilities/src/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RemoteBrowserCapabilities } from '../../scripts/remote-browser/capabilities.js';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
import { acknowledgePresentation } from '../../scripts/remote-browser/tab-presentation.mjs';
import { nativeToolCapabilityToken } from '../../packages/session-capabilities/src/credentials.js';

class NativeFixture extends RemoteBrowserService {
  installed = true;
  async available() { return this.installed; }
  calls: any[] = []; onAutomation?: (method: string, signal: AbortSignal) => Promise<unknown>;
  native = new Map<string, any>();
  async start() { await this.load(); }
  async request(page: string, method: string, input: any, control?: string, document?: string, options?: {signal: AbortSignal}) {
    this.calls.push({ page, method, input, control, document });
    if (method === 'create') this.native.set(page, { document: randomUUID(), width: 1280, height: 720, deviceProfile: 'desktop', navigation: { url: 'about:blank' } });
    if (method === 'navigate') this.native.get(page).navigation.url = input.url;
    if (method === 'close') { this.native.delete(page); return; }
    if (method === 'create' || method === 'snapshot') return this.native.get(page);
    if (method !== 'automation') return;
    if (this.onAutomation) return this.onAutomation(input.method, options!.signal);
    if (input.method === 'capture') return 'data:image/png;base64,iVBORw0KGgo=';
    if (input.method === 'readContext') return { content: '<untrusted>', selection: null, title: 'Fixture', revision: 1, url: 'https://example.test' };
    if (input.method === 'inspect') return { elements: [], revision: 1 };
  }
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-capability-'));
  const service = new NativeFixture({ root: directory, dataDirectory: directory, ownerConnector: null });
  const capabilities = new SessionCapabilities(); let enabled = true, live = true;
  const session = { serverId: 'server', threadId: 'thread', execution: { inputId: 'input', turnId: 'turn', callId: 'call' } };
  const authorize = () => { if (!enabled) throw new Error('revoked'); };
  const provider = new RemoteBrowserCapabilities(capabilities, service, async (session, invocation) => {
    authorize();
    if (session.serverId !== 'server' || !session.execution || invocation && !live) throw new Error('unadmitted execution');
    return { ownerId: 'owner', hostId: 'host', threadId: session.threadId, turnId: 'turn', authorize };
  });
  t.after(async () => { await provider.close(); service.close(); await service.persistence; await rm(directory, { recursive: true, force: true }); });
  const { scope } = await service.metadata('owner', undefined, authorize);
  const values = {
    pages: [{ id: 'page', ownerId: 'scope', hostId: 'host', entries: [], index: -1 }, { id: 'other-page', ownerId: 'other-scope', hostId: 'host', entries: [], index: -1 }],
    tabs: [{ id: 'tab', ownerId: 'scope', pageId: 'page' }, { id: 'other-tab', ownerId: 'other-scope', pageId: 'other-page' }],
    storage: { page: 'browser-tab', 'other-page': 'browser-other' },
    bindings: [{ scopeId: 'scope', hostId: 'host', threadId: 'thread' }, { scopeId: 'other-scope', hostId: 'host', threadId: 'other-thread' }],
  };
  for (const [key, value] of Object.entries(values)) await service.metadata('owner', { scope, key, value: JSON.stringify(value), expectedKeyRevision: 0, mutationId: randomUUID() }, authorize);
  for (const page of service.pages.values()) { page.live = true; page.document = randomUUID(); }
  await capabilities.refresh(session);
  return { capabilities, session, provider, service, revoke() { enabled = false; }, finish() { live = false; } };
}

test('native browser callbacks share domain receipts with MCP and require exact execution identity', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const tool = { namespace: 'opencraft_browser', name: 'browser_use' };
  const args = { action: 'fill', tab_id: 'tab', expected_revision: 1, ref: 'ref', value: 'native draft' };
  const invoke = (session = f.session, value: unknown = args) => f.provider.invokeNative(session, tool, value, signal)!;
  assert.equal(f.provider.invokeNative(f.session, { name: 'unrelated_tool' }, {}, signal), null);
  for (const execution of [undefined, { ...f.session.execution, callId: '' }, { ...f.session.execution, turnId: '' }, { ...f.session.execution, turnId: 'other-turn' }])
    await assert.rejects(invoke({ ...f.session, execution } as typeof f.session), /authority/);
  assert.equal(f.service.calls.filter(call => call.input?.method === 'fill').length, 0);
  assert.equal((await invoke()).success, true);
  assert.equal((await f.capabilities.call(f.session, 'opencraft_browser_browser_use', args, signal)).success, true);
  assert.equal(f.service.calls.filter(call => call.input?.method === 'fill').length, 1);
  assert.equal((await invoke(f.session, { ...args, value: 'different' })).success, false);
  const image = await f.provider.invokeNative({ ...f.session, execution: { ...f.session.execution, callId: 'image' } },
    { name: 'opencraft_browser_browser_use' }, { action: 'screenshot', tab_id: 'tab' }, signal);
  assert.equal(image?.contentItems[0].type, 'inputImage');
  f.revoke(); await assert.rejects(invoke(), /revoked/);
});

test('native mutation identity cannot change operation or target after SQLite restart', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const invoke = (args: unknown, tool = 'opencraft_browser_browser_use') =>
    f.provider.invokeNative(f.session, { name: tool }, args, signal)!;
  const created = await invoke({ url: 'https://example.test/original' }, 'opencraft_app_open_in_opencraft');
  assert.equal(created.success, true);
  const tabId = JSON.parse((created.contentItems[0] as { text: string }).text).tabId;
  // Restart the actual Worker/store, preserving durable state rather than an adapter cache.
  await f.service.store.close();
  const { BrowserStateStore } = await import('../../scripts/remote-browser/state-store.mjs');
  f.service.store = new BrowserStateStore(f.service.dataDirectory);
  await f.service.store.open();
  const before = f.service.calls.length;
  for (const [args, tool] of [
    [{ action: 'close', tab_id: tabId }, 'opencraft_browser_browser_use'],
    [{ url: 'https://example.test/rebound' }, 'opencraft_app_open_in_opencraft'],
  ] as const) {
    const result = await invoke(args, tool);
    assert.equal(result.success, false);
    assert.match(JSON.stringify(result), /OPERATION_CONFLICT/);
  }
  assert.equal(f.service.calls.length, before);
});

test('a close invocation cannot retire another tab and read observations allocate no binding', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const invoke = (callId: string, name: string, args: unknown) => f.provider.invokeNative(
    { ...f.session, execution: { ...f.session.execution, callId } }, { name }, args, signal)!;
  const open = async (callId: string) => {
    const result = await invoke(callId, 'opencraft_app_open_in_opencraft', { url: 'https://example.test/' });
    assert.equal(result.success, true);
    return JSON.parse((result.contentItems[0] as { text: string }).text).tabId;
  };
  const first = await open('create-first'), second = await open('create-second');
  const use = (args: unknown) => invoke('close-call', 'opencraft_browser_browser_use', args);
  assert.equal((await use({ action: 'close', tab_id: first })).success, true);
  assert.equal((await use({ action: 'close', tab_id: first })).success, true);
  const before = f.service.calls.length;
  const rebound = await use({ action: 'close', tab_id: second });
  assert.equal(rebound.success, false); assert.match(JSON.stringify(rebound), /OPERATION_CONFLICT/);
  assert.equal(f.service.calls.length, before);
  const original = f.service.bindInvocation.bind(f.service);
  let bindings = 0;
  f.service.bindInvocation = (...args: Parameters<typeof original>) => { bindings++; return original(...args); };
  for (const action of ['list_tabs', 'inspect', 'screenshot'])
    assert.equal((await invoke('observation', 'opencraft_browser_browser_use', { action, ...(action === 'list_tabs' ? {} : { tab_id: second }) })).success, true);
  assert.equal(bindings, 0);
});

for (const cancellation of ['signal', 'authority'] as const) test(`native browser callback ${cancellation} cancellation settles physical work without replay`, async t => {
  const f = await fixture(t), controller = new AbortController();
  let admitted!: () => void;
  const started = new Promise<void>(resolve => { admitted = resolve; });
  let settled = false;
  f.service.onAutomation = async (_method, signal) => {
    admitted();
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve(); });
    settled = true;
    throw Object.assign(new Error('cancelled'), { code: 'CDP_ABORTED', outcome: 'unknown' });
  };
  const args = { action: 'click', tab_id: 'tab', expected_revision: 1, ref: 'ref' };
  const call = f.provider.invokeNative(f.session, { namespace: 'opencraft_browser', name: 'browser_use' }, args, controller.signal)!;
  await started; if (cancellation === 'signal') controller.abort(); else f.revoke();
  await assert.rejects(call, /authority/); assert.equal(settled, true);
  const replay = f.capabilities.call(f.session, 'opencraft_browser_browser_use', args, new AbortController().signal);
  if (cancellation === 'signal') assert.equal((await replay).success, false);
  else await assert.rejects(replay, /not authorized/);
  assert.equal(f.service.calls.filter(call => call.input?.method === 'click').length, 1);
});

test('shared browser provider lists only conversation-owned tabs and preserves native errors and typed screenshots', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  assert.deepEqual(f.capabilities.tools(f.session).map(tool => tool.name), ['opencraft_browser_get_tab_context', 'opencraft_browser_browser_use', 'opencraft_app_open_in_opencraft']);
  const use = (args: unknown) => f.capabilities.call({ ...f.session, execution: { ...f.session.execution, callId: randomUUID() } }, 'opencraft_browser_browser_use', args, signal);
  const list = await use({ action: 'list_tabs' });
  assert.deepEqual(JSON.parse((list.contentItems[0] as any).text).tabs.map((tab: any) => tab.tabId), ['tab']);
  assert.equal((await use({ action: 'inspect', tab_id: 'other-tab' })).success, false);
  await assert.rejects(use({ action: 'inspect', tab_id: 'tab', hostId: 'foreign' }), /Unknown/);
  for (const action of ['navigate', 'back', 'forward', 'reload', 'stop']) {
    const navigated = await use({ action, tab_id: 'tab', ...(action === 'navigate' ? { url: 'https://example.test' } : {}) });
    assert.deepEqual(JSON.parse((navigated.contentItems[0] as any).text), { action, tabId: 'tab', accepted: true });
    assert(f.service.calls.find(call => call.input?.method === action)?.control);
  }
  assert.equal((await use({ action: 'navigate', tab_id: 'tab', url: 'javascript:alert(1)' })).success, false);
  const image = await use({ action: 'screenshot', tab_id: 'tab' });
  assert.deepEqual(image, { success: true, contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' }] });
  await use({ action: 'fill', tab_id: 'tab', expected_revision: 1, ref: 'ref', value: '   ' });
  assert.equal(f.service.calls.find(call => call.input?.method === 'fill').input.input.value, '   ');
  assert.equal([...f.service.pages.values()].every(page => f.service.viewers(page).size === 0 && page.controller === null), true);
  f.service.onAutomation = async () => { throw Object.assign(new Error('unknown'), { code: 'CDP_TIMEOUT', retryable: false, outcome: 'unknown' }); };
  const failure = await use({ action: 'click', tab_id: 'tab', expected_revision: 1, ref: 'ref' });
  assert.equal(failure.success, false); assert.equal(JSON.parse((failure.contentItems[0] as any).text).outcome, 'unknown');
  f.finish(); await assert.rejects(use({ action: 'inspect', tab_id: 'tab' }), /unadmitted/);
});

test('MCP invokes viewer-free browser provider, preserves images, rejects foreign threads and revokes active work', async t => {
  const f = await fixture(t), gateway = new SessionCapabilityMcp(f.capabilities, randomBytes(32)); await gateway.listen();
  t.after(() => gateway.close());
  const config = gateway.config(f.session) as any, client = new Client({ name: 'browser-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } })); t.after(() => client.close());
  await client.listTools();
  const image = await client.callTool({ name: 'opencraft_browser_browser_use', arguments: { action: 'screenshot', tab_id: 'tab' } });
  assert.deepEqual(image.content, [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
  const foreign = { ...f.session, threadId: 'foreign' }; await f.capabilities.refresh(foreign);
  assert.equal((await f.capabilities.call(foreign, 'opencraft_browser_browser_use', { action: 'inspect', tab_id: 'tab' }, new AbortController().signal)).success, false);
  let admitted!: () => void; const started = new Promise<void>(resolve => { admitted = resolve; });
  f.service.onAutomation = (_method, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CDP_ABORTED', outcome: 'unknown' })), { once: true }); admitted();
  });
  const wait = client.callTool({ name: 'opencraft_browser_browser_use', arguments: { action: 'wait', tab_id: 'tab', text: 'never' } });
  await started; f.revoke(); assert.equal((await wait).isError, true);
  assert.deepEqual(f.capabilities.tools(f.session), []);
});

async function foregroundMcp(t: test.TestContext) {
  const f = await fixture(t), secret = randomBytes(32);
  const gateway = new SessionCapabilityMcp(f.capabilities, secret); await gateway.listen();
  t.after(() => gateway.close());
  const connect = async (session = f.session, endpoint = gateway) => {
    const config = endpoint.config(session) as any, client = new Client({ name: 'foreground-fixture', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: {
      headers: { Authorization: 'Bearer ' + nativeToolCapabilityToken(secret, session) },
    } }));
    t.after(() => client.close()); return client;
  };
  const socket = { readyState: 1, send() {}, close() {} };
  const attach = () => f.service.metadataPeers.set(socket as any, { ownerId: 'owner', authorize() {} } as any);
  const waitFor = async (predicate: () => any) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const found = predicate(); if (found) return found; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('foreground MCP condition did not settle');
  };
  const receipt = () => f.service.store.account('owner').states[0]?.[1].presentationRequests?.[0];
  return { ...f, gateway, secret, connect, attach, waitFor, receipt };
}

test('foreground MCP rejects missing workbenches and foreign conversations without native effects', async t => {
  const f = await foregroundMcp(t), client = await f.connect();
  const missing = await client.callTool({ name: 'opencraft_app_open_in_opencraft', arguments: { url: 'https://example.test/offline', visible: true } });
  assert.equal(missing.isError, true); assert.equal(f.service.calls.length, 0);
  f.attach();
  const foreign = await client.callTool({ name: 'opencraft_app_open_in_opencraft', arguments: { tab_id: 'other-tab', visible: true } });
  assert.equal(foreign.isError, true); assert.equal(f.receipt(), undefined); assert.equal(f.service.calls.length, 0);
});

test('foreground MCP preserves human control and gateway restart reuses the receipt without refocusing', async t => {
  const f = await foregroundMcp(t); f.attach(); const client = await f.connect();
  const page = [...f.service.pages.values()].find(page => page.link?.tabId === 'tab')!;
  const human = Object.freeze({ kind: 'human' }); page.controller = human; page.controlToken = 'human-control-token'; page.controlKind = 'human';
  const args = { name: 'opencraft_app_open_in_opencraft', arguments: { tab_id: 'tab', visible: true } };
  const pending = client.callTool(args); const request = await f.waitFor(f.receipt);
  const clientId = 'client-' + randomUUID();
  for (const action of ['claim', 'visible']) await acknowledgePresentation(f.service, 'owner', { id: request.id, clientId, action }, () => {});
  assert.equal((await pending).isError, false);
  assert.equal(page.controller, human); assert.equal(page.controlToken, 'human-control-token'); assert.equal(f.service.calls.length, 0);
  f.service.metadataPeers.clear();
  await f.service.commit(draft => { draft.states[0][1].presentationRequests = []; }, { ownerId: 'owner' });
  await client.close(); await f.gateway.close();
  const replacement = new SessionCapabilityMcp(f.capabilities, f.secret); await replacement.listen(); t.after(() => replacement.close());
  const reconnected = await f.connect(f.session, replacement);
  const replay = await reconnected.callTool(args);
  assert.equal(replay.isError, false, JSON.stringify(replay));
  assert.equal(JSON.parse((replay.content as any[])[0].text).presentationId, request.id);
  assert.equal(f.receipt(), undefined); assert.equal(page.controller, human); assert.equal(f.service.calls.length, 0);
});

test('foreground MCP revocation retires a claimed delivery before a late visibility acknowledgement', async t => {
  const f = await foregroundMcp(t); f.attach(); const client = await f.connect();
  const pending = client.callTool({ name: 'opencraft_app_open_in_opencraft', arguments: { tab_id: 'tab', visible: true } });
  const request = await f.waitFor(f.receipt), clientId = 'client-' + randomUUID();
  await acknowledgePresentation(f.service, 'owner', { id: request.id, clientId, action: 'claim' }, () => {});
  f.revoke(); assert.equal((await pending).isError, true);
  await f.waitFor(() => f.receipt()?.status === 'cancelled');
  const late = await acknowledgePresentation(f.service, 'owner', { id: request.id, clientId, action: 'visible' }, () => {});
  assert.equal(late.status, 'cancelled'); assert.equal(f.service.calls.length, 0);
});

test('foreground MCP cancellation retires pending delivery before a late workbench claim', async t => {
  const f = await foregroundMcp(t); f.attach(); const client = await f.connect(), controller = new AbortController();
  const pending = client.callTool({ name: 'opencraft_app_open_in_opencraft', arguments: { tab_id: 'tab', visible: true } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  const request = await f.waitFor(f.receipt); controller.abort(); await rejected;
  await f.waitFor(() => f.receipt()?.status === 'cancelled');
  const late = await acknowledgePresentation(f.service, 'owner', { id: request.id, clientId: 'client-' + randomUUID(), action: 'claim' }, () => {});
  assert.equal(late.status, 'cancelled'); assert.equal(f.service.calls.length, 0);
});

test('native execution completion cancels an active browser call without replay', async t => {
  const f = await fixture(t); let admitted!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { admitted = resolve; });
  f.service.onAutomation = (_method, signal) => new Promise((_resolve, reject) => {
    calls++; signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CDP_ABORTED', outcome: 'unknown' })), { once: true }); admitted();
  });
  const pending = f.capabilities.call(f.session, 'opencraft_browser_browser_use', { action: 'fill', tab_id: 'tab', ref: 'ref', expected_revision: 1, value: 'pending' }, new AbortController().signal);
  const rejected = assert.rejects(pending, { code: 'TAB_ACCESS_DENIED', outcome: 'unknown' });
  await started; f.finish(); await rejected;
  assert.equal(calls, 1); assert.equal([...f.service.pages.values()][0].controller, null);
});

test('missing native runtime publishes no browser declarations and cannot invoke stale ones', async t => {
  const f = await fixture(t); f.service.installed = false;
  await assert.rejects(f.capabilities.call(f.session, 'opencraft_browser_browser_use', { action: 'list_tabs' }, new AbortController().signal), { code: 'CAPABILITY_UNAVAILABLE', outcome: 'not-dispatched' });
  await f.capabilities.refresh(f.session); assert.deepEqual(f.capabilities.tools(f.session), []);
});

test('background creation atomically publishes identity and reuses the same admitted call without replay', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const open = (args: unknown, session = f.session) => f.capabilities.call(session, 'opencraft_app_open_in_opencraft', args, signal);
  const initial = await f.service.metadata('owner', undefined, () => {});
  assert.equal((await open({ url: 'https://example.test/new', visible: true }, { ...f.session, execution: { ...f.session.execution, callId: 'unavailable-presentation' } })).success, false);
  assert.equal(f.service.calls.length, 0);
  const created = await open({ url: 'https://example.test/new' }); assert.equal(created.success, true, JSON.stringify(created));
  const tab = JSON.parse((created.contentItems[0] as any).text); assert.equal(tab.visible, false); assert.equal(tab.runtime, 'live');
  const state = await f.service.metadata('owner', undefined, () => {});
  assert.equal(state.revision, initial.revision + 1);
  for (const field of ['pages', 'tabs', 'storage']) assert.equal(state.keyRevisions[field], initial.keyRevisions[field] + 1);
  const page = JSON.parse(state.values.pages).find((row: any) => row.id === tab.pageId);
  assert.equal(page.ownerId, 'scope'); assert.equal(page.hostId, 'host');
  assert.equal(JSON.parse(state.values.tabs).find((row: any) => row.id === tab.tabId).pageId, page.id);
  const duplicate = await open({ url: 'https://example.test/new' });
  assert.equal(JSON.parse((duplicate.contentItems[0] as any).text).tabId, tab.tabId);
  assert.equal(f.service.calls.filter(call => call.method === 'create').length, 1);
  assert.equal((await f.service.metadata('owner', undefined, () => {})).revision, state.revision);
  assert.equal((await open({ url: 'https://example.test/different' })).success, false);
  assert.equal((await open({ tab_id: tab.tabId, visible: false }, { ...f.session, execution: { ...f.session.execution, callId: 'activate-existing' } })).success, true);
  assert.equal((await open({ tab_id: 'other-tab' })).success, false);
  const native = [...f.service.pages.values()].find(page => page.link?.tabId === tab.tabId)!;
  assert.equal(f.service.viewers(native).size, 0); assert.equal(f.service.sockets.size, 0);
  await f.service.retire(native);
  assert.equal((await open({ url: 'https://example.test/new' })).success, false, 'closed creation cannot be resurrected');
});

test('foreground creation retry reads its durable acknowledgement after the workbench disconnects', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const socket = { readyState: 1, send() {}, close() {} };
  f.service.metadataPeers.set(socket as any, { ownerId: 'owner', authorize() {} } as any);
  const open = () => f.capabilities.call(f.session, 'opencraft_app_open_in_opencraft',
    { url: 'https://example.test/visible-receipt', visible: true }, signal);
  const first = open();
  let request: any;
  const deadline = Date.now() + 5000;
  while (!request && Date.now() < deadline) {
    request = f.service.store.account('owner').states[0]?.[1].presentationRequests?.[0];
    if (!request) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(request, 'foreground request must commit');
  const clientId = 'client-' + randomUUID();
  for (const action of ['claim', 'visible']) await acknowledgePresentation(f.service, 'owner', { id: request.id, clientId, action }, () => {});
  assert.equal((await first).success, true);
  f.service.metadataPeers.clear();
  await f.service.commit(draft => { draft.states[0][1].presentationRequests = []; }, { ownerId: 'owner' });
  const replay = await open();
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(JSON.parse((replay.contentItems[0] as any).text).presentationId, request.id);
  assert.equal(f.service.calls.filter(call => call.method === 'create').length, 1);
  const fresh = await f.capabilities.call({ ...f.session, execution: { ...f.session.execution, callId: 'new-offline' } },
    'opencraft_app_open_in_opencraft', { url: 'https://example.test/offline', visible: true }, signal);
  assert.equal(fresh.success, false);
  assert.equal(JSON.parse((fresh.contentItems[0] as any).text).outcome, 'not-dispatched');
  assert.equal(f.service.calls.filter(call => call.method === 'create').length, 1);
});

test('foreground creation checks workbench availability at the logical commit boundary', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const socket = { readyState: 1, send() {}, close() {} };
  f.service.metadataPeers.set(socket as any, { ownerId: 'owner', authorize() {} } as any);
  assert.equal(f.service.presentationAvailable('owner'), true);
  const previous = await f.service.metadata('owner', undefined, () => {});
  f.service.start = async () => { socket.readyState = 3; await f.service.load(); };
  const result = await f.capabilities.call(f.session, 'opencraft_app_open_in_opencraft',
    { url: 'https://example.test/disconnected-before-commit', visible: true }, signal);
  assert.equal(result.success, false);
  assert.equal(JSON.parse((result.contentItems[0] as any).text).outcome, 'not-dispatched');
  assert.equal((await f.service.metadata('owner', undefined, () => {})).revision, previous.revision);
  assert.equal(f.service.calls.length, 0);
  socket.readyState = 1;
  f.service.metadataPeers.set(socket as any, { ownerId: 'owner', authorize() { throw Error('revoked'); } } as any);
  assert.equal(f.service.presentationAvailable('owner'), false);
});

test('foreground failure after creation preserves the committed tab and reports an unknown open outcome', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  f.service.presentationAvailable = () => true;
  f.service.presentTab = async () => { throw Object.assign(Error('client disconnected'), {
    code: 'PRESENTATION_UNAVAILABLE', outcome: 'not-dispatched',
  }); };
  const open = () => f.capabilities.call(f.session, 'opencraft_app_open_in_opencraft',
    { url: 'https://example.test/foreground-failure', visible: true }, signal);
  const first = await open();
  assert.equal(first.success, false);
  const failure = JSON.parse((first.contentItems[0] as any).text);
  assert.equal(failure.outcome, 'unknown');
  assert.equal(failure.retryable, false);
  const committed = (await f.service.conversationTabs('owner', 'host', 'thread', () => {}))
    .find(tab => tab.url === 'https://example.test/foreground-failure')!;
  assert(committed);
  assert(failure.message.includes(committed.tabId));
  await open();
  assert.equal(f.service.calls.filter(call => call.method === 'create').length, 1);
});

test('foreground existing-tab navigation replays archived success offline without another native effect', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const socket = { readyState: 1, send() {}, close() {} };
  f.service.metadataPeers.set(socket as any, { ownerId: 'owner', authorize() {} } as any);
  const args = { tab_id: 'tab', url: 'https://example.test/existing-visible', visible: true };
  const open = (session = f.session) => f.capabilities.call(session, 'opencraft_app_open_in_opencraft', args, signal);
  const first = open();
  let request: any;
  const deadline = Date.now() + 5000;
  while (!request && Date.now() < deadline) {
    request = f.service.store.account('owner').states[0]?.[1].presentationRequests?.[0];
    if (!request) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(request, 'existing-tab foreground request must commit');
  const clientId = 'client-' + randomUUID();
  for (const action of ['claim', 'visible']) await acknowledgePresentation(f.service, 'owner', { id: request.id, clientId, action }, () => {});
  assert.equal((await first).success, true);
  f.service.metadataPeers.clear();
  await f.service.commit(draft => { draft.states[0][1].presentationRequests = []; }, { ownerId: 'owner' });
  const replay = await open();
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(JSON.parse((replay.contentItems[0] as any).text).presentationId, request.id);
  const navigations = () => f.service.calls.filter(call => call.method === 'automation' && call.input.method === 'navigate').length;
  assert.equal(navigations(), 1);
  const fresh = await open({ ...f.session, execution: { ...f.session.execution, callId: 'fresh-offline-navigation' } });
  assert.equal(fresh.success, false);
  assert.equal(JSON.parse((fresh.contentItems[0] as any).text).outcome, 'not-dispatched');
  assert.equal(navigations(), 1, 'fresh offline navigation must not dispatch');
  f.revoke();
  await assert.rejects(open(), /not authorized/, 'stored success cannot restore revoked authority');
});

test('foreground navigation rechecks connected presentation before native dispatch', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const socket = { readyState: 1, send() {}, close() {} };
  f.service.metadataPeers.set(socket as any, { ownerId: 'owner', authorize() {} } as any);
  const changeControl = f.service.changeControl.bind(f.service);
  f.service.changeControl = async (...args: Parameters<typeof changeControl>) => {
    const result = await changeControl(...args);
    if (args[2].action === 'agent') f.service.metadataPeers.clear();
    return result;
  };
  const result = await f.capabilities.call(f.session, 'opencraft_app_open_in_opencraft',
    { tab_id: 'tab', url: 'https://example.test/disconnected-before-native', visible: true }, signal);
  assert.equal(result.success, false);
  assert.equal(JSON.parse((result.contentItems[0] as any).text).outcome, 'not-dispatched');
  assert.equal(f.service.calls.filter(call => call.method === 'automation' && call.input.method === 'navigate').length, 0);
});

test('disconnect after native navigation leaves an unknown presentation outcome without replay', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const socket = { readyState: 1, send() {}, close() {} };
  f.service.metadataPeers.set(socket as any, { ownerId: 'owner', authorize() {} } as any);
  f.service.onAutomation = async method => { if (method === 'navigate') f.service.metadataPeers.clear(); };
  const open = () => f.capabilities.call(f.session, 'opencraft_app_open_in_opencraft',
    { tab_id: 'tab', url: 'https://example.test/disconnected-after-native', visible: true }, signal);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await open();
    assert.equal(result.success, false);
    const error = JSON.parse((result.contentItems[0] as any).text);
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.retryable, false);
  }
  assert.equal(f.service.calls.filter(call => call.method === 'automation' && call.input.method === 'navigate').length, 1);
});

test('foreground failure after existing-tab navigation cannot report the whole open as not dispatched', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  f.service.presentationAvailable = () => true;
  f.service.presentTab = async () => { throw Object.assign(Error('client disconnected'), {
    code: 'PRESENTATION_UNAVAILABLE', outcome: 'not-dispatched',
  }); };
  const result = await f.capabilities.call(f.session, 'opencraft_app_open_in_opencraft',
    { tab_id: 'tab', url: 'https://example.test/navigated', visible: true }, signal);
  assert.equal(result.success, false);
  const failure = JSON.parse((result.contentItems[0] as any).text);
  assert.equal(failure.outcome, 'unknown');
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /tab accepted navigation/);
  assert.equal(f.service.calls.filter(call => call.method === 'automation' && call.input.method === 'navigate').length, 1);
});

test('cold conversation creation gets a canonical binding and separate calls get separate tabs', async t => {
  const f = await fixture(t), session = { ...f.session, threadId: 'new-thread' }; await f.capabilities.refresh(session);
  const open = (callId: string) => f.capabilities.call({ ...session, execution: { ...session.execution, callId } }, 'opencraft_app_open_in_opencraft', { url: 'https://example.test/cold' }, new AbortController().signal);
  const [one, two] = await Promise.all([open('one'), open('two')]); assert(one.success && two.success);
  const tabs = await f.service.conversationTabs('owner', 'host', 'new-thread', () => {});
  assert.equal(tabs.length, 2); assert.notEqual(tabs[0].tabId, tabs[1].tabId);
  assert.equal(tabs[0].scopeId, 'conversation:' + JSON.stringify(['host', 'new-thread']));
  const state = await f.service.metadata('owner', undefined, () => {});
  assert(JSON.parse(state.values.bindings).some((b: any) => b.scopeId === tabs[0].scopeId && b.threadId === 'new-thread'));
});

test('independent MCP clients can open different URLs in one native execution', async t => {
  const f = await fixture(t), gateway = new SessionCapabilityMcp(f.capabilities, randomBytes(32)); await gateway.listen();
  const config = gateway.config(f.session) as any, clients: Client[] = [], tabs: string[] = [];
  try {
    for (const url of ['https://example.test/one', 'https://example.test/two']) {
      const client = new Client({ name: 'independent', version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } }));
      const result = await client.callTool({ name: 'opencraft_app_open_in_opencraft', arguments: { url, visible: false } });
      assert.equal(result.isError, false, JSON.stringify(result)); tabs.push(JSON.parse((result.content as any[])[0].text).tabId);
    }
    assert.notEqual(tabs[0], tabs[1]); assert.equal(f.service.calls.filter(call => call.method === 'create').length, 2);
  } finally { await Promise.all(clients.map(client => client.close())); await gateway.close(); }
});

test('provider closes its conversation tab through the resource service and preserves idempotent ownership', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const opened = await f.capabilities.call(f.session, 'opencraft_app_open_in_opencraft', { url: 'https://example.test/close' }, signal);
  const tabId = JSON.parse((opened.contentItems[0] as any).text).tabId;
  const close = (id: string) => f.capabilities.call({ ...f.session, execution: { ...f.session.execution, callId: 'close-' + id } }, 'opencraft_browser_browser_use', { action: 'close', tab_id: id }, signal);
  assert.equal((await close('other-tab')).success, false);
  const closed = await close(tabId); assert.equal(closed.success, true, JSON.stringify(closed));
  assert.deepEqual(JSON.parse((closed.contentItems[0] as any).text), { tabId, closed: true });
  const count = f.service.calls.length;
  assert.equal((await close(tabId)).success, true); assert.equal(f.service.calls.length, count);
  assert.equal((await f.service.conversationTabs('owner', 'host', 'thread', () => {})).some(tab => tab.tabId === tabId), false);
  f.finish(); await assert.rejects(close(tabId), /unadmitted/);
});
