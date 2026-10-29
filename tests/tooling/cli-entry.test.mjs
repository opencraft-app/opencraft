import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const entry of ['verify-web-package.mjs', 'full-upgrade/cli.mjs', 'recovery/prepare-join-legacy-fallback.ts']) {
  test(`${entry}: symlink reaches CLI validation, import stays inert`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'opencraft-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const target = resolve(root, 'scripts', entry), link = join(directory, entry.split('/').at(-1));
    await symlink(target, link);
    const flags = entry.endsWith('.ts') ? ['--import', 'tsx'] : [];
    const direct = spawnSync(process.execPath, [...flags, target, '--invalid'], { cwd: root, encoding: 'utf8' });
    const linked = spawnSync(process.execPath, [...flags, link, '--invalid'], { cwd: root, encoding: 'utf8' });
    assert.equal(direct.status, 1, direct.stderr);
    assert.equal(linked.status, 1, linked.stderr);
    assert.ok(linked.stderr.length > 0);
    const imported = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(target).href)}); console.log('imported');`], { cwd: root, encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, 'imported\n');
  });
}
for (const entry of ['agent', 'helper', 'watchdog']) {
  test(`full-upgrade/${entry}: symlink emits the protocol`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'opencraft-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const target = resolve(root, 'scripts/full-upgrade', entry + '.mjs'), link = join(directory, entry + '.mjs');
    await symlink(target, link);
    const direct = spawnSync(process.execPath, [target, '--protocol'], { encoding: 'utf8' });
    const linked = spawnSync(process.execPath, [link, '--protocol'], { encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(linked.status, 0, linked.stderr);
    assert.deepEqual(JSON.parse(linked.stdout), JSON.parse(direct.stdout));
  });
}
