import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectNpmFiles } from '../../scripts/full-release/npm-archive.mjs';

test('incremental directory selection remains equal to a fresh npm scan across payload and policy changes', async t => {
  const base = await mkdtemp(join(tmpdir(), 'npm-selection-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'package'), cacheDirectory = join(base, 'cache');
  const manifest = { name: 'selection-fixture', version: '1.0.0', files: ['web', 'runtime'],
    main: 'outside/main.js', bin: { fixture: 'outside/bin.js' }, dependencies: { dep: '1.0.0' }, bundleDependencies: ['dep'] };
  async function put(path, content) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  async function updateManifest() { await put('package.json', JSON.stringify(manifest)); }
  await updateManifest();
  for (const path of ['web/a.js', 'runtime/a.js', 'runtime/ignored.js', 'outside/main.js', 'outside/bin.js', 'LICENSE', 'node_modules/dep/index.js', 'node_modules/dep/hidden.js']) await put(path, path);
  await put('runtime/.npmignore', 'ignored.js\n');
  await put('node_modules/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.0', files: ['index.js'] }));
  async function compare() {
    const fresh = await selectNpmFiles(root, { cacheDirectory: null });
    const cached = await selectNpmFiles(root, { cacheDirectory });
    assert.deepEqual(cached.names, fresh.names);
    return cached.names;
  }
  await compare(); // Populate.
  await compare(); // Reuse, including bundles and mandatory paths outside files.
  await put('ignored/package.json', '{invalid policy fixture'); await compare();
  await rm(join(root, 'ignored'), { recursive: true });
  manifest.version = '1.0.1'; manifest.opencraftWeb = { buildId: 'new-build' }; await updateManifest(); await compare();
  await put('runtime/a.js', 'changed contents and size'); await compare();
  await rm(join(root, 'web/a.js')); await put('web/b.js', 'new hashed asset'); await compare();
  await put('runtime/added.js', 'new file'); await compare();
  await put('runtime/.npmignore', 'a.js\n'); await compare();
  await put('node_modules/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.0', files: ['hidden.js'] })); await compare();
  manifest.files = ['runtime']; await updateManifest(); await compare();
  await put('.npmignore', 'runtime\n'); await compare(); // files still wins.
  delete manifest.files; await updateManifest(); await compare();
  await put('.npmignore', 'web\n'); await compare();
  await rm(join(root, 'runtime/added.js')); await mkdir(join(root, 'runtime/added.js')); await put('runtime/added.js/nested', 'file became directory'); await compare();
  await symlink('a.js', join(root, 'runtime/link')); await compare();
  await put('runtime/policy-source', 'a.js\n');
  await rm(join(root, 'runtime/.npmignore'));
  await symlink('policy-source', join(root, 'runtime/.npmignore')); await compare();
  await put('runtime/policy-source', 'added.js\n'); await compare();
  await rm(join(root, 'runtime/.npmignore')); await put('runtime/.npmignore', 'a.js\n');
  await symlink('../web', join(root, 'runtime/cross-directory')); await compare();
  await put('web/another.js', 'changed linked topology'); await compare();
  await rm(join(root, 'runtime/cross-directory'));
  await symlink(base, join(root, 'external')); await compare(); // External targets disable reuse.
  await rm(join(root, 'external'));
  await writeFile(join(cacheDirectory, 'npm-selection-v1.json'), '{invalid'); await compare();
  await writeFile(join(cacheDirectory, 'npm-selection-v1.json'), JSON.stringify({ entries: [null] })); await compare();
  const record = JSON.parse(await readFile(join(cacheDirectory, 'npm-selection-v1.json')));
  record.entries[0][2].push('runtime/nonexistent'); // Damaged cache digest is rejected.
  await writeFile(join(cacheDirectory, 'npm-selection-v1.json'), JSON.stringify(record)); await compare();
});
