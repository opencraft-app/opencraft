import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, readlink, symlink, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { assertExecutionNativePayload } from './native-preflight.mjs';
import { readEngineHostIdentity } from './engine-host-client.mjs';
import { attachDshHost, readPrivateJson } from './dsh-host-client.mjs';
import { browserRuntimeIdentity } from '../browser-runtime-identity.mjs';
import { withGatewayUpdateIntent } from './gateway-update-intent.mjs';
import { linuxProcessIdentity, sameProcess } from './runtime-equivalence.mjs';

const exec = promisify(execFile);
const daemonPayloadFiles = ['gateway.mjs', 'daemon.cjs', 'dsh-capability-plugin.mjs'];

// Legacy execution archives predate the explicit daemon/headless discriminator.
// Infer daemon only from a complete v1 payload; absence of execution is Web-only.
export async function resolveExecutionProfile(releaseRoot, metadata) {
  if (metadata === undefined) return null;
  if (metadata?.profile === 'daemon' || metadata?.profile === 'headless') return metadata.profile;
  if (metadata?.profile !== undefined || metadata?.protocolVersion !== 1
    || typeof metadata.platform !== 'string' || !/^[a-z0-9]+$/i.test(metadata.platform)
    || typeof metadata.arch !== 'string' || !/^[a-z0-9]+$/i.test(metadata.arch)
    || typeof metadata.nodeAbi !== 'string' || !/^[1-9][0-9]*$/.test(metadata.nodeAbi))
    throw new Error('Release execution profile metadata is invalid');
  let web;
  try { web = JSON.parse(await readFile(join(releaseRoot, 'web/version.json'), 'utf8')); }
  catch (cause) {
    if (cause.code !== 'ENOENT') throw new Error('Release execution profile metadata is invalid', { cause });
  }
  if (web?.headlessServer === true || metadata.independentDshHost === 1)
    throw new Error('Release execution profile must explicitly declare Headless');
  try {
    for (const file of daemonPayloadFiles) {
      if ((await readFile(join(releaseRoot, 'execution', file))).length === 0) throw new Error('Empty legacy payload');
    }
  } catch (cause) { throw new Error('Release execution profile has no complete legacy daemon payload', { cause }); }
  return 'daemon';
}
async function executionFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await executionFiles(join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
async function releaseIdentity(root) {
  const identity = [];
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (typeof manifest?.opencraftWeb?.buildId === 'string') identity.push(manifest.opencraftWeb.buildId);
  } catch { /* A release without a manifest cannot claim a web identity. */ }
  try {
    const web = JSON.parse(await readFile(join(root, 'web/version.json'), 'utf8'));
    if (typeof web?.sourceRevision === 'string') identity.push(web.sourceRevision);
  } catch { /* Web assets are optional for an embedded execution-only release. */ }
  return [...new Set(identity.filter(value => value.length > 0))];
}
function normalizeReleaseIdentity(content, identity) {
  let normalized = content;
  for (const value of [...identity].sort((left, right) => right.length - left.length)) {
    const needle = Buffer.from(value);
    if (needle.length === 0) continue;
    const pieces = [];
    let start = 0;
    for (let at = normalized.indexOf(needle); at >= 0; at = normalized.indexOf(needle, start)) {
      pieces.push(normalized.subarray(start, at), Buffer.from('__opencraft_release_identity__'));
      start = at + needle.length;
    }
    if (pieces.length > 0) { pieces.push(normalized.subarray(start)); normalized = Buffer.concat(pieces); }
  }
  return normalized;
}
/** Hash the backend runtime payload while ignoring release identity strings
 * embedded by the web build. A real backend change still alters the digest. */
