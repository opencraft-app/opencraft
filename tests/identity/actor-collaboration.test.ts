import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { MembershipStore, InstanceAccess } from '../../packages/access-control/src/index';
import { ActorStore } from '../../packages/access-control/src/actors';
import { ActorAccess } from '../../packages/access-control/src/actor-access';
import { Collaboration, CollaborationHttpApi, type ConversationExecutionPort, type ExecutionReceipt } from '../../packages/access-control/src/collaboration';
import { parsePrincipal } from '../../packages/identity-core/src/index';
import { createConversationExecution } from '../../scripts/conversation-execution.mjs';

async function fixture(t: any, now = Date.now, hostId = 'fixture-host') {
  const root = await mkdtemp(join(tmpdir(), 'actor-collaboration-'));
  const actors = new ActorStore(join(root, 'actors.sqlite'));
  const principal = parsePrincipal({ provider: 'local', subject: 'person-1', displayName: 'person', expiresAt: Date.now() + 60_000 })!;
  const human = actors.resolveHuman(principal)!;
  const a = actors.createSession('A', human.actorId), b = actors.createSession('B', human.actorId);
  const ca = actors.issueCredential(a.id, Date.now() + 60_000, human.actorId), cb = actors.issueCredential(b.id, Date.now() + 60_000, human.actorId);
  const aContext = actors.authenticateSession(ca.token)!, bContext = actors.authenticateSession(cb.token)!;
  const receipts = new Map<string, ExecutionReceipt>();
  const inputs: string[] = [], calls: string[] = [];
  let failAdd = false, failSteer: boolean | 'ambiguous' = false, validateHold: Promise<void> | undefined, current = true;
  const execution: ConversationExecutionPort = {
    hostId,
    async validate() { await validateHold; },
    async receipt(_binding, id) { return receipts.get(id) ?? null; },
    async add(_binding, id, input) {
      inputs.push(input); calls.push('add');
      const row = { id: 'queue:' + id, state: 'queued', targetTurnId: null }; receipts.set(id, row);
      if (failAdd) throw new Error('connection lost after durable add');
      return row;
    },
    async steer(_binding, id, _queueId, turn) {
      calls.push('steer');
      if (failSteer === 'ambiguous') receipts.set(id, { id: 'queue:' + id, state: 'unknown', targetTurnId: turn });
      if (failSteer) throw Object.assign(new Error('stale turn'), { code: -32600 });
      receipts.set(id, { id: 'queue:' + id, state: 'delivered', targetTurnId: turn });
    },
    async cancel(_binding, id) { calls.push('cancel'); const receipt = receipts.get(id); if (receipt?.state !== 'queued') return false; receipts.set(id, { ...receipt, state: 'discarded' }); return true; },
  };
  let service = new Collaboration(join(root, 'collaboration.sqlite'), actors, execution, now, () => current);
  const grant = (from: string, to: string, action: string, enabled = true) => actors.setGrant(from, to, action, enabled, 'operator');
  grant(human.actorId, b.id, 'message.send'); grant(human.actorId, b.id, 'execution.queue'); grant(human.actorId, b.id, 'execution.steer');
  grant(a.id, b.id, 'message.send'); grant(a.id, b.id, 'execution.queue'); grant(a.id, b.id, 'execution.steer'); grant(b.id, a.id, 'message.send');
  await service.bind(b.id, 'thread-B', 0, () => {});
  t.after(async () => { await service.close(); actors.close(); await rm(root, { recursive: true, force: true }); });
  return { root, actors, principal, human, a, b, aContext, bContext, ca, cb, grant, receipts, inputs, calls, execution,
    get service() { return service; },
    setFailAdd(value = true) { failAdd = value; }, setFailSteer(value: boolean | 'ambiguous' = true) { failSteer = value; },
    holdValidation(value: Promise<void>) { validateHold = value; }, revokeAdmission() { current = false; },
    async restart() { await service.close(); service = new Collaboration(join(root, 'collaboration.sqlite'), actors, execution); },
    async checksumDrift() { await service.close(); const db = new DatabaseSync(join(root, 'collaboration.sqlite')); db.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=1"); db.close(); assert.throws(() => new Collaboration(join(root, 'collaboration.sqlite'), actors, execution)); },
    send(extra: Record<string, unknown> = {}) { return service.send(aContext, { targetActorId: b.id, content: 'review the code', idempotencyKey: 'first', ...extra }); },
  };
}

test('execution ownership must be explicit before opening collaboration storage or connecting a Host', async t => {
  const f = await fixture(t), path = join(f.root, 'invalid-route.sqlite');
  for (const hostId of [undefined, null, '', ' ', 'bad\nhost', 'x'.repeat(257)]) {
    assert.throws(() => new Collaboration(path, f.actors, { ...f.execution, hostId } as unknown as ConversationExecutionPort), /execution_host_required/);
    assert.equal(existsSync(path), false, 'invalid ownership cannot create a database');
    assert.throws(() => createConversationExecution(() => { throw Error('must not connect'); }, { serverId: 'fixture', hostId }), /Host required/);
  }
});

test('an explicit non-native Host survives binding, durable handoff and restart without an engine fallback', async t => {
  const f = await fixture(t);
  assert.equal(f.service.binding(f.b.id)!.hostId, 'fixture-host');
  let receivedHost: string | undefined;
  const add = f.execution.add;
  f.execution.add = async (binding, ...args) => { receivedHost = binding.hostId; return add(binding, ...args); };
  const sent = f.send({ execution: { mode: 'queue' } });
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).host_id, 'fixture-host');
  assert.equal(f.service.usageSubmission('thread-B', 'actor-input:' + sent.requestId)?.actorId, f.a.id);
  await f.service.pump();
  assert.equal(receivedHost, 'fixture-host');
  await f.restart();
  assert.equal(f.service.binding(f.b.id)!.hostId, 'fixture-host');
  assert.equal(f.service.usageSubmission('thread-B', 'actor-input:' + sent.requestId)?.actorId, f.a.id);
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'queued');
});

