import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { metadataLeaves, metadataRoot, mergeMetadataValue, sha256 } from '@opencraft/browser-core/metadata-sync';

test('the portable fingerprint matches Node SHA-256 for every UTF-8 width', () => {
  for (const text of ['', 'abc', 'x'.repeat(4096), '中文🙂'.repeat(120)]) {
    assert.equal(sha256(text), createHash('sha256').update(text, 'utf8').digest('hex'));
  }
});

test('a field leaf covers both content and revision, so equal content still diverges', () => {
  const one = metadataRoot(metadataLeaves({ tabs: '[]' }, { tabs: 1 }));
  const two = metadataRoot(metadataLeaves({ tabs: '[]' }, { tabs: 2 }));
  const other = metadataRoot(metadataLeaves({ tabs: '[1]' }, { tabs: 1 }));
  assert.notEqual(one, two);
  assert.notEqual(one, other);
  assert.equal(one, metadataRoot(metadataLeaves({ tabs: '[]' }, { tabs: 1 })));
});

test('concurrent local edits survive and concurrent removals win', () => {
  const base = JSON.stringify([{ id: 'kept' }, { id: 'closed' }, { id: 'edited' }]);
  const local = JSON.stringify([{ id: 'kept' }, { id: 'closed' }, { id: 'edited', viewportMode: 'mobile' }]);
  const remote = JSON.stringify([{ id: 'kept' }, { id: 'edited' }, { id: 'added' }]);
  const merged = JSON.parse(mergeMetadataValue('tabs', base, local, remote)!);
  assert.deepEqual(merged.map((row: any) => row.id).sort(), ['added', 'edited', 'kept']);
  assert.equal(merged.find((row: any) => row.id === 'edited').viewportMode, 'mobile');
});

test('unparseable values never lose the local edit', () => {
  assert.equal(mergeMetadataValue('tabs', '[]', 'not json', '[]'), 'not json');
  // Unchanged locally: the remote value wins even across a shape change.
  assert.equal(mergeMetadataValue('tabs', '[]', '[]', '{"different":true}'), '{"different":true}');
  // Both sides changed shape: the local value is kept rather than dropped.
  assert.equal(mergeMetadataValue('tabs', '[]', '[1]', '{"different":true}'), '[1]');
  assert.equal(mergeMetadataValue('storage', '{}', '{"a":"browser-1"}', undefined), '{"a":"browser-1"}');
});
