import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolatedTest } from '../scripts/ci/test-environment.mjs';

test('test child inherits source loader and isolated paths, not live credentials; cleanup runs on failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'test-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'result.json'), loader = join(root, 'source loader.mjs');
  writeFileSync(loader, 'globalThis.loadedByCiFixture = true;');
  const code = `const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({env:process.env,loaded:globalThis.loadedByCiFixture,mode:fs.statSync(process.env.TMPDIR).mode & 0o777}));process.exit(7);`;
  const result = await runIsolatedTest(process.execPath, ['-e', code, output], { root, loader, parent: {
    PATH: process.env.PATH, HOME: '/production/home', OPENCRAFT_DATA_DIR: '/production/data',
    OPENCRAFT_WORKSPACE_DIR: '/production/workspace', GITHUB_TOKEN: 'synthetic-secret',
    PLAYWRIGHT_BROWSERS_PATH: '/ci/verified-browser-cache',
    NODE_OPTIONS: '--require=/production/startup.js', SSH_AUTH_SOCK: '/production/agent',
  } });
  assert.equal(result, 7);
  const receipt = JSON.parse(readFileSync(output));
  assert.equal(receipt.loaded, true); assert.equal(receipt.mode, 0o700);
  assert.equal(receipt.env.PLAYWRIGHT_BROWSERS_PATH, '/ci/verified-browser-cache');
  assert.equal(receipt.env.GITHUB_TOKEN, undefined); assert.equal(receipt.env.SSH_AUTH_SOCK, undefined);
  assert.notEqual(receipt.env.OPENCRAFT_DATA_DIR, '/production/data');
  assert.equal(receipt.env.OPENCRAFT_DATA_DIR, join(receipt.env.TMPDIR, 'data'));
  assert.equal(receipt.env.HOME, join(receipt.env.TMPDIR, 'home'));
  assert.equal(existsSync(receipt.env.TMPDIR), false);
});

test('spawn failures reject instead of reporting a passing test', async t => {
  const root = mkdtempSync(join(tmpdir(), 'test-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(runIsolatedTest(join(root, 'missing-executable'), [], { root, loader: join(root, 'unused.mjs') }), /ENOENT/);
});
