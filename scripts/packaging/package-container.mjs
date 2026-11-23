import { build } from 'esbuild';
import { access, cp, mkdir, readFile, writeFile, readdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageHeadlessLinux, buildHeadlessBundle } from './package-headless-linux.mjs';
import { SOURCE_FALLBACK_SIBLINGS, verifySiblingFiles } from './verify-sibling-files.mjs';
import { buildCodexBridgeRuntime } from './package-web-server.mjs';
import { verifyWorkspaceLinks } from './workspace-links.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
verifyWorkspaceLinks(repository);
const output = resolve(process.argv[2] ?? '/out');
await mkdir(output, { recursive: true });
console.log('Building the verified Headless tree and native runtimes');
// Staged in place: the image copies this directory, so no archive is needed.
const root = await packageHeadlessLinux({ architecture: process.arch === 'arm64' ? 'arm64' : 'amd64', stageInto: output, includeBrowser: !process.argv.slice(3).includes('--without-browser') });
console.log('Preparing container Gateway, Brain and Hands owner entries');
for (const [source, target] of [
  [process.env.OPENCRAFT_CONTAINER_GATEWAY_ENTRY || 'scripts/container-deployment/gateway.mjs', 'container-gateway.mjs'],
  ['scripts/server-deployment/engine-host.mjs', 'engine-host.mjs'],
  ['scripts/server-deployment/dsh-host.mjs', 'dsh-host.mjs'],
  ['scripts/server-deployment/sandbox-command.mjs', 'sandbox-command.mjs'],
  ['scripts/container-deployment/hands-execution-owner.mjs', 'hands-execution-owner.mjs'],
  ['scripts/container-deployment/health.mjs', 'container-health.mjs'],
  ['scripts/container-deployment/terminal.mjs', 'hands-terminal-owner.mjs'],
  ['scripts/container-deployment/files.mjs', 'hands-files-owner.mjs'],
  ['scripts/admin/hub-admin.ts', 'hub-admin.mjs'],
]) await buildHeadlessBundle(join(root, 'runtime', target), { headlessEntry: join(repository, source) });
for (const [source, target, format] of [
  ['apps/codex-core/src/bin.ts', 'codex-core.cjs', 'cjs'],
  ['apps/codex-core/src/app-server-bin.ts', 'codex-app-server.cjs', 'cjs'],
  ['apps/codex-core/src/generation-registry.worker.ts', 'generation-registry-worker.mjs', 'esm'],
  ['apps/codex-core/src/router-evidence.worker.ts', 'router-evidence-worker.mjs', 'esm'],
  ['scripts/container-deployment/host.mjs', 'native-host.mjs', 'esm'],
  [process.env.OPENCRAFT_CONTAINER_HANDS_ENTRY || 'scripts/container-deployment/hands.mjs', 'native-hands.mjs', 'esm'],
  ['scripts/container-deployment/proxy.mjs', 'proxy-host.mjs', 'esm'],
  ['scripts/container-deployment/service.mjs', 'container-service.mjs', 'esm'],
]) await build({ entryPoints: [join(repository, source)], outfile: join(root, 'runtime', target),
  bundle: true, platform: 'node', format, target: 'node26',
  ...(format === 'esm' ? { banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } } : {}) });
// Brain names these Workers in its owners' configurations rather than by URL, so
// the sibling check below cannot see them: the Pi/DSH Git port and the durable
// admission reader of DSH, Pi and the Codex AppServer's ENV receiver.
const BRAIN_CONFIGURED_WORKERS = Object.freeze(['personal-git-worker.mjs', 'execution-admission-worker.mjs']);
for (const name of BRAIN_CONFIGURED_WORKERS) await access(join(root, 'runtime', name));
// The Gateway's own Codex Engine Host and provider; native commands still run in Hands via the AppServer.
await buildCodexBridgeRuntime(join(root, 'runtime/codex-bridge'), { nodePty: '../node_modules/node-pty/lib/index.js' });
// Trusted distribution assembly must also ship its process/worker sidecars.
if (process.env.OPENCRAFT_CONTAINER_GATEWAY_BUILD_SCRIPT)
  execFileSync(process.execPath, [resolve(repository, process.env.OPENCRAFT_CONTAINER_GATEWAY_BUILD_SCRIPT), join(root, 'runtime/container-gateway.mjs')], { cwd: repository, env: process.env, stdio: 'inherit' });
await writeFile(join(root, 'bin/opencraft-host'), '#!/bin/sh\nset -eu\nopencraft_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)\nexec "$opencraft_root/bin/node" --env-file-if-exists=.env "$opencraft_root/runtime/native-host.mjs" "$@"\n');
await chmod(join(root, 'bin/opencraft-host'), 0o755);
await writeFile(join(root, 'bin/opencraft-hands'), '#!/bin/sh\nset -eu\nopencraft_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)\nexec "$opencraft_root/bin/node" "$opencraft_root/runtime/native-hands.mjs"\n');
await chmod(join(root, 'bin/opencraft-hands'), 0o755);
await writeFile(join(root, 'bin/opencraft-health'), '#!/bin/sh\nset -eu\nopencraft_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)\nexec "$opencraft_root/bin/node" "$opencraft_root/runtime/container-health.mjs" "$@"\n');
await chmod(join(root, 'bin/opencraft-health'), 0o755);
await cp(join(repository, 'LICENSE'), join(root, 'LICENSE'));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const files = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), name = relative(root, path);
    if (entry.isDirectory()) await inventory(path);
    else if (entry.isFile() && name !== 'manifest.json') {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      files.push({ path: name, sha256: hash.digest('hex') });
    }
  }
}
await inventory(root);
// Every file a container bundle starts from beside itself must have been built beside it.
await verifySiblingFiles(join(root, 'runtime'), { nested: ['codex-bridge'], optional: SOURCE_FALLBACK_SIBLINGS });
await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, delivery: 'docker-compose-owners',
  files: [...files, ...manifest.files.filter(file => file.link)].sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + '\n');
console.log('Container owner payload ready');
