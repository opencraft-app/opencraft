import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openServerDatabase } from '@opencraft/storage-node/server';
import { parsePrincipal } from '@opencraft/identity-core';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration } from '../../packages/access-control/src/collaboration';
import { ServerSpacesLedger } from '../../packages/access-control/src/server-spaces-ledger';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'crew-contact-'));
  const storage = await openServerDatabase(dir), actors = new ActorStore(storage), service = new Collaboration(storage, actors);
  const ledger = new ServerSpacesLedger(storage.database);
  const human = (subject: string) => actors.resolveHuman(parsePrincipal({ provider: 'local', subject, displayName: subject, expiresAt: Date.now() + 60000 })!)!;
  const alice = human('Alice'), bob = human('Bob'), carol = human('Carol');
  const bot = (name: string) => {
    const actor = actors.createSession(name, alice.actorId);
    const token = actors.issueCredential(actor.id, Date.now() + 60000, alice.actorId).token;
    return { id: actor.id, context: actors.authenticateSession(token)! };
  };
  const alan = bot('Alan'), zhe = bot('Zhe'), loner = bot('Loner');
  // Alice owns the historical default space (contact closed) and a new team space (contact open).
  ledger.bootstrap(alice.actorId, [bob.actorId]);
  const team = (ledger.command(alice, { action: 'create', name: 'Team' }) as { spaceId: string }).spaceId;
  const code = (ledger.command(alice, { action: 'invite', spaceId: team }) as { code: string }).code;
  ledger.command(bob, { action: 'join', code });
  ledger.command(alice, { action: 'addBot', spaceId: team, actorId: alan.id });
  ledger.command(alice, { action: 'addBot', spaceId: team, actorId: zhe.id });
  const call = (context: typeof alice, method: string, params: Record<string, unknown> = {}) => service.communicate(context, method, params);
  const open = (context: typeof alice, actorId: string) => call(context, 'opencraft/channels/direct/open', { actorId });
  const canMessage = async (context: typeof alice, actorId: string) =>
    ((await call(context, 'opencraft/channels/people/list', {})) as { people: { actorId: string; canMessage: boolean }[] })
      .people.find(p => p.actorId === actorId)?.canMessage;
  t.after(async () => { await service.close(); actors.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  return { storage, actors, service, ledger, alice, bob, carol, alan, zhe, loner, team, call, open, canMessage };
}

test('humans reach any member of a shared open space without per-target grants', async t => {
  const f = await fixture(t);
  await f.open(f.bob, f.alice.actorId);
  await f.open(f.bob, f.alan.id);
  assert.equal(await f.canMessage(f.bob, f.zhe.id), true);
  await assert.rejects(f.open(f.carol, f.bob.actorId), /actor_action_denied/, 'not a member of any shared space');
  assert.equal(await f.canMessage(f.carol, f.bob.actorId), false);
  f.ledger.command(f.alice, { action: 'contact', spaceId: f.team, open: false });
  await assert.rejects(f.open(f.bob, f.alan.id), /actor_action_denied/, 'closing contact returns to per-target grants');
  assert.equal(await f.canMessage(f.bob, f.alice.actorId), false, 'the historical default space does not open contact');
  f.actors.setGrant(f.bob.actorId, f.alan.id, 'message.send', true, 'fixture');
  await f.open(f.bob, f.alan.id);
});

test('a space Bot proactively reaches only its phonebook, inside its own space', async t => {
  const f = await fixture(t);
  await assert.rejects(f.open(f.alan.context, f.bob.actorId), /actor_action_denied/, 'an empty phonebook reaches nobody');
  await assert.rejects(f.open(f.alan.context, f.zhe.id), /actor_action_denied/);
  const entries = await f.call(f.alice, 'opencraft/crew/phonebook/set', { botId: f.alan.id, actorId: f.zhe.id, present: true }) as { entries: { actorId: string; kind: string }[] };
  assert.deepEqual(entries.entries.map(e => [e.actorId, e.kind]), [[f.zhe.id, 'session']]);
  await f.open(f.alan.context, f.zhe.id);
  await assert.rejects(f.open(f.zhe.context, f.alan.id), /actor_action_denied/, 'a phonebook is one-way');
  // A grant to someone outside the space does not count as a phonebook entry.
  f.actors.setGrant(f.alan.id, f.carol.actorId, 'message.send', true, 'fixture');
  await assert.rejects(f.open(f.alan.context, f.carol.actorId), /actor_action_denied/);
  // Removing the entry stops later proactive contact.
  await f.call(f.alice, 'opencraft/crew/phonebook/set', { botId: f.alan.id, actorId: f.zhe.id, present: false });
  await assert.rejects(f.open(f.alan.context, f.zhe.id), /actor_action_denied/);
});

test('only the space owner edits a phonebook, only with members; members can read it', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call(f.bob, 'opencraft/crew/phonebook/set', { botId: f.alan.id, actorId: f.zhe.id, present: true }), /channel_denied/);
  await assert.rejects(f.call(f.alan.context, 'opencraft/crew/phonebook/set', { botId: f.alan.id, actorId: f.zhe.id, present: true }), /channel_denied/, 'a Bot cannot edit phonebooks');
  await assert.rejects(f.call(f.alice, 'opencraft/crew/phonebook/set', { botId: f.alan.id, actorId: f.carol.actorId, present: true }), /invalid_input/, 'not a member of the space');
  await assert.rejects(f.call(f.alice, 'opencraft/crew/phonebook/set', { botId: f.alan.id, actorId: f.alan.id, present: true }), /invalid_input/);
  await assert.rejects(f.call(f.alice, 'opencraft/crew/phonebook/set', { botId: f.loner.id, actorId: f.bob.actorId, present: true }), /channel_denied/, 'a Bot outside every space has no crew phonebook');
  await f.call(f.alice, 'opencraft/crew/phonebook/set', { botId: f.alan.id, actorId: f.bob.actorId, present: true });
  const read = await f.call(f.bob, 'opencraft/crew/phonebook/list', { botId: f.alan.id }) as { entries: { actorId: string }[]; members: { actorId: string }[]; editable: boolean };
  assert.equal(read.editable, false, 'members read the phonebook; only the owner edits it');
  assert.deepEqual(new Set(read.members.map(m => m.actorId)), new Set([f.alice.actorId, f.bob.actorId, f.zhe.id]), 'the whole space except the Bot itself');
  assert.equal(((await f.call(f.alice, 'opencraft/crew/phonebook/list', { botId: f.alan.id })) as { editable: boolean }).editable, true);
  assert.deepEqual(read.entries.map(e => e.actorId), [f.bob.actorId]);
  await assert.rejects(f.call(f.carol, 'opencraft/crew/phonebook/list', { botId: f.alan.id }), /channel_denied/);
  // The entry also carries handing work to that member. Commands run in the storage Worker, so read the committed grants.
  const actions = f.storage.database.prepare("SELECT action FROM actor_grants WHERE actor_id=? AND resource=? AND enabled=1 ORDER BY action").all(f.alan.id, f.bob.actorId).map(r => r.action);
  assert.deepEqual(actions, ['execution.queue', 'message.send']);
});

