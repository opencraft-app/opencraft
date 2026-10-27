import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SSH_CONNECTION_MIGRATIONS } from '../../apps/opencraft-daemon/src/ssh-connection-store.js';
import { acceptsPublishedSshHistory, legacySshHistoryExpression, prepareJoinLegacyFallback } from '../../scripts/recovery/prepare-join-legacy-fallback.js';
const identities = SSH_CONNECTION_MIGRATIONS.map(({ version, name, sql }) => ({ version, name, checksum: createHash('sha256').update(sql).digest('hex') }));
test('legacy recovery accepts only the published v1/v2 identities, never unknown history', () => {
  assert.equal(acceptsPublishedSshHistory(identities.slice(0, 1), identities), true);
  assert.equal(acceptsPublishedSshHistory(identities, identities), true);
  for (const rows of [[], null, [identities[1]], [...identities, { version: 3, name: 'future', checksum: 'unknown' }],
    [identities[0], { ...identities[1], checksum: 'changed' }], [{ ...identities[0], checksum: 'changed' }],
    [identities[0], { ...identities[1], name: 'other' }]]) assert.equal(acceptsPublishedSshHistory(rows, identities), false);
});
test('generated predicate reads real legacy ledger rows without altering records or history', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,checksum TEXT);CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT)');
    db.prepare('INSERT INTO records VALUES(?,?)').run('stable-id', 'synthetic-value');
    const put = db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)');
    const accepts = new Function('history', `return ${legacySshHistoryExpression()}`);
    put.run(identities[0]!.version, identities[0]!.name, identities[0]!.checksum);
    const records = () => JSON.stringify(db.prepare('SELECT * FROM records ORDER BY id').all());
    const before = records();
    assert.equal(accepts(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()), true);
    put.run(identities[1]!.version, identities[1]!.name, identities[1]!.checksum);
    const ledger = JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all());
    assert.equal(accepts(JSON.parse(ledger)), true); assert.equal(records(), before);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()), ledger);
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=2').run('changed');
    assert.equal(accepts(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()), false);
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=2').run(identities[1]!.checksum);
    put.run(3, 'future', 'unknown');assert.equal(accepts(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()), false);
    assert.equal(records(), before);
  } finally { db.close(); }
});
test('wrong bundle bytes are refused before generating any output', () => {
  assert.throws(() => prepareJoinLegacyFallback(Buffer.from('unreviewed source')), /Unknown legacy entry source bytes/);
});
