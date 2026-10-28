import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { deploymentPaths, readPrivateToken } from './paths.mjs';
import { coreHealth } from '../server-deployment/execution.mjs';
import { readDshHostIdentity } from '../server-deployment/dsh-host-client.mjs';
import { readEngineHostIdentity } from '../server-deployment/engine-host-client.mjs';

// Run this launcher on the Linux host, independently of Docker's lifecycle.
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
  throw new Error('The native execution bundle requires matching Linux arm64 or amd64');
const paths = deploymentPaths();
await mkdir(paths.dataDirectory, { recursive: true, mode: 0o700 });
const info = await stat(paths.dataDirectory);
if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
  throw new Error('The data directory must be owned by this user with mode 0700');
await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
await mkdir(paths.runDirectory, { recursive: true, mode: 0o700 });
const release = await lockfile.lock(join(paths.dataDirectory, 'native-host'), { realpath: false, retries: 0 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let stopping, failed = false;
async function stop(code = 0) {
  return stopping ??= (async () => {
    for (const child of children) if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGTERM');
    await Promise.all(children.map(child => child.exited));
    await release();
    process.exitCode = code;
  })();
}
function start(entry, argv, env = {}) {
  if (stopping) throw new Error('Native Host startup was cancelled');
  const child = spawn(join(root, 'bin/node'), [join(root, 'runtime', entry), ...argv], {
    cwd: paths.runtimeDirectory, env: { ...process.env, ...env }, stdio: 'inherit', shell: false,
  });
  const exited = new Promise(accept => {
    child.once('error', () => { failed = true; accept(); void stop(1); });
    child.once('exit', () => { accept(); if (!stopping) { failed = true; void stop(1); } });
  });
  children.push({ process: child, exited });
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
try {
  try { await writeFile(paths.tokenPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await readPrivateToken(paths.tokenPath);
  await writeFile(paths.engineConfig, JSON.stringify({
    descriptorPath: paths.engineDescriptor, dataDirectory: paths.dataDirectory,
    runtimeDirectory: paths.runtimeDirectory, engines: ['dsh', 'pi'], defaultEngine: 'pi',
    dshDescriptorPath: paths.dshDescriptor,
  }) + '\n', { mode: 0o600 });
  await writeFile(paths.dshConfig, JSON.stringify({
    descriptorPath: paths.dshDescriptor, dataDirectory: join(paths.dataDirectory, 'agent'),
    machineIdentityDirectory: paths.dataDirectory, runtimeDirectory: paths.runtimeDirectory,
    dshExecutable: join(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    dshCapabilityPlugin: join(root, 'runtime/dsh/opencraft-capability-plugin.mjs'),
    modelStorageDirectory: join(paths.dataDirectory, 'models'), speechModelManagement: true,
    projectStorageDirectory: join(paths.dataDirectory, 'projects'),
    projectlessWorkspaceDirectory: join(paths.dataDirectory, 'workspaces'),
    skillsDirectory: join(paths.dataDirectory, 'skills'),
    taskCodexCoreEndpoint: paths.coreEndpoint, taskCodexCoreTokenFile: paths.tokenPath,
  }) + '\n', { mode: 0o600 });
  await mkdir(join(paths.dataDirectory, 'codex'), { recursive: true, mode: 0o700 });
  // One fixed proxy port for this independently supervised execution lifetime.
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const proxyPort = listener.address().port;
  await new Promise(accept => listener.close(accept));
  start('codex-core.cjs', [
    '--app-server-endpoint', paths.appServerEndpoint, '--proxy-port', String(proxyPort),
    '--endpoint', paths.coreEndpoint, '--token-file', paths.tokenPath,
    '--codex-executable', join(root, 'runtime/codex/bin/codex'),
    '--runtime-directory', paths.runtimeDirectory,
    '--data-directory', join(paths.dataDirectory, 'codex'),
    '--native-codex-home-directory', join(paths.dataDirectory, 'native-codex'),
  ]);
  start('codex-app-server.cjs', [
    '--endpoint', paths.appServerEndpoint, '--core-endpoint', paths.coreEndpoint,
    '--token-file', paths.tokenPath, '--codex-executable', join(root, 'runtime/codex/bin/codex'),
    '--runtime-directory', paths.runtimeDirectory, '--data-directory', join(paths.dataDirectory, 'codex'),
  ]);
  start('dsh-host.mjs', [], { OPENCRAFT_DSH_HOST_CONFIG: paths.dshConfig });
  start('engine-host.mjs', [], { OPENCRAFT_ENGINE_HOST_CONFIG: paths.engineConfig });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      await Promise.all([coreHealth(paths.coreEndpoint, paths.tokenPath), readEngineHostIdentity(paths.engineDescriptor), readDshHostIdentity(paths.dshDescriptor)]);
      ready = true; break;
    } catch { await new Promise(accept => setTimeout(accept, 500)); }
  }
  if (!ready || failed || stopping) throw new Error('Native execution Host did not become ready');
  console.log('OpenCraft native execution Hosts ready; start docker compose in a separate terminal.');
} catch (error) {
  console.error(error.message);
  await stop(1);
}
