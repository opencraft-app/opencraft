import { verifyCurrentRecovery } from './recover-current.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { upgradeBridge } from './full-upgrade.mjs';
import { atomicJson as durableJson } from '../full-upgrade/durable.mjs';
import { loadUserPlugins, assertUserPluginCompatibility } from './user-plugins.mjs';
import { fullReleaseTrust } from '../full-release/trust.mjs';
import { readReplayState } from '../full-release/archive.mjs';
import { verifyRetainedRelease, initializeReplayState } from '../full-release/retained.mjs';
import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { readFile, writeFile, mkdir, rename, rm, cp, stat, readdir, open } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createLocalTreeReleaseSource } from './local-tree-release.mjs';
import { createLocalReleaseSource } from './local-release.mjs';
import semver from 'semver';
import { createHeadlessBackendProxy, isHeadlessBackendPath, validHeadlessBackendRoutes } from './headless-backend.mjs';
import { loadLocalMachineAccess } from '../local-machine-access.mjs';
import { acquireDeploymentLock } from './lock.mjs';
import { resolveExecutionProfile } from '../server-deployment/execution.mjs';
import { WEB_UPDATE_PATH } from '../../packages/web-update-protocol/src/index.mjs';
import { createNpmReleaseSource, inspectRelease, unpackRelease, PACKAGE_NAME, isNewerVersion } from './releases.mjs';

