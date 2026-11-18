import assert from 'node:assert/strict';
import { encodeConversationRef } from '../../packages/appserver-protocol/src/collaboration';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActorStore, humanActorPolicy, assistantMemberPolicy, actorPolicyFromEnvironment, type ActorCapability, type ActorPolicy, type ActorPolicyRequest } from '../../packages/access-control/src/actors';
import { Collaboration, CollaborationError, type ConversationExecutionPort } from '../../packages/access-control/src/collaboration';
import { parsePrincipal } from '../../packages/identity-core/src/index';

const capabilities: ActorCapability[] = ['conversation.shared-history', 'conversation.directory', 'conversation.search',
  'conversation.create', 'execution.delegate', 'automation.manage', 'channel.create', 'channel.invite', 'people.directory',
  'channel.wake', 'channel.forward-input'];

async function fixture(t: any, policy?: ActorPolicy) {
  const root = await mkdtemp(join(tmpdir(), 'actor-policy-'));
  const actors = new ActorStore(join(root, 'actors.sqlite'), Date.now, policy ? { policy } : {});
  const principal = parsePrincipal({ provider: 'local', subject: 'person-1', displayName: 'person', expiresAt: Date.now() + 60_000 })!;
  const human = actors.resolveHuman(principal)!;
  const session = actors.createSession('Assistant', human.actorId);
  const credential = actors.issueCredential(session.id, Date.now() + 60_000, human.actorId);
  const assistant = actors.authenticateSession(credential.token)!;
  t.after(async () => { actors.close(); await rm(root, { recursive: true, force: true }); });
  return { root, actors, human, session, assistant };
}

test('default policy preserves the existing human-only standing for every capability', async t => {
  const { actors, human, assistant } = await fixture(t);
  for (const capability of capabilities) {
    assert.equal(actors.allows(human, capability), true, capability);
    assert.equal(actors.allows(assistant, capability), false, capability);
  }
  assert.equal(humanActorPolicy({ actor: actors.get(human.actorId)!, capability: 'conversation.search' }), true);
});

test('durable admissions revalidate generation and enablement before the policy', async t => {
  let calls = 0;
  const { actors, human, session } = await fixture(t, () => { calls++; return true; });
  assert.equal(actors.allowsAdmitted(session.id, 1, 'execution.delegate'), true);
  assert.equal(actors.allowsAdmitted(session.id, 2, 'execution.delegate'), false);
  actors.setEnabled(session.id, false, human.actorId);
  assert.equal(actors.allowsAdmitted(session.id, 1, 'execution.delegate'), false);
  assert.equal(calls, 1);
});

test('stale or disabled Actors are denied before an embedder policy runs', async t => {
  let calls = 0;
  const { actors, human, session, assistant } = await fixture(t, () => { calls++; return true; });
  assert.equal(actors.allows(assistant, 'conversation.search'), true);
  assert.equal(actors.allows({ ...human, generation: human.generation + 1 }, 'conversation.search'), false);
  actors.setEnabled(session.id, false, human.actorId);
  assert.equal(actors.allows(assistant, 'conversation.search'), false);
  assert.equal(calls, 1);
});

test('an embedder policy receives the resolved Actor and resource and fails closed', async t => {
  const seen: ActorPolicyRequest[] = [];
  const { actors, human, session, assistant } = await fixture(t, request => {
    seen.push(request);
    if (request.resource === 'conversation://throws') throw new Error('policy unavailable');
    if (request.resource === 'conversation://truthy') return 1 as unknown as boolean;
    return request.actor.kind === 'human' || request.actor.id === session.id && request.capability === 'conversation.search';
  });
  assert.equal(actors.allows(assistant, 'conversation.search', 'conversation://allowed'), true);
  assert.equal(actors.allows(assistant, 'conversation.directory'), false);
  assert.equal(actors.allows(assistant, 'conversation.search', 'conversation://throws'), false);
  assert.equal(actors.allows(human, 'conversation.search', 'conversation://truthy'), false);
  assert.deepEqual({ ...seen[0] }, { actor: actors.get(session.id), capability: 'conversation.search', resource: 'conversation://allowed' });
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal('resource' in seen[1]!, false);
});

async function collaboration(t: any, policy?: ActorPolicy) {
  const f = await fixture(t, policy);
  const searches: string[] = [];
  const execution: ConversationExecutionPort = {
    hostId: 'fixture-host', serverId: 'fixture-server',
    async discover(search) { searches.push(search); return { conversations: [] }; },
    directory: () => ({ instanceId: 'instance', servers: [] }),
    async validate() {}, async receipt() { return null; }, async add() { return null; }, async steer() {}, async cancel() { return false; },
  };
  const service = new Collaboration(join(f.root, 'collaboration.sqlite'), f.actors, execution);
  t.after(() => service.close());
  return { ...f, service, searches };
}

test('Collaboration consults the policy for conversation search and directory', async t => {
  const preserved = await collaboration(t);
  await assert.rejects(preserved.service.discover(preserved.assistant, 'notes', null),
    (error: unknown) => error instanceof CollaborationError && error.status === 403);
  assert.throws(() => preserved.service.servers(preserved.assistant), CollaborationError);
  assert.deepEqual((await preserved.service.discover(preserved.human, 'notes', null) as { conversations: unknown[] }).conversations, []);
  assert.deepEqual(preserved.searches, ['notes']);

  const embedded = await collaboration(t, ({ actor, capability }) => actor.kind === 'human'
    || capability === 'conversation.search' || capability === 'conversation.directory');
  assert.deepEqual((await embedded.service.discover(embedded.assistant, 'plans', null) as { conversations: unknown[] }).conversations, []);
  assert.equal(embedded.service.servers(embedded.assistant).actor.kind, 'session');
  assert.deepEqual(embedded.searches, ['plans']);
});

