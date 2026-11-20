import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserGrantResolver } from '../../scripts/remote-browser/execution-grant.js';
import { NativeExecutionAuthority } from '../../scripts/native-execution-authority.js';

test('browser grants bind admitted human, canonical server and exact active native turn', async () => {
  const context = { actorId: 'human', generation: 1, credentialId: null, expiresAt: Date.now() + 60000 };
  let enabled = true, native = { id: 'turn', status: 'inProgress' }, authority = 'authority';
  const seen: unknown[] = [];
  const resolve = createBrowserGrantResolver({ serverForThread: () => 'server', hostForServer: () => 'host',
    async source(_thread, execution) {
      seen.push(execution);
      if (execution.inputId && execution.inputId !== 'input' || execution.turnId && execution.turnId !== 'turn') throw new Error('wrong source');
      return { context, authorityId: execution.turnId ? authority : 'authority', turnId: execution.turnId ?? null };
    }, authorize() { if (!enabled) throw new Error('revoked'); }, owner: context => context.actorId,
    async currentTurn() { return native; } });
  const session = { serverId: 'server', threadId: 'thread', execution: { inputId: 'input' } };
  assert.equal((await resolve(session, false)).turnId, null, 'declarations may precede native turn creation');
  const grant = await resolve(session, true); assert.equal(grant.turnId, 'turn'); assert.equal(grant.ownerId, 'human');
  assert.deepEqual(seen.at(-1), { inputId: 'input', turnId: 'turn' });
  await assert.rejects(resolve({ ...session, serverId: 'other' }, true));
  await assert.rejects(resolve({ ...session, execution: { inputId: 'other', turnId: 'turn' } }, true));
  await assert.rejects(resolve({ ...session, execution: { turnId: 'old' } }, true));
  authority = 'replacement'; await assert.rejects(resolve(session, true), /changed/); authority = 'authority';
  native = { id: 'turn', status: 'completed' }; await assert.rejects(resolve(session, true), /active/);
  enabled = false; assert.throws(grant.authorize, /revoked/);
});

test('remote native grant resolves its physical Host source without borrowing an identical local turn', async () => {
  let enabled = true;
  const context = {actorId:'remote-human',generation:1,credentialId:null,expiresAt:Date.now()+60000};
  const authorize = () => { if (!enabled) throw Error('revoked'); };
  const remote = new NativeExecutionAuthority(authorize);
  remote.admit(context, 'same-thread', 'input'); remote.started('same-thread', 'input', 'same-turn');
  const sources = new Map([['remote-server', {hostId:'ssh:one', authority:remote}],
    ['other-remote', {hostId:'ssh:two', authority:new NativeExecutionAuthority(authorize)}]]);
  let localReads = 0;
  const resolve = createBrowserGrantResolver({
    serverForThread: (_thread, requested) => sources.has(requested!) ? requested! : 'local-server',
    hostForServer: server => sources.get(server)!.hostId,
    async source(thread, execution, server) {
      const entry = sources.get(server);
      if (!entry) { localReads++; throw Error('must not read local authority'); }
      return entry.authority.source(thread, execution);
    }, authorize, owner: context => context.actorId,
    async currentTurn(hostId, threadId) { assert.equal(hostId, 'ssh:one'); assert.equal(threadId, 'same-thread'); return {id:'same-turn',status:'inProgress'}; },
  });
  const session = {serverId:'remote-server',threadId:'same-thread',execution:{turnId:'same-turn',callId:'call'}};
  const grant = await resolve(session, true);
  assert.equal(grant.hostId, 'ssh:one'); assert.equal(grant.ownerId, 'remote-human');
  await assert.rejects(resolve({...session,serverId:'other-remote'}, true));
  await assert.rejects(resolve({...session,serverId:'unregistered'}, true));
  assert.equal(localReads, 0);
  enabled = false; assert.throws(grant.authorize, /revoked/u);
  await assert.rejects(resolve(session, true), /revoked/u);
});
