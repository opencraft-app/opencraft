import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installOwnedBrowserRuntime } from '../../scripts/build/install-owned-browser-runtime.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'owned-browser-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distribution = join(root, 'artifact'), application = join(root, 'app'), definition = join(root, 'fork.json');
  await mkdir(distribution); await mkdir(join(application, 'runtime/browser/electron'), { recursive: true });
  const fork = JSON.stringify({ version: '44.8.0', chromiumVersion: '152.0.7977.167' });
  await writeFile(definition, fork);
  const files = [];
  for (const name of ['electron', 'LICENSE', 'LICENSES.chromium.html', 'chrome-sandbox']) {
    const bytes = Buffer.from('fixture ' + name); await writeFile(join(distribution, name), bytes);
    files.push({ path: name, sha256: hash(bytes), size: bytes.length });
  }
  await chmod(join(distribution, 'electron'), 0o755);
  const marker = { schemaVersion: 1, platform: 'linux', arch: process.arch, electronVersion: '44.8.0',
    chromiumVersion: '152.0.7977.167', forkDefinitionSha256: hash(fork), nativeCopyProbePassed: true,
    nativeInputCausalityProbePassed: true, nativeImeFocusIdentityProbePassed: true, files };
  const save = () => writeFile(join(distribution, 'opencraft-electron-artifact.json'), JSON.stringify(marker));
  await save();
  await writeFile(join(application, 'runtime/browser/electron/old-resource'), 'old browser');
  await writeFile(join(application, 'runtime/browser/worker.cjs'), 'preserved worker');
  await writeFile(join(application, 'manifest.json'), JSON.stringify({ schemaVersion: 1, buildId: 'existing',
    deploymentPatch: { keep: true }, files: [{ path: 'runtime/browser/worker.cjs', sha256: hash('preserved worker') },
      { path: 'runtime/browser/electron/old-resource', sha256: hash('old browser') }] }));
  return { distribution, application, definition, marker, save, sourceRevision: 'a'.repeat(40), baseImage: 'sha256:' + 'b'.repeat(64) };
}
test('component install removes obsolete browser files and preserves the existing application', async t => {
  const f = await fixture(t); await installOwnedBrowserRuntime(f);
  assert.equal(await readFile(join(f.application, 'runtime/browser/worker.cjs'), 'utf8'), 'preserved worker');
  await assert.rejects(readFile(join(f.application, 'runtime/browser/electron/old-resource')), { code: 'ENOENT' });
  const manifest = JSON.parse(await readFile(join(f.application, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.deploymentPatch, { keep: true });
  assert.equal(manifest.browserRuntimeUpdate.baseImage, f.baseImage);
  assert(manifest.files.some(file => file.path.endsWith('opencraft-electron-artifact.json')));
  assert(!manifest.files.some(file => file.path.endsWith('old-resource')));
  for (const file of manifest.files) assert.equal(hash(await readFile(join(f.application, file.path))), file.sha256);
});
test('failed native input probes and corrupt archives leave the previous component intact', async t => {
  const f = await fixture(t);
  f.marker.nativeImeFocusIdentityProbePassed = false; await f.save();
  await assert.rejects(installOwnedBrowserRuntime(f), /all native input probes/);
  assert.equal(await readFile(join(f.application, 'runtime/browser/electron/old-resource'), 'utf8'), 'old browser');
  f.marker.nativeImeFocusIdentityProbePassed = true; await f.save();
  await writeFile(join(f.distribution, 'electron'), 'corrupt');
  await assert.rejects(installOwnedBrowserRuntime(f), /checksum/);
  assert.equal(await readFile(join(f.application, 'runtime/browser/electron/old-resource'), 'utf8'), 'old browser');
});
