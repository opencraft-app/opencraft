import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolatedTest, loadSuites, suites as defaultSuites } from '../scripts/ci/test-environment.mjs';

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

function routeSuites(root, suites, extra = []) {
  const npm = join(root, 'npm');
  writeFileSync(npm, `#!${process.execPath}
console.log('ROUTE:' + JSON.stringify({ args: process.argv.slice(2), secret: process.env.GITHUB_TOKEN, home: process.env.HOME, data: process.env.OPENCRAFT_DATA_DIR }));
`);
  chmodSync(npm, 0o700);
  for (const [suite, args] of Object.entries(suites)) {
    const child = spawnSync(process.execPath, [new URL('../scripts/ci/test-environment.mjs', import.meta.url).pathname, ...extra, suite], {
      encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', PATH: root + ':' + process.env.PATH, GITHUB_TOKEN: 'synthetic-routing-secret' },
    });
    assert.equal(child.status, 0, `${suite}: ${child.stderr}`);
    const receipt = JSON.parse(child.stdout.split('\n').find(line => line.startsWith('ROUTE:')).slice(6));
    assert.deepEqual(receipt.args, args, suite);
    assert.equal(receipt.secret, undefined, suite);
    assert.notEqual(receipt.home, process.env.HOME, suite);
    assert.equal(existsSync(receipt.home), false, suite);
    assert.equal(existsSync(receipt.data), false, suite);
  }
}

test('CLI routes the default suites through the isolated runner', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'test-ci-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(defaultSuites, {
    'core-anthropic': ['run', 'test:codex-anthropic'], core: ['run', 'test:codex-core'],
    assistant: ['run', 'test:assistant-runtime'], gate: ['run', 'gate'],
  });
  routeSuites(root, defaultSuites);
  const unknown = spawnSync(process.execPath, [new URL('../scripts/ci/test-environment.mjs', import.meta.url).pathname, 'example'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Select core-anthropic, core, assistant or gate/);
});

test('a suite configuration file adds suites without redefining the defaults', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'test-ci-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'suites.json');
  const extra = { example: ['run', 'example:test'], 'example-api': ['run', 'test', '--workspace', '@example/api'] };
  writeFileSync(config, JSON.stringify(extra));
  assert.deepEqual(loadSuites(config), { ...defaultSuites, ...extra });
  routeSuites(root, { ...defaultSuites, ...extra }, ['--suites', config]);
  const unknown = spawnSync(process.execPath, [new URL('../scripts/ci/test-environment.mjs', import.meta.url).pathname, '--suites', config, 'missing'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Select core-anthropic, core, assistant, gate, example or example-api/);
  for (const value of [[], { core: ['run', 'other'] }, { 'Bad Name': ['run', 'x'] }, { example: [] }, { example: 'run example' }, { example: ['run', ''] }]) {
    writeFileSync(config, JSON.stringify(value));
    assert.throws(() => loadSuites(config), /[Ss]uite/);
  }
});