test('usage recovery matches the declared Host and cannot recover another engine request with the same thread', async t => {
  const f = await fixture(t), sent = f.send({ execution: { mode: 'queue' } });
  const inputId = 'actor-input:' + sent.requestId;
  assert.equal(f.service.usageSubmission('thread-B', inputId)?.actorId, f.a.id);
  assert.equal(f.service.usageSubmission('other-thread', inputId), null);
  await f.service.close();
  const db = new DatabaseSync(join(f.root, 'collaboration.sqlite'));
  db.prepare('UPDATE actor_execution_requests SET host_id=? WHERE id=?').run('local-codex', sent.requestId);
  db.close();
  await f.restart();
  assert.equal(f.service.usageSubmission('thread-B', inputId), null, 'a legacy native identity is not the current generic Host');
});

test('historical nullable request ownership retains its old native identity and migration ledger on reopen', async t => {
  const f = await fixture(t, Date.now, 'local-codex');
  const sent = f.send({ execution: { mode: 'queue' } });
  await f.service.close();
  const db = new DatabaseSync(join(f.root, 'collaboration.sqlite'));
  const before = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  db.prepare('UPDATE actor_execution_requests SET host_id=NULL WHERE id=?').run(sent.requestId);
  db.close();
  let receivedHost: string | undefined;
  const add = f.execution.add;
  f.execution.add = async (binding, ...args) => { receivedHost = binding.hostId; return add(binding, ...args); };
  await f.restart(); await f.service.pump();
  assert.equal(receivedHost, 'local-codex', 'read compatibility must not rewrite pre-existing ownership');
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'queued');
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).host_id, null);
  const reopened = new DatabaseSync(join(f.root, 'collaboration.sqlite'), { readOnly: true });
  assert.deepEqual(reopened.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), before);
  reopened.close();
});

test('human and Session use one message contract; delivery, reading and execution remain distinct', async t => {
  const f = await fixture(t);
  const sent = f.send();
  assert.equal(sent.requestId, null); assert.equal(f.calls.length, 0);
  const inbox = f.service.inbox(f.bContext, 0, 50);
  assert.equal(inbox.length, 1); assert.equal(inbox[0]!.author_id, f.a.id); assert.equal(inbox[0]!.delivery_state, 'received');
  f.service.read(f.bContext, sent.messageId!);
  assert.equal(f.service.inbox(f.bContext, 0, 50)[0]!.delivery_state, 'read');
  assert.throws(() => f.service.read(f.aContext, sent.messageId!));
  const response = f.service.send(f.bContext, { targetActorId: f.a.id, content: 'done', replyTo: sent.messageId, idempotencyKey: 'reply' });
  assert.equal(f.service.messages(f.aContext, f.b.id, 0, 50).length, 2);
  f.service.send(f.human, { targetActorId: f.b.id, content: 'human request', idempotencyKey: 'human' });
  assert.ok(response.messageId); assert.equal(f.calls.length, 0);
});

test('stable send key is exact and atomic; a failed execution admission leaves no message', async t => {
  const f = await fixture(t);
  const sent = f.send({ execution: { mode: 'queue' } });
  assert.equal(f.send({ execution: { mode: 'queue' } }).requestId, sent.requestId);
  assert.throws(() => f.send({ content: 'different' }), /idempotency_key_reused/);
  assert.throws(() => f.send({ idempotencyKey: 'invalid', execution: { mode: 'steer' } }), /invalid_field/);
  assert.equal(f.service.inbox(f.bContext, 0, 50).length, 1);
});

