import { hostExecutionCli } from '@opencraft/session-capabilities/execution-cli';
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { systemdSandboxBackend } from '@opencraft/sandbox-node';
import { BridgeHost } from './host.js';
import { attachGateway } from './server.js';
// Explicit opt-in executable. No imports from existing engine composition.
const path = process.argv[2];
if (!path || !isAbsolute(path)) throw Error('Supply an absolute private Host configuration path');
const config = JSON.parse(await readFile(path, 'utf8'));
if (config.backend !== 'linux-systemd' || !isAbsolute(config.database)) throw Error('Explicit supported backend and database required');
if(config.automation && (!config.automation.hostId||!config.automation.environment||Object.keys(config.automation).some(key=>!['hostId','environment'].includes(key))))throw Error('Explicit automation Host and environment identities required');
let executionCli;
let launcherEndpoint:string;
if(config.cli) {
  if(!isAbsolute(config.cli.directory)||!isAbsolute(config.cli.signingKey))throw Error('Absolute private CLI configuration required');
  const info=await lstat(config.cli.signingKey);
  if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077||info.uid!==process.getuid?.())throw Error('Private owned CLI signing key required');
  const key=await readFile(config.cli.signingKey);
  if(key.length!==32)throw Error('Invalid CLI signing key');
  executionCli=hostExecutionCli({directory:config.cli.directory,endpoint:config.cli.endpoint,key,launcherEndpoint:()=>launcherEndpoint});
}
const host = await BridgeHost.open({ automation:config.automation, executionCli, path: config.database, policy: config.policy, backend: systemdSandboxBackend(config.backendOptions) });
if (config.generations !== undefined) {
  if (!Array.isArray(config.generations) || config.generations.length > 16) throw Error('Invalid generation list');
  for (const generation of config.generations) await host.add(generation);
}
if (config.activate !== undefined) {
  if (typeof config.activate !== 'string' || !config.activate) throw Error('Invalid generation activation');
  const snapshot = await host.snapshot();
  await host.activate(config.activate, typeof snapshot.current === 'string' ? snapshot.current : '');
}
const gateway = await attachGateway(host, config.token, config.port ?? 0);
launcherEndpoint=new URL('/thread-cli',gateway.url).href;
process.stdout.write(JSON.stringify({ url: gateway.url, pid: process.pid }) + '\n');
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  try { await gateway.close(); await host.close(); process.exitCode = 0; }
  catch { process.stderr.write('Bridge Host cleanup unconfirmed\n'); process.exitCode = 1; }
};
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
