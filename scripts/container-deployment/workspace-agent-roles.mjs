import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { readPrivateToken } from './paths.mjs';
import { handsResources } from './resources.mjs';
import { coreHealth } from '../server-deployment/execution.mjs';
import { readDshHostIdentity } from '../../apps/headless-server/src/server-deployment/dsh-host-client.mjs';
import { readEngineHostIdentity } from '../../apps/headless-server/src/server-deployment/engine-host-client.mjs';
import { readHandsIncarnation, watchHandsIncarnation } from './hands-incarnation.mjs';
import { codexCoreArguments, waitForProxy } from './proxy-core.mjs';

/** Roles are composition: which owners this agent supervises. They contain no provider
 * branch; a container (static Compose service today, a provisioned workspace later)
 * selects roles, and the supervisor treats every role child the same way. */

const privateDirectory = async (path, message) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error(message);
};
const isSocket = async path => (await stat(path)).isSocket() || Promise.reject(new Error(`${path} is not a socket`));
const node = root => join(root, 'bin/node');
const runtime = (root, entry) => join(root, 'runtime', entry);

/** Brain: Codex AppServer owner (+ native app-server), DSH and Pi engine hosts, and the
 * embedded account Core only when no proxy service owns it. */
export const brainRole = {
  name: 'brain',
  async start(agent, { paths, root, env }) {
    await privateDirectory(paths.dataDirectory, 'The data directory must be owned by this user with mode 0700');
    await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
    await mkdir(paths.runDirectory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(join(paths.dataDirectory, 'native-host'), { realpath: false, retries: 0 });
    agent.defer(() => release());
    // Releases before the workspace agent kept launch configuration and the native
    // listener in the shared run directory; under the lock no other Brain uses them.
    for (const name of ['engine-host-config.json', 'dsh-host-config.json', 'codex-hands-sandbox.json', 'native-internal.sock'])
      await rm(join(paths.runDirectory, name), { force: true });
    const executionResources = handsResources(env);
    try { await writeFile(paths.tokenPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await readPrivateToken(paths.tokenPath);
    // Launch configuration is agent-private: only this container's children read it.
    await writeFile(paths.engineConfig, JSON.stringify({
      descriptorPath: paths.engineDescriptor, dataDirectory: paths.dataDirectory,
      runtimeDirectory: paths.runtimeDirectory, engines: ['dsh', 'pi'], defaultEngine: 'pi',
      executionContext: paths.executionContext, gitWorkerFile: runtime(root, 'personal-git-worker.mjs'),
      dshDescriptorPath: paths.dshDescriptor,
      fileSystemOwner: { endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken },
    }) + '\n', { mode: 0o600 });
    await writeFile(paths.dshConfig, JSON.stringify({
      executionContext: paths.executionContext,
      fileSystemOwner: { endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken },
      artifactDirectory: join(paths.dataDirectory, 'artifacts'),
      descriptorPath: paths.dshDescriptor, dataDirectory: join(paths.dataDirectory, 'agent'),
      machineIdentityDirectory: paths.dataDirectory, runtimeDirectory: paths.runtimeDirectory,
      dshExecutable: env.OPENCRAFT_DSH_EXECUTABLE?.trim() || runtime(root, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),
      dshCapabilityPlugin: runtime(root, 'dsh/opencraft-capability-plugin.mjs'),
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
    const start = (name, entry, argv = [], extra = {}, options = {}) => agent.start(name, node(root), [runtime(root, entry), ...argv],
      { cwd: paths.runtimeDirectory, env: { ...env, ...extra }, ...options });
    if (paths.proxyMode === 'external') {
      // The proxy service owns the account Core and its fixed port; Brain only waits for it.
      console.log(JSON.stringify({ type: 'model-proxy-ready', ...await waitForProxy(paths.coreEndpoint, paths.tokenPath, { signal: agent.signal }) }));
    } else {
      // One fixed proxy port for this independently supervised execution lifetime.
      let proxyPort = paths.proxyPort;
      if (proxyPort === null) {
        const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
        proxyPort = listener.address().port;
        await new Promise(accept => listener.close(accept));
      }
      start('codex-core', 'codex-core.cjs', codexCoreArguments(paths, root, proxyPort));
    }
    // Capture the Hands identity before Native can attach an execution lease.
    const handsIncarnation = await agent.waitUntil(signal => readHandsIncarnation(paths.handsExecutionEndpoint, { signal }),
      { description: 'Hands execution owner' });
    const appServerArgs = [
      '--endpoint', paths.appServerEndpoint, '--core-endpoint', paths.coreEndpoint,
      '--token-file', paths.tokenPath, '--codex-executable', runtime(root, 'codex/bin/codex'),
      '--runtime-directory', paths.runtimeDirectory, '--data-directory', join(paths.dataDirectory, 'codex'),
      '--private-directory', paths.codexPrivateDirectory,
    ];
    const appServerEnv = { OPENCRAFT_SANDBOX_CONFIG: paths.sandboxConfig, OPENCRAFT_CODEX_PROJECTLESS_DIR: paths.codexProjectlessDirectory };
    // The AppServer owner and its native process form one process group.
    const startAppServer = () => start('codex-app-server', 'codex-app-server.cjs', appServerArgs, appServerEnv, { processGroup: true });
    let appServer = startAppServer();
    // With an external proxy, engines reach configured providers through it with their own caller token.
    const callerFile = name => paths.proxyMode === 'external' ? { OPENCRAFT_PROXY_CALLER_FILE: join(paths.runDirectory, 'proxy-callers', name + '.json') } : {};
    start('dsh-host', 'dsh-host.mjs', [], { OPENCRAFT_DSH_HOST_CONFIG: paths.dshConfig, ...callerFile('dsh') });
    start('engine-host', 'engine-host.mjs', [], { OPENCRAFT_ENGINE_HOST_CONFIG: paths.engineConfig, ...callerFile('pi') });
    await agent.waitUntil(() => Promise.all([coreHealth(paths.coreEndpoint, paths.tokenPath),
      readEngineHostIdentity(paths.engineDescriptor), readDshHostIdentity(paths.dshDescriptor)]), { description: 'Native execution Host' });
    // Gateway/proxy still reach these two through the shared run directory until step 4c.
    await agent.publishEndpoint('codex-control', paths.appServerEndpoint);
    await agent.publishEndpoint('codex-native', join(paths.runDirectory, 'native.sock'));
    return {
      // Runs after the agent is ready. A different Hands owner invalidates every cached
      // stdio execution connection, so the AppServer is replaced, never patched.
      afterReady: () => watchHandsIncarnation({
        initial: handsIncarnation,
        signal: agent.signal,
        probe: () => readHandsIncarnation(paths.handsExecutionEndpoint, { signal: agent.signal }),
        replace: async () => {
          const next = await agent.replace(appServer, startAppServer);
          if (!next) return;
          appServer = next;
          await agent.waitUntil(() => coreHealth(paths.coreEndpoint, paths.tokenPath), { description: 'Codex execution owner' });
          console.log(JSON.stringify({ type: 'codex-hands-owner-rebound' }));
        },
      }).catch(() => agent.stop(1, 'Hands owner rebinding failed')),
    };
  },
};

/** Hands: fixed Codex exec-server owner, terminal owner (holds the PTYs; Host/Gateway
 * disconnects never end them) and the resident filesystem owner. */
export const handsRole = {
  name: 'hands',
  async start(agent, { paths, root, env, startServices = async () => [] }) {
    const services = await startServices(() => void agent.stop(1, 'composition service failed'));
    agent.defer(() => Promise.all(services.map(service => service.close())));
    const owners = [
      ['exec', 'hands-execution-owner.mjs', [], env.OPENCRAFT_HANDS_EXECUTION_SOCKET],
      ['terminal', 'hands-terminal-owner.mjs', ['--hands-terminal-owner'], paths.terminalEndpoint],
      ['files', 'hands-files-owner.mjs', [], paths.fileSystemEndpoint],
    ];
    if (!owners[0][3]?.startsWith('/')) throw new Error('Set OPENCRAFT_HANDS_EXECUTION_SOCKET to an absolute path');
    for (const [name, entry, argv] of owners)
      agent.start(name, node(root), [runtime(root, entry), ...argv], { cwd: paths.runtimeDirectory, env });
    await agent.waitUntil(() => Promise.all(owners.map(([, , , socket]) => isSocket(socket))), { attempts: 120, description: 'Hands owners' });
    for (const [name, , , socket] of owners) await agent.publishEndpoint(name, socket);
    return {};
  },
};

/** Optional remote browser owner. */
export const browserRole = {
  name: 'browser',
  async start(agent, { paths, root, env }) {
    const data = env.OPENCRAFT_BROWSER_DATA_DIR;
    if (!data || !data.startsWith('/')) throw new Error('Set OPENCRAFT_BROWSER_DATA_DIR to an absolute path');
    await privateDirectory(data, 'Hands data directory must be private and owned by this user');
    agent.start('browser', node(root), [runtime(root, 'browser/owner.cjs')], { cwd: paths.runtimeDirectory, env });
    const socket = join(data, 'owner.sock');
    await agent.waitUntil(() => isSocket(socket), { attempts: 120, description: 'Browser owner' });
    await agent.publishEndpoint('browser', socket);
    return {};
  },
};

export const WORKSPACE_AGENT_ROLES = Object.freeze({ brain: brainRole, hands: handsRole, browser: browserRole });
