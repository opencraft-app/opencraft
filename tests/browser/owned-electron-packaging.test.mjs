import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageBrowserRuntime } from '../../scripts/package-browser-runtime.mjs';
import { packageHeadlessLinux } from '../../scripts/package-headless-linux.mjs';
import { packageBuilderArguments } from '../../scripts/package-electron-desktop.mjs';
import { ownedDesktopFixture } from '../fixtures/owned-electron.mjs';

test('browser packaging with an invalid explicit owned distribution fails before creating output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owned-browser-required-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION;
  process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION = join(root, "missing");
  try {
    await assert.rejects(packageBrowserRuntime(join(root, 'browser')), /Owned Electron artifact is missing/);
    await assert.rejects(packageHeadlessLinux({ architecture: process.arch === 'arm64' ? 'arm64' : 'amd64' }), process.platform === 'linux' ? /Owned Electron artifact is missing/ : /must be built on native Linux/);
    await assert.rejects(access(join(root, 'browser')), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION;
    else process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION = previous;
  }
});

test('desktop packaging rejects the former stock override and replaces arbitrary electronDist flags', async t => {
  await assert.rejects(packageBuilderArguments([], {}), /only verified repository-owned/);
  await assert.rejects(packageBuilderArguments([], { OPENCRAFT_ELECTRON_ALLOW_STOCK: '1' }), /only verified repository-owned/);
  const distribution = await ownedDesktopFixture(t);
  const args = await packageBuilderArguments(['--config.electronDist=/unverified'], { OPENCRAFT_ELECTRON_DISTRIBUTION: distribution });
  assert.equal(args.at(-1), '--config.electronDist=' + distribution);
  assert.match(args.at(-2), /^--config\.electronVersion=\d+\.\d+\.\d+$/);
});
