import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { installationManifests } from './installation-manifests.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'oc-fingerprint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function json(path, value) { await mkdir(dirname(join(root,path)),{recursive:true}); await writeFile(join(root,path), JSON.stringify(value)); }
  return { root, json };
}
test('standalone installation fingerprints both real manifests and rejects dependency changes as identical', async t => {
  const f=await fixture(t);await f.json('package.json',{name:'test-assistant'});await f.json('package-lock.json',{lockfileVersion:3,packages:{'':{name:'test-assistant'}}});
  const before=await installationManifests(f.root);assert.deepEqual(before.map(x=>x.file),['package.json','package-lock.json']);assert.ok(before.every(x=>x.kind==='dependency'&&x.sha256.length===64));
  await f.json('package-lock.json',{lockfileVersion:3,packages:{'':{name:'test-assistant',version:'changed'}}});assert.notEqual((await installationManifests(f.root))[1].sha256,before[1].sha256);
});
test('actual workspace lock wins over stale local lock, with bounded archive paths and exact bytes', async t => {
  const f=await fixture(t);await f.json('package.json',{name:'installation',workspaces:['apps/*']});await f.json('package-lock.json',{lockfileVersion:3,packages:{'':{name:'installation'},'apps/assistant':{name:'test-assistant'}}});
  await f.json('apps/assistant/package.json',{name:'test-assistant'});await f.json('apps/assistant/package-lock.json',{lockfileVersion:3,packages:{'':{name:'test-assistant',version:'stale'}}});
  const root=join(f.root,'apps/assistant'), entries=await installationManifests(root);assert.deepEqual(entries.map(x=>x.file),['package.json','installation/package.json','installation/package-lock.json']);assert.equal(entries.at(-1).sourceFile,'../../package-lock.json');
  const output=join(f.root,'evidence');for(const entry of entries){assert.ok(!entry.file.split('/').includes('..'));const target=join(output,entry.file);await mkdir(dirname(target),{recursive:true});await copyFile(join(root,entry.sourceFile),target);assert.deepEqual(await readFile(target),await readFile(join(root,entry.sourceFile)));assert.ok(!relative(output,target).startsWith('..'));}
});
test('missing or foreign lockfile cannot create a source identity without dependencies', async t => {
  const f=await fixture(t);await f.json('apps/assistant/package.json',{name:'test-assistant'});await f.json('package.json',{name:'installation',workspaces:['apps/*']});
  await assert.rejects(installationManifests(join(f.root,'apps/assistant')),/No installation/);
  await f.json('package-lock.json',{packages:{'apps/assistant':{name:'someone-else'}}});await assert.rejects(installationManifests(join(f.root,'apps/assistant')),/No installation/);
});
test('malformed installation metadata fails rather than silently changing the fingerprint source', async t => {
  const f=await fixture(t);await f.json('package.json',{name:'test-assistant'});await writeFile(join(f.root,'package-lock.json'),'{bad');await assert.rejects(installationManifests(f.root),SyntaxError);
});


test('actual evaluator fingerprints include frozen SQL and dependency changes in recovery identity', async t => {
  const { sourceFingerprint, validateRecovery } = await import('./benchmark.mjs');
  const { fingerprint } = await import('./memory-system.mjs');
  const f=await fixture(t);await f.json('package.json',{name:'test-assistant'});await f.json('package-lock.json',{lockfileVersion:3,packages:{'':{name:'test-assistant'}}});
  await mkdir(join(f.root,'src'));await mkdir(join(f.root,'evaluation'));
  await writeFile(join(f.root,'src/schema.sql'),'CREATE TABLE example(value TEXT);');
  for (const compute of [sourceFingerprint, fingerprint]) {
    await writeFile(join(f.root,'src/schema.sql'),'CREATE TABLE example(value TEXT);');
    const before=await compute(f.root);assert.ok(before.files.some(x=>x.file==='src/schema.sql'));
    assert.ok(before.files.some(x=>x.kind==='dependency'&&x.file==='package-lock.json'));
    await writeFile(join(f.root,'src/schema.sql'),'CREATE TABLE example(value TEXT, extra TEXT);');
    const after=await compute(f.root);assert.notEqual(after.sha256,before.sha256);
    assert.throws(()=>validateRecovery({identity:{sourceCodeSha256:before.sha256},sourceFiles:before.files},{sourceCodeSha256:after.sha256},after.files),/product source differs/);
  }
});
