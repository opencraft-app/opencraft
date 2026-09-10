const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, stat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const prepare = require('../scripts/prepare-packaged-pty.cjs');

test('packaging repairs the executable helper before signing and rejects absent native assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'packaged-pty-'));
  const context = { appOutDir: directory, electronPlatformName: 'darwin', arch: 3,
    packager: { appInfo: { productFilename: 'OpenCraft' } } };
  try {
    await assert.rejects(prepare(context), /native module is missing/);
    const native = join(directory, 'OpenCraft.app/Contents/Resources/runtime/node_modules/node-pty/prebuilds/darwin-arm64');
    await mkdir(native, { recursive: true });
    await writeFile(join(native, 'pty.node'), 'fixture');
    await assert.rejects(prepare(context), /ENOENT/);
    const helper = join(native, 'spawn-helper');
    await writeFile(helper, 'fixture', { mode: 0o644 });
    await prepare(context);
    assert.equal((await stat(helper)).mode & 0o777, 0o755);
    await prepare(context);
    assert.equal((await stat(helper)).mode & 0o777, 0o755);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