test('a Bot outside every space keeps the existing per-target grant rule', async t => {
  const f = await fixture(t);
  await assert.rejects(f.open(f.loner.context, f.bob.actorId), /actor_action_denied/);
  f.actors.setGrant(f.loner.id, f.carol.actorId, 'message.send', true, 'fixture');
  await f.open(f.loner.context, f.carol.actorId);
});

const dispatch = (f: Awaited<ReturnType<typeof fixture>>, from: { actorId: string } | { context: unknown }, target: string, key: string, parentWorkId?: string) =>
  f.call(('context' in from ? from.context : from) as never, 'opencraft/crew/work/dispatch',
    { targetActorId: target, content: key, idempotencyKey: key, ...(parentWorkId ? { parentWorkId } : {}) }) as Promise<{ workId: string; work: { chain: { actorId: string }[]; budget: { used: number; limit: number } } }>;
const say = (f: Awaited<ReturnType<typeof fixture>>, bot: { context: unknown }, workId: string, target: string, key: string) =>
  f.call(bot.context as never, 'opencraft/crew/work/message', { workId, targetActorId: target, content: key, idempotencyKey: key });

test('work opened by a member lets its Bot reach that member and the owner, whatever its phonebook', async t => {
  const f = await fixture(t);
  const work = await dispatch(f, f.bob, f.alan.id, 'tidy the release');
  assert.deepEqual(work.work.chain.map(p => p.actorId), [f.bob.actorId, f.alice.actorId]);
  const seen = async (who: object) => (await f.call(('context' in who ? who.context : who) as never, 'opencraft/crew/work/get', { workId: work.workId }) as { work: { request: string | null } }).work.request;
  assert.equal(await seen(f.alan), 'tidy the release', 'the Bot reads what it was asked');
  assert.equal(await seen(f.bob), 'tidy the release');
  assert.equal(await seen(f.alice), null, 'the rest of the chain sees the work, not the dispatch text');
  await say(f, f.alan, work.workId, f.bob.actorId, 'which branch?');
  await say(f, f.alan, work.workId, f.alice.actorId, 'heads up');
  await assert.rejects(say(f, f.alan, work.workId, f.zhe.id, 'not on the chain'), /crew_work_denied/);
  await assert.rejects(say(f, f.zhe, work.workId, f.bob.actorId, 'not my work'), /crew_work_denied/);
  const replay = await dispatch(f, f.bob, f.alan.id, 'tidy the release');
  assert.equal(replay.workId, work.workId, 'a retried dispatch reuses its work');
  await f.call(f.alan.context, 'opencraft/crew/work/finish', { workId: work.workId });
  await assert.rejects(say(f, f.alan, work.workId, f.bob.actorId, 'after finishing'), /crew_work_denied/, 'the pass ends with the work');
  await assert.rejects(dispatch(f, f.carol, f.alan.id, 'outsider'), /actor_action_denied/);
});

