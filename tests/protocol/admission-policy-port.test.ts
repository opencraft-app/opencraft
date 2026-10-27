import test from 'node:test';
import assert from 'node:assert/strict';
import { InstanceAccess, MembershipStore, type InstanceAdmissionPolicy } from '../../packages/access-control/src/index';
import { ActorStore } from '../../packages/access-control/src/actors';
import { parsePrincipal } from '../../packages/identity-core/src/index';

test('the policy port fences live and durable human access without changing membership', async () => {
  const membership = new MembershipStore(':memory:'), actors = new ActorStore(':memory:');
  const principal = parsePrincipal({ provider: 'fixture', subject: 'one', displayName: 'One', expiresAt: Date.now() + 60_000 });
  const request = { headers: {} }; let allowed = false;
  const policy: InstanceAdmissionPolicy = { prepare: async p => { assert.equal(p, principal); allowed = true; }, allows: () => allowed, allowsBinding: () => allowed };
  const access = new InstanceAccess(membership, [{ authenticate: () => principal }], actors, ['fixture'], policy);
  try {
    assert.equal(access.admissionStatus(request), 403);
    await access.prepare(request); assert.equal(access.admissionStatus(request), 204);
    const actor = actors.findHuman(principal)!;
    assert.equal(access.admitsActor(actor.id), true); assert.deepEqual(membership.list(), []);
    allowed = false;
    assert.equal(access.role(principal), null); assert.equal(access.admitsActor(actor.id), false);
    membership.set(principal, 'admin', true, 'fixture');
    assert.equal(access.role(principal), null, 'explicit grants cannot bypass a restricting policy');
    allowed = true; assert.equal(access.role(principal), 'admin');
    membership.set(principal, 'member', false, 'fixture');
    assert.equal(access.role(principal), null, 'policy cannot override revocation');
  } finally { actors.close(); membership.close(); }
});
