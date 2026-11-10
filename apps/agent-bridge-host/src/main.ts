import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { systemdSandboxBackend } from '@opencraft/sandbox-node';
import { BridgeHost } from './host.js';
import { attachGateway } from './server.js';
// Explicit opt-in executable. No imports from existing engine composition.
const path = process.argv[2];
if (!path || !isAbsolute(path)) throw Error('Supply an absolute private Host configuration path');
const config = JSON.parse(await readFile(path, 'utf8'));
if (config.backend !== 'linux-systemd' || !isAbsolute(config.database)) throw Error('Explicit supported backend and database required');
const host = await BridgeHost.open({ path: config.database, policy: config.policy, backend: systemdSandboxBackend(config.backendOptions) });
const gateway = await attachGateway(host, config.token, config.port ?? 0);
process.stdout.write(JSON.stringify({ url: gateway.url, pid: process.pid }) + '\n');
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  try { await gateway.close(); await host.close(); process.exitCode = 0; }
  catch { process.stderr.write('Bridge Host cleanup unconfirmed\n'); process.exitCode = 1; }
};
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
