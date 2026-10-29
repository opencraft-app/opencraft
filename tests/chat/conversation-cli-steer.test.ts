import assert from 'node:assert/strict';
import test from 'node:test';
import { run, sendWithAttention } from '../../apps/opencraft-cli/src/main';
import type { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { createConversationExecution, createRoutedConversationExecution } from '../../scripts/conversation-execution.mjs';
import { projectConversationMetadata } from '../../scripts/conversation-projections.mjs';

test('steer requires an exact expected Turn and never silently selects queue', async () => {
  await assert.rejects(run(['thread','send','ref','input','--key','k','--mode','steer']), /Steer needs exact --expected-turn/);
  await assert.rejects(run(['thread','send','ref','input','--key','k','--expected-turn','turn']), /--expected-turn needs --mode steer/);
  await assert.rejects(run(['thread','list','--cwd','relative/path']), /--cwd must be absolute on the Server/);
});
test('attention and recovery report only explicit metadata; idle and unavailable states do not imply completion', () => {
  const thread = { id: 'synthetic', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, preview: 'private text' };
  const row = projectConversationMetadata('server', thread);
  assert.equal(row.runtime, 'awaiting_interaction'); assert.deepEqual(row.attention, { kind: 'approval', interactionId: null });
  assert.equal(JSON.stringify(row).includes('private text'), false);
  assert.equal(projectConversationMetadata('server', { ...thread, status: { type: 'idle', activeFlags: ['waitingOnApproval'] } }).attention, null);
  const recovering = projectConversationMetadata('server', { id: 't', status: { type: 'idle' } }, false,
    { threadId: 't', rootTurnId: 'root', turnId: 'turn', state: 'scheduled', attempts: 1, limit: 3, sourceKind: 'system' });
  assert.equal(recovering.runtime, 'recovering');
  assert.equal(projectConversationMetadata('server', { id: 't' }).runtime, 'unknown');
});
test('project and cwd filter the bounded native metadata catalog in the Server path', async () => {
  const operations: any[] = [];
  const host = { accept(endpoint: any) {
    const unsubscribe = endpoint.subscribe((message: any) => {
      if (message.type === 'hello') endpoint.postMessage({ type: 'ready' });
      if (message.type === 'host/connect') endpoint.postMessage({ type: 'response', requestId: 'connect', ok: true, result: { generation: 1 } });
      if (message.type === 'host/send') {
        const rpc = JSON.parse(message.frame);
        if (rpc.method !== 'initialize') operations.push(rpc);
        const result = rpc.method === 'initialize' ? {} : { data: [{ id: 't', projectId: 'project', cwd: '/remote/repo', preview: 'private', turns: [] }], nextCursor: 'next' };
        endpoint.postMessage({ type: 'host/frame', hostId: message.hostId, generation: 1, frame: JSON.stringify({ id: rpc.id, result }) });
      }
    });
    return { close: unsubscribe };
  } };
  const port = createConversationExecution(() => host, { serverId: 'server', hostId: 'host' });
  const result = await port.discoverMetadata({ serverId: 'server', projectId: 'project', cwd: '/remote/repo/nested/..' });
  assert.equal(operations.length, 1); assert.equal(operations[0].method, 'thread/list');
  assert.equal(operations[0].params.limit, 30); assert.equal(operations[0].params.useStateDbOnly, true);
  assert.equal(operations[0].params.projectId, 'project'); assert.equal(operations[0].params.cwd, '/remote/repo');
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(result.nextCursor, 'next');
  const routed = createRoutedConversationExecution(() => { throw Error('must not open unsupported engine'); }, { machineId: 'test', engines: ['dsh'], getInputs: async () => null });
  await assert.rejects(routed.discoverMetadata({ serverId: 'server:test:dsh', cwd: '/remote' }), { code: 'unsupported_capability' });
});
test('steer skips auxiliary metadata; queue still sends when attention is unavailable', async () => {
  const ref = { serverId: 'server', threadId: 't' };
  let reads = 0, sends = 0;
  const client = { require() {}, async metadata() { reads++; throw Error('auxiliary read unavailable'); },
    async send() { sends++; return { messageId: 'm', requestId: 'r', replayed: false }; } } as unknown as CollaborationClient;
  const input = { content: 'synthetic', operationKey: 'key', generated: false, timeoutMs: null };
  const scope = { instanceId: 'instance', actorId: 'actor', recordsDirectory: '/unused-for-explicit-key' };
  const profile = { sshAlias: 'synthetic', instanceId: 'instance' };
  const steer = await sendWithAttention(client, ref, { ...input, execution: { mode: 'steer', expectedTurnId: 'turn' } }, scope, profile);
  assert.equal(steer.mode, 'steer'); assert.equal(reads, 0); assert.equal(sends, 1);
  const queue = await sendWithAttention(client, ref, { ...input, execution: { mode: 'queue' } }, scope, profile);
  assert.equal(queue.deliveryState, 'accepted'); assert.equal((queue as any).attention.kind, 'unknown');
  assert.equal(reads, 1); assert.equal(sends, 2);
});
test('queue admission precedes a slow metadata operation on a serial Host channel', { timeout: 2000 }, async () => {
  const ref = { serverId: 'server', threadId: 't' }, trace: string[] = [];
  let channel = Promise.resolve<unknown>(undefined);
  const enqueue = <T>(operation: () => Promise<T>) => {
    const result = channel.then(operation); channel = result.catch(() => {}); return result;
  };
  const client = { require() {},
    metadata() {
      void enqueue(async () => { trace.push('metadata'); return new Promise(() => {}); });
      return new Promise((_resolve, reject) => setTimeout(() => reject(Error('local read deadline')), 10));
    },
    send() { return enqueue(async () => { trace.push('accepted'); return { messageId: 'm', requestId: 'r', replayed: false }; }); },
  } as unknown as CollaborationClient;
  const receipt = await sendWithAttention(client, ref, { content: 'synthetic', operationKey: 'key', generated: false, timeoutMs: null },
    { instanceId: 'i', actorId: 'a', recordsDirectory: '/unused' }, { sshAlias: 'synthetic', instanceId: 'i' });
  assert.deepEqual(trace, ['accepted', 'metadata']); assert.equal(receipt.deliveryState, 'accepted');
  assert.equal((receipt as any).attention.kind, 'unknown');
});
test('native metadata and attention remain readable when recovery is unsupported or times out', async t => {
  const keepAlive = setTimeout(() => {}, 2000); t.after(() => clearTimeout(keepAlive));
  for (const missing of ['unsupported', 'timeout']) {
    const host = { accept(endpoint: any) {
      const unsubscribe = endpoint.subscribe((message: any) => {
        if (message.type === 'hello') endpoint.postMessage({ type: 'ready' });
        if (message.type === 'host/connect') endpoint.postMessage({ type: 'response', requestId: 'connect', ok: true, result: { generation: 1 } });
        if (message.type !== 'host/send') return;
        const rpc = JSON.parse(message.frame);
        const frame: any = { id: rpc.id, result: rpc.method === 'thread/read'
          ? { thread: { id: 't', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, preview: 'private' } } : {} };
        if (rpc.method === 'opencraft/turn-recovery/read') {
          if (missing === 'timeout') return;
          delete frame.result; frame.error = { code: -32601, message: 'unsupported' };
        }
        endpoint.postMessage({ type: 'host/frame', hostId: message.hostId, generation: 1, frame: JSON.stringify(frame) });
      });
      return { close: unsubscribe };
    } };
    const port = createConversationExecution(() => host, { serverId: 'server', hostId: 'host' });
    const metadata = await port.metadata({ serverId: 'server', threadId: 't' });
    assert.equal(metadata.runtime, 'awaiting_interaction'); assert.equal(metadata.attention.kind, 'approval');
    assert.equal(metadata.recovery, null); assert.equal(JSON.stringify(metadata).includes('private'), false);
  }
});
