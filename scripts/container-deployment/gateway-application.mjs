import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeadlessArguments, startHeadlessServer } from '../../apps/headless-server/src/headless-application.mjs';
import { validateHeadlessExtensions } from '../../apps/headless-server/src/headless-extensions.mjs';
import { attachDshHost, readDshHostIdentity } from '../../apps/headless-server/src/server-deployment/dsh-host-client.mjs';
import { readEngineHostIdentity } from '../../apps/headless-server/src/server-deployment/engine-host-client.mjs';
import { codexBridgePrograms, observeExecutionHealth } from '../server-deployment/headless-gateway-application.mjs';
import { deploymentPaths, readPrivateToken } from './paths.mjs';
import { openGatewayWorkspace } from './gateway-workspace.mjs';

export async function startContainerGateway(composition = {}) {
  // Malformed composition fails before any deployment owner is contacted.
  validateHeadlessExtensions(composition.extensions);
  // This delivery attaches existing owners. It never starts an execution engine.
  const paths = deploymentPaths();
  // AccountCore (§5) is the only owner still reached through the shared run directory.
  const token = await readPrivateToken(paths.tokenPath);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const options = parseHeadlessArguments(process.argv.slice(2));
  if (options.help) throw new Error('Configure this deployment through deploy/docker/compose.yaml; see deploy/docker/README.md');
  if (options.dataDirectory !== paths.dataDirectory || (options.engines ?? ['dsh']).join() !== 'dsh,pi')
    throw new Error('The container gateway requires the shared data directory and external execution Hosts');
  const home = process.env.OPENCRAFT_GATEWAY_HOME ?? join(paths.dataDirectory, 'home', 'gateway');
  if (!home.startsWith('/')) throw new Error('Gateway home must be absolute');
  await mkdir(home, { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  // Codex runs through the Gateway's own Engine Host by default (OPENCRAFT_CODEX_BRIDGE=0 keeps the
  // legacy path). Its provider takes broker auth from the account Core and reaches the workspace's
  // native AppServer (Brain) through the codex-native endpoint; native commands still run in Hands.
  const bridgePrograms = await codexBridgePrograms(root, options, process.env, 'runtime/codex-bridge');
  // Brain and Hands owners are workspace endpoints, reached through the configured
  // provider; a missing or unready workspace fails startup like a missing owner did.
  const workspace = await openGatewayWorkspace({ dataDirectory: paths.dataDirectory });
  let app;
  try {
    await Promise.all([workspace.codexHealth(), readEngineHostIdentity(workspace.piDescriptor), readDshHostIdentity(workspace.dshDescriptor)]);
    app = await startHeadlessServer({
      ...options, root, webRoot: join(root, 'web'),
      // The vault owner publishes its issuer where Brain pins it into DSH, Pi and the Codex AppServer.
      ...(paths.environmentDelivery ? { environmentIssuer: { ...options.environmentIssuer, publish: paths.environmentIssuerFile } } : {}),
      runtimeDirectory: paths.runtimeDirectory,
      threadCliDirectory: paths.threadCliDirectory,
      terminalOwner: { directory: join(home, 'terminal'), endpoint: workspace.sockets.terminal, tokenFile: workspace.tokenFiles.terminal },
      fileSystemOwner: { endpoint: workspace.sockets.files, tokenFile: workspace.tokenFiles.files },
      browserOwnerSocket: workspace.sockets.browser,
      engineHostDescriptor: workspace.piDescriptor,
      startAgentHost: options => attachDshHost(workspace.dshDescriptor, options.dataDirectory, options.machineIdentity.machineId),
      codexCoreEndpoint: paths.coreEndpoint,
      codexCoreAuthToken: token,
      codexRuntime: workspace.codexRuntime,
      ...(bridgePrograms ? { codexBridgePrograms: bridgePrograms } : {}),
      getExecutionHealth: () => observeExecutionHealth({
        version: manifest.version, buildId: manifest.buildId,
        core: async () => { await workspace.observe(); return workspace.executionHealth(paths.coreEndpoint, paths.tokenPath); },
        dsh: () => readDshHostIdentity(workspace.dshDescriptor),
        engineHost: () => readEngineHostIdentity(workspace.piDescriptor),
      }),
    }, composition);
  } catch (error) {
    await workspace.close().catch(() => {});
    throw error;
  }
  console.log(`OpenCraft WebUI: ${app.url}`);
  let closing;
  const stop = () => closing ??= app.close().finally(() => workspace.close()).then(() => process.exit(0), () => process.exit(1));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return app;
}
