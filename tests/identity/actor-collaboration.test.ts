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
import { OrchestrationRuntimeWorker } from '../../packages/access-control/src/orchestration-runtime-store';
import { parsePrincipal } from '../../packages/identity-core/src/index';
import { createConversationExecution } from '../../apps/headless-server/src/conversation-execution.mjs';

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
    async restart() { await service.close(); service = new Collaboration(join(root, 'collaboration.sqlite'), actors, execution, now); },
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
  await f.service.pump(); assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'injected');
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

test('stable execution polling performs no update, while each durable transition commits in the Worker', async t => {
  let now=1000;
  const f=await fixture(t,()=>now);
  const sent=f.send({execution:{mode:'queue'}});
  await f.service.pump();
  const before=f.service.getRequest(f.aContext,sent.requestId!);
  assert.equal(before.state,'queued');
  const reader=new DatabaseSync(join(f.root,'collaboration.sqlite'),{readOnly:true});
  t.after(()=>reader.close());
  const version=reader.prepare('PRAGMA data_version').get()!.data_version;
  const prepare=DatabaseSync.prototype.prepare;
  let mainUpdates=0;
  DatabaseSync.prototype.prepare=function(sql:string){
    if(/^\s*UPDATE actor_execution_requests/u.test(sql)){mainUpdates++;throw Error('Execution observation wrote on the main thread');}
    return prepare.call(this,sql);
  };
  try {
    now=2000;
    for(let i=0;i<20;i++)await f.service.pump();
    assert.equal(f.service.getRequest(f.aContext,sent.requestId!).updated_at,before.updated_at);
    assert.equal(reader.prepare('PRAGMA data_version').get()!.data_version,version);
    f.receipts.set(sent.requestId!,{id:'queue:'+sent.requestId,state:'delivered',targetTurnId:'final-turn'});
    await f.service.pump();
    const after=f.service.getRequest(f.aContext,sent.requestId!);
    assert.equal(after.state,'injected');assert.equal(after.turn_id,'final-turn');assert.equal(after.updated_at,now);
    assert.equal(mainUpdates,0);
  } finally {DatabaseSync.prototype.prepare=prepare;}
  await f.restart();
  assert.equal(f.service.getRequest(f.aContext,sent.requestId!).state,'injected');
});

test('one HTTP Server keeps concurrent Human authors, receipts and revocation independent', async t => {
  const f = await fixture(t);
  const secondPrincipal = parsePrincipal({ provider: 'local', subject: 'person-2', displayName: 'second', expiresAt: Date.now() + 60_000 })!;
  const second = f.actors.resolveHuman(secondPrincipal)!;
  f.grant(second.actorId, f.b.id, 'message.send');
  const access = new ActorAccess(f.actors, {
    authenticateHuman: request => request.headers.cookie === 'human=one' ? f.principal : request.headers.cookie === 'human=two' ? secondPrincipal : null,
    admitted: () => true, administrator: () => false,
  });
  const api = new CollaborationHttpApi(f.service, access);
  const server = createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const url = origin + '/__opencraft_actors/collaboration/';
  const send = (cookie: string, content: string, idempotencyKey = 'same-key') => fetch(url + 'messages', {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ targetActorId: f.b.id, content, idempotencyKey }),
  });
  const replies = await Promise.all([send('human=one', 'from one'), send('human=two', 'from two')]);
  assert.deepEqual(replies.map(r => r.status), [200, 200]);
  const [one, two] = await Promise.all(replies.map(r => r.json()));
  assert.notEqual(one.messageId, two.messageId, 'idempotency keys are scoped to each Actor');
  const rows = f.service.database.prepare('SELECT author_id,content FROM actor_messages ORDER BY content').all();
  assert.deepEqual(rows.map(row => [row.author_id, row.content]), [[f.human.actorId, 'from one'], [second.actorId, 'from two']]);
  const firstHistory = await fetch(url + 'messages?peerActorId=' + encodeURIComponent(f.b.id), { headers: { cookie: 'human=one' } }).then(r => r.json());
  assert.ok(JSON.stringify(firstHistory).includes('from one'));
  assert.ok(!JSON.stringify(firstHistory).includes('from two'), 'same recipient does not make private messages shared');
  assert.equal((await send('human=one', 'from one').then(r => r.json())).messageId, one.messageId);
  f.actors.setEnabled(second.actorId, false, 'operator');
  assert.equal((await send('human=two', 'revoked', 'later')).status, 401);
  assert.equal((await send('human=one', 'still admitted', 'later')).status, 200);
});

