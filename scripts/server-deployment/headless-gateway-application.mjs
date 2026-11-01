import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeadlessServer, parseHeadlessArguments } from '../headless-application.mjs';
import { coreHealth } from './execution.mjs';
import { readEngineHostIdentity } from './engine-host-client.mjs';
import { attachDshHost, readDshHostIdentity } from './dsh-host-client.mjs';
import { readGatewayUpdateIntent } from './gateway-update-intent.mjs';

/** Read dependencies concurrently and retain release identity even when one is
 * unavailable. A live gateway and a ready execution service are different facts. */
export async function observeExecutionHealth({ version, buildId, core, dsh, engineHost }) {
  const [coreResult, dshResult, engineResult] = await Promise.allSettled([core(), dsh?.(), engineHost?.()]);
  const coreReady = coreResult.status === 'fulfilled';
  const dshReady = dshResult.status === 'fulfilled';
  const engineReady = engineResult.status === 'fulfilled';
  return { ok: coreReady && dshReady && engineReady, profile: 'headless', version, buildId,
    core: coreReady ? coreResult.value : { state: 'unavailable' },
    ...(dsh ? { dsh: dshReady ? dshResult.value : { state: 'unavailable' } } : {}),
    ...(engineHost ? { engineHost: engineReady ? engineResult.value : {state:'unavailable'} } : {}),
    dependencies: { ...(engineHost ? {engineHost:engineReady ? 'ready' : 'unavailable'} : {}), core: coreReady ? 'ready' : 'unavailable', dsh: dsh ? dshReady ? 'ready' : 'unavailable' : 'disabled' } };
}

/** The stable execution pointer preserves its identity while web-only releases
 * switch. Read the manifest through that pointer for every health observation. */
export async function readCurrentReleaseManifest(releaseRoot, executable = process.argv[1]) {
  const pointerRoot = typeof executable === 'string' && isAbsolute(executable)
    && basename(dirname(executable)) === 'execution'
    ? dirname(dirname(executable)) : releaseRoot;
  const value = JSON.parse(await readFile(join(pointerRoot, 'package.json'), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release manifest');
  return value;
}
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** Apply a signed package's engine profile without allowing a deployment config
 * to activate an engine that the package did not declare. An explicit subset
 * remains useful for operators; an omitted selection receives the profile's
 * default so a Pi-only package cannot fall back to the legacy DSH default. */
export function applyExecutionProfile(argv, manifest) {
  const profile = manifest?.opencraftExecution?.engines;
  if (profile === undefined) return [...argv];
  if (!Array.isArray(profile) || profile.length === 0 || new Set(profile).size !== profile.length
    || profile.some(engine => !['pi', 'dsh'].includes(engine))) throw new Error('Invalid release execution profile');
  for (const flag of ['--engines', '--default-engine']) {
    if (argv.filter(value => value === flag).length > 1) throw new Error('Duplicate Headless execution selection');
  }
  const selectionIndex = argv.indexOf('--engines');
  const selected = selectionIndex >= 0 ? (argv[selectionIndex + 1] ?? '').split(',').filter(Boolean) : profile;
  if (!selected.length || selected.some(engine => !profile.includes(engine))) throw new Error('Headless configuration requests an engine outside the release profile');
  const result = [...argv];
  if (selectionIndex < 0) {
    result.push('--engines', profile.join(','));
    if (typeof manifest?.opencraftExecution?.defaultEngine === 'string' && !argv.includes('--default-engine'))
      result.push('--default-engine', manifest.opencraftExecution.defaultEngine);
  }
  return result;
}
export async function runHeadlessGateway({ parseArguments = parseHeadlessArguments, startServer = startHeadlessServer } = {}) {
  const releaseRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const manifest = JSON.parse(await readFile(join(releaseRoot, 'package.json'), 'utf8'));
  if (manifest.opencraftExecution?.profile !== 'headless') throw new Error('Headless execution profile required');
  if (process.env.OPENCRAFT_DSH_HOST_DESCRIPTOR && manifest.opencraftExecution.independentDshHost !== 1)
    throw new Error('Release cannot attach an independent DSH Host; crossing this migration boundary requires drained maintenance');
  const configPath = required('OPENCRAFT_HEADLESS_CONFIG');
  if (!isAbsolute(configPath)) throw new Error('Headless configuration path must be absolute');
  const info = await stat(configPath);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('Headless configuration must be an owned private file');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => key !== 'argv')
    || !Array.isArray(config.argv) || !config.argv.every(value => typeof value === 'string')) throw new Error('Invalid Headless configuration');
  const options = parseArguments(applyExecutionProfile(config.argv, manifest));
  if (options.help) throw new Error('Headless configuration cannot request help');
  if (options.port < 1) throw new Error('Managed Headless requires a fixed loopback port');
  const tokenPath = required('OPENCRAFT_DAEMON_TOKEN_FILE');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  const endpoint = required('OPENCRAFT_CODEX_CORE_ENDPOINT');
  const health = () => coreHealth(endpoint, tokenPath);
  const dshDescriptor = process.env.OPENCRAFT_DSH_HOST_DESCRIPTOR;
  const engineHostDescriptor = process.env.OPENCRAFT_ENGINE_HOST_DESCRIPTOR;
  if (engineHostDescriptor && manifest.opencraftExecution.independentEngineHost !== 1) throw new Error('Release cannot attach an independent execution Host');
  const app = await startServer({ ...options, ...(engineHostDescriptor ? {engineHostDescriptor} : {}), root: releaseRoot, webRoot: join(releaseRoot, 'web'),
    ...(dshDescriptor ? {
      startAgentHost: async agentOptions => {
        return attachDshHost(dshDescriptor, agentOptions.dataDirectory, agentOptions.machineIdentity.machineId);
      },
    } : {}),
    // Admission continues to consume the configured public host; bind only on loopback.
    listenHost: '127.0.0.1',
    runtimeDirectory: required('OPENCRAFT_RUNTIME_DIRECTORY'),
    dshExecutable: required('OPENCRAFT_DSH_EXECUTABLE'),
    dshCapabilityPlugin: join(releaseRoot, 'execution/dsh-capability-plugin.mjs'),
    codexExecutable: required('OPENCRAFT_CODEX_EXECUTABLE'),
    codexCoreEndpoint: endpoint, codexCoreAuthToken: token,
    getExecutionHealth: async () => {
      const current = await readCurrentReleaseManifest(releaseRoot);
      const observed = await observeExecutionHealth({ version: typeof current.version === 'string' ? current.version : null,
        buildId: typeof current.opencraftWeb?.buildId === 'string' ? current.opencraftWeb.buildId : null, core: health,
        ...(dshDescriptor ? { dsh: () => readDshHostIdentity(dshDescriptor) } : {}),
        ...(engineHostDescriptor ? {engineHost:() => readEngineHostIdentity(engineHostDescriptor)} : {}),
      });
      return { ...observed, runtimeReleaseRoot: releaseRoot, storageWriterProtocol: 2 };
    },
  });
  console.log(`[opencraft headless] ${app.url}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    try { await app.close(await readGatewayUpdateIntent()); process.exit(0); }
    catch (error) { console.error(error); process.exit(1); }
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);

  return app;
}