test('native groups consult the policy for creation and invitation search', async t => {
  const preserved = await collaboration(t);
  assert.throws(() => preserved.service.createChannelGroup(preserved.assistant, 'Plans', [], 'create-1'), /channel_denied/);
  assert.equal(preserved.service.createChannelGroup(preserved.human, 'Plans', [preserved.session.id], 'create-1').kind, 'group');

  const embedded = await collaboration(t, ({ actor, capability }) => actor.kind === 'human'
    || capability === 'channel.create' || capability === 'channel.invite');
  const group = embedded.service.createChannelGroup(embedded.assistant, 'Assistant group', [embedded.human.actorId], 'create-2');
  assert.equal(group.kind, 'group');
  assert.equal(group.canManageMembers, true);
  assert.throws(() => embedded.service.channels.people(embedded.assistant), /channel_denied/);
});

test('assistant member preset lets assistants wake within a per-group budget only', async t => {
  let clock = 1_000;
  const { actors, human, assistant } = await fixture(t, assistantMemberPolicy({ wakesPerWindow: 2, windowMs: 10_000, now: () => clock }));
  for (const capability of capabilities) assert.equal(actors.allows(human, capability, 'g1', true), true, capability);
  for (const capability of capabilities.filter(c => c !== 'channel.wake')) assert.equal(actors.allows(assistant, capability, 'g1', true), false, capability);
  assert.equal(actors.allows(assistant, 'channel.wake'), false, 'wake needs a group');
  for (let i = 0; i < 5; i++) assert.equal(actors.allows(assistant, 'channel.wake', 'g1'), true, 'previews do not spend');
  assert.equal(actors.allows(assistant, 'channel.wake', 'g1', true), true);
  assert.equal(actors.allows(assistant, 'channel.wake', 'g1', true), true);
  assert.equal(actors.allows(assistant, 'channel.wake', 'g1', true), false);
  assert.equal(actors.allows(assistant, 'channel.wake', 'g1'), false, 'exhausted budget is visible');
  assert.equal(actors.allows(assistant, 'channel.wake', 'g2', true), true, 'budgets are per group');
  clock += 10_000;
  assert.equal(actors.allows(assistant, 'channel.wake', 'g1', true), true, 'window refills');
});

test('assistant member preset can make an assistant the accountable delegator', async t => {
  const target = { serverId: 'fixture-server', threadId: 'thread-1' };
  const off = await collaboration(t, assistantMemberPolicy());
  off.actors.setGrant(off.session.id, encodeConversationRef(target), 'execution.delegate', true, off.human.actorId);
  off.service.authorizeExecution(off.assistant, 'thread-1', 'input-1');
  const offId = off.service.inputOrigin('thread-1', 'input-1')!.delegationId!;
  assert.throws(() => off.service.delegation('thread-1', 'turn-unused', offId), CollaborationError, 'standing is checked where the authority is used');

  const on = await collaboration(t, assistantMemberPolicy({ delegation: true }));
  assert.throws(() => on.service.authorizeExecution(on.assistant, 'thread-1', 'input-1'), CollaborationError, 'a conversation grant is still required');
  on.actors.setGrant(on.session.id, encodeConversationRef(target), 'execution.delegate', true, on.human.actorId);
  on.service.authorizeExecution(on.assistant, 'thread-1', 'input-1');
  const origin = on.service.inputOrigin('thread-1', 'input-1')!;
  assert.equal(origin.authorActorId, on.session.id);
  assert.equal(origin.delegatorActorId, on.session.id);
  const delegation = on.service.delegation('thread-1', 'turn-unused', origin.delegationId!);
  assert.equal(delegation.context.actorId, on.session.id, 'children spawned under this authority belong to the assistant');
  on.actors.setEnabled(on.session.id, false, on.human.actorId);
  assert.throws(() => on.service.delegation('thread-1', 'turn-unused', origin.delegationId!), CollaborationError);
});

test('the installation preset comes from one environment variable and fails closed', async t => {
  const { actors, human, assistant } = await fixture(t);
  const actor = actors.get(assistant.actorId)!, person = actors.get(human.actorId)!;
  const decide = (value: string | undefined, capability: ActorCapability, resource?: string) =>
    actorPolicyFromEnvironment({ OPENCRAFT_ACTOR_POLICY: value })({ actor, capability, ...(resource ? { resource } : {}) });
  for (const value of [undefined, '', 'human', 'admin', 'assistant-member+everything']) {
    assert.equal(decide(value, 'channel.wake', 'g1'), false, String(value));
    assert.equal(actorPolicyFromEnvironment({ OPENCRAFT_ACTOR_POLICY: value })({ actor: person, capability: 'channel.wake' }), true);
  }
  assert.equal(decide('assistant-member', 'channel.wake', 'g1'), true);
  assert.equal(decide('assistant-member', 'execution.delegate'), false);
  assert.equal(decide(' assistant-member+delegation ', 'execution.delegate'), true);
  assert.equal(decide('assistant-member+delegation', 'automation.manage'), false);
});