test('Bot hand-offs follow the phonebook, reach the whole chain, and stop at the root budget', async t => {
  const f = await fixture(t);
  const root = await dispatch(f, f.bob, f.alan.id, 'ship 2.3');
  await assert.rejects(dispatch(f, f.alan, f.zhe.id, 'no phonebook', root.workId), /actor_action_denied/);
  await f.call(f.alice, 'opencraft/crew/phonebook/set', { botId: f.alan.id, actorId: f.zhe.id, present: true });
  await assert.rejects(dispatch(f, f.alan, f.zhe.id, 'no parent'), /crew_parent_required/);
  const child = await dispatch(f, f.alan, f.zhe.id, 'check the signatures', root.workId);
  assert.deepEqual(child.work.chain.map(p => p.actorId), [f.alan.id, f.bob.actorId, f.alice.actorId], 'nearest first, owner last');
  await say(f, f.zhe, child.workId, f.bob.actorId, 'needs you: 2.3 or 2.3.1?');
  for (let i = 2; i <= 8; i++) await dispatch(f, f.alan, f.zhe.id, 'step ' + i, root.workId);
  const view = await f.call(f.bob, 'opencraft/crew/work/get', { workId: root.workId }) as { work: { budget: { used: number; limit: number } } };
  assert.deepEqual(view.work.budget, { used: 8, limit: 8 });
  await assert.rejects(dispatch(f, f.alan, f.zhe.id, 'one too many', root.workId), /crew_budget_exhausted/);
  // The rejected hand-off left no message behind.
  const left = f.storage.database.prepare("SELECT COUNT(*) AS n FROM actor_messages WHERE content='one too many'").get()!.n;
  assert.equal(left, 0);
  await assert.rejects(f.call(f.carol, 'opencraft/crew/work/get', { workId: root.workId }), /crew_work_denied/);
});

test('work a Bot starts on its own answers to the space owner', async t => {
  const f = await fixture(t);
  const started = await f.call(f.alan.context, 'opencraft/crew/work/start', {}) as { work: { id: string; origin: string; chain: { actorId: string }[] } };
  assert.equal(started.work.origin, 'routine');
  assert.deepEqual(started.work.chain.map(p => p.actorId), [f.alice.actorId]);
  await say(f, f.alan, started.work.id, f.alice.actorId, 'nightly check found a gap');
  await assert.rejects(say(f, f.alan, started.work.id, f.bob.actorId, 'not on the chain'), /crew_work_denied/);
  await assert.rejects(f.call(f.alice, 'opencraft/crew/work/start', {}), /crew_work_denied/, 'only space Bots start work');
  const listed = await f.call(f.alan.context, 'opencraft/crew/work/list', {}) as { works: { id: string }[] };
  assert.deepEqual(listed.works.map(w => w.id), [started.work.id]);
});

test('members who leave are skipped on the chain, and a removed Bot holds no work', async t => {
  const f = await fixture(t);
  const work = await dispatch(f, f.bob, f.alan.id, 'before leaving');
  f.ledger.command(f.alice, { action: 'remove', spaceId: f.team, actorId: f.bob.actorId });
  const view = await f.call(f.alan.context, 'opencraft/crew/work/get', { workId: work.workId }) as { work: { chain: { actorId: string }[] } };
  assert.deepEqual(view.work.chain.map(p => p.actorId), [f.alice.actorId], 'the departed requester is skipped; escalation goes on up');
  await assert.rejects(say(f, f.alan, work.workId, f.bob.actorId, 'gone'), /crew_work_denied/);
  await say(f, f.alan, work.workId, f.alice.actorId, 'Bob left; your call');
  f.ledger.command(f.alice, { action: 'remove', spaceId: f.team, actorId: f.alan.id });
  await assert.rejects(say(f, f.alan, work.workId, f.alice.actorId, 'removed'), /crew_work_denied/);
  assert.deepEqual((await f.call(f.alan.context, 'opencraft/crew/work/list', {}) as { works: unknown[] }).works, []);
});

