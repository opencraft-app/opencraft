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
  const read = await f.call(f.bob, 'opencraft/crew/phonebook/list', { botId: f.alan.id }) as { entries: { actorId: string }[] };
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
