import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export function sourceIdentity(root = repository) {
  const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'A clean committed fork is required');
  const sourceRevision = git('rev-parse', 'HEAD');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  assert(!git('ls-tree', '-r', 'HEAD').split('\n').some(line => line.startsWith('160000 ')), 'Fork source must not contain gitlinks');
  const provenance = JSON.parse(readFileSync(resolve(root, '.ci/fork-provenance.json'), 'utf8'));
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.status, 'isolated-private-fork-candidate');
  for (const key of ['originalRevision', 'originalConsumerTree', 'originalSourceTree', 'upstreamBaseline', 'materializedRevision']) {
    assert.match(provenance[key] ?? '', /^[a-f0-9]{40}$/, `Invalid provenance ${key}`);
  }
  assert.notEqual(provenance.originalRevision, provenance.materializedRevision, 'Original and materialized revisions are different identities');
  assert.equal(git('rev-parse', `${provenance.materializedRevision}^{tree}`), provenance.originalSourceTree, 'Materialized business tree mismatch');
  assert.equal(git('rev-parse', `${provenance.materializedRevision}^`), provenance.upstreamBaseline, 'Upstream baseline mismatch');
  git('merge-base', '--is-ancestor', provenance.materializedRevision, sourceRevision);
  return { schemaVersion: 1, sourceRevision, sourceTree, buildId: `git-${sourceRevision}-join-ci`, provenance };
}
export function verifySnapshot(snapshot, root = repository) {
  assert.deepEqual(sourceIdentity(root), snapshot, 'Source changed during build');
  return snapshot;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 2) console.log(JSON.stringify(sourceIdentity(), null, 2));
  else {
    assert.equal(process.argv.length, 4, 'Usage: source-identity.mjs [--check SNAPSHOT]');
    assert.equal(process.argv[2], '--check');
    verifySnapshot(JSON.parse(readFileSync(process.argv[3], 'utf8')));
  }
}
