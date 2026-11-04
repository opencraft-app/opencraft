import { isAbsolute, join, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

export function deploymentPaths(env = process.env) {
  const data = env.OPENCRAFT_DATA_DIR;
  const workspace = env.OPENCRAFT_WORKSPACE_DIR;
  if (![data, workspace].every(value => typeof value === 'string' && isAbsolute(value)))
    throw new Error('Set OPENCRAFT_DATA_DIR and OPENCRAFT_WORKSPACE_DIR to absolute host paths');
  const dataDirectory = resolve(data), runtimeDirectory = resolve(workspace);
  if (dataDirectory === '/' || runtimeDirectory === '/' || dataDirectory === runtimeDirectory)
    throw new Error('Use separate data and workspace directories, neither at the filesystem root');
  return {
    dataDirectory, runtimeDirectory,
    runDirectory: join(dataDirectory, 'run'),
    tokenPath: join(dataDirectory, 'daemon.token'),
    coreEndpoint: join(dataDirectory, 'run', 'codex-core.sock'),
    appServerEndpoint: join(dataDirectory, 'run', 'codex-app-server.sock'),
    engineDescriptor: join(dataDirectory, 'run', 'engine-host.json'),
    engineConfig: join(dataDirectory, 'run', 'engine-host-config.json'),
    dshDescriptor: join(dataDirectory, 'run', 'dsh-host.json'),
    dshConfig: join(dataDirectory, 'run', 'dsh-host-config.json'),
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