test('model task authority uses current Human delegation, not historical usage or Session provenance',async t=>{
 const f=await fixture(t);
 const sent=f.service.send(f.human,{targetActorId:f.b.id,content:'Help me',idempotencyKey:'model-task',execution:{mode:'queue'}});
 const input='actor-input:'+sent.requestId;
 const authority=f.service.modelExecutionAuthority('thread-B',input);
 assert.equal(authority.authorizer,f.human.actorId);assert.equal(authority.executor,f.b.id);
 assert.throws(()=>f.service.modelExecutionAuthority('another-thread',input),/delegation_revoked/);
 const autonomous=f.send({execution:{mode:'queue'}});
 assert.throws(()=>f.service.modelExecutionAuthority('thread-B','actor-input:'+autonomous.requestId),/delegation_revoked/);
 f.grant(f.human.actorId,f.b.id,'execution.queue',false);
 assert.equal(f.service.usageSubmission('thread-B',input)?.actorId,f.human.actorId,'historical accounting is retained');
 assert.throws(()=>f.service.modelExecutionAuthority('thread-B',input),/delegation_revoked/);
});

test('exact actor-input start before add reply advances injection after stale queued write and survives restart', async t => {
  const f = await fixture(t), add = f.execution.add;
  f.execution.add = async (binding, id, input) => {
    f.service.executionStarted(binding.threadId, 'actor-input:' + id, 'exact-turn');
    return add(binding, id, input);
  };
  const sent = f.send({execution:{mode:'queue'}});
  await f.service.pump();
  await f.restart(); // close drains the start write queued behind the pump.
  const row = f.service.getRequest(f.aContext, sent.requestId!);
  assert.equal(row.state, 'injected');
  assert.equal(row.turn_id, 'exact-turn');
  assert.equal(row.queue_id, 'queue:' + sent.requestId);
  await f.service.pump();
  assert.equal(f.inputs.length, 1);
});

test('start correlation rejects another input, thread, Host, and a different steer Turn', async t => {
  const f = await fixture(t), sent = f.send({execution:{mode:'queue'}});
  await f.service.pump();
  f.service.executionStarted('thread-B', 'some-old-input', 'old-turn');
  f.service.executionStarted('other-thread', 'actor-input:' + sent.requestId, 'old-turn');
  f.service.executionStarted('thread-B', 'actor-input:' + sent.requestId, 'unknown');
  await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext, sent.requestId!).state, 'queued');
  const steer = f.send({idempotencyKey:'steer',execution:{mode:'steer',expectedTurnId:'expected'}});
  f.service.executionStarted('thread-B', 'actor-input:' + steer.requestId, 'old-turn');
  assert.equal(f.service.getRequest(f.aContext, steer.requestId!).state, 'accepted');
  await f.service.close();
  const db = new DatabaseSync(join(f.root,'collaboration.sqlite'));
  db.prepare('UPDATE actor_execution_requests SET host_id=? WHERE id=?').run('other-host',sent.requestId);
  db.close();
  await f.restart();
  f.service.executionStarted('thread-B', 'actor-input:' + sent.requestId, 'old-turn');
  await f.service.close();
  const read = new DatabaseSync(join(f.root,'collaboration.sqlite'),{readOnly:true});
  assert.equal(read.prepare('SELECT state FROM actor_execution_requests WHERE id=?').get(sent.requestId)!.state,'queued');
  read.close();
});