export async function computeExecutionHash(root, extraIdentity = []) {
  const directory = join(root, 'execution');
  let files;
  try { files = await executionFiles(directory); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  const identity = [...new Set([...await releaseIdentity(root), ...extraIdentity])];
  const hash = createHash('sha256');
  for (const relative of files) {
    const content = normalizeReleaseIdentity(await readFile(join(directory, relative)), identity);
    hash.update(relative); hash.update('\0'); hash.update(String(content.length)); hash.update('\0'); hash.update(content);
  }
  // Browser workers, assets and Electron live outside execution/, but are
  // selected from the gateway's immutable startup root just like its bundles.
  // An absent browser directory remains compatible with daemon/legacy releases.
  const browserDirectory = join(root, 'runtime/browser');
  let browserPresent = true;
  try { await readdir(browserDirectory); }
  catch (error) { if (error.code === 'ENOENT') browserPresent = false; else throw error; }
  if (browserPresent) hash.update('\0browser-runtime\0').update(await browserRuntimeIdentity(browserDirectory));
  return hash.digest('hex');
}
// Observe the independent process identity. Protocol compatibility is checked by
// its connection adapter, never by Web/execution deployment admission.
export async function coreHealth(endpoint, tokenPath) {
  const token = (await readFile(tokenPath, 'utf8')).trim();
  return new Promise((accept, reject) => {
    const req = request({ socketPath: endpoint, path: '/health', headers: { authorization: `Bearer ${token}` } }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; if (data.length > 8192) req.destroy(new Error('Invalid core health')); });
      response.on('end', () => {
        try {
          const value = JSON.parse(data);
          if (response.statusCode !== 200 || (!Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1) || !Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isSafeInteger(value.codexPid) || value.codexPid < 1) throw new Error();
          accept(value);
        } catch { reject(new Error('Codex core identity is unavailable')); }
      });
      response.on('error', reject);
    });
    req.on('error', () => reject(new Error('Codex core health request failed')));
    req.setTimeout(5000, () => req.destroy(new Error('Core health timeout'))); req.end();
  });
}
async function unitProperties(unit) {
  const { stdout } = await exec('systemctl', ['show', unit, '--property=Id,ControlGroup,PartOf,BindsTo,PropagatesStopTo,ExecStart,StopWhenUnneeded,KillMode,MainPID,Conflicts,User,DynamicUser'], { timeout: 10_000 });
  return Object.fromEntries(stdout.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}
export async function assertIndependentUnits(unit, coreUnit, link, readProperties = unitProperties, health = null) {
  const [execution, core] = await Promise.all([readProperties(unit), readProperties(coreUnit)]);
  if (!core.ControlGroup || execution.ControlGroup === core.ControlGroup
    || (execution.ControlGroup && core.ControlGroup.startsWith(`${execution.ControlGroup}/`))
    || ['PartOf', 'BindsTo'].some(key => core[key]) || core.StopWhenUnneeded !== 'no'
    || execution.Conflicts?.split(' ').includes(core.Id) || core.Conflicts?.split(' ').includes(execution.Id)
    || execution.PropagatesStopTo || execution.KillMode !== 'control-group'
    || (health && Number(core.MainPID) !== health.pid)
    || !execution.ExecStart?.includes(`${link}/execution/gateway.mjs`))
    throw new Error('Execution service must use the managed gateway and an independent Codex core');
}
export async function grantExecutionAccess(releaseRoot, user, deploymentDirectory) {
  const { stdout } = await exec('id', ['-u', '--', user], { timeout: 5000 });
  const uid = Number(stdout.trim());
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Unknown execution user');
  if (uid === process.getuid?.()) return;
  // Grant only traversal to private deployment containers; code receives read access.
  const parents = new Set([deploymentDirectory, dirname(releaseRoot), dirname(dirname(releaseRoot))]);
  for (const parent of parents) await exec('setfacl', ['-m', `u:${uid}:--x`, '--', parent], { timeout: 10_000 });
  await exec('setfacl', ['-R', '-m', `u:${uid}:rX`, '--', releaseRoot], { timeout: 30_000 });
}
export function createExecutionDeployment({ link, unit, coreUnit, coreEndpoint, tokenPath, healthUrl, profile = 'daemon',
  dshDescriptor, dshUnit, engineDescriptor, engineUnit,
  validate = health => assertIndependentUnits(unit, coreUnit, link, unitProperties, health),
  prepareAccess = async release => {
    const properties = await unitProperties(unit);
    if (properties.DynamicUser === 'yes') throw new Error('Managed execution requires a stable service user');
    await grantExecutionAccess(release.releaseRoot, properties.User || 'root', dirname(link));
  },
  restart = () => exec('systemctl', ['restart', unit], { timeout: 60_000 }), timeout = 30_000,
  runtimeProcess = async () => linuxProcessIdentity(Number((await unitProperties(unit)).MainPID)),
  statusTimeoutMs = 6_500 }) {
  if (!['daemon', 'headless'].includes(profile)) throw new Error('Invalid execution profile');
  if ((dshDescriptor || dshUnit) && (profile !== 'headless' || !isAbsolute(dshDescriptor || '')
    || !/^[A-Za-z0-9_.@-]+\.service$/.test(dshUnit || '') || [unit, coreUnit].includes(dshUnit)))
    throw new Error('Invalid independent DSH Host configuration');
  if ((engineDescriptor || engineUnit) && (profile !== 'headless' || !isAbsolute(engineDescriptor || '')
    || !/^[A-Za-z0-9_.@-]+\.service$/.test(engineUnit || '') || [unit, coreUnit, dshUnit].includes(engineUnit)))
    throw new Error('Invalid independent execution Host configuration');
  if (![link, coreEndpoint, tokenPath].every(isAbsolute) || !/^[A-Za-z0-9_.@-]+\.service$/.test(unit)
    || !/^[A-Za-z0-9_.@-]+\.service$/.test(coreUnit) || unit === coreUnit) throw new Error('Invalid managed execution configuration');
  const url = new URL(healthUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Execution health must use loopback HTTP');
  const pinsPath = `${link}.pins.json`;
  async function dshHealth() {
    if (!dshDescriptor) return null;
    const descriptor = await readPrivateJson(dshDescriptor);
    const attachment = await attachDshHost(dshDescriptor, descriptor.dataDirectory);
    await assertIndependentUnits(unit, dshUnit, link, unitProperties, attachment.identity);
    return attachment.identity;
  }
  async function engineHealth() {
    if (!engineDescriptor) return null;
    const identity = await readEngineHostIdentity(engineDescriptor);
    await assertIndependentUnits(unit, engineUnit, link, unitProperties, identity);
    return identity;
  }
  async function pinnedRoots() {
    try {
      const roots = JSON.parse(await readFile(pinsPath, 'utf8'));
      if (!Array.isArray(roots) || !roots.every(root => typeof root === 'string' && isAbsolute(root))) throw new Error('Invalid execution pins');
      return roots;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function pin(roots) {
    const temporary = `${pinsPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify([...new Set(roots)]), { mode: 0o600 }); await rename(temporary, pinsPath); }
    finally { await rm(temporary, { force: true }); }
  }
  async function inspect(release) {
    const manifest = JSON.parse(await readFile(join(release.releaseRoot, 'package.json'), 'utf8'));
    const metadata = manifest.opencraftExecution;
    if (metadata?.protocolVersion !== 1 || metadata.platform !== process.platform || metadata.arch !== process.arch || metadata.nodeAbi !== process.versions.modules
      || await resolveExecutionProfile(release.releaseRoot, metadata) !== profile)
      throw new Error('Release has no compatible execution payload');
    if (dshDescriptor && metadata.independentDshHost !== 1)
      throw new Error('Release cannot attach an independent DSH Host; crossing this migration boundary requires drained maintenance');
    if (engineDescriptor && metadata.independentEngineHost !== 1) throw new Error('Release cannot attach an independent execution Host');
    if (profile === 'headless') {
      let current;
      try { current = JSON.parse(await readFile(join(link, 'package.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current?.opencraftExecution?.storageWriterProtocol === 2 && metadata.storageWriterProtocol !== 2)
        throw new Error('Release cannot read the kernel-owned Headless writer locks');
    }
    for (const file of [...daemonPayloadFiles, ...(profile === 'headless' ? ['dsh-thread-persistence-plugin.mjs', 'dsh-thread-projection-plugin.mjs'] : [])]) await readFile(join(release.releaseRoot, 'execution', file));
    await assertExecutionNativePayload(release.releaseRoot);
    await validate();
  }
  async function point(root) {
    const temporary = `${link}.${randomUUID()}.tmp`;
    try { await symlink(root, temporary); await rename(temporary, link); }
    finally { await rm(temporary, { force: true }); }
  }
  async function runningPayloadMatches(root, health) {
    if (profile !== 'headless') return true;
    const runtime = health?.runtimeReleaseRoot;
    if (typeof runtime !== 'string' || !isAbsolute(runtime)) return false;
    if (runtime === root) return true;
    const identity = [...new Set([...await releaseIdentity(root), ...await releaseIdentity(runtime)])];
    const [wanted, actual] = await Promise.all([computeExecutionHash(root, identity), computeExecutionHash(runtime, identity)]);
    return !!wanted && wanted === actual;
  }
  async function ready(release, before, dshBefore = null, engineBefore = null) {
    const deadline = Date.now() + timeout;
    let attempts = 0; let stage = 'health-unreachable'; let lastReason = stage;
    while (Date.now() < deadline) {
      try {
        attempts++; stage = 'health-unreachable';
        const response = await fetch(url, { signal: AbortSignal.timeout(statusTimeoutMs) });
        stage = 'health-invalid';
        const health = await response.json();
        lastReason = !response.ok ? `health-http-${response.status}` : !health.ok ? 'dependency-unavailable'
          : profile === 'headless' && health.profile !== 'headless' ? 'profile-mismatch' : 'release-identity-mismatch';
        if (response.ok && health.ok && (profile !== 'headless' || health.profile === 'headless') && health.version === release.version && health.buildId === release.buildId) {
          stage = 'runtime-payload-mismatch';
          if (!await runningPayloadMatches(release.releaseRoot, health))
            throw new Error('Execution runtime payload does not match selected release');
          stage = 'core-health-unavailable';
          const after = await coreHealth(coreEndpoint, tokenPath);
          if (after.pid !== before.pid || after.codexPid !== before.codexPid || health.core?.pid !== before.pid || health.core?.codexPid !== before.codexPid)
            throw new Error('Codex core changed during execution update');
          if (dshBefore) {
            stage = 'dsh-health-unavailable';
            const current = await dshHealth();
            if (current.pid !== dshBefore.pid || current.enginePid !== dshBefore.enginePid
              || health.dsh?.pid !== dshBefore.pid || health.dsh?.enginePid !== dshBefore.enginePid)
              throw new Error('DSH Host changed during execution update');
          }
          if (engineBefore) {
            stage = 'engine-health-unavailable';
            const current = await engineHealth();
            if (current.pid !== engineBefore.pid || health.engineHost?.pid !== engineBefore.pid)
              throw new Error('Execution Host changed during execution update');
          }
          return health;
        }
      } catch (error) {
        if (['Codex core changed during execution update', 'DSH Host changed during execution update', 'Execution Host changed during execution update'].includes(error.message)) throw error;
        lastReason = ['TimeoutError', 'AbortError'].includes(error.name) && stage === 'health-unreachable' ? 'health-timeout' : stage;
      }
      await delay(100);
    }
    // Only bounded reason codes escape; dependency errors can contain credentials.
    throw Object.assign(new Error(`Execution release failed readiness: ${lastReason} (${attempts} observations)`),
      { code: 'EXECUTION_READINESS_FAILED', reason: lastReason, attempts });
  }
  async function retainRuntime(release, health, restarted = false) {
    if (restarted) { await pin([release.releaseRoot]); return; }
    const roots = await pinnedRoots();
    // The current pointer is a release identity, not the running process's
    // filesystem lifetime. Legacy health cannot prove any old root disposable.
    const runtime = health?.runtimeReleaseRoot;
    await pin(typeof runtime === 'string' && roots.includes(runtime)
      ? [runtime, release.releaseRoot] : roots);
  }
  let statusOperation = null;
  async function readStatus() {
    const started = Date.now();
    const result = (reason, health = null) => ({ enabled: true, profile,
      version: typeof health?.version === 'string' ? health.version : null,
      buildId: typeof health?.buildId === 'string' ? health.buildId : null,
      ready: reason === 'ready',
      observation: { reason, sampledAt: new Date().toISOString(), durationMs: Date.now() - started } });
    let target, root;
    try {
      root = await readlink(link);
      target = JSON.parse(await readFile(join(link, 'package.json'), 'utf8'));
    } catch { return result('pointer-unavailable'); }
    try {
      // Headless health observes Core and DSH in parallel, each bounded at 5s.
      // The outer budget includes that work and response delivery.
      const response = await fetch(url, { signal: AbortSignal.timeout(statusTimeoutMs) });
      let health;
      try { health = await response.json(); } catch { return result('health-invalid'); }
      if (typeof health?.version !== 'string' || typeof health?.buildId !== 'string') return result('health-invalid');
      if (health.ok !== true) return result('dependency-unavailable', health);
      if (!response.ok) return result('health-http-error', health);
      if (profile === 'headless' && health.profile !== 'headless') return result('health-invalid', health);
      // Do not authorize an observation across an execution pointer change.
      if (await readlink(link) !== root || health.version !== target.version || health.buildId !== target.opencraftWeb?.buildId)
        return result('release-mismatch', health);
      return result('ready', health);
    } catch (error) { return result(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'health-timeout' : 'health-unreachable'); }
  }
  return {
    inspect,
    // Observe an already selected retained release. Never switch pointers or
    // restart any owner to turn an unknown update into an apparent success.
    async verifyRecovery(release) {
      await inspect(release);
      const root = resolve(link, '..', await readlink(link));
      if (root !== release.releaseRoot) throw new Error('Recovery execution pointer mismatch');
      const processBefore = await runtimeProcess();
      if (!processBefore) throw new Error('Recovery execution process unavailable');
      const before = await coreHealth(coreEndpoint, tokenPath);
      const dshBefore = await dshHealth(); const engineBefore = await engineHealth();
      await validate(before);
      await ready(release, before, dshBefore, engineBefore);
      if (resolve(link, '..', await readlink(link)) !== root
        || !sameProcess(processBefore, await runtimeProcess())) throw new Error('Recovery execution changed during verification');
      return { process: processBefore, core: { pid: before.pid, codexPid: before.codexPid },
        ...(dshBefore ? { dsh: { pid: dshBefore.pid, enginePid: dshBefore.enginePid } } : {}),
        ...(engineBefore ? { engineHost: { pid: engineBefore.pid } } : {}) };
    },
    status() {
      // Concurrent updater readers share one observation, never an old success.
      if (statusOperation) return statusOperation;
      statusOperation = readStatus().finally(() => { statusOperation = null; });
      return statusOperation;
    },
    async referencedRoots() {
      const roots = await pinnedRoots();
      try { return [...new Set([...roots, resolve(link, '..', await readlink(link))])]; }
      catch { throw new Error('Execution release pointer is unreadable; retain release files'); }
    },
    async apply(release) {
      await inspect(release);
      let oldRoot;
      try { oldRoot = resolve(link, '..', await readlink(link)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Automatic recovery must be compatible before any candidate can be activated.
      if ((dshDescriptor || engineDescriptor) && oldRoot && oldRoot !== release.releaseRoot) await inspect({ releaseRoot: oldRoot });
      const before = await coreHealth(coreEndpoint, tokenPath);
      const dshBefore = await dshHealth();
      const engineBefore = await engineHealth();
      await validate(before);
      await prepareAccess(release);
      await pin([...(await pinnedRoots()), ...(oldRoot ? [oldRoot] : []), release.releaseRoot]);
      // A different backend payload needs a fresh process. A web-only release
      // may switch the pointer while the running gateway reports the current
      // release identity from that same pointer.
      // Normalize the union so a partially rewritten bundle still compares
      // equal when only its embedded web identity differs.
      const comparisonIdentity = [...new Set([...(oldRoot ? await releaseIdentity(oldRoot) : []),
        ...await releaseIdentity(release.releaseRoot)])];
      const previousRuntimeHash = oldRoot ? await computeExecutionHash(oldRoot, comparisonIdentity) : null;
      const runtimeHash = await computeExecutionHash(release.releaseRoot, comparisonIdentity);
      const runtimeChanged = previousRuntimeHash !== runtimeHash;
      const restartGateway = () => withGatewayUpdateIntent(link, release, restart);
      // Startup also reconciles a pointer changed by an interrupted update.
      if (oldRoot !== release.releaseRoot) {
        await point(release.releaseRoot);
        if (!runtimeChanged) {
          try { await retainRuntime(release, await ready(release, before, dshBefore, engineBefore)); return; }
          catch { await restartGateway(); }
        } else await restartGateway();
      } else {
        try { await retainRuntime(release, await ready(release, before, dshBefore, engineBefore)); return; }
        catch { await restartGateway(); }
      }
      await retainRuntime(release, await ready(release, before, dshBefore, engineBefore), true);
    },
  };
}
