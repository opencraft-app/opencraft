import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sourceIdentity, verifySnapshot } from '../scripts/ci/source-identity.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fork-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Delivery Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), '.local/\nnode_modules/\napps/workbench-web/dist/\nproducts/join/dist/\n');
  git('add', '.'); git('commit', '-qm', 'upstream');
  const upstreamBaseline = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'business'), 'original business bytes\n');
  git('add', '.'); git('commit', '-qm', 'materialized business');
  const materializedRevision = git('rev-parse', 'HEAD');
  const originalSourceTree = git('rev-parse', 'HEAD^{tree}');
  mkdirSync(join(root, '.ci'));
  const provenance = { schemaVersion: 1, status: 'isolated-private-fork-candidate',
    originalRevision: 'a'.repeat(40), originalConsumerTree: 'b'.repeat(40),
    upstreamBaseline, materializedRevision, originalSourceTree };
  writeFileSync(join(root, '.ci/fork-provenance.json'), JSON.stringify(provenance));
  mkdirSync(join(root, 'scripts/ci'), { recursive: true });
  for (const file of ['source-identity.mjs', 'build.sh', 'build-image.sh']) cpSync(new URL(`../scripts/ci/${file}`, import.meta.url), join(root, 'scripts/ci', file));
  git('add', '.'); git('commit', '-qm', 'delivery tools');
  return { root, git, provenance, commit() { git('add', '.'); git('commit', '-qm', 'fixture change'); } };
}
test('receipt separates original, materialized, upstream and actual build identities', t => {
  const f = fixture(t), identity = sourceIdentity(f.root);
  assert.equal(identity.sourceRevision, f.git('rev-parse', 'HEAD'));
  assert.equal(identity.sourceTree, f.git('rev-parse', 'HEAD^{tree}'));
  assert.equal(identity.provenance.originalRevision, 'a'.repeat(40));
  assert.notEqual(identity.sourceRevision, identity.provenance.originalRevision);
  assert.notEqual(identity.sourceTree, identity.provenance.originalSourceTree);
  assert.equal(identity.buildId, `git-${identity.sourceRevision}-join-ci`);
  assert.deepEqual(verifySnapshot(identity, f.root), identity);
});
test('tracked edits, untracked source and changed commits fail closed', t => {
  const f = fixture(t), identity = sourceIdentity(f.root);
  writeFileSync(join(f.root, 'business'), 'changed');
  assert.throws(() => sourceIdentity(f.root), /clean committed fork/);
  f.git('restore', 'business');
  writeFileSync(join(f.root, 'untracked'), 'new input');
  assert.throws(() => sourceIdentity(f.root), /clean committed fork/);
  f.commit();
  assert.throws(() => verifySnapshot(identity, f.root), /Source changed during build/);
});
test('wrong historical tree or upstream baseline cannot mint receipts', t => {
  const f = fixture(t);
  for (const key of ['originalSourceTree', 'upstreamBaseline']) {
    writeFileSync(join(f.root, '.ci/fork-provenance.json'), JSON.stringify({ ...f.provenance, [key]: 'c'.repeat(40) }));
    f.commit();
    assert.throws(() => sourceIdentity(f.root), /mismatch/);
  }
});
test('gitlinks cannot reintroduce a submodule source authority', t => {
  const f = fixture(t);
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.provenance.upstreamBaseline},core`);
  f.git('commit', '-qm', 'forbidden gitlink');
  mkdirSync(join(f.root, 'core'));
  assert.throws(() => sourceIdentity(f.root), /gitlinks/);
});
test('actual build entry consumes root and writes separate immutable source receipts', t => {
  const f = fixture(t);
  const bin = join(f.root, '.local/bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.slice(2).join(' ') === 'run join:build:web') {
  fs.mkdirSync('apps/workbench-web/dist', { recursive: true });
  fs.writeFileSync('apps/workbench-web/dist/version.json', JSON.stringify({ sourceRevision: process.env.OPENCRAFT_SOURCE_REVISION, buildId: process.env.OPENCRAFT_BUILD_ID }));
} else if (process.argv.slice(2).join(' ') === 'run join:build:gateway') {
  fs.mkdirSync('products/join/dist/runtime', { recursive: true });
  fs.writeFileSync('products/join/dist/runtime/container-gateway.mjs', 'export const fixture = true;');
  if (process.env.FIXTURE_DIRTY) fs.writeFileSync('business', 'unexpected build edit');
} else process.exit(97);
`, { mode: 0o755 });
  const run = (extra = {}) => spawnSync('bash', ['scripts/ci/build.sh'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra } });
  for (let i = 0; i < 2; i++) {
    const result = run(); assert.equal(result.status, 0, result.stderr);
  }
  const receipts = readdirSync(join(f.root, '.local/ci')).filter(name => name.startsWith('build.'));
  assert.equal(receipts.length, 2);
  for (const dir of receipts) {
    const receipt = JSON.parse(readFileSync(join(f.root, '.local/ci', dir, 'build.json')));
    assert.equal(receipt.sourceRevision, f.git('rev-parse', 'HEAD'));
    assert.equal(receipt.provenance.originalRevision, f.provenance.originalRevision);
    assert.equal(receipt.web, join(f.root, 'apps/workbench-web/dist'));
  }
  const dirty = run({ FIXTURE_DIRTY: '1' });
  assert.notEqual(dirty.status, 0); assert.match(dirty.stderr, /clean committed fork/);
  const completed = readdirSync(join(f.root, '.local/ci')).filter(dir => {
    try { readFileSync(join(f.root, '.local/ci', dir, 'build.json')); return true; } catch { return false; }
  });
  assert.equal(completed.length, 2, 'failed build must not publish a completed receipt');
});
test('actual control image entry keeps runtime checks and fork receipt without invoking Docker', t => {
  const f = fixture(t), bin = join(f.root, '.local/bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), String.raw`#!/usr/bin/env node
const fs = require('node:fs'), assert = require('node:assert/strict');
const args = process.argv.slice(2);
fs.appendFileSync('.local/docker-calls.jsonl', JSON.stringify(args) + '\n');
if (args[0] === 'buildx') {
  assert.equal(process.env.JOIN_SOURCE, process.cwd());
  assert.deepEqual(args.slice(-3), ['gateway', 'brain', 'proxy']);
} else if (args[0] === 'image') {
  const role = args.at(-1).split(':')[1].split('-')[0];
  if (args[3] === '{{.Id}}') console.log('sha256:' + 'a'.repeat(64));
  else console.log('linux/amd64 ' + process.env.JOIN_REVISION + ' join ' + role + ' /opt/opencraft/bin/node /opt/opencraft/runtime/container-service.mjs ' + role);
} else if (args[0] === 'run') {
  if (process.env.FIXTURE_PYTHON_FAIL && args.includes('/usr/bin/python3')) process.exit(9);
  if (args.includes('-i')) fs.readFileSync(0);
} else process.exit(97);
` , { mode: 0o755 });
  const run = (extra = {}) => spawnSync('bash', ['scripts/ci/build-image.sh', 'control'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra } });
  const success = run(); assert.equal(success.status, 0, success.stderr);
  const directory = readdirSync(join(f.root, '.local/ci')).find(name => name.startsWith('image.'));
  const receipt = JSON.parse(readFileSync(join(f.root, '.local/ci', directory, 'source.json')));
  assert.deepEqual(receipt, sourceIdentity(f.root));
  for (const role of ['gateway', 'brain', 'proxy']) assert.equal(readFileSync(join(f.root, '.local/ci', directory, role + '.iid'), 'utf8').trim(), 'sha256:' + 'a'.repeat(64));
  const calls = readFileSync(join(f.root, '.local/docker-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args.includes('/usr/bin/python3')).length, 3);
  assert(calls.filter(args => args[0] === 'run').every(args => args.includes('--network') && args.includes('none')));
  assert(calls.some(args => args.includes('-i')), 'product manifest/version verification retained');
  const failure = run({ FIXTURE_PYTHON_FAIL: '1' }); assert.notEqual(failure.status, 0);
  assert.equal(readdirSync(join(f.root, '.local/ci')).filter(name => name.startsWith('image.')).length, 1);
});
test('CI and native entrypoints parse as Bash without running external operations', () => {
  for (const directory of ['.ci', 'scripts/ci', 'scripts/ci/csighub-auto-upload']) {
    for (const name of readdirSync(new URL(`../${directory}/`, import.meta.url))) {
      if (!name.endsWith('.sh') && !['resolve-oa-images', 'publish-oa-image'].includes(name)) continue;
      execFileSync('bash', ['-n', new URL(`../${directory}/${name}`, import.meta.url).pathname]);
    }
  }
});
