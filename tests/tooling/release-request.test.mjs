import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRelease } from '../../scripts/release-request.mjs';
const input = { eventName: 'push', ref: 'refs/heads/main', event: {}, previousVersion: '0.1.12', currentVersion: '0.1.13', changelog: '# Changelog\n\n## v0.1.13\n\nChanges\n' };
test('main version bump requests exact automatic tag; unchanged version does nothing', () => {
  assert.deepEqual(selectRelease(input), { publish: true, tag: 'v0.1.13', createTag: true });
  assert.equal(selectRelease({ ...input, currentVersion: '0.1.12' }).publish, false);
});
test('downgrades, prereleases, missing notes, unknown events and foreign refs reject', () => {
  for (const override of [{ currentVersion: '0.1.11' }, { currentVersion: '0.2.0-rc.1' }, { changelog: '## v0.1.130\n' }, { ref: 'refs/tags/v0.1.13' }, { eventName: 'pull_request' }, { event: { deleted: true } }]) {
    assert.throws(() => selectRelease({ ...input, ...override }));
  }
});
test('manual retry keeps an existing exact tag and cannot create or substitute another ref', () => {
  assert.deepEqual(selectRelease({ ...input, eventName: 'workflow_dispatch', event: { inputs: { tag: 'v0.1.12' } } }), { publish: true, tag: 'v0.1.12', createTag: false });
  assert.throws(() => selectRelease({ ...input, eventName: 'workflow_dispatch', event: { inputs: { tag: 'main' } } }));
});
test('version comparison uses numeric components', () => {
  assert.equal(selectRelease({ ...input, currentVersion: '0.1.100', changelog: '# Changelog\n\n## v0.1.100\n\nChanges\n' }).publish, true);
  assert.throws(() => selectRelease({ ...input, previousVersion: '0.10.0', currentVersion: '0.2.0' }));
});
