import assert from 'node:assert/strict';
import test from 'node:test';
import { MembershipStore } from '@opencraft/access-control';
import { resolveMigrationContract } from '@opencraft/sqlite-node';
import { createHash } from 'node:crypto';

test('employee credential fence survives re-enabling the same membership', () => {
  const store = new MembershipStore(':memory:');
  const actor = 'human://fixture/alice', principal = { provider: 'tencentoa', subject: '123' };
  try {
    store.setActor(actor, 'member', true, 'fixture');
    assert.equal(store.revocationRevision(actor, [principal]), 0);
    store.setActor(actor, 'member', false, 'fixture');
    const revoked = store.revocationRevision(actor, [principal]);
    assert.ok(revoked > 0);
    store.setActor(actor, 'member', true, 'fixture');
    assert.equal(store.revocationRevision(actor, [principal]), revoked);
    store.set(principal, 'member', false, 'fixture');
    assert.ok(store.revocationRevision(actor, [principal]) > revoked);
  } finally { store.close(); }
});

test('product migration contract rejects a changed published SQL prefix', () => {
  const old = [{ version: 1, name: 'published', sql: 'CREATE TABLE t(n);' }];
  const next = { baseline: old.map(({ version, name, sql }) => ({ version, name, checksum: createHash('sha256').update(sql).digest('hex') })), migrations: [{ version: 2, name: 'next', sql: 'ALTER TABLE t ADD m;' }] };
  assert.deepEqual(resolveMigrationContract('fixture', old, next), [...old, ...next.migrations]);
  assert.throws(() => resolveMigrationContract('fixture', [{ ...old[0], sql: 'CREATE TABLE t(secret);' }], next), /Published migration prefix/);
});
