import { isAbsolute, join, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

export const codexProjectlessDirectory = workspaceDirectory => join(workspaceDirectory, 'sessions', 'codex');

/** embedded: Brain starts the account Core itself (default). external: a separate proxy service owns it. */
export function proxyConfiguration(env = process.env) {
  const mode = env.OPENCRAFT_PROXY_MODE ?? 'embedded';
  if (!['embedded', 'external'].includes(mode)) throw new Error('OPENCRAFT_PROXY_MODE must be embedded or external');
  const raw = env.OPENCRAFT_PROXY_PORT;
  const port = raw === undefined || raw === '' ? null : Number(raw);
  if (port !== null && (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(port) || port < 1024 || port > 65535))
    throw new Error('OPENCRAFT_PROXY_PORT must be an integer from 1024 to 65535');
  if (mode === 'external' && port === null) throw new Error('An external model proxy requires a fixed OPENCRAFT_PROXY_PORT');
  return { proxyMode: mode, proxyPort: port };
}

export function deploymentPaths(env = process.env) {
  const data = env.OPENCRAFT_DATA_DIR;
  const workspace = env.OPENCRAFT_WORKSPACE_DIR;
  if (![data, workspace].every(value => typeof value === 'string' && isAbsolute(value)))
    throw new Error('Set OPENCRAFT_DATA_DIR and OPENCRAFT_WORKSPACE_DIR to absolute deployment paths');
  const dataDirectory = resolve(data), runtimeDirectory = resolve(workspace);
  if (dataDirectory === '/' || runtimeDirectory === '/' || dataDirectory === runtimeDirectory)
    throw new Error('Use separate data and workspace directories, neither at the filesystem root');
  const absolute = (name, fallback) => {
    const value = env[name] ?? fallback;
    if (!isAbsolute(value) || resolve(value) === '/') throw new Error(`${name} must be an absolute non-root path`);
    return resolve(value);
  };
  const executionContext=env.OPENCRAFT_EXECUTION_CONTEXT??'assets';
  if(!['assets','legacy'].includes(executionContext))throw Error('OPENCRAFT_EXECUTION_CONTEXT must be assets or legacy');
  const executionDirectory = absolute('OPENCRAFT_EXECUTION_DIR', join(dataDirectory, 'execution'));
  // Container-private (tmpfs in Compose): never under the shared data or execution mounts.
  const agentRunDirectory = absolute('OPENCRAFT_AGENT_RUN_DIR', '/run/opencraft-agent');
  if ([dataDirectory, runtimeDirectory, executionDirectory].some(root => agentRunDirectory === root || agentRunDirectory.startsWith(root + '/')))
    throw new Error('OPENCRAFT_AGENT_RUN_DIR must be container-private, outside the shared mounts');
  const agentLinkDirectory = env.OPENCRAFT_AGENT_LINK_DIR ? absolute('OPENCRAFT_AGENT_LINK_DIR', '') : null;
  if (agentLinkDirectory && [dataDirectory, runtimeDirectory, executionDirectory, agentRunDirectory].some(root => agentLinkDirectory === root
    || agentLinkDirectory.startsWith(root + '/') || root.startsWith(agentLinkDirectory + '/')))
    throw new Error('OPENCRAFT_AGENT_LINK_DIR must be a dedicated link mount, outside the shared and private directories');
  return {
    dataDirectory, runtimeDirectory, executionDirectory, executionContext, ...proxyConfiguration(env),
    threadCliDirectory: join(executionDirectory, 'cli'),
    terminalDirectory: join(executionDirectory, 'terminal'),
    terminalEndpoint: join(executionDirectory, 'terminal.sock'),
    terminalToken: join(executionDirectory, 'terminal.token'),
    fileSystemEndpoint: join(executionDirectory, 'files.sock'),
    fileSystemToken: join(executionDirectory, 'files.token'),
    logDirectory: absolute('OPENCRAFT_LOG_DIR', '/var/log/opencraft'),
    browserDirectory: absolute('OPENCRAFT_BROWSER_DATA_DIR', join(executionDirectory, 'browser')),
    // AccountCore only (§5): daemon.token, codex-core.sock and proxy-callers/. Brain
    // owners publish nothing here; the Gateway reaches them as workspace endpoints.
    runDirectory: join(dataDirectory, 'run'),
    agentRunDirectory,
    agentControlEndpoint: join(agentRunDirectory, 'control.sock'),
    agentEndpointDirectory: join(agentRunDirectory, 'endpoints'),
    // Mounted only into this container and the Gateway (static-docker link).
    agentLinkDirectory,
    codexPrivateDirectory: join(agentRunDirectory, 'codex'),
    tokenPath: join(dataDirectory, 'daemon.token'),
    coreEndpoint: join(dataDirectory, 'run', 'codex-core.sock'),
    // AppServer owner control (codex-control) and its native facade (codex-native, same directory).
    appServerEndpoint: join(agentRunDirectory, 'codex', 'control.sock'),
    appServerNativeSocket: join(agentRunDirectory, 'codex', 'native.sock'),
    appServerTokenFile: join(agentRunDirectory, 'codex-control.token'),
    engineSocket: join(agentRunDirectory, 'pi.sock'),
    engineDescriptor: join(agentRunDirectory, 'engine-host.json'),
    engineConfig: join(agentRunDirectory, 'engine-host-config.json'),
    dshSocket: join(agentRunDirectory, 'dsh.sock'),
    dshControlSocket: join(agentRunDirectory, 'dsh-control.sock'),
    dshDescriptor: join(agentRunDirectory, 'dsh-host.json'),
    dshConfig: join(agentRunDirectory, 'dsh-host-config.json'),
    sandboxConfig: join(agentRunDirectory, 'codex-hands-sandbox.json'),
    handsExecutionEndpoint: join(executionDirectory, 'exec-owner.sock'),
    handsExecutionToken: join(executionDirectory, 'exec-owner.token'),
    codexProjectlessDirectory: absolute('OPENCRAFT_CODEX_PROJECTLESS_DIR', codexProjectlessDirectory(runtimeDirectory)),
    dshProjectlessDirectory: absolute('OPENCRAFT_DSH_PROJECTLESS_DIR', join(runtimeDirectory, 'sessions', 'dsh')),
  };
}

export async function readPrivateToken(path) {
  const info = await stat(path);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error('Core token must be a private file owned by the deployment user');
  const value = (await readFile(path, 'utf8')).trim();
  if (!value || value.length > 4096) throw new Error('Invalid core token file');
  return value;
}
