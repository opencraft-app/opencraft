import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyRemoteBrowserArtifact } from '../../scripts/remote-browser-artifact.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'owned-browser-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const forkPath = join(directory, 'fork-definition.json');
  const fork = JSON.stringify({ version: '44.8.0', chromiumVersion: '152.0.7977.167' });
  await writeFile(forkPath, fork);
  const { mkdir } = await import('node:fs/promises');
  const distribution = join(directory, 'distribution'); await mkdir(distribution);
  const files = [];
  for (const name of ['electron', 'LICENSE', 'LICENSES.chromium.html']) {
    const data = Buffer.from('fixture ' + name); await writeFile(join(distribution, name), data);
    files.push({ path: name, sha256: hash(data), size: data.length });
  }
  await chmod(join(distribution, 'electron'), 0o755);
  const marker = { schemaVersion: 1, platform: 'linux', arch: process.arch, forkDefinitionSha256: hash(fork),
    electronVersion: '44.8.0', chromiumVersion: '152.0.7977.167', nativeCopyProbePassed: true, files };
  const save = () => writeFile(join(distribution, 'opencraft-electron-artifact.json'), JSON.stringify(marker));
  await save(); return { distribution, forkPath, marker, save };
}
test('owned runtime requires exact fork, native probe receipt and complete byte inventory', async t => {
  const f = await fixture(t);
  assert.equal(await verifyRemoteBrowserArtifact(f.distribution, f.forkPath), f.distribution);
  await writeFile(join(f.distribution, 'electron'), 'tampered');
  await assert.rejects(verifyRemoteBrowserArtifact(f.distribution, f.forkPath), /checksum/);
});
test('stale fork, failed native probe, undeclared and escaping files fail closed', async t => {
  const f = await fixture(t), original = f.marker.forkDefinitionSha256;
  f.marker.forkDefinitionSha256 = '0'.repeat(64); await f.save();
  await assert.rejects(verifyRemoteBrowserArtifact(f.distribution, f.forkPath), /provenance/);
  f.marker.forkDefinitionSha256 = original; f.marker.nativeCopyProbePassed = false; await f.save();
  await assert.rejects(verifyRemoteBrowserArtifact(f.distribution, f.forkPath), /provenance/);
  f.marker.nativeCopyProbePassed = true; await f.save();
  await writeFile(join(f.distribution, 'unexpected'), 'extra');
  await assert.rejects(verifyRemoteBrowserArtifact(f.distribution, f.forkPath), /checksum/);
  await rm(join(f.distribution, 'unexpected'));
  f.marker.files.push({ path: '../escape', sha256: '0'.repeat(64), size: 0 }); await f.save();
  await assert.rejects(verifyRemoteBrowserArtifact(f.distribution, f.forkPath), /inventory/);
});
