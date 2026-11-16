import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { startHeadlessServer } from '../../scripts/headless-server.mjs';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';
import { LOGICAL_CLIENT_FIELD } from '../../packages/app-host-protocol/src/index.js';
import type { SessionCapabilityPort } from '../../packages/session-capabilities/src/index.js';

test('headless assembly binds browser capabilities to admitted execution and configured anonymous owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'headless-browser-capabilities-')), webRoot = join(root, 'web');
  await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<html>fixture</html>');
  await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'browser-capability', headlessServer: true, headlessHostId: 'opencraft-server' }));
  const native = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(native, 'listening');
  let app: any, options: any, capabilities: SessionCapabilityPort | undefined, state = 'inProgress', inspections = 0;
  t.after(async () => { await app?.close(); for (const socket of native.clients) socket.terminate(); await new Promise<void>(resolve => native.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  native.on('connection', socket => socket.on('message', bytes => {
    const message = JSON.parse(String(bytes)); if (message.id === undefined) return;
    let result: unknown = {};
    if (message.method === 'initialize') result = { capabilities: {} };
    if (message.method === 'thread/turns/list') { inspections++; result = { data: [{ id: 'turn', status: state, items: [] }], nextCursor: null }; }
    if (message.method === 'thread/read') result = { thread: { id: message.params.threadId, status: { type: 'active', activeFlags: [] }, turns: [] } };
    socket.send(JSON.stringify({ id: message.id, result, ...(message[LOGICAL_CLIENT_FIELD] ? { [LOGICAL_CLIENT_FIELD]: message[LOGICAL_CLIENT_FIELD] } : {}) }));
  }));
  app = await startHeadlessServer({ root, webRoot, dataDirectory: join(root, 'data'), port: 0,
    startAgentHost: async (input: any) => { capabilities = input.sessionCapabilities; return { websocketUrl: `ws://127.0.0.1:${(native.address() as any).port}/rpc`, async close() {} }; },
    createWebServer: async (input: any) => { options = input; return createWorkbenchWebServer(input); } });
  assert(capabilities);
  const actors = options.actorService.store, service = options.actorCollaborationService.service;
  const context = actors.resolveHuman({ provider: 'opencraft-deployment', subject: 'anonymous-operator', displayName: 'Operator', expiresAt: Date.now() + 60000 });
  const threadId = 'codex_fixture';
  service.authorizeExecution(context, threadId, 'input'); service.executionStarted(threadId, 'input', 'turn');
  const browser = options.remoteBrowserService, { scope } = await browser.metadata('local-anonymous', undefined, () => {});
  // The native execution transport is a fixture; no browser process is needed
  // for this assembly test's metadata-only invocation.
  browser.available = async () => true;
  const values = { pages: [{ id: 'page', ownerId: 'scope', hostId: 'opencraft-server', entries: [], index: -1 }],
    tabs: [{ id: 'tab', pageId: 'page', ownerId: 'scope' }], storage: { page: 'browser-tab' },
    bindings: [{ scopeId: 'scope', hostId: 'opencraft-server', threadId }] };
  for (const [key, value] of Object.entries(values)) await browser.metadata('local-anonymous', { scope, key, value: JSON.stringify(value), expectedKeyRevision: 0, mutationId: randomUUID() }, () => {});
  await capabilities.refresh!(threadId, { inputId: 'input', turnId: 'turn' });
  assert(capabilities.tools(threadId).some(tool => tool.name === 'opencraft_browser_browser_use'));
  const result = await capabilities.call(threadId, 'opencraft_browser_browser_use', { action: 'list_tabs' }, new AbortController().signal, { inputId: 'input', turnId: 'turn', callId: 'browser-call' });
  assert.equal(result.success, true); assert.deepEqual(JSON.parse((result.contentItems[0] as any).text).tabs.map((tab: any) => tab.tabId), ['tab']);
  assert(inspections >= 1, 'invocation must inspect the active native execution');
  state = 'completed';
  await assert.rejects(capabilities.call(threadId, 'opencraft_browser_browser_use', { action: 'list_tabs' }, new AbortController().signal, { inputId: 'input', turnId: 'turn' }), /active/);
  actors.setEnabled(context.actorId, false, 'fixture');
  assert.equal(capabilities.tools(threadId).some(tool => tool.name === 'opencraft_browser_browser_use'), false);
});
