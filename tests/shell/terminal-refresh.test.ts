import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { createAppServerWorkbenchRuntime, ConversationTerminalSessionRegistry } from '@opencraft/workbench-runtime';
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage, supportsTerminalMethod } from '@opencraft/appserver-protocol';

const hands = { 'opencraft/terminal': { version: 1, available: true, recovery: true } };

test('Hands recovery capability is recognized independently of the engine admission manifest', () => {
  for (const method of ['process/list', 'process/attach'] as const) {
    assert.equal(supportsTerminalMethod(hands, method), true);
    for (const marker of [{ version: 2, available: true, recovery: true }, { version: 1, available: false, recovery: true }, { version: 1, available: true, recovery: false }])
      assert.equal(supportsTerminalMethod({ 'opencraft/terminal': marker }, method), false);
    assert.equal(supportsTerminalMethod({ ...hands, 'opencraft/method-access': { version: 1, methods: [] } }, method), false, 'positive support cannot bypass admission');
  }
});

test('a fresh Workbench runtime lists and attaches the original PTY with its scope intact', async () => {
  const context = { resourceOwnerId: 'conversation', threadId: 'thread', projectId: 'project', cwd: '/workspace', shell: '/bin/bash' };
  const calls: { method: string; params: any }[] = [];
  const processes = new Map<string, any>();
  const create = () => createAppServerWorkbenchRuntime({ hostId: 'host', autoReconnect: false,
    transport: new MemoryTransport({ receive(frame, peer) {
      const request = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(request)) return;
      const params = request.params as any ?? {};
      calls.push({ method: request.method, params });
      let result: any = request.method.endsWith('/list') ? { data: [], nextCursor: null } : {};
      if (request.method === 'initialize') result = { userAgent: 'Hands fixture', capabilities: { extensions: hands } };
      if (request.method === 'process/spawn') {
        processes.set(params.processHandle, { processHandle: params.processHandle, phase: 'running', exitCode: null, context,
          output: [{ sequence: 1, stream: 'stdout', deltaBase64: Buffer.from('original shell state').toString('base64') }], nextSequence: 2, truncated: false });
      }
      if (request.method === 'process/list') result = { processes: [...processes.values()].filter(p => p.context.threadId === params.threadId && p.context.projectId === params.projectId) };
      if (request.method === 'process/attach') {
        assert.equal(params.threadId, context.threadId);
        assert.equal(params.projectId, context.projectId);
        result = processes.get(params.processHandle);
      }
      peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    } }),
  });
  let runtime = create();
  let registry = new ConversationTerminalSessionRegistry(() => runtime);
  try {
    await runtime.connect();
    const id = registry.open({ hostId: 'host', ...context });
    await registry.get(id)!.resize(80, 24);
    await registry.dispose(); await runtime.dispose();
    runtime = create(); registry = new ConversationTerminalSessionRegistry(() => runtime);
    await runtime.connect();
    assert.deepEqual(await registry.restore('host', context.resourceOwnerId, { threadId: context.threadId, projectId: context.projectId }), [id]);
    const restored = registry.get(id)!;
    await restored.resize(90, 30);
    assert.equal(restored.getSnapshot().phase, 'running');
    assert.equal(Buffer.from(restored.getSnapshot().output[0]!.deltaBase64, 'base64').toString(), 'original shell state');
    assert.equal(calls.filter(c => c.method === 'process/spawn').length, 1);
    assert.equal(calls.filter(c => c.method === 'process/kill').length, 0);
  } finally { await registry.dispose(); await runtime.dispose(); }
});

for (const [mixed, alias] of [[false, false], [true, false], [true, true]]) test(`promotion preserves draft-owned terminals without adopting other owners or Threads (mixed=${mixed}, alias=${alias})`, async () => {
  const process = (id: string, owner: string, threadId: string | null) => ({ processHandle: id, phase: 'running' as const, exitCode: null,
    context: { resourceOwnerId: owner, threadId, projectId: null, cwd: '/workspace', shell: '/bin/bash' } });
  const draft = process('original-draft', alias ? 'draft-alias' : 'conversation', null);
  const bound = process('bound', 'conversation', 'thread');
  const inventory = [draft, ...(mixed ? [bound] : []), process('other-owner', 'other', null), process('other-thread', 'conversation', 'other-thread')];
  const attached: { id: string; scope: unknown }[] = [];
  const terminal = {
    async list(scope: any = {}) { return { processes: inventory.filter(p => !scope.threadId || p.context.threadId === scope.threadId) }; },
    attach(id: string, scope: unknown) {
      attached.push({ id, scope });
      return { processId: id, subscribe: () => () => {}, dispose: async () => {},
        getSnapshot: () => ({ phase: 'running', output: [], revision: 0, exitCode: null, error: null }) };
    },
  };
  const registry = new ConversationTerminalSessionRegistry(() => ({ resources: { terminal } }) as any);
  try {
    const restored = await registry.restore('host', 'conversation', { threadId: 'thread' }, alias ? ['draft-alias'] : []);
    assert.deepEqual(restored.map(id => JSON.parse(id)[1]).sort(), [draft.processHandle, ...(mixed ? [bound.processHandle] : [])].sort());
    assert.deepEqual(registry.listForOwner('conversation'), restored);
    assert.deepEqual(attached.find(p => p.id === draft.processHandle)?.scope, { threadId: null, projectId: null });
    assert.ok(!attached.some(p => p.id === 'other-owner' || p.id === 'other-thread'));
  } finally { await registry.dispose(); }
});
