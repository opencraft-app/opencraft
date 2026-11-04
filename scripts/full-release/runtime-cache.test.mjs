import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedRuntime, runtimeCacheKey } from './runtime-cache.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'source');
  for (const path of ['runtime/codex/package.json', 'runtime/codex/package-lock.json',
    'scripts/full-release/runtime-cache.mjs', 'scripts/full-release/package-runtime.mjs', 'scripts/full-release/closure.mjs',
    'scripts/prepare-dsh-runtime.mjs', 'scripts/patch-dsh-thread-environment.mjs',
    'scripts/patch-dsh-provider-lifecycle.mjs', 'scripts/patch-dsh-owner-admission.mjs']) {
    await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), path);
  }
  let builds = 0;
  const logs = [];
  const options = { repositoryRoot: repo, name: 'codex', cacheRoot: join(root, 'cache'), log: line => logs.push(line),
    build: async destination => { builds++; await mkdir(destination, { recursive: true });
      await mkdir(join(destination, 'node_modules/@openai/codex'), { recursive: true });
      await writeFile(join(destination, 'node_modules/@openai/codex/package.json'), JSON.stringify({ version: '1.2.3' }));
      await writeFile(join(destination, 'cli'), 'locked payload'); await chmod(join(destination, 'cli'), 0o755);
      return { '@openai/codex': '1.2.3' }; } };
  let run = 0;
  return { root, repo, logs, builds: () => builds, options,
    build: () => cachedRuntime({ ...options, destination: join(root, `out-${run++}`) }) };
}
test('warm payload is identical, independently copied, and skips installation', async t => {
  const f = await fixture(t); await f.build(); await f.build(); assert.equal(f.builds(), 1);
  assert.match(f.logs.at(-1), /hit/);
  await writeFile(join(f.root, 'out-1/cli'), 'staging changed');
  await f.build(); assert.equal(f.builds(), 1);
  assert.equal(await readFile(join(f.root, 'out-2/cli'), 'utf8'), 'locked payload');
});
test('lockfile and transformation changes invalidate the key', async t => {
  const f = await fixture(t); await f.build();
  for (const path of ['runtime/codex/package-lock.json', 'scripts/patch-dsh-owner-admission.mjs']) {
    const before = await runtimeCacheKey(f.repo, 'codex'); await writeFile(join(f.repo, path), 'changed');
    assert.notEqual(await runtimeCacheKey(f.repo, 'codex'), before); await f.build();
  }
  assert.equal(f.builds(), 3);
});
test('corrupt, missing, extra files and changed modes rebuild rather than package stale data', async t => {
  const f = await fixture(t); await f.build();
  const entry = join(f.root, 'cache/codex', await runtimeCacheKey(f.repo, 'codex'), 'payload');
  await writeFile(join(entry, 'cli'), 'corrupt'); await f.build();
  await rm(join(entry, 'cli')); await f.build();
  await writeFile(join(entry, 'unexpected'), 'extra'); await f.build();
  await chmod(join(entry, 'cli'), 0o644); await f.build();
  assert.equal(f.builds(), 5); assert.deepEqual((await readdir(entry)).sort(), ['cli', 'node_modules']);
});
test('failed builds never publish; unusable cache falls back to fresh payload', async t => {
  const f = await fixture(t);
  await assert.rejects(cachedRuntime({ ...f.options, destination: join(f.root, 'failed'), build: async () => { throw new Error('install failed'); } }), /install failed/);
  await f.build(); assert.equal(f.builds(), 1); assert.match(f.logs.at(-1), /miss/);
  const blocked = join(f.root, 'blocked'); await writeFile(blocked, 'not a directory');
  await cachedRuntime({ ...f.options, cacheRoot: blocked, destination: join(f.root, 'fresh') });
  assert.equal(await readFile(join(f.root, 'fresh/cli'), 'utf8'), 'locked payload');
});

test('reusing a staging destination clears prior release files without rebuilding a valid cache', async t => {
  const f = await fixture(t), destination = join(f.root, 'reused');
  await cachedRuntime({ ...f.options, destination });
  await writeFile(join(destination, 'old-release-data'), 'stale');
  await cachedRuntime({ ...f.options, destination });
  assert.equal(f.builds(), 1);
  assert.deepEqual((await readdir(destination)).sort(), ['cli', 'node_modules']);
});
