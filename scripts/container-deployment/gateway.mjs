import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeadlessArguments, startHeadlessServer } from '../headless-application.mjs';
import { coreHealth } from '../server-deployment/execution.mjs';
import { attachDshHost, readDshHostIdentity } from '../server-deployment/dsh-host-client.mjs';
import { readEngineHostIdentity } from '../server-deployment/engine-host-client.mjs';
import { observeExecutionHealth } from '../server-deployment/headless-gateway-application.mjs';
import { deploymentPaths, readPrivateToken } from './paths.mjs';

// This delivery attaches existing owners. It never starts an execution engine.
const paths = deploymentPaths();
const token = await readPrivateToken(paths.tokenPath);
await readEngineHostIdentity(paths.engineDescriptor);
await readDshHostIdentity(paths.dshDescriptor);
await coreHealth(paths.coreEndpoint, paths.tokenPath);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const options = parseHeadlessArguments(process.argv.slice(2));
if (options.help) throw new Error('Configure this deployment through docker/compose.yaml; see docker/README.md');
if (options.dataDirectory !== paths.dataDirectory || (options.engines ?? ['dsh']).join() !== 'dsh,pi')
  throw new Error('The container gateway requires the shared data directory and external execution Hosts');
await mkdir(join(paths.dataDirectory, 'container-home'), { recursive: true, mode: 0o700 });
process.env.HOME = join(paths.dataDirectory, 'container-home');
const app = await startHeadlessServer({
  ...options, root, webRoot: join(root, 'web'),
  runtimeDirectory: paths.runtimeDirectory,
  engineHostDescriptor: paths.engineDescriptor,
  startAgentHost: options => attachDshHost(paths.dshDescriptor, options.dataDirectory, options.machineIdentity.machineId),
  codexCoreEndpoint: paths.coreEndpoint,
  codexCoreAuthToken: token,
  getExecutionHealth: () => observeExecutionHealth({
    version: manifest.version, buildId: manifest.buildId,
    core: () => coreHealth(paths.coreEndpoint, paths.tokenPath),
    dsh: () => readDshHostIdentity(paths.dshDescriptor),
    engineHost: () => readEngineHostIdentity(paths.engineDescriptor),
  }),
});
console.log(`OpenCraft WebUI: ${app.url}`);
let closing;
const stop = () => closing ??= app.close().then(() => process.exit(0), () => process.exit(1));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
