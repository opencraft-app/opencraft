import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBrowserMetadata as merge, retireBrowserMetadata as retire } from '@opencraft/browser-core/metadata-merge';
const encode = JSON.stringify;
test('record merge preserves remote additions and independent local edits or deletions', () => {
  const base = [{ id: 'one', title: 'original' }, { id: 'two' }];
  const remote = [base[0], { id: 'two', remote: true }, { id: 'new' }];
  assert.deepEqual(JSON.parse(merge('pages', encode(base), encode([{ id: 'one', title: 'draft' }, base[1]]), encode(remote))!),
    [{ id: 'one', title: 'draft' }, { id: 'two', remote: true }, { id: 'new' }]);
  assert.deepEqual(JSON.parse(merge('tabs', encode(base), encode([base[1]]), encode(remote))!), [remote[1], remote[2]]);
  assert.deepEqual(JSON.parse(merge('storage', '{"one":"a"}', '{}', '{"one":"a","new":"b"}')!), { new: 'b' });
  assert.deepEqual(JSON.parse(merge('bindings', '[]', '[{"scopeId":"a"}]', '[{"scopeId":"b"}]')!), [{ scopeId: 'b' }, { scopeId: 'a' }]);
});

test('authoritative retirement removes only its identities from stale or pending metadata', () => {
  const retired = [{ lease: 'browser-closed', pageIds: ['closed'], tabIds: ['closed-tab'] }];
  assert.equal(retire('pages', '[{"id":"closed","draft":true},{"id":"kept"}]', retired), '[{"id":"kept"}]');
  assert.equal(retire('tabs', '[{"id":"closed-tab"},{"id":"alias","pageId":"closed"},{"id":"kept"}]', retired), '[{"id":"kept"}]');
  assert.equal(retire('storage', '{"closed":"browser-closed","alias":"browser:closed","kept":"browser-other"}', retired), '{"kept":"browser-other"}');
  assert.equal(retire('bindings', '[{"scopeId":"retained-conversation"}]', retired), '[{"scopeId":"retained-conversation"}]');
});
test('same-record conflicts, remote deletion and malformed identity never overwrite current state', () => {
  for (const remote of ['[{"id":"one","value":2}]', '[]', '[{"id":"one"},{"id":"one"}]'])
    assert.throws(() => merge('pages', '[{"id":"one","value":0}]', '[{"id":"one","value":1}]', remote), { code: 'STATE_CONFLICT' });
  assert.equal(merge('pages', null, '[{"id":"local"}]', '[{"id":"remote"}]'), '[{"id":"remote"},{"id":"local"}]');
  assert.equal(merge('storage', '{}', '{"__proto__":"lease"}', '{"other":"lease"}'), '{"other":"lease","__proto__":"lease"}');
});

test('retirement filtering uses indexed membership without enumerating historical facts', async () => {
  const { browserMetadataReferences, retireBrowserMetadata } = await import('@opencraft/browser-core/metadata-merge');
  const visited: string[] = [];
  const lookup = { pages: { has(id: string) { visited.push(id); return id === 'closed'; } }, tabs: new Set<string>(), leases: new Set<string>() };
  const value = JSON.stringify([{ id: 'closed' }, { id: 'live' }]);
  assert.deepEqual(JSON.parse(retireBrowserMetadata('pages', value, lookup)!), [{ id: 'live' }]);
  assert.deepEqual(visited, ['closed', 'live']);
  assert.deepEqual(browserMetadataReferences('tabs', JSON.stringify([{ id: 'tab', pageId: 'page' }])), { pages: ['page'], tabs: ['tab'], leases: [] });
});
