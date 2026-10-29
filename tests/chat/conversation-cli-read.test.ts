import assert from 'node:assert/strict';
import test from 'node:test';
import { readConversationPage, projectConversationMetadata } from '../../scripts/conversation-projections.mjs';
import { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { encodeJsonRpcMessage, isJsonRpcRequest } from '@opencraft/appserver-protocol';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRoutedConversationExecution } from '../../scripts/conversation-execution.mjs';

test('metadata is an allowlisted server projection without title fallback or message content', () => {
  const result = projectConversationMetadata('server', { id: 'thread', name: 'sensitive-title', preview: 'sensitive-preview',
    turns: [{ items: [{ text: 'sensitive-message' }] }], status: { type: 'idle' }, cwd: '/repo', projectId: null });
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
  assert.equal(result.cwd, '/repo'); assert.equal(result.runtime, 'idle');
  assert.equal(projectConversationMetadata('server', { id: 't', preview: 'body' }, true).title, undefined);
});

test('history pages bound native reads, preserve Unicode long-message tails and fence watermarks', async () => {
  const ref = { serverId: 's', threadId: 't' }, content = '🦉'.repeat(4501);
  let revision = 1;
  const calls: any[] = [];
  const invoke = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: { id: 't', updatedAt: revision } }; }
    assert.equal(method, 'thread/items/list'); assert.equal(params.limit, 1);
    return { data: [{ turnId: 'turn', item: { type: 'agentMessage', id: 'item', text: content } }], nextCursor: null };
  };
  let cursor: string | null = null, text = '';
  do {
    const page = await readConversationPage(invoke, ref, cursor);
    assert.ok(Array.from(page.entries[0].text).length <= 2000);
    text += page.entries[0].text; cursor = page.nextCursor;
  } while (cursor);
  assert.equal(text, content);
  const page = await readConversationPage(invoke, ref, null);
  revision++;
  await assert.rejects(readConversationPage(invoke, ref, page.nextCursor), { code: 'history_changed' });
  assert.ok(calls.length > 0);
});

test('old Host capabilities fail before issuing content reads or mutations', async () => {
  const methods: string[] = [];
  const transport = new MemoryTransport({ server: { receive(frame, peer) {
    const message = JSON.parse(frame);
    if (!isJsonRpcRequest(message)) return;
    methods.push(message.method);
    if (message.method === 'initialize') peer.send(encodeJsonRpcMessage({ id: message.id, result: { codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux', userAgent: 'fixture', capabilities: { extensions: { 'opencraft/collaboration': { version: 1, read: true } } } } }));
  } } });
  const client = new CollaborationClient(transport);
  try {
    await client.connect();
    await assert.rejects(client.metadata({ serverId: 's', threadId: 't' }), { code: 'UNSUPPORTED_CAPABILITY' });
    await assert.rejects(client.read({ serverId: 's', threadId: 't' }), { code: 'UNSUPPORTED_CAPABILITY' });
    assert.throws(() => client.discover('s', undefined, false, { projectId: 'p' }), { code: 'UNSUPPORTED_CAPABILITY' });
    assert.deepEqual(methods, ['initialize']);
  } finally { await client.close(); }
});

test('unsupported engines reject bounded logs before any native history read', () => {
  let opened = 0;
  const execution = createRoutedConversationExecution(() => ({hostState: () => 'idle', accept() { opened++; throw Error('must not open'); }}),
    {machineId:'fixture',engines:['dsh'],getInputs:async()=>undefined});
  const server = execution.directory().servers.find((row: any) => row.engine === 'dsh');
  assert.equal(server.capabilities.read, false); assert.equal(server.capabilities.boundedRead, false);
  assert.throws(() => execution.readBounded({serverId:server.serverId,threadId:'legacy-dsh'},null), {code:'unsupported_capability'});
  assert.equal(opened,0);
});

test('CLI help and invalid arguments return one versioned JSON value with stable exit codes', async () => {
  const invoke = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('../../apps/opencraft-cli/src/main.ts', import.meta.url)), ...args, '--json']);
  const help = JSON.parse((await invoke('--help')).stdout);
  assert.equal(help.schemaVersion, 1); assert.equal(help.ok, true);
  for (const args of [['unknown'], ['thread','show'], ['thread','show','ref','--cursor','bad']]) {
    await assert.rejects(invoke(...args), (error: any) => {
      assert.equal(error.code, 2); const output = JSON.parse(error.stdout);
      assert.equal(output.ok, false); assert.equal(output.error.code, 'INVALID_ARGUMENTS');
      return true;
    });
  }
});
