import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration, type ConversationExecutionPort } from '../../packages/access-control/src/collaboration';
import { sendMessage } from '../../apps/opencraft-cli/src/send';
import { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { COLLABORATION_CAPABILITIES } from '@opencraft/appserver-protocol/collaboration';
import { run } from '../../apps/opencraft-cli/src/main';

const ref = { serverId: 'synthetic-server', threadId: 'synthetic-thread' };
test('lookup is read-only, actor/target scoped, survives restart and does not expose message content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cli-lookup-'));
  const actors = new ActorStore(join(root, 'actors.sqlite'));
  const human = actors.resolveHuman({ provider: 'local', subject: 'one', displayName: 'One', expiresAt: Date.now() + 60000 })!;
  const other = actors.resolveHuman({ provider: 'local', subject: 'two', displayName: 'Two', expiresAt: Date.now() + 60000 })!;
  let admitted = true, inputs = 0;
  const port: ConversationExecutionPort = { serverId: ref.serverId, hostId: 'synthetic-host',
    async validate() {}, async receipt() { return null; }, async add() { inputs++; return null; }, async steer() {}, async cancel() { return false; } };
  const path = join(root, 'collaboration.sqlite');
  let service = new Collaboration(path, actors, port, Date.now, () => admitted);
  t.after(async () => { await service.close(); actors.close(); await rm(root, { recursive: true, force: true }); });
  const args = { reference: ref, content: 'synthetic-private-content', idempotencyKey: 'one', execution: { mode: 'queue' } };
  assert.equal(service.lookupConversation(human, ref, 'one').found, false);
  const sent = service.sendConversation(human, args);
  assert.equal(service.sendConversation(human, args).requestId, sent.requestId);
  assert.throws(() => service.sendConversation(human, { ...args, content: 'changed' }), /idempotency_key_reused/);
  assert.throws(() => service.sendConversation(human, { ...args, reference: { ...ref, threadId: 'changed' } }), /idempotency_key_reused/);
  await service.close(); service = new Collaboration(path, actors, port, Date.now, () => admitted);
  const lookup = await service.command(human, { action: 'lookup', reference: ref, idempotencyKey: 'one' });
  assert.equal(lookup.found, true);
  assert.equal(lookup.receipt.requestId, sent.requestId);
  assert.equal(lookup.receipt.deliveryState, 'accepted'); assert.equal(lookup.receipt.taskOutcome, 'unknown');
  assert.equal(JSON.stringify(lookup).includes('synthetic-private-content'), false);
  assert.equal(service.lookupConversation(other, ref, 'one').found, false);
  assert.throws(() => service.conversationDelivery(other, ref, sent.requestId!), /missing/);
  assert.throws(() => service.lookupConversation(human, { ...ref, threadId: 'changed' }, 'one'), /missing/);
  assert.equal(inputs, 0, 'read-only lookup/delivery never run the pump');
  let mutations = 0, drop = true;
  const connect = async () => {
    const client = new CollaborationClient(new MemoryTransport({ server: { async receive(frame, peer) {
      const message = JSON.parse(frame); if (message.id === undefined) return;
      if (message.method === 'initialize') {
        peer.send(JSON.stringify({ id: message.id, result: { capabilities: { extensions: { 'opencraft/collaboration': COLLABORATION_CAPABILITIES } } } })); return;
      }
      if (message.params.action === 'send') mutations++;
      const result = await service.command(human, message.params);
      if (drop && message.params.action === 'send') { peer.close('synthetic dropped acknowledgement'); return; }
      peer.send(JSON.stringify({ id: message.id, result }));
    } } }));
    await client.connect(); t.after(() => client.close()); return client;
  };
  const disconnected = await connect();
  await assert.rejects(sendMessage(disconnected, ref,
    { content: 'lost acknowledgement', operationKey: 'lost-key', generated: false, timeoutMs: null },
    { instanceId: 'synthetic', actorId: human.actorId, recordsDirectory: root }), { code: 'OUTCOME_UNKNOWN' });
  drop = false;
  const recovered = await (await connect()).lookup(ref, 'lost-key');
  assert.equal(recovered.found, true); assert.equal(mutations, 1);
  admitted = false;
  assert.throws(() => service.lookupConversation(human, ref, 'one'), /conversation_action_denied/);
});

test('lost send responses never replay a mutation; waiting polls only delivery and retains the key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cli-send-')); t.after(() => rm(root, { recursive: true, force: true }));
  const scope = { instanceId: 'synthetic', actorId: 'human', recordsDirectory: root };
  const input = { content: 'message', operationKey: 'synthetic-key', generated: false, timeoutMs: null };
  let mutations = 0, reads = 0, state = 'queued';
  const fake = { require() {}, async send() { mutations++; throw Error('connection lost after commit'); },
    async delivery() { reads++; return { ref, operationKey: input.operationKey, messageId: 'message', requestId: 'request',
      mode: 'queue', deliveryState: state, targetTurnId: null, observedAt: Date.now(), taskOutcome: 'unknown' }; } };
  const client = fake as unknown as CollaborationClient;
  await assert.rejects(sendMessage(client, ref, input, scope), (error: any) => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN'); assert.equal(error.exitCode, 7);
    assert.equal(error.details.operationKey, input.operationKey); return true;
  });
  assert.equal(mutations, 1); assert.equal(reads, 0);
  fake.send = async () => { mutations++; return { messageId: 'message', requestId: 'request', replayed: false }; };
  await assert.rejects(sendMessage(client, ref, { ...input, timeoutMs: 2 }, scope), (error: any) => {
    assert.equal(error.code, 'DELIVERY_TIMEOUT'); assert.equal(error.details.receipt.deliveryState, 'queued');
    assert.equal(error.details.operationKey, input.operationKey); return true;
  });
  state = 'rejected';
  await assert.rejects(sendMessage(client, ref, { ...input, timeoutMs: 100 }, scope), (error: any) => error.exitCode === 8 && error.details.receipt.deliveryState === 'rejected');
  state = 'submitted';
  const delivered = await sendMessage(client, ref, { ...input, timeoutMs: 100 }, scope);
  assert.equal(delivered.deliveryState, 'submitted'); assert.equal(delivered.taskOutcome, 'unknown');
  assert.equal(mutations, 4); assert.ok(reads >= 3);
  await sendMessage(client, ref, { ...input, generated: true }, scope);
  const record = JSON.parse(await readFile(join(root, input.operationKey + '.json'), 'utf8'));
  assert.equal(record.operationKey, input.operationKey); assert.equal(record.content, undefined);
  const before = mutations;
  await assert.rejects(sendMessage(client, ref, { ...input, generated: true }, scope), { code: 'OPERATION_RECORD_FAILED' });
  assert.equal(mutations, before, 'a generated key must be saved before sending');
});

test('non-interactive sends require a key and validate input before opening a connection', async () => {
  await assert.rejects(run(['thread', 'send', 'ref', 'text']), /Non-interactive send needs --key/);
  await assert.rejects(run(['thread', 'send', 'ref', 'text', '--key', 'k', '--message-file', '-']), /Choose text/);
  await assert.rejects(run(['thread', 'send', 'ref', 'text', '--key', 'k', '--wait', 'completed']), /Use --wait delivered/);
});
