#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function packageRelay({ output = join(root, 'dist/relay'), relayEntry = join(root, 'apps/relay-server/src/main.ts') } = {}) {
  output = resolve(output);
  let revision = process.env.OPENCRAFT_SOURCE_REVISION ?? null;
  if (revision !== null && !/^[a-f0-9]{40}$/u.test(revision)) throw new Error('Invalid relay source revision');
  if (!revision) {
    try { if (!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* Source archive can have unknown revision. */ }
  }
  const buildId = new Date().toISOString();
  await mkdir(output, { recursive: true });
  for (const [entry, file] of [[resolve(relayEntry), 'relay.mjs'], [join(root, 'scripts/access-admin.ts'), 'access-admin.mjs'], [join(root, 'scripts/hub-admin.ts'), 'hub-admin.mjs']]) {
    await build({ nodePaths: [join(root, 'node_modules')], entryPoints: [entry], outfile: join(output, file), bundle: true, platform: 'node', format: 'esm', target: 'node24',
      define: { 'process.env.OPENCRAFT_RELAY_SOURCE_REVISION': JSON.stringify(revision), 'process.env.OPENCRAFT_RELAY_BUILD_ID': JSON.stringify(buildId) },
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  }
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: '@opencraft/relay-deployment', version: '0.1.0', private: true, type: 'module', engines: { node: '>=24' } }, null, 2));
  await copyFile(join(root, 'docs/relay-deployment.md'), join(output, 'README.md'));
  console.log(output);
  return { output, revision, buildId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await packageRelay({ output: process.argv[2] });
}
