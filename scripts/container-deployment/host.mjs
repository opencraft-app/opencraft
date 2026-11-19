import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { deploymentPaths, readPrivateToken } from './paths.mjs';
import { handsResources } from './resources.mjs';
import { coreHealth } from '../server-deployment/execution.mjs';
import { readDshHostIdentity } from '../server-deployment/dsh-host-client.mjs';
import { readEngineHostIdentity } from '../server-deployment/engine-host-client.mjs';
import { readHandsIncarnation, watchHandsIncarnation } from './hands-incarnation.mjs';
import { codexCoreArguments, waitForProxy } from './proxy-core.mjs';

// Run this launcher as the independent Brain owner, outside Gateway's lifecycle.
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
  throw new Error('The native execution bundle requires matching Linux arm64 or amd64');
const paths = deploymentPaths();
const executionResources = handsResources();
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
const lifecycle = new AbortController();
async function stop(code = 0) {
  return stopping ??= (async () => {
    lifecycle.abort();
    for (const child of children) if (child.process.exitCode === null && child.process.signalCode === null) child.signal('SIGTERM');
    await Promise.all(children.map(child => child.exited));
    await release();
    process.exitCode = code;
  })();
}
function start(entry, argv, env = {}) {
  if (stopping) throw new Error('Native Host startup was cancelled');
  const child = spawn(join(root, 'bin/node'), [join(root, 'runtime', entry), ...argv], {
    cwd: paths.runtimeDirectory, env: { ...process.env, ...env }, stdio: 'inherit', shell: false,
    detached: entry === 'codex-app-server.cjs',
  });
  const record = {
    process: child, exited: null, replacing: false,
    signal: value => {
      try {
        if (entry === 'codex-app-server.cjs' && child.pid) process.kill(-child.pid, value);
        else child.kill(value);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    },
  };
  const exited = new Promise(accept => {
    child.once('error', () => { failed = true; accept(); void stop(1); });
    child.once('exit', () => { accept(); if (!stopping && !record.replacing) { failed = true; void stop(1); } });
  });
  record.exited = exited; children.push(record);
  return record;
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
    fileSystemOwner: {endpoint:paths.fileSystemEndpoint,tokenFile:paths.fileSystemToken},
  }) + '\n', { mode: 0o600 });
  await writeFile(paths.dshConfig, JSON.stringify({
    fileSystemOwner: {endpoint:paths.fileSystemEndpoint,tokenFile:paths.fileSystemToken},
    artifactDirectory: join(paths.dataDirectory,"artifacts"),
    descriptorPath: paths.dshDescriptor, dataDirectory: join(paths.dataDirectory, 'agent'),
    machineIdentityDirectory: paths.dataDirectory, runtimeDirectory: paths.runtimeDirectory,
    dshExecutable: join(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    dshCapabilityPlugin: join(root, 'runtime/dsh/opencraft-capability-plugin.mjs'),
    modelStorageDirectory: join(paths.dataDirectory, 'models'), speechModelManagement: true,
    projectStorageDirectory: join(paths.dataDirectory, 'projects'),
    projectlessWorkspaceDirectory: paths.dshProjectlessDirectory,
    skillsDirectory: join(paths.dataDirectory, 'skills'),
    taskCodexCoreEndpoint: paths.coreEndpoint, taskCodexCoreTokenFile: paths.tokenPath,
  }) + '\n', { mode: 0o600 });
  await writeFile(paths.sandboxConfig, JSON.stringify({
    schemaVersion: 1,
    backend: { id: 'hands-unix', options: { endpoint: paths.handsExecutionEndpoint, tokenFile: paths.handsExecutionToken } },
    pool: { idPrefix: 'codex-hands', capacity: executionResources, defaults: executionResources },
    environment: { mode: 'selected', names: ['PATH', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'] },
  }) + '\n', { mode: 0o600 });
  await mkdir(join(paths.dataDirectory, 'codex'), { recursive: true, mode: 0o700 });
  if (paths.proxyMode === 'external') {
    // The proxy service owns the account Core and its fixed port; Brain only waits for it.
    console.log(JSON.stringify({ type: 'model-proxy-ready', ...await waitForProxy(paths.coreEndpoint, paths.tokenPath, { signal: lifecycle.signal }) }));
  } else {
    // One fixed proxy port for this independently supervised execution lifetime.
    let proxyPort = paths.proxyPort;
    if (proxyPort === null) {
      const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
      proxyPort = listener.address().port;
      await new Promise(accept => listener.close(accept));
    }
    start('codex-core.cjs', codexCoreArguments(paths, root, proxyPort));
  }
  // Capture the provider identity before Native can attach an execution lease.
  // Older Hands packages without this protocol must be upgraded as a pair.
  let handsIncarnation;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try { handsIncarnation = await readHandsIncarnation(paths.handsExecutionEndpoint, { signal: lifecycle.signal }); break; }
    catch { await new Promise(accept => setTimeout(accept, 500)); }
  }
  if (!handsIncarnation || stopping) throw new Error('Hands execution owner did not become ready');
  const appServerArgs = [
    '--endpoint', paths.appServerEndpoint, '--core-endpoint', paths.coreEndpoint,
    '--token-file', paths.tokenPath, '--codex-executable', join(root, 'runtime/codex/bin/codex'),
    '--runtime-directory', paths.runtimeDirectory, '--data-directory', join(paths.dataDirectory, 'codex'),
  ];
  const appServerEnv = { OPENCRAFT_SANDBOX_CONFIG: paths.sandboxConfig, OPENCRAFT_CODEX_PROJECTLESS_DIR: paths.codexProjectlessDirectory };
  let appServer = start('codex-app-server.cjs', appServerArgs, appServerEnv);
  // With an external proxy, engines reach configured providers through it with their own caller token.
  const callerFile = name => paths.proxyMode === 'external' ? { OPENCRAFT_PROXY_CALLER_FILE: join(paths.runDirectory, 'proxy-callers', name + '.json') } : {};
  start('dsh-host.mjs', [], { OPENCRAFT_DSH_HOST_CONFIG: paths.dshConfig, ...callerFile('dsh') });
  start('engine-host.mjs', [], { OPENCRAFT_ENGINE_HOST_CONFIG: paths.engineConfig, ...callerFile('pi') });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      await Promise.all([coreHealth(paths.coreEndpoint, paths.tokenPath), readEngineHostIdentity(paths.engineDescriptor), readDshHostIdentity(paths.dshDescriptor)]);
      ready = true; break;
    } catch { await new Promise(accept => setTimeout(accept, 500)); }
  }
  if (!ready || failed || stopping) throw new Error('Native execution Host did not become ready');
  void watchHandsIncarnation({
    initial: handsIncarnation,
    signal: lifecycle.signal,
    probe: () => readHandsIncarnation(paths.handsExecutionEndpoint, { signal: lifecycle.signal }),
    replace: async () => {
      // Native caches stdio execution connections for its process lifetime.
      // End the old process and its requests before admitting a replacement.
      appServer.replacing = true;
      appServer.signal('SIGTERM');
      const timer = setTimeout(() => appServer.signal('SIGKILL'), 10_000);
      try { await appServer.exited; } finally { clearTimeout(timer); }
      children.splice(children.indexOf(appServer), 1);
      if (stopping) return;
      appServer = start('codex-app-server.cjs', appServerArgs, appServerEnv);
      let available = false;
      for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
        try { await coreHealth(paths.coreEndpoint, paths.tokenPath); available = true; break; }
        catch { await new Promise(accept => setTimeout(accept, 500)); }
      }
      if (!available && !stopping) throw new Error('Codex execution owner did not reconnect');
      console.log(JSON.stringify({ type: 'codex-hands-owner-rebound' }));
    },
  }).catch(() => { failed = true; void stop(1); });
  console.log('OpenCraft native execution Hosts ready; start docker compose in a separate terminal.');
} catch (error) {
  console.error(error.message);
  await stop(1);
}
