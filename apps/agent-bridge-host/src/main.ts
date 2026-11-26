import { hostExecutionCli } from '@opencraft/session-capabilities/execution-cli';
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { systemdSandboxBackend } from '@opencraft/sandbox-node';
import { nodeSandboxBackends } from '@opencraft/sandbox-node/runtime';
import { BridgeHost } from './host.js';
import { attachGateway, attachGatewaySocket } from './server.js';
// Explicit opt-in executable. No imports from existing engine composition.
const path = process.argv[2];
if (!path || !isAbsolute(path)) throw Error('Supply an absolute private Host configuration path');
const config = JSON.parse(await readFile(path, 'utf8'));
if (config.socketPath !== undefined &&
    (typeof config.socketPath !== 'string' || !isAbsolute(config.socketPath) || config.port !== undefined || config.cli !== undefined))
  throw Error('Private Bridge socket requires an absolute path and no loopback CLI listener');
// The backend is always explicit; there is no fallback to another one.
const BACKENDS = ['linux-systemd', 'host-process', 'hands-unix'];
if (!BACKENDS.includes(config.backend) || !isAbsolute(config.database)) throw Error('Explicit supported backend and database required');
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
if (config.generations !== undefined && (!Array.isArray(config.generations) || config.generations.length > 16))
  throw Error('Invalid generation list');
if (config.activate !== undefined && (typeof config.activate !== 'string' || !config.activate))
  throw Error('Invalid generation activation');
if (config.cutoverCodex !== undefined && typeof config.cutoverCodex !== 'boolean')
  throw Error('Invalid Codex startup cutover');
const host = await BridgeHost.open({
  automation: config.automation, executionCli, path: config.database, policy: config.policy,
  backend: config.backend === 'linux-systemd' ? systemdSandboxBackend(config.backendOptions) : await nodeSandboxBackends[config.backend]!(config.backendOptions),
  startup: { generations: config.generations, activate: config.activate, cutoverCodex: config.cutoverCodex },
});
const gateway = config.socketPath === undefined
  ? await attachGateway(host, config.token, config.port ?? 0)
  : await attachGatewaySocket(host, config.token, config.socketPath);
const address = 'url' in gateway ? { url: gateway.url } : { socketPath: gateway.socketPath };
if ('url' in gateway) launcherEndpoint=new URL('/thread-cli',gateway.url).href;
process.stdout.write(JSON.stringify({ ...address, pid: process.pid }) + '\n');
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  try { await gateway.close(); await host.close(); process.exitCode = 0; }
  catch (error) {
    const reasons = error instanceof AggregateError ? error.errors : [error];
    process.stderr.write(`Bridge Host cleanup unconfirmed: ${reasons.map(reason => reason instanceof Error ? reason.message : String(reason)).join('; ').slice(0, 500)}\n`);
    process.exitCode = 1;
  }
};
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