test('submitted without Turn proof recovers the original exact receipt after restart without resubmission', async t => {
  const f = await fixture(t), sent = f.send({execution:{mode:'queue'}}), id = sent.requestId!;
  await f.service.pump();
  f.receipts.set(id,{id:'queue:'+id,state:'delivered',targetTurnId:null});
  await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'submitted');
  await f.restart();
  for (const targetTurnId of [null,'unknown']) {
    f.receipts.set(id,{id:'queue:'+id,state:'delivered',targetTurnId});
    await f.service.pump();
    assert.equal(f.service.getRequest(f.aContext,id).state,'submitted');
  }
  f.receipts.set(id,{id:'wrong-queue',state:'delivered',targetTurnId:'old-turn'});
  await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'submitted');
  f.receipts.set(id,{id:'queue:'+id,state:'unknown',targetTurnId:'old-turn'});
  await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'submitted');
  f.receipts.set(id,{id:'queue:'+id,state:'delivered',targetTurnId:'exact-turn'});
  await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'injected');
  assert.equal(f.service.getRequest(f.aContext,id).turn_id,'exact-turn');
  assert.equal(f.inputs.length,1);
});

test('accepted steering receipt recovers injection only for its pinned Turn', async t => {
  const f = await fixture(t), sent = f.send({execution:{mode:'steer',expectedTurnId:'expected'}}), id = sent.requestId!;
  f.receipts.set(id,{id:'queue:'+id,state:'steering',targetTurnId:'old-turn'});
  await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'submitted');
  // The existing mismatched Turn cannot silently be rebound to unrelated execution.
  f.receipts.set(id,{id:'queue:'+id,state:'steering',targetTurnId:'expected'});
  await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'submitted');
});

test('Worker rejects late receipt downgrades and conflicting injected Turn identities without durable writes', async t => {
  const f = await fixture(t), sent = f.send({execution:{mode:'queue'}}), id = sent.requestId!;
  await f.service.pump();
  f.service.executionStarted('thread-B','actor-input:'+id,'exact-turn');
  await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'injected');
  const worker = new OrchestrationRuntimeWorker(join(f.root,'collaboration.sqlite'));
  await worker.start();
  try {
    const before = f.service.getRequest(f.aContext,id);
    const reader = new DatabaseSync(join(f.root,'collaboration.sqlite'),{readOnly:true});
    try {
      const version = reader.prepare('PRAGMA data_version').get()!.data_version;
      for (const state of ['accepted','transferring','queued','unknown','submitted','rejected','cancelled']) {
        await worker.updateExecution({id,state,reason:'late',queueId:'queue:'+id,turnId:'exact-turn',now:999999});
        assert.deepEqual(f.service.getRequest(f.aContext,id),before);
      }
      await worker.updateExecution({id,state:'injected',reason:null,queueId:'queue:'+id,turnId:'old-turn',now:999999});
      assert.deepEqual(f.service.getRequest(f.aContext,id),before);
      await worker.updateExecution({id,state:'injected',reason:null,queueId:'wrong-queue',turnId:'exact-turn',now:999999});
      assert.deepEqual(f.service.getRequest(f.aContext,id),before);
      assert.equal(reader.prepare('PRAGMA data_version').get()!.data_version,version);
    } finally { reader.close(); }
  } finally { await worker.close(); }
});

test('an exact start remains factual when a lost native reply races a negative reconciliation', async t => {
  const f = await fixture(t);
  f.execution.add = async (binding, id) => {
    f.service.executionStarted(binding.threadId,'actor-input:'+id,'exact-turn');
    throw Object.assign(new Error('lost reply after native start'),{code:-32600});
  };
  const sent = f.send({execution:{mode:'queue'}});
  await f.service.pump();
  await f.restart();
  assert.equal(f.service.getRequest(f.aContext,sent.requestId!).state,'injected');
  assert.equal(f.service.getRequest(f.aContext,sent.requestId!).turn_id,'exact-turn');
});


test('matching acknowledged steering receipt recovers the pinned Turn without a second steer', async t => {
  const f = await fixture(t), sent = f.send({execution:{mode:'steer',expectedTurnId:'expected'}}), id = sent.requestId!;
  let steers = 0;
  f.execution.steer = async () => { steers++; };
  f.receipts.set(id,{id:'queue:'+id,state:'steering',targetTurnId:'expected'});
  await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'injected');
  assert.equal(f.service.getRequest(f.aContext,id).turn_id,'expected');
  assert.equal(steers,0);
  assert.equal(f.inputs.length,0);
});