test('one execution consumes multiple referenced messages; no forgery or cross-peer input', async t => {
  const f = await fixture(t), one = f.send(), two = f.send({ idempotencyKey: 'second', content: 'also review tests' });
  const result = f.service.request(f.aContext, { targetActorId: f.b.id, messageIds: [one.messageId, two.messageId], execution: { mode: 'queue' }, idempotencyKey: 'batch' });
  await f.service.pump(); assert.equal(f.inputs.length, 1); assert.match(f.inputs[0]!, /also review tests/);
  assert.equal(f.service.getRequest(f.aContext, result.requestId!).state, 'queued');
  assert.throws(() => f.send({ author_id: f.b.id }), /unexpected_field/);
  assert.throws(() => f.service.getRequest(f.human, result.requestId!), /missing/);
  assert.throws(() => f.service.request(f.aContext, { targetActorId: f.b.id, messageIds: ['not-visible'], execution: { mode: 'queue' }, idempotencyKey: 'bad' }), /input_not_visible/);
});

test('send permission does not grant queue/steer; revocation and actor generation fence durable requests', async t => {
  const f = await fixture(t);
  f.grant(f.a.id, f.b.id, 'execution.steer', false);
  assert.throws(() => f.send({ execution: { mode: 'steer', expectedTurnId: 'R' } }), /actor_action_denied/);
  const sent = f.send({ execution: { mode: 'queue' } });
  assert.equal(f.service.authorizeInput('thread-B', 'actor-input:' + sent.requestId, 'queue'), true);
  f.grant(f.a.id, f.b.id, 'execution.queue', false);
  assert.equal(f.service.authorizeInput('thread-B', 'actor-input:' + sent.requestId, 'queue'), false);
  await f.service.pump(); assert.equal(f.calls.length, 0); assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'rejected');
  f.grant(f.a.id, f.b.id, 'execution.queue');
  const next = f.send({ idempotencyKey: 'next', execution: { mode: 'queue' } });
  f.actors.setEnabled(f.b.id, false, 'operator'); f.actors.setEnabled(f.b.id, true, 'operator');
  assert.equal(f.service.authorizeInput('thread-B', 'actor-input:' + next.requestId, 'queue'), false);
});

test('binding CAS, unique runtime ownership and late administrator revocation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.bind(f.a.id, 'thread-B', 0, () => {}), /thread_already_bound/);
  await assert.rejects(f.service.bind(f.b.id, 'thread-C', 0, () => {}), /binding_changed/);
  let resume!: () => void;
  f.holdValidation(new Promise(resolve => { resume = resolve; }));
  const pending = f.service.bind(f.b.id, 'thread-C', 1, () => { throw new Error('admin revoked'); });
  resume(); await assert.rejects(pending, /admin revoked/);
  assert.equal(f.service.binding(f.b.id)!.threadId, 'thread-B');
});

test('rebind invalidates old work while preserving communication history', async t => {
  const f = await fixture(t), sent = f.send({ execution: { mode: 'queue' } });
  await f.service.bind(f.b.id, 'thread-C', 1, () => {});
  await f.service.pump(); assert.equal(f.inputs.length, 0);
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'rejected');
  assert.equal(f.service.inbox(f.bContext, 0, 50).length, 1);
});

test('lost add acknowledgement queries the original queue after restart, never sends a second input', async t => {
  const f = await fixture(t); f.setFailAdd();
  const sent = f.send({ execution: { mode: 'queue' } }); await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'unknown');
  await f.restart(); await f.service.pump();
  assert.equal(f.inputs.length, 1); assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'queued');
  f.receipts.set(sent.requestId!, { id: 'queue:' + sent.requestId, state: 'delivered', targetTurnId: 'R' });
  await f.service.pump(); assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'submitted');
});

test('steer is pinned to one Turn; definitive rejection never falls back to queue execution', async t => {
  const f = await fixture(t), sent = f.send({ execution: { mode: 'steer', expectedTurnId: 'R' } });
  assert.equal(f.service.authorizeInput('thread-B', 'actor-input:' + sent.requestId, 'steer', 'next-R'), false);
  assert.equal(f.service.authorizeInput('thread-B', 'actor-input:' + sent.requestId, 'steer', 'R'), true);
  f.setFailSteer(); await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'rejected');
  assert.equal(f.service.inputMode('actor-input:' + sent.requestId), null);
  await f.service.pump(); assert.deepEqual(f.calls, ['add', 'steer', 'cancel']);
});

