import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, readdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageHeadlessLinux, buildHeadlessBundle } from './package-headless-linux.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? '/out');
await mkdir(output, { recursive: true });
process.env.OPENCRAFT_HEADLESS_PACKAGE_OUTPUT = join(output, 'server.tar.gz');
console.log('Building the verified Headless archive and native runtimes');
const archive = await packageHeadlessLinux({ architecture: process.arch === 'arm64' ? 'arm64' : 'amd64' });
console.log('Preparing container gateway and independent native Host entries');
execFileSync('tar', ['-xzf', archive, '-C', output]);
const root = join(output, 'opencraft-server');
for (const [source, target] of [
  ['scripts/container-deployment/gateway.mjs', 'container-gateway.mjs'],
  ['scripts/server-deployment/engine-host.mjs', 'engine-host.mjs'],
  ['scripts/server-deployment/dsh-host.mjs', 'dsh-host.mjs'],
]) await buildHeadlessBundle(join(root, 'runtime', target), { headlessEntry: join(repository, source) });
for (const [source, target, format] of [
  ['apps/codex-core/src/bin.ts', 'codex-core.cjs', 'cjs'],
  ['apps/codex-core/src/app-server-bin.ts', 'codex-app-server.cjs', 'cjs'],
  ['scripts/container-deployment/host.mjs', 'native-host.mjs', 'esm'],
]) await build({ entryPoints: [join(repository, source)], outfile: join(root, 'runtime', target),
  bundle: true, platform: 'node', format, target: 'node26',
  ...(format === 'esm' ? { banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } } : {}) });
await writeFile(join(root, 'bin/opencraft-host'), '#!/bin/sh\nset -eu\nopencraft_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)\nexec "$opencraft_root/bin/node" --env-file-if-exists=.env "$opencraft_root/runtime/native-host.mjs" "$@"\n');
await chmod(join(root, 'bin/opencraft-host'), 0o755);
await cp(join(repository, 'LICENSE'), join(root, 'LICENSE'));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const files = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), name = relative(root, path);
    if (entry.isDirectory()) await inventory(path);
    else if (entry.isFile() && name !== 'manifest.json')
      files.push({ path: name, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
}
await inventory(root);
await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, delivery: 'docker-external-host',
  files: [...files, ...manifest.files.filter(file => file.link)].sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + '\n');
console.log('Container and native Host payload ready');