test('receipt rejection is an observation failure: one query, no mutation and no pump bypass', async t => {
  let clock = Date.now(); const f = await fixture(t, () => clock);
  let queries = 0, broken = true;
  const read = f.execution.receipt;
  f.execution.receipt = async (...args) => { queries++; if (broken) throw Object.assign(Error('private engine detail'), {code:-32602}); return read(...args); };
  const sent = f.send({execution:{mode:'queue'}}), id = sent.requestId!;
  await f.service.pump();
  assert.equal(queries,1); assert.deepEqual(f.calls,[]);
  const row = f.service.getRequest(f.aContext,id);
  assert.equal(row.state,'accepted');
  assert.equal((row.reconciliation as any).state,'waiting');
  assert.equal((row.reconciliation as any).reason,'protocol');
  assert.equal(JSON.stringify(row.reconciliation).includes('private engine detail'),false);
  for (let i=0;i<5;i++) await f.service.pump();
  assert.equal(queries,1,'another input/manual pump cannot hammer the broken receipt endpoint');
  clock+=30_000;broken=false;await f.service.pump();
  assert.equal(queries,2);assert.deepEqual(f.calls,['add']);
  assert.equal(f.service.getRequest(f.aContext,id).state,'queued');
  assert.deepEqual(f.service.getRequest(f.aContext,id).reconciliation,{state:'ready'});
});

test('unknown delivery enters bounded recovery, leaves other work live and settles only on original evidence', async t => {
  let clock=Date.now();const f=await fixture(t,()=>clock);f.setFailAdd();
  const id=f.send({execution:{mode:'queue'}}).requestId!;await f.service.pump();
  const before=f.service.getRequest(f.aContext,id);assert.equal(before.state,'unknown');
  let queries=0,broken=true;const read=f.execution.receipt;
  f.execution.receipt=async (binding,requestId,options)=>{
    if(requestId===id){queries++;if(broken)throw Object.assign(Error('unsupported receipt'),{code:-32602});}
    return read(binding,requestId,options);
  };
  await f.service.pump();clock+=30_000;await f.service.pump();clock+=60_000;await f.service.pump();
  const after=f.service.getRequest(f.aContext,id);
  for(const key of ['state','reason','queue_id','turn_id','updated_at'])assert.equal(after[key],before[key]);
  assert.equal(queries,3);assert.equal((after.reconciliation as any).state,'recovery_required');
  assert.equal((after.reconciliation as any).nextAttemptAt,clock+300_000);
  // Different receiver/thread, not a global circuit breaker or another runnable queue.
  f.setFailAdd(false);const receiver=f.actors.createSession('independent',f.human.actorId);
  f.grant(f.a.id,receiver.id,'message.send');f.grant(f.a.id,receiver.id,'execution.queue');
  await f.service.bind(receiver.id,'thread-independent',0,()=>{});
  const other=f.service.send(f.aContext,{targetActorId:receiver.id,content:'independent input',idempotencyKey:'independent',execution:{mode:'queue'}});
  await f.service.pump();assert.equal(f.service.getRequest(f.aContext,other.requestId!).state,'queued');
  assert.equal(queries,3);assert.equal(f.inputs.length,2);
  broken=false;f.receipts.set(id,{id:'queue:'+id,state:'delivered',targetTurnId:'original-turn'});
  clock+=300_000;await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'injected');
  assert.equal(f.service.getRequest(f.aContext,id).turn_id,'original-turn');
  assert.deepEqual(f.service.getRequest(f.aContext,id).reconciliation,{state:'ready'});
  assert.equal(f.inputs.length,2,'recovery never creates a replacement for the old input');
});

