import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageBrowserRuntime } from '../../scripts/build/package-browser-runtime.mjs';
import { packageHeadlessLinux } from '../../scripts/build/package-headless-linux.mjs';
import { forkUpstreamElectronVersion, packageBuilderArguments } from '../../scripts/build/package-electron-desktop.mjs';
import checkDesktopTarget from '../../scripts/check/check-desktop-target.cjs';
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
  await assert.rejects(packageBuilderArguments(['--linux', 'AppImage'], { OPENCRAFT_ELECTRON_ALLOW_STOCK: '1' }), /requires the verified fork/);
  const distribution = await ownedDesktopFixture(t);
  const args = await packageBuilderArguments(['--config.electronDist=/unverified'], { OPENCRAFT_ELECTRON_DISTRIBUTION: distribution });
  assert.equal(args.at(-2), '--config.electronDist=' + distribution);
  assert.match(args.at(-1), /^--config\.electronVersion=\d+\.\d+\.\d+$/);
});

test('stock Electron is an explicit macOS and Windows desktop option; Linux and browser runtimes keep the fork', async () => {
  const stock = { OPENCRAFT_ELECTRON_STOCK_DESKTOP: '1' };
  const version = forkUpstreamElectronVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const platform of ['--mac', '--win']) {
    const args = await packageBuilderArguments([platform, '--x64', '--config.electronDist=/unverified', '--config.electronVersion=1.0.0'], stock);
    assert.deepEqual(args, [platform, '--x64', '--config.electronVersion=' + version]);
  }
  await assert.rejects(packageBuilderArguments(['--linux', 'AppImage', '--x64'], stock), /linux requires the verified fork/);
  // The variable is an explicit opt-in; other values select the owned distribution path.
  await assert.rejects(packageBuilderArguments(['--mac', '--arm64'], { OPENCRAFT_ELECTRON_STOCK_DESKTOP: 'true' }), /only verified repository-owned/);
});

test('direct electron-builder runs accept stock Electron only for explicit macOS and Windows desktop packages', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const appDir = await mkdtemp(join(tmpdir(), 'stock-desktop-target-'));
  t.after(() => rm(appDir, { recursive: true, force: true }));
  await mkdir(join(appDir, 'dist-host'));
  const main = '// desktop main fixture';
  const production = { displayName: 'OpenCraft', applicationId: 'app.opencraft.desktop' };
  await writeFile(join(appDir, 'dist-host/main.cjs'), main);
  await writeFile(join(appDir, 'dist-host/desktop-identity.json'), JSON.stringify({
    production, preview: { displayName: 'OpenCraft Preview', applicationId: 'app.opencraft.desktop.preview' },
    mainSha256: createHash('sha256').update(main).digest('hex'),
  }));
  const arch = { x64: 1, arm64: 3 }[process.arch];
  const context = (config) => ({
    packager: { info: { appDir }, appInfo: { productName: production.displayName, id: production.applicationId }, config },
    electronPlatformName: process.platform, arch,
  });
  const previous = process.env.OPENCRAFT_ELECTRON_STOCK_DESKTOP;
  process.env.OPENCRAFT_ELECTRON_STOCK_DESKTOP = '1';
  t.after(() => { if (previous === undefined) delete process.env.OPENCRAFT_ELECTRON_STOCK_DESKTOP; else process.env.OPENCRAFT_ELECTRON_STOCK_DESKTOP = previous; });
  const version = forkUpstreamElectronVersion();
  if (arch === undefined) return;
  if (process.platform === 'darwin' || process.platform === 'win32') {
    await checkDesktopTarget(context({ electronVersion: version }));
    await assert.rejects(checkDesktopTarget(context({ electronVersion: '1.0.0' })), /use Electron/);
    await assert.rejects(checkDesktopTarget(context({ electronVersion: version, electronDist: '/x' })), /must not also select/);
  } else {
    await assert.rejects(checkDesktopTarget(context({ electronVersion: version })), /requires the verified fork/);
  }
});
