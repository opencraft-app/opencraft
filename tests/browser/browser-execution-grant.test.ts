import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserGrantResolver } from '../../scripts/remote-browser/execution-grant.js';

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