test('a crew dispatch from the Bot owner is marked so the owner chat does not take it twice', async t => {
  const f = await fixture(t);
  const alice = f.actors.get(f.alice.actorId)!;
  f.storage.database.prepare(`INSERT INTO personal_assistants(bot_id,actor_id,owner_human_id,owner_generation,assignment_id,epoch,state,created_at,credential_id,is_default,paused)
    VALUES('bot-alan',?,?,?,'assignment-alan','1','claimed',?,?,1,0)`).run(f.alan.id, alice.id, alice.generation, Date.now(), f.alan.context.credentialId);
  await f.call(f.alice, 'send', { targetActorId: f.alan.id, content: 'plain chat', idempotencyKey: 'plain' });
  await dispatch(f, f.alice, f.alan.id, 'crew job');
  const rows = await f.call(f.alan.context, 'personal-assistant/own-messages', { after: 0 }) as { content: string; crewWork: boolean }[];
  assert.deepEqual(rows.map(r => [r.content, r.crewWork]), [['plain chat', false], ['crew job', true]]);
});

test('every message a member sends to a space Bot is a dispatch', async t => {
  const f = await fixture(t);
  const sent = await f.call(f.bob, 'send', { targetActorId: f.alan.id, content: 'draft the notes', idempotencyKey: 'notes' }) as { messageId: string };
  const works = (await f.call(f.alan.context, 'opencraft/crew/work/list', {}) as { works: { id: string; messageId: string; requesterId: string; request: string }[] }).works;
  assert.deepEqual(works.map(w => [w.messageId, w.requesterId, w.request]), [[sent.messageId, f.bob.actorId, 'draft the notes']]);
  await f.call(f.bob, 'send', { targetActorId: f.alan.id, content: 'draft the notes', idempotencyKey: 'notes' });
  assert.equal((await f.call(f.alan.context, 'opencraft/crew/work/list', {}) as { works: unknown[] }).works.length, 1, 'a retried send opens nothing new');
  const viaDispatch = await dispatch(f, f.bob, f.alan.id, 'second job');
  assert.equal((await f.call(f.alan.context, 'opencraft/crew/work/list', {}) as { works: unknown[] }).works.length, 2);
  assert.ok(viaDispatch.workId);
});

test('replies between Bots open no work, spend no budget and come back on the work they answer', async t => {
  const f = await fixture(t);
  await f.call(f.alice, 'opencraft/crew/phonebook/set', { botId: f.alan.id, actorId: f.zhe.id, present: true });
  const root = await dispatch(f, f.bob, f.alan.id, 'ship 2.3');
  const child = await dispatch(f, f.alan, f.zhe.id, 'check the signatures', root.workId);
  const work = async (workId: string) => (await f.call(f.bob, 'opencraft/crew/work/get', { workId }) as { work: { budget: { used: number }; openChildren: number } }).work;
  assert.equal((await work(root.workId)).openChildren, 1);

  await say(f, f.zhe, child.workId, f.alan.id, 'signatures look fine');
  const replies = async (bot: { context: unknown }) => (await f.call(bot.context as never, 'opencraft/crew/work/replies', { after: 0 }) as { replies: { workId: string; requesterId: string; content: string; from: { actorId: string } }[] }).replies;
  assert.deepEqual((await replies(f.alan)).map(r => [r.workId, r.requesterId, r.content, r.from.actorId]),
    [[root.workId, f.bob.actorId, 'signatures look fine', f.zhe.id]], 'filed against the work Alan holds, which Bob gave it');
  await say(f, f.alan, child.workId, f.zhe.id, 'thanks, also check the notes');
  assert.deepEqual((await replies(f.zhe)).map(r => [r.workId, r.content]), [[child.workId, 'thanks, also check the notes']], 'the requester answers down the tree');
  assert.equal(((await f.call(f.alan.context, 'opencraft/crew/work/replies', { after: 0 })) as { replies: { fromWorkId: string }[] }).replies[0]!.fromWorkId, child.workId, 'a reply says which hand-off it came from');
  assert.equal((await f.call(f.zhe.context, 'opencraft/crew/work/list', {}) as { works: unknown[] }).works.length, 1, 'no new work for Zhe');
  assert.equal((await work(root.workId)).budget.used, 1, 'replies spend no budget');

  await assert.rejects(f.call(f.bob, 'opencraft/crew/work/message', { workId: child.workId, targetActorId: f.zhe.id, content: 'not my hand-off', idempotencyKey: 'bob-down' }), /crew_work_denied/, 'only the requester answers down');
  await f.call(f.zhe.context, 'opencraft/crew/work/finish', { workId: child.workId });
  assert.equal((await work(root.workId)).openChildren, 0);
  await assert.rejects(say(f, f.alan, child.workId, f.zhe.id, 'too late'), /crew_work_denied/, 'closed work carries no replies');
});
