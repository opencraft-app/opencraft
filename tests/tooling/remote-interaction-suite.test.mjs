import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
test('remote interaction gate names existing files and includes client plus page-state recovery', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const prefix = 'node --import tsx --test ';
  const suites = manifest.scripts['test:remote-interaction'].split(' && ').filter(value => value.startsWith(prefix));
  assert.equal(suites.length, 1, 'one explicit remote interaction suite must run');
  const paths = suites[0].slice(prefix.length).trim().split(/\s+/u);
  assert.equal(new Set(paths).size, paths.length, 'do not execute a suite twice');
  for (const path of paths) {
    assert.match(path, /^tests\/browser\/[A-Za-z0-9._-]+\.test\.(?:mjs|ts)$/u);
    assert.equal(await stat(new URL(path, root)).then(value => value.isFile(), () => false), true,
      `remote interaction gate references a missing test: ${path}`);
  }
  for (const required of ['tests/browser/remote-browser-reconnect-client.test.ts', 'tests/browser/remote-browser-recovery-state.test.ts'])
    assert.ok(paths.includes(required), `recovery regression is not gated: ${required}`);
});