test('cancel removes an unclaimed input, leaves the message and refuses already submitted work', async t => {
  const f = await fixture(t), sent = f.send({ execution: { mode: 'queue' } }); await f.service.pump();
  await f.service.cancel(f.aContext, sent.requestId!, () => {});
  assert.equal(f.receipts.get(sent.requestId!)!.state, 'discarded');
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'cancelled');
  assert.equal(f.service.inbox(f.bContext, 0, 50).length, 1);
});

test('accepted work has independent lifetime; actor/instance revocation still prevents execution', async t => {
  const f = await fixture(t), sent = f.send({ execution: { mode: 'queue' } });
  f.actors.revokeCredential(f.ca.credentialId, 'operator');
  assert.equal(f.actors.authenticateSession(f.ca.token), null);
  assert.equal(f.service.authorizeInput('thread-B', 'actor-input:' + sent.requestId, 'queue'), true);
  f.revokeAdmission(); await f.service.pump(); assert.equal(f.inputs.length, 0);
});

test('HTTP authenticates the source, rejects anonymous/forged fields/CSRF, and accepts a Session bearer', async t => {
  const f = await fixture(t);
  const access = new ActorAccess(f.actors, { authenticateHuman: request => request.headers.cookie === 'human=test' ? f.principal : null, admitted: () => true, administrator: () => false });
  const api = new CollaborationHttpApi(f.service, access);
  const server = createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as any).port}/__opencraft_actors/collaboration/`;
  assert.equal((await fetch(url + 'inbox')).status, 401);
  const humanBody = JSON.stringify({ targetActorId: f.b.id, content: 'human', idempotencyKey: 'human-http' });
  assert.equal((await fetch(url + 'messages', { method: 'POST', headers: { cookie: 'human=test', 'content-type': 'application/json' }, body: humanBody })).status, 403);
  assert.equal((await fetch(url + 'messages', { method: 'POST', headers: { cookie: 'human=test', 'content-type': 'application/json', origin: new URL(url).origin }, body: humanBody })).status, 200);
  const headers = { authorization: 'Bearer ' + f.ca.token, 'content-type': 'application/json' };
  assert.equal((await fetch(url + 'messages', { method: 'POST', headers, body: JSON.stringify({ targetActorId: f.b.id, content: 'hello', idempotencyKey: 'http', actorId: f.b.id }) })).status, 400);
  assert.equal((await fetch(url + 'messages', { method: 'POST', headers, body: JSON.stringify({ targetActorId: f.b.id, content: 'hello', idempotencyKey: 'http' }) })).status, 200);
  assert.equal((await fetch(url + 'bindings', { method: 'POST', headers, body: JSON.stringify({ actorId: f.b.id, threadId: 'evil', expectedEpoch: 1 }) })).status, 403);
});


test('collaboration migration checksum drift fails closed and preserves message data', async t => {
  const f = await fixture(t), sent = f.send();
  await f.checksumDrift();
  const db = new DatabaseSync(join(f.root, 'collaboration.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT id FROM actor_messages').get()!.id, sent.messageId); db.close();
});


test('a native failure with a claimed queue receipt stays unknown, never becomes a definite rejection', async t => {
  const f = await fixture(t), sent = f.send({ execution: { mode: 'steer', expectedTurnId: 'R' } });
  f.setFailSteer('ambiguous'); await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'unknown');
  await f.service.pump(); assert.deepEqual(f.calls, ['add', 'steer']);
});


test('durable human admission follows provider defaults and explicit revocation without a live login', async t => {
  const f = await fixture(t), members = new MembershipStore(join(f.root, 'members.sqlite')); t.after(() => members.close());
  const instance = new InstanceAccess(members, [], f.actors, ['local']);
  assert.equal(instance.admitsActor(f.human.actorId), true);
  assert.equal(new InstanceAccess(members, [], f.actors).admitsActor(f.human.actorId), false);
  assert.equal(instance.admitsActor(f.a.id), true);
  members.set(f.principal, 'member', false, 'operator');
  assert.equal(instance.admitsActor(f.human.actorId), false);
  members.set(f.principal, 'member', true, 'operator');
  assert.equal(instance.admitsActor(f.human.actorId), true);
  members.setActor(f.human.actorId, 'member', false, 'operator');
  assert.equal(instance.admitsActor(f.human.actorId), false);
});


test('busy requests do not starve later admissions when timestamps are equal', async t => {
  const f = await fixture(t, () => 1);
  for (let i = 0; i < 40; i++) f.send({ idempotencyKey: 'batch-' + i, execution: { mode: 'queue' } });
  await f.service.pump(); assert.equal(f.inputs.length, 32);
  await f.service.pump(); assert.equal(f.inputs.length, 40);
});
