import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageWebServer } from '../../scripts/package-web-server.mjs';
import { inspectPublicRelease } from '../../scripts/inspect-public-release.mjs';
import { parseNpmPackResult } from '../../scripts/web-deployment/npm-pack-result.mjs';

test('public execution archive is consumable and rejects deployment secrets and mismatched runtime constraints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-public-archive-'));
  try {
    const web = join(root, 'web'); await mkdir(web);
    await writeFile(join(web, 'version.json'), JSON.stringify({ buildId: 'public-release-test' }));
    await writeFile(join(web, 'index.html'), '<html><head><meta content="public-release-test"></head></html>');
    const packed = await packageWebServer({ version: '0.1.10', webRoot: web, output: join(root, 'packed'), execution: true });
    const inspected = await inspectPublicRelease(packed.archive);
    assert.equal(inspected.packageName, '@opencraft-app/opencraft');
    assert.equal(inspected.buildId, 'public-release-test');
    async function repack() {
      const { stdout } = await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: packed.packageRoot });
      return join(root, parseNpmPackResult(JSON.parse(stdout)).filename);
    }
    const secret = join(packed.packageRoot, 'runtime/admin-key');
    await writeFile(secret, 'synthetic-deployment-secret');
    await assert.rejects(inspectPublicRelease(await repack()), /Private or debug file/);
    await rm(secret);
    const manifestPath = join(packed.packageRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.engines.node = '>=22';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(inspectPublicRelease(await repack()), /installation constraints/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
