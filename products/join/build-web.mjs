import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { verifyWorkspaceBindings } from './build-workspace-guard.mjs';
import { headlessWebHostDefinitions } from '../../scripts/package-headless-linux.mjs';
const product = dirname(fileURLToPath(import.meta.url)), root = resolve(product, '../..');
verifyWorkspaceBindings(root);
const revision = process.env.OPENCRAFT_SOURCE_REVISION || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const env = { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=4096", OPENCRAFT_SOURCE_REVISION: revision,
  OPENCRAFT_BUILD_ID: process.env.OPENCRAFT_BUILD_ID ?? `git-${revision.slice(0, 12)}-join`,
  OPENCRAFT_SERVER_EXTENSIONS_ENTRY: resolve(product, 'web.ts'), OPENCRAFT_HEADLESS_SERVER_BUILD: 'true',
  VITE_HYPERNODE_PLUGIN: 'disabled', VITE_APPSERVER_HOSTS_JSON: JSON.stringify(headlessWebHostDefinitions()), OPENCRAFT_RELEASE_MINIFY: 'standard' };
for (const cwd of ['packages/browser-preview-bridge', 'apps/workbench-web']) {
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build',
    ...(cwd === 'apps/workbench-web' ? ['--config', resolve(product, 'vite.config.mjs')] : [])], { cwd: resolve(root, cwd), env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const check = spawnSync(process.execPath, [resolve(root, 'scripts/check-browser-compatibility.mjs')], { cwd: root, env, stdio: 'inherit' });
process.exit(check.status ?? 1);
