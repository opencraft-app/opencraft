import { isAbsolute, join, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { environmentDeliveryOptions } from '../../apps/headless-server/src/headless-identity.mjs';

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
  // Opaque ENV delivery: Gateway's vault owner publishes its issuer here and
  // Brain pins it into DSH, Pi and the Codex AppServer. Unset keeps every path unchanged.
  const environmentIssuerFile = join(dataDirectory, 'run', 'environment-issuer.json');
  const delivery = environmentDeliveryOptions(env);
  if (delivery.environmentDelivery && executionContext !== 'assets')
    throw new Error('OPENCRAFT_ENVIRONMENT_DELIVERY requires OPENCRAFT_EXECUTION_CONTEXT=assets');
  if (delivery.environmentIssuer?.publish !== undefined && resolve(delivery.environmentIssuer.publish) !== environmentIssuerFile)
    throw new Error('OPENCRAFT_ENVIRONMENT_ISSUER_FILE must be the deployment issuer path');
  return {
    dataDirectory, runtimeDirectory, executionDirectory, executionContext, ...proxyConfiguration(env),
    environmentDelivery: delivery.environmentDelivery ?? null, environmentIssuerFile,
    threadCliDirectory: join(executionDirectory, 'cli'),
    terminalDirectory: join(executionDirectory, 'terminal'),
    terminalEndpoint: join(executionDirectory, 'terminal.sock'),
    terminalToken: join(executionDirectory, 'terminal.token'),
    fileSystemEndpoint: join(executionDirectory, 'files.sock'),
    fileSystemToken: join(executionDirectory, 'files.token'),
    logDirectory: absolute('OPENCRAFT_LOG_DIR', '/var/log/opencraft'),
    browserDirectory: absolute('OPENCRAFT_BROWSER_DATA_DIR', join(executionDirectory, 'browser')),
    runDirectory: join(dataDirectory, 'run'),
    tokenPath: join(dataDirectory, 'daemon.token'),
    coreEndpoint: join(dataDirectory, 'run', 'codex-core.sock'),
    appServerEndpoint: join(dataDirectory, 'run', 'codex-app-server.sock'),
    engineDescriptor: join(dataDirectory, 'run', 'engine-host.json'),
    engineConfig: join(dataDirectory, 'run', 'engine-host-config.json'),
    dshDescriptor: join(dataDirectory, 'run', 'dsh-host.json'),
    dshConfig: join(dataDirectory, 'run', 'dsh-host-config.json'),
    sandboxConfig: join(dataDirectory, 'run', 'codex-hands-sandbox.json'),
    // The split Codex AppServer's `--environment-launch-config` (ENV delivery only).
    codexEnvironmentLaunchConfig: join(dataDirectory, 'run', 'codex-app-server-environment.json'),
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