const busy = job => job !== null && !['completed', 'failed'].includes(job.phase);
const json = (response, code, value) => {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
};
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function body(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    if ((bytes += chunk.length) > 4096) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function assertReleaseProfile(release, current) {
  const manifest = async root => JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const [candidate, installed] = await Promise.all([manifest(release.releaseRoot), manifest(current.releaseRoot)]);
  const [candidateProfile, installedProfile] = await Promise.all([
    resolveExecutionProfile(release.releaseRoot, candidate.opencraftExecution),
    resolveExecutionProfile(current.releaseRoot, installed.opencraftExecution),
  ]);
  if (candidateProfile !== installedProfile)
    throw new Error('Release execution profile differs from this website; select the matching npm update channel');
}
async function startWorker(release, environment) {
  const plugins = await loadUserPlugins(environment.OPENCRAFT_USER_PLUGIN_DIRECTORY);
  await assertUserPluginCompatibility(release, plugins);
  const child = fork(join(release.releaseRoot, 'runtime/worker.mjs'), [], {
    env: { ...process.env, ...environment, OPENCRAFT_RELEASE_ROOT: release.releaseRoot },
    execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const worker = { child, release, port: null, connections: 0, retired: false, alive: true };
  child.once('exit', () => { worker.alive = false; });
  try {
    const ready = await new Promise((accept, reject) => {
      const timeout = setTimeout(() => finish(new Error('New Web worker startup timed out')), 20_000);
      const onExit = () => finish(new Error('New Web worker exited before readiness'));
      const onError = () => finish(new Error('Unable to start Web worker'));
      const onMessage = message => {
        if (message?.protocol !== 1 || message.version !== release.version || message.buildId !== release.buildId
          || (message.headlessBackendRoutes !== undefined && !validHeadlessBackendRoutes(message.headlessBackendRoutes))
          || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) finish(new Error('New Web worker identity mismatch'));
        else finish(null, message);
      };
      function finish(error, value) {
        clearTimeout(timeout); child.off('exit', onExit); child.off('error', onError); child.off('message', onMessage);
        error ? reject(error) : accept(value);
      }
      child.once('exit', onExit); child.once('error', onError); child.once('message', onMessage);
    });
    worker.port = ready.port;
    worker.headlessBackendRoutes = ready.headlessBackendRoutes;
    const health = await fetch(`http://127.0.0.1:${worker.port}/__opencraft_health`, { signal: AbortSignal.timeout(5000) });
    const version = await fetch(`http://127.0.0.1:${worker.port}/version.json`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok || (await health.json()).ok !== true || !version.ok || (await version.json()).buildId !== release.buildId || !worker.alive)
      throw new Error('New Web worker failed health check');
    return worker;
  } catch (error) { child.kill('SIGKILL'); throw error; }
}
function retire(worker) {
  worker.retired = true;
  if (worker.connections === 0 && worker.alive) worker.child.kill('SIGTERM');
}
function lease(worker) {
  worker.connections++;
  let released = false;
  return () => {
    if (released) return;
    released = true; worker.connections--;
    if (worker.retired && worker.connections === 0 && worker.alive) worker.child.kill('SIGTERM');
  };
}

export async function createManagedWebServer({ initialRelease, stateDirectory, registry, channel, userconfig, publicOrigin,
  appServerTarget = null, codexServerTarget = null, headlessBackendTarget = null, relayIngressTarget = null, relayInternalPort = null, localAccessFile = null, hyperNodeUser = '', execution = null, rollbackRecovery = null, recoveryMarker = null, upgradeConfigPath = null, stateWriter = atomicJson, source = createNpmReleaseSource({ registry, channel, userconfig, stateFile: join(resolve(stateDirectory), 'full-release-state.json') }) }) {
  const headlessBackend = createHeadlessBackendProxy(headlessBackendTarget);
  const relayIngress = createHeadlessBackendProxy(relayIngressTarget);
  if (relayIngress && (!headlessBackend || !Number.isInteger(relayInternalPort) || relayInternalPort < 0 || relayInternalPort > 65535)) throw new Error('Relay ingress requires a protected Headless backend and loopback internal port');
  if (!relayIngress && relayInternalPort !== null) throw new Error('Relay internal port requires relay ingress');
  const localAccess = await loadLocalMachineAccess(localAccessFile);
  if (localAccess && !headlessBackend) throw new Error('Local machine access requires a protected Headless backend');
  const directory = resolve(stateDirectory);
  const upgrade = await upgradeBridge(upgradeConfigPath, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireDeploymentLock(directory);
  const statePath = join(directory, 'deployment.json');
  async function writeDeploymentState(path, value) {
    await stateWriter(path, value);
    // The current pointer authorizes restart independently of newer staged
    // manifests and replaceable jobs, so make that commit durable first.
    if (fullReleaseTrust) {
      const file = await open(path, 'r');
      try { await file.sync(); } finally { await file.close(); }
      const parent = await open(dirname(path), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  const keyPath = join(directory, 'admin-key');
  const workers = new Set(); const tunnels = new Set();
  let recovery = null;
  let active; let persisted; let closed = false; let operation = null; let checking = null; let latest = null;
  let checkedAt = null; let checkError = null; let checkErrorCode = null; const sessions = new Map(); let loginAttempts = [];
  const environment = { OPENCRAFT_USER_PLUGIN_DIRECTORY: join(directory, 'user-plugins'), OPENCRAFT_RESOURCE_CACHE_DIRECTORY: process.env.OPENCRAFT_RESOURCE_CACHE_DIRECTORY || join(directory, 'resource-cache'),
    OPENCRAFT_NPM_REGISTRY: registry || process.env.OPENCRAFT_NPM_REGISTRY || 'https://registry.npmjs.org/',
    OPENCRAFT_NPM_USERCONFIG: userconfig || process.env.OPENCRAFT_NPM_USERCONFIG || '', OPENCRAFT_APPSERVER_URL: appServerTarget || '', OPENCRAFT_CODEX_APPSERVER_URL: codexServerTarget || '', OPENCRAFT_HYPERNODE_USER: hyperNodeUser };
  try {
    try { persisted = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Deployment state is unreadable; inspect deployment.json');
      const seed = await inspectRelease(initialRelease);
      const installedRoot = join(directory, 'releases', randomUUID(), 'package');
      await mkdir(installedRoot, { recursive: true });
      await cp(seed.releaseRoot, installedRoot, { recursive: true });
      persisted = { schemaVersion: 1, current: await inspectRelease(installedRoot), previous: null, job: null };
      await writeDeploymentState(statePath, persisted);
    }
    if (persisted.schemaVersion !== 1) throw new Error('Incompatible deployment state');
    const current = await inspectRelease(persisted.current.releaseRoot);
    if (current.version !== persisted.current.version || current.buildId !== persisted.current.buildId) throw new Error('Installed release identity changed');
    if (fullReleaseTrust) {
      const authenticated = await initializeReplayState(current.releaseRoot, fullReleaseTrust,
        join(directory, 'full-release-state.json'), persisted.current.fullRelease);
      if (!persisted.current.fullRelease) {
        persisted.current = { ...persisted.current, fullRelease: authenticated.identity };
        await writeDeploymentState(statePath, persisted);
      }
    }
    if (busy(persisted.job)) { persisted.job = { ...persisted.job, phase: 'failed', error: 'Update interrupted before activation; the installed release was preserved' }; await writeDeploymentState(statePath, persisted); }
    try { await writeFile(keyPath, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const key = (await readFile(keyPath, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid deployment administrator key');
    const keyHash = createHash('sha256').update(key).digest();
    function track(worker) {
      workers.add(worker);
      worker.child.once('exit', () => {
        workers.delete(worker);
        if (closed || worker !== active || recovery) return;
        recovery = (async () => {
          while (!closed && !active.alive) {
            await new Promise(done => setTimeout(done, 250));
            if (closed || active.alive) break;
            const expected = active;
            try {
              const replacement = await startWorker(persisted.current, environment);
              track(replacement);
              if (closed || active !== expected) retire(replacement);
              else active = replacement;
            } catch { console.error('[opencraft web] Worker restart failed; retrying'); }
          }
        })().finally(() => { recovery = null; });
      });
    }
    await assertUserPluginCompatibility(current, await loadUserPlugins(environment.OPENCRAFT_USER_PLUGIN_DIRECTORY));
    if (execution) await execution.apply(current);
    active = await startWorker(current, environment); track(active);
    const cookieName = 'opencraft_web_admin';
    function authenticated(request) {
      const cookie = String(request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
      const token = cookie?.slice(cookieName.length + 1);
      for (const [id, until] of sessions) if (until < Date.now()) sessions.delete(id);
      return token !== undefined && sessions.has(token);
    }
    async function webRecoveryRequired(authoritative = false) {
      if (!upgrade) return false;
      try {
        const status = await upgrade({ action: authoritative ? 'web-admission' : 'page-status' });
        if (authoritative) return status.recoveryRequired;
        return status.jobs.some(job => job.state === 'recovery-required' && job.components.some(c => c.componentId === 'web-execution'));
      } catch { return true; } // No write is authorized from an unknown owner result.
    }
    async function snapshot(request) {
      const executionStatus = execution ? await execution.status() : null;
      return { schemaVersion: 1, enabled: true, localInstall: true, localTreeInstall: fullReleaseTrust ? 1 : 0, authenticated: authenticated(request),
        current: { version: persisted.current.version, buildId: persisted.current.buildId },
        latest: latest ? { version: latest.version, buildId: latest.buildId } : null,
        checking: checking !== null, checkedAt, checkError, checkErrorCode, packageName: PACKAGE_NAME, channel: source.channel || channel || 'latest',
        updateAvailable: latest !== null && isNewerVersion(latest.version, persisted.current.version),
        canRollback: persisted.previous !== null, recoveryRequired: await webRecoveryRequired(),
        execution: executionStatus,
        recovery: { maintenanceMarker: recoveryMarker !== null, rollbackHook: rollbackRecovery !== null },
        // A terminal job is visible only after its persistence and cleanup finish.
        job: operation && persisted.job && !busy(persisted.job) ? { ...persisted.job, phase: 'starting', error: null } : persisted.job };
    }
    async function check() {
      try { const found = await source.latest(); if (!closed) { latest = found; checkError = null; checkErrorCode = null; } }
      catch (error) { if (!closed) { latest = null; checkError = error.message; checkErrorCode = ['authentication', 'network', 'unavailable', 'registry'].includes(error.code) ? error.code : null; } }
      finally { checkedAt = new Date().toISOString(); checking = null; }
    }
    async function activate(release, job, rollback = false) {
      const candidate = await startWorker(release, environment); track(candidate);
      try {
        if (execution) await execution.apply(release);
        if (rollback && rollbackRecovery) await rollbackRecovery();
        if (closed) throw new Error('Deployment is stopping');
        const next = { schemaVersion: 1, current: release, previous: persisted.current, job: { ...job, phase: 'completed', error: null } };
        await writeDeploymentState(statePath, next);
        if (!candidate.alive || closed) {
          // The old pointer and worker remain authoritative until activation.
          await writeDeploymentState(statePath, persisted);
          throw new Error('New Web worker exited during activation');
        }
        const old = active; active = candidate; persisted = next; retire(old);
      } catch (error) {
        retire(candidate);
        if (execution) {
          try { await execution.apply(persisted.current); }
          catch (rollbackError) { throw new Error(`${error.message}; execution rollback failed (${rollbackError.code === 'EXECUTION_READINESS_FAILED' ? rollbackError.reason : 'execution-rollback-error'}); inspect the execution service`); }
        }
        throw error;
      }
    }
    async function install(selected, rollback, releaseSource = source, childId = randomUUID()) {
      const job = { id: childId, version: selected.version, phase: rollback ? 'starting' : 'downloading', error: null };
      const original = persisted;
      const child = { schemaVersion: 1, id: job.id, version: selected.version, buildId: selected.buildId,
        phase: job.phase, releaseId: selected.fullRelease?.release?.releaseId ?? null, startedAt: new Date().toISOString(), finishedAt: null, manifestSha256: null };
      async function childState(phase) {
        if (!upgrade) return;
        child.phase = phase;
        if (['completed', 'failed', 'deferred'].includes(phase)) child.finishedAt = new Date().toISOString();
        await mkdir(join(directory, 'upgrade-children'), { recursive: true, mode: 0o700 });
        await durableJson(join(directory, 'upgrade-children', job.id + '.json'), child);
        // A durable official receipt survives an agent outage; status reconciles
        // it later. An unknown notification is never an installation retry.
        try { await upgrade({ action: 'web-child', operationId: job.id }); } catch { /* retain owner receipt */ }
      }
      const staging = join(directory, 'staging', job.id); let releaseContainer = null; let activated = false;
      try {
        persisted = { ...original, job };
        await writeDeploymentState(statePath, persisted);
        await childState(job.phase);
        let release;
        if (rollback) {
          release = await inspectRelease(selected.releaseRoot);
          await assertReleaseProfile(release, persisted.current);
          if (fullReleaseTrust) {
            job.rollbackIntent = await verifyRetainedRelease(selected.releaseRoot, fullReleaseTrust,
              await readReplayState(join(directory, 'full-release-state.json')));
            release.fullRelease = { manifestSha256: job.rollbackIntent.manifestSha256,
              releaseId: job.rollbackIntent.releaseId, releaseSequence: job.rollbackIntent.releaseSequence,
              authorization: 'verified-installation' };
            persisted.job = { ...job };
            await writeDeploymentState(statePath, persisted);
          }
        }
        else {
          const archive = releaseSource.prepare ? null : await releaseSource.download(selected, staging);
          job.phase = 'verifying'; persisted.job = { ...job };
          await childState('verifying');
          const unpacked = releaseSource.prepare ? await releaseSource.prepare(selected, staging)
            : await unpackRelease(archive, join(staging, 'unpacked'), { stateFile: join(directory, 'full-release-state.json') });
          if (unpacked.version !== selected.version || unpacked.buildId !== selected.buildId) throw new Error('Downloaded release differs from the checked release');
          await assertReleaseProfile(unpacked, persisted.current);
          releaseContainer = join(directory, 'releases', job.id);
          await mkdir(join(directory, 'releases'), { recursive: true });
          await rename(join(staging, 'unpacked'), releaseContainer);
          release = { ...unpacked, releaseRoot: join(releaseContainer, 'package') };
        }
        // Retain lazy chunks used by browsers still displaying an older build.
        const oldAssets = join(persisted.current.releaseRoot, 'web/assets');
        try { if ((await stat(oldAssets)).isDirectory()) await cp(oldAssets, join(release.releaseRoot, 'web/assets'), { recursive: true, force: false, errorOnExist: false }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (execution) await execution.inspect(release);
        child.manifestSha256 = release.fullRelease?.manifestSha256 ?? null;
        child.releaseId = release.fullRelease?.releaseId ?? child.releaseId;
        await childState('prepared');
        if (upgrade) {
          const observed = await upgrade({ action: 'page-status' });
          const parent = observed.jobs.find(j => j.jobId === 'web-' + job.id);
          if (!parent) throw new Error('Upgrade journal unavailable');
          if (parent.stopRequested) {
            const stopped = new Error('upgrade-cancelled-at-safe-point'); stopped.code = 'UPGRADE_CANCELLED'; throw stopped;
          }
        }
        job.phase = 'starting'; persisted.job = { ...job };
        await childState('starting');
        await activate(release, job, rollback); activated = true;
        try { await childState('completed'); } catch { console.error('[opencraft update] Child receipt requires reconciliation'); }
      } catch (error) {
        persisted = { ...original, job: { ...job, phase: 'failed', error: error.message } };
        try { await writeDeploymentState(statePath, persisted); await childState(error.code === 'UPGRADE_CANCELLED' ? 'deferred' : error.message.includes('rollback failed') ? 'recovery-required' : 'failed'); }
        catch {
          persisted.job = { ...persisted.job, error: `${persisted.job.error}; state recovery could not be saved. Release files are retained for recovery.` };
          console.error('[opencraft update] State recovery could not be saved; release files retained');
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
        if (!activated && releaseContainer) {
          // A failed rollback write can leave the durable pointer on the candidate.
          // Delete only after independently reading a state that cannot reference it.
          try {
            const disk = JSON.parse(await readFile(statePath, 'utf8'));
            const root = join(releaseContainer, 'package');
            if (disk.schemaVersion === 1 && disk.current?.releaseRoot !== root && disk.previous?.releaseRoot !== root
              && !(execution && (await execution.referencedRoots()).includes(root)))
              await rm(releaseContainer, { recursive: true, force: true });
          } catch { /* Retain uncertain state for recovery. */ }
        }
        try {
          const disk = JSON.parse(await readFile(statePath, 'utf8'));
          if (disk.schemaVersion !== 1) throw new Error('Unknown state');
          const protectedRoots = new Set([persisted.current.releaseRoot, persisted.previous?.releaseRoot,
            disk.current?.releaseRoot, disk.previous?.releaseRoot, ...(execution ? await execution.referencedRoots() : []), ...[...workers].filter(worker => worker.alive).map(worker => worker.release.releaseRoot)]);
          for (const entry of await readdir(join(directory, 'releases'))) {
            if (!/^[a-f0-9-]{36}$/.test(entry)) continue;
            const container = join(directory, 'releases', entry);
            if (!protectedRoots.has(join(container, 'package'))) await rm(container, { recursive: true, force: true });
          }
        } catch { console.error('[opencraft update] Old release cleanup deferred'); }
      }
    }
    const handleRequest = async (request, response, internal = false) => {
      let pathname;
      try { pathname = new URL(request.url || '/', 'http://localhost').pathname; }
      catch { json(response, 400, { error: 'Invalid request URL' }); return; }
      if (pathname === WEB_UPDATE_PATH || pathname.startsWith(`${WEB_UPDATE_PATH}/`)) {
        try {
          if (pathname === `${WEB_UPDATE_PATH}/full` && request.method === 'GET') {
            if (!authenticated(request)) { json(response, 401, { error: 'Deployment administrator access required' }); return; }
            if (!upgrade) { json(response, 200, { schemaVersion: 1, plan: null, jobs: [], fullStackExecutable: false, unavailable: true }); return; }
            const result = await upgrade({ action: 'page-status' });
            json(response, 200, result); return;
          }
          if (request.method === 'GET' && pathname === WEB_UPDATE_PATH) { json(response, 200, await snapshot(request)); return; }
          if (request.method !== 'POST') { json(response, 405, { error: 'POST required' }); return; }
          const origin = request.headers.origin;
          let allowed = false;
          try { const url = new URL(origin); allowed = publicOrigin ? url.origin === new URL(publicOrigin).origin : url.host === request.headers.host && ['http:', 'https:'].includes(url.protocol); } catch {}
          if (!allowed || request.headers['content-type']?.split(';')[0] !== 'application/json') { json(response, 403, { error: 'Same-origin JSON request required' }); return; }
          const input = await body(request);
          if (pathname === `${WEB_UPDATE_PATH}/login`) {
            loginAttempts = loginAttempts.filter(time => time > Date.now() - 60_000);
            if (loginAttempts.length >= 10) { json(response, 429, { error: 'Wait a minute before retrying administrator access' }); return; }
            loginAttempts.push(Date.now());
            const provided = createHash('sha256').update(typeof input?.key === 'string' ? input.key : '').digest();
            if (!timingSafeEqual(provided, keyHash)) { json(response, 401, { error: 'Invalid deployment administrator key' }); return; }
            const token = randomBytes(32).toString('hex');
            sessions.set(token, Date.now() + 60 * 60 * 1000);
            response.setHeader('set-cookie', `${cookieName}=${token}; Path=${WEB_UPDATE_PATH}; HttpOnly; SameSite=Strict; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
            json(response, 200, { ok: true }); return;
          }
          // Metadata lookup is read-only; installation and rollback remain privileged.
          if (pathname === `${WEB_UPDATE_PATH}/check`) {
            if (operation || busy(persisted.job) || checking) { json(response, 409, { error: 'Another update operation is running' }); return; }
            checking = check(); json(response, 202, { ok: true }); return;
          }
          if (!authenticated(request)) { json(response, 401, { error: 'Deployment administrator access required' }); return; }
          if (pathname.startsWith(`${WEB_UPDATE_PATH}/full/`)) {
            if (recoveryMarker && existsSync(recoveryMarker)) { json(response, 409, { error: 'Managed recovery maintenance is active' }); return; }
            if (!upgrade) { json(response, 503, { error: 'Upgrade control unavailable' }); return; }
            const action = pathname.slice((WEB_UPDATE_PATH + '/full/').length);
            if (!['check', 'start', 'stop'].includes(action) || !input || Object.keys(input).some(k => !['planDigest', 'jobId'].includes(k))) {
              json(response, 400, { error: 'Invalid upgrade request' }); return;
            }
            json(response, 200, await upgrade({ action: 'page-' + action,
              ...(input.planDigest ? { planDigest: input.planDigest } : {}), ...(input.jobId ? { operationId: input.jobId } : {}) })); return;
          }
          if (pathname === `${WEB_UPDATE_PATH}/logout`) { sessions.clear(); response.setHeader('set-cookie', `${cookieName}=; Path=${WEB_UPDATE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`); json(response, 200, { ok: true }); return; }
          if (pathname === `${WEB_UPDATE_PATH}/install` && persisted.job && input?.version === persisted.job.version
            && latest?.version === input.version && (operation || busy(persisted.job) || persisted.job.phase === 'completed')) {
            json(response, 202, { ok: true, jobId: persisted.job.id }); return;
          }
          if (operation || busy(persisted.job) || checking) { json(response, 409, { error: 'Another update operation is running' }); return; }
          if (pathname === `${WEB_UPDATE_PATH}/recover-current`) {
            // Reserve synchronously before any verification await. The server
            // already owns the deployment writer lock; updates/handoffs wait.
            if (!input || Object.keys(input).some(k => !['jobId', 'version', 'buildId'].includes(k))
              || input.jobId !== persisted.job?.id || persisted.job?.phase !== 'failed'
              || input.version !== persisted.current.version || input.buildId !== persisted.current.buildId) {
              json(response, 409, { error: 'recovery-identity-mismatch' }); return;
            }
            if (recoveryMarker && existsSync(recoveryMarker)
              && request.headers['x-opencraft-recovery-id'] !== readFileSync(recoveryMarker, 'utf8').trim()) {
              json(response, 409, { error: 'Managed recovery maintenance is active' }); return;
            }
            const expected = persisted; const worker = active;
            operation = (async () => {
              const verified = await verifyCurrentRecovery({ directory, persisted: expected, execution,
                trust: fullReleaseTrust, input,
                active: () => !closed && active === worker && worker.alive && worker.release.releaseRoot === expected.current.releaseRoot });
              // Commit evidence before the terminal child receipt. Either crash
              // gap stays unknown and can be retried with the same exact job.
              await writeDeploymentState(statePath, verified.next); persisted = verified.next;
              await durableJson(join(directory, 'upgrade-children', input.jobId + '.json'), verified.child);
              try { await upgrade?.({ action: 'web-child', operationId: input.jobId }); } catch { /* durable owner receipt reconciles later */ }
            })().catch(async error => {
              // Preserve the original install/rollback error and all unknown
              // receipts. Never persist arbitrary dependency exception text.
              persisted = { ...persisted, job: { ...persisted.job, recoveryError: /^recovery-(verifier-unavailable|identity-mismatch|child-mismatch|retained-identity-mismatch|retained-verification-failed|execution-verification-failed|owner-changed)$/.test(error.message) ? error.message : 'recovery-verification-failed' } };
              await writeDeploymentState(statePath, persisted);
            }).catch(() => console.error('[opencraft update] Recovery receipt requires inspection'))
              .finally(() => { operation = null; });
            json(response, 202, { ok: true, jobId: input.jobId }); return;
          }
          if (await webRecoveryRequired(true)) { json(response, 409, { error: 'local-recovery-required' }); return; }
          // Recheck admission after the asynchronous recovery observation.
          if (pathname === `${WEB_UPDATE_PATH}/install` && persisted.job && input?.version === persisted.job.version
            && latest?.version === input.version && (operation || busy(persisted.job) || persisted.job.phase === 'completed')) {
            json(response, 202, { ok: true, jobId: persisted.job.id }); return;
          }
          if (operation || busy(persisted.job) || checking) { json(response, 409, { error: 'Another update operation is running' }); return; }

          let selected; let rollback = false; let releaseSource = source;
          if (pathname === `${WEB_UPDATE_PATH}/install`) {
            if (!latest || input?.version !== latest.version || !isNewerVersion(latest.version, persisted.current.version)) { json(response, 409, { error: 'Check updates again before installing' }); return; }
            selected = { ...latest };
          } else if (([`${WEB_UPDATE_PATH}/install-local`, `${WEB_UPDATE_PATH}/install-local-tree`].includes(pathname))) {
            if (!semver.valid(input?.version) || !isNewerVersion(input.version, persisted.current.version)
              || typeof input.buildId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(input.buildId)) {
              json(response, 409, { error: 'Local release must have a newer exact version and valid build identity' }); return;
            }
            releaseSource = pathname.endsWith('/install-local-tree')
              ? createLocalTreeReleaseSource(input.tree, input.manifestSha256, { stateFile: join(directory, 'full-release-state.json') })
              : createLocalReleaseSource(input.archive, { stateFile: join(directory, 'full-release-state.json') });
            selected = { version: input.version, buildId: input.buildId, integrity: input.integrity };
          } else if (pathname === `${WEB_UPDATE_PATH}/rollback`) {
            if (!persisted.previous) { json(response, 409, { error: 'No previous release is available' }); return; }
            selected = { ...persisted.previous }; rollback = true;
          } else { json(response, 404, { error: 'Unknown update action' }); return; }
          // Synchronous final admission closes the status/marker race: no await
          // may occur between this check and reserving the update operation.
          if (recoveryMarker && existsSync(recoveryMarker)
            && !(rollback && request.headers['x-opencraft-recovery-id'] === readFileSync(recoveryMarker, 'utf8').trim())) {
            json(response, 409, { error: 'Managed recovery maintenance is active' }); return;
          }
          operation = install(selected, rollback, releaseSource).catch(() => console.error('[opencraft update] Cannot persist update result; inspect the deployment state')).finally(() => { operation = null; });
          json(response, 202, { ok: true, jobId: persisted.job.id });
        } catch { if (!response.headersSent) json(response, 400, { error: 'Invalid update request' }); }
        return;
      }
      // Preserve deployment authority and metadata probes at the managed entry.
      // All business routes, including login/tunnel endpoints, go through the relay.
      const local = !internal && localAccess?.forward(request);
      if (relayIngress && !internal && !local && !['/version.json', '/health', '/__opencraft_health'].includes(pathname)) {
        relayIngress.http(request, response, () => {}); return;
      }
      const worker = active;
      if (headlessBackend && isHeadlessBackendPath(pathname, false, worker.headlessBackendRoutes)) { headlessBackend.http(request, response, lease(worker)); return; }
      if (headlessBackend && pathname !== '/version.json'
        && (local || (relayIngress && internal) || (request.method === 'GET' && request.headers.accept?.includes('text/html')))
        && !await headlessBackend.admitDocument(request, response)) return;
      if (!worker.alive) { json(response, 503, { error: 'Web worker unavailable; restart the website service' }); return; }
      const release = lease(worker);
      const upstream = httpRequest({ hostname: '127.0.0.1', port: worker.port, path: request.url, method: request.method, headers: request.headers }, result => {
        result.on('error', () => response.destroy());
        result.on('aborted', () => response.destroy());
        result.on('close', () => { if (!result.complete) response.destroy(); });
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstream.on('error', () => { if (!response.headersSent) json(response, 502, { error: 'Web worker unavailable' }); else response.destroy(); });
      response.once('close', () => { upstream.destroy(); release(); });
      request.pipe(upstream);
    };
    const handleUpgrade = (request, socket, head, internal = false) => {
      let pathname;
      try { pathname = new URL(request.url || '/', 'http://localhost').pathname; }
      catch { socket.destroy(); return; }
      const local = !internal && localAccess?.forward(request);
      // The wire upgrade proxy forwards rawHeaders, so carry only the proof produced here.
      if (!internal && localAccess) {
        const raw = [];
        for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() !== 'x-opencraft-local-machine-proof') raw.push(request.rawHeaders[i], request.rawHeaders[i + 1]);
        if (local) raw.push('x-opencraft-local-machine-proof', request.headers['x-opencraft-local-machine-proof']);
        request.rawHeaders = raw;
      }
      if (relayIngress && !internal && !local) { relayIngress.upgrade(request, socket, head, () => {}, tunnels); return; }
      if (!closed && headlessBackend && isHeadlessBackendPath(pathname, true, active.headlessBackendRoutes)) {
        headlessBackend.upgrade(request, socket, head, lease(active), tunnels); return;
      }
      if (closed || !active.alive || !['/appserver', '/codex-appserver'].includes(pathname)) { socket.destroy(); return; }
      const worker = active; const release = lease(worker);
      const upstream = createConnection({ host: '127.0.0.1', port: worker.port });
      tunnels.add(socket);
      socket.once('close', () => { tunnels.delete(socket); upstream.destroy(); release(); });
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); upstream.once('close', () => socket.destroy());
      upstream.once('connect', () => {
        const headers = request.rawHeaders;
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${Array.from({ length: headers.length / 2 }, (_, i) => `${headers[i * 2]}: ${headers[i * 2 + 1]}`).join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
    };
    const server = createServer((req, res) => { void handleRequest(req, res); });
    server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));
    const internalServer = relayIngress ? createServer((req, res) => { void handleRequest(req, res, true); }) : null;
    internalServer?.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, true));
    return {
      server, adminKeyPath: keyPath, internalAddress: () => internalServer?.address() ?? null,
      async listen({ host = '127.0.0.1', port = 10000 } = {}) {
        if (internalServer) await new Promise((accept, reject) => { internalServer.once('error', reject); internalServer.listen(relayInternalPort, '127.0.0.1', () => { internalServer.off('error', reject); accept(); }); });
        return new Promise((accept, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); accept(server.address()); }); });
      },
      async close() {
        closed = true;
        await Promise.allSettled([operation, checking, recovery].filter(Boolean));
        for (const socket of tunnels) socket.destroy();
        for (const worker of workers) if (worker.alive) worker.child.kill('SIGTERM');
        if (server.listening) await new Promise(accept => server.close(accept));
        if (internalServer?.listening) await new Promise(accept => internalServer.close(accept));
        await releaseLock();
      },
    };
  } catch (error) {
    for (const worker of workers) if (worker.alive) worker.child.kill('SIGKILL');
    await releaseLock(); throw error;
  }
}
