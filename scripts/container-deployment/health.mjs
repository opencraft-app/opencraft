import { createConnection } from 'node:net';
import { deploymentPaths } from './paths.mjs';
import { coreHealth } from '../server-deployment/execution.mjs';
import { readDshHostIdentity } from '../server-deployment/dsh-host-client.mjs';
import { readEngineHostIdentity } from '../server-deployment/engine-host-client.mjs';

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
  const browserDirectory = environment.OPENCRAFT_BROWSER_DATA_DIR;
  const executionSocket = environment.OPENCRAFT_HANDS_EXECUTION_SOCKET;
  if (!browserDirectory?.startsWith('/') || !executionSocket?.startsWith('/')) throw new Error('Hands health paths are invalid');
  await Promise.all([
    probeSocket(`${browserDirectory}/owner.sock`, { type: 'probe', protocol: 1 }, value => value.type === 'healthy' && value.protocol === 1),
    probeSocket(executionSocket, { type: 'probe', protocol: 1 }, value => value.type === 'healthy' && value.protocol === 1),
  ]);
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
  const check = mode === 'hands' ? checkHands : mode === 'brain' ? checkBrain : null;
  if (!check) throw new Error('Usage: opencraft-health hands|brain');
  await check();
}
