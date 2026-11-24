#!/usr/bin/env node
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { build } from 'esbuild';
import { OWNER_WORKERS, buildStartedOwnerWorkers } from './owner-workers.mjs';
import { verifySiblingFiles } from './verify-sibling-files.mjs';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyWorkspaceLinks } from './workspace-links.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function packageRelay({ output = join(root, 'dist/relay'), relayEntry = join(root, 'apps/relay-server/src/main.ts') } = {}) {
  output = resolve(output);
  let revision = process.env.OPENCRAFT_SOURCE_REVISION ?? null;
  if (revision !== null && !/^[a-f0-9]{40}$/u.test(revision)) throw new Error('Invalid relay source revision');
  if (!revision) {
    try { if (!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* Source archive can have unknown revision. */ }
  }
  const buildId = new Date().toISOString();
  await mkdir(output, { recursive: true });
  // An earlier package into the same directory may have left owners Relay no longer starts.
  for (const [, file] of OWNER_WORKERS) await rm(join(output, file), { force: true });
  for (const [entry, file] of [[resolve(relayEntry), 'relay.mjs'], [join(root, 'scripts/admin/access-admin.ts'), 'access-admin.mjs'], [join(root, 'scripts/admin/hub-admin.ts'), 'hub-admin.mjs'], [join(root, 'scripts/admin/relay-cluster-admin.ts'), 'relay-cluster-admin.mjs']]) {
    await build({ nodePaths: [join(root, 'node_modules')], entryPoints: [entry], outfile: join(output, file), bundle: true, platform: 'node', format: 'esm', target: 'node24',
      define: { 'process.env.OPENCRAFT_RELAY_SOURCE_REVISION': JSON.stringify(revision), 'process.env.OPENCRAFT_RELAY_BUILD_ID': JSON.stringify(buildId) },
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  }
  // Relay starts only the Hub state owner; a Server owner here would never run
  // and would name Workers this package does not ship.
  await buildStartedOwnerWorkers(output);
  await verifySiblingFiles(output);
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: '@opencraft/relay-deployment', version: '0.1.0', private: true, type: 'module', engines: { node: '>=24' } }, null, 2));
  await copyFile(join(root, 'docs/operations/relay-deployment.md'), join(output, 'README.md'));
  console.log(output);
  return { output, revision, buildId };
}
if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  verifyWorkspaceLinks();
  await packageRelay({ output: process.argv[2] });
}
