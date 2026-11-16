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

test('shared browser provider lists only conversation-owned tabs and preserves native errors and typed screenshots', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  assert.deepEqual(f.capabilities.tools(f.session).map(tool => tool.name), ['opencraft_browser_get_tab_context', 'opencraft_browser_browser_use', 'opencraft_app_open_in_opencraft']);
  const use = (args: unknown) => f.capabilities.call(f.session, 'opencraft_browser_browser_use', args, signal);
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
  assert.equal((await open({ url: 'https://example.test/new', visible: true })).success, false);
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
  assert.equal((await open({ tab_id: tab.tabId, visible: false })).success, true);
  assert.equal((await open({ tab_id: 'other-tab' })).success, false);
  const native = [...f.service.pages.values()].find(page => page.link?.tabId === tab.tabId)!;
  assert.equal(f.service.viewers(native).size, 0); assert.equal(f.service.sockets.size, 0);
  await f.service.retire(native);
  assert.equal((await open({ url: 'https://example.test/new' })).success, false, 'closed creation cannot be resurrected');
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
  const close = (id: string) => f.capabilities.call(f.session, 'opencraft_browser_browser_use', { action: 'close', tab_id: id }, signal);
  assert.equal((await close('other-tab')).success, false);
  const closed = await close(tabId); assert.equal(closed.success, true, JSON.stringify(closed));
  assert.deepEqual(JSON.parse((closed.contentItems[0] as any).text), { tabId, closed: true });
  const count = f.service.calls.length;
  assert.equal((await close(tabId)).success, true); assert.equal(f.service.calls.length, count);
  assert.equal((await f.service.conversationTabs('owner', 'host', 'thread', () => {})).some(tab => tab.tabId === tabId), false);
  f.finish(); await assert.rejects(close(tabId), /unadmitted/);
});
