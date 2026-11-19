import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('formal Web build rejects a shared package from another assembly before invoking Vite', t => {
  const root = mkdtempSync(join(tmpdir(), 'web-build-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['products/join', 'scripts', 'packages/design-system', 'node_modules/@opencraft', 'older-assembly'])
    mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', workspaces: ['packages/*'] }));
  writeFileSync(join(root, 'packages/design-system/package.json'), JSON.stringify({ name: '@opencraft/design-system' }));
  symlinkSync(join(root, 'older-assembly'), join(root, 'node_modules/@opencraft/design-system'));
  for (const name of ['build-web.mjs', 'build-workspace-guard.mjs'])
    copyFileSync(new URL('../' + name, import.meta.url), join(root, 'products/join', name));
  writeFileSync(join(root, 'scripts/package-headless-linux.mjs'), 'export const headlessWebHostDefinitions = () => [];');
  const result = spawnSync(process.execPath, [join(root, 'products/join/build-web.mjs')], {
    encoding: 'utf8', env: { ...process.env, OPENCRAFT_SOURCE_REVISION: 'fixture' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the selected source assembly/);
  assert.doesNotMatch(result.stderr, /Cannot find module.*vite/);
});
