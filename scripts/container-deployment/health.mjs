import { createConnection } from 'node:net';
import { deploymentPaths, readPrivateToken } from './paths.mjs';
import { coreHealth } from '../server-deployment/execution.mjs';
import { proxyHealth } from './proxy-core.mjs';
import { readDshHostIdentity } from '../../apps/headless-server/src/server-deployment/dsh-host-client.mjs';
import { readEngineHostIdentity } from '../../apps/headless-server/src/server-deployment/engine-host-client.mjs';
import { createHostFileSystem } from '../../apps/headless-server/src/host-filesystem.ts';

const timeoutMs = 4000;
function probeSocket(path, frame, expected) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let buffer = '', finished = false;
    const finish = error => {
      if (finished) return; finished = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Health probe timed out: ${path}`)), timeoutMs);
    timer.unref();
    socket.setEncoding('utf8');
    socket.once('error', finish);
    socket.once('connect', () => socket.write(JSON.stringify(frame) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) { if (buffer.length > 64 * 1024) finish(new Error('Health response exceeds its budget')); return; }
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (!expected(response)) throw new Error('Owner rejected its health protocol');
        finish();
      } catch (error) { finish(error); }
    });
  });
}

export async function checkHands(environment = process.env) {
  const paths = deploymentPaths(environment);
  const files = createHostFileSystem({ endpoint: paths.fileSystemEndpoint, tokenFile: paths.fileSystemToken });
  const terminalToken = await readPrivateToken(paths.terminalToken);
  const browserDirectory = environment.OPENCRAFT_BROWSER_DATA_DIR;
  const executionSocket = environment.OPENCRAFT_HANDS_EXECUTION_SOCKET;
  if (!browserDirectory?.startsWith('/') || !executionSocket?.startsWith('/')) throw new Error('Hands health paths are invalid');
  try { await Promise.all([
    files.probe(AbortSignal.timeout(timeoutMs)),
    probeSocket(`${browserDirectory}/owner.sock`, { type: 'probe', protocol: 1 }, value => value.type === 'healthy' && value.protocol === 1),
    probeSocket(executionSocket, { type: 'probe', protocol: 1 }, value => value.type === 'healthy' && value.protocol === 1),
    probeSocket(paths.terminalEndpoint, { type: 'probe', protocol: 1, token: terminalToken }, value => value.type === 'healthy' && value.protocol === 1),
  ]); } finally { files.close(); }
}

export async function checkProxy(environment = process.env) {
  const paths = deploymentPaths(environment);
  await proxyHealth(paths.coreEndpoint, paths.tokenPath, timeoutMs);
}

export async function checkBrain(environment = process.env) {
  const paths = deploymentPaths(environment);
  await Promise.all([
    coreHealth(paths.coreEndpoint, paths.tokenPath),
    readEngineHostIdentity(paths.engineDescriptor),
    readDshHostIdentity(paths.dshDescriptor),
  ]);
}

const mode = process.argv[2];
if (mode) {
  const check = mode === 'hands' ? checkHands : mode === 'brain' ? checkBrain : mode === 'proxy' ? checkProxy : null;
  if (!check) throw new Error('Usage: opencraft-health hands|brain|proxy');
  await check();
}
