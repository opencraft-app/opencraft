import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createControlledReleaseRegistry } from '../../scripts/web-deployment/controlled-registry.mjs';
import { createNpmReleaseSource, PACKAGE_NAME, unpackRelease } from '../../scripts/web-deployment/releases.mjs';
import { releaseFixture } from '../support/web-deployment-fixture.mjs';

test('controlled managed-headless channel uses exact archive, rejects changed bytes and never falls back to public latest', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-controlled-registry-'));
  let fixture, registry;
  try {
    fixture = await releaseFixture(root);
    const archive = fixture.releases.get('1.1.0');
    const catalogPath = join(root, 'catalog.json');
    const catalog = { schemaVersion: 1, channel: 'managed-headless', selected: archive.version,
      releases: [{ version: archive.version, buildId: archive.buildId, archive: archive.archive, integrity: archive.integrity }] };
    const save = () => writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    await save();
    registry = await createControlledReleaseRegistry({ catalogPath });
    const address = await registry.listen({ port: 0 });
    const origin = `http://127.0.0.1:${address.port}/`;
    const source = createNpmReleaseSource({ registry: origin, channel: 'managed-headless' });
    const exact = await source.latest();
    assert.equal(exact.version, archive.version); assert.equal(exact.buildId, archive.buildId); assert.equal(exact.integrity, archive.integrity);
    const downloaded = await source.download(exact, join(root, 'download'));
    assert.equal('sha512-' + createHash('sha512').update(await readFile(downloaded)).digest('base64'), exact.integrity);
    assert.equal((await unpackRelease(downloaded, join(root, 'unpack'))).buildId, exact.buildId);
    await assert.rejects(createNpmReleaseSource({ registry: origin, channel: 'latest' }).latest(), /registry configuration/);
    const metadata = await (await fetch(origin + encodeURIComponent(PACKAGE_NAME), { headers: { host: 'untrusted.invalid' } })).json();
    assert.equal(new URL(metadata.versions[archive.version].dist.tarball).hostname, '127.0.0.1');
    await writeFile(archive.archive, 'corrupted-owned-fixture');
    assert.equal((await fetch(origin + `archives/${archive.version}.tgz`)).status, 503);
    catalog.selected = '9.0.0'; await save();
    assert.equal((await fetch(origin + encodeURIComponent(PACKAGE_NAME))).status, 503);
    await chmod(catalogPath, 0o644);
    await assert.rejects(createControlledReleaseRegistry({ catalogPath }), /private file/);
  } finally { await registry?.close(); await fixture?.close(); await rm(root, { recursive: true, force: true }); }
});