test('restart drops only health hints; durable unknown request and no-replay custody survive', async t => {
  let clock=Date.now();const f=await fixture(t,()=>clock);f.setFailAdd();
  const id=f.send({execution:{mode:'queue'}}).requestId!;await f.service.pump();
  const before=f.service.getRequest(f.aContext,id);const read=f.execution.receipt;let broken=true,queries=0;
  f.execution.receipt=async (...args)=>{queries++;if(broken)throw Object.assign(Error('offline'),{code:-32602});return read(...args);};
  await f.service.pump();await f.restart();
  assert.deepEqual(f.service.getRequest(f.aContext,id).reconciliation,{state:'ready'});
  await f.service.pump();assert.equal(queries,2);
  for(const key of ['state','reason','queue_id','turn_id','updated_at'])assert.equal(f.service.getRequest(f.aContext,id)[key],before[key]);
  assert.equal(f.inputs.length,1);
  clock+=30_000;broken=false;f.receipts.delete(id);await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'unknown');assert.equal(f.inputs.length,1,'absence is not permission to replay');
});

test('a rejected mutation without a receipt cannot prove non-execution', async t=>{
  const f=await fixture(t);f.execution.add=async()=>{f.calls.push('add');throw Object.assign(Error('invalid native response'),{code:-32602});};
  const id=f.send({execution:{mode:'queue'}}).requestId!;await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'unknown');assert.deepEqual(f.calls,['add']);
  await f.service.pump();assert.deepEqual(f.calls,['add']);
});

test('a claim racing rejected steer cannot be relabelled unexecuted when cancel loses', async t=>{
  const f=await fixture(t);f.setFailSteer();
  f.execution.cancel=async(_binding,id)=>{f.calls.push('cancel');f.receipts.set(id,{id:'queue:'+id,state:'delivered',targetTurnId:'R'});return false;};
  const id=f.send({execution:{mode:'steer',expectedTurnId:'R'}}).requestId!;await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'unknown');
  await f.service.pump();assert.equal(f.service.getRequest(f.aContext,id).state,'injected');
  assert.equal(f.service.getRequest(f.aContext,id).turn_id,'R');assert.deepEqual(f.calls,['add','steer','cancel']);
});

test('revocation plus a missing receipt cannot turn an uncertain input into a confirmed rejection',async t=>{
  const f=await fixture(t);f.setFailAdd();const id=f.send({execution:{mode:'queue'}}).requestId!;await f.service.pump();
  f.receipts.delete(id);f.grant(f.a.id,f.b.id,'execution.queue',false);await f.service.pump();
  assert.equal(f.service.getRequest(f.aContext,id).state,'unknown');assert.deepEqual(f.calls,['add']);
});

test('a failed observation after a lost cancellation is not queried again in the rejection handler',async t=>{
  const f=await fixture(t);const id=f.send({execution:{mode:'queue'}}).requestId!;await f.service.pump();
  f.grant(f.a.id,f.b.id,'execution.queue',false);
  let queries=0;const read=f.execution.receipt;
  f.execution.receipt=async (...args)=>{queries++;if(queries>1)throw Object.assign(Error('receipt protocol mismatch'),{code:-32602});return read(...args);};
  f.execution.cancel=async()=>{f.calls.push('cancel');return false;};
  await f.service.pump();
  assert.equal(queries,2,'only initial observation and post-cancel observation; no duplicate reconcile query');
  assert.equal(f.service.getRequest(f.aContext,id).state,'unknown');
  assert.equal((f.service.getRequest(f.aContext,id).reconciliation as any).state,'waiting');
  await f.service.pump();assert.equal(queries,2);assert.deepEqual(f.calls,['add','cancel']);
});

test('submitted custody is retained when a later exact-injection receipt lookup fails',async t=>{
  const f=await fixture(t);const id=f.send({execution:{mode:'queue'}}).requestId!;await f.service.pump();
  f.receipts.set(id,{id:'queue:'+id,state:'delivered',targetTurnId:null});await f.service.pump();
  const before=f.service.getRequest(f.aContext,id);assert.equal(before.state,'submitted');
  f.execution.receipt=async()=>{throw Object.assign(Error('receipt endpoint invalid'),{code:-32602});};
  await f.service.pump();const after=f.service.getRequest(f.aContext,id);
  for(const key of ['state','reason','queue_id','turn_id','updated_at'])assert.equal(after[key],before[key]);
  assert.equal((after.reconciliation as any).state,'waiting');assert.equal(f.inputs.length,1);
});
