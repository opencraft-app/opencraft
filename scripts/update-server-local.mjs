#!/usr/bin/env node
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { headlessWebHostDefinitions } from './package-headless-linux.mjs';
import { packageWebServer } from './package-web-server.mjs';

// Installation may synchronously inventory/decompress/verify a large payload.
// Only the accepted job's terminal state determines the outcome; an individual
// status transport failure never authorizes another installation request.
const updateObservationBudgetMs = 15 * 60_000;
export async function observeLocalUpdate({ jobId, version, buildId, status, deadline,
  now = () => performance.now(), sleep = delay }) {
  if (typeof jobId !== 'string' || !jobId) throw new Error('Local update did not return a job identity');
  while (now() < deadline) {
    let current;
    try {
      current = await status(AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))));
    } catch {
      // The entry can be temporarily unavailable while switching execution.
      // The next read remains bound to this same job and the original deadline.
    }
    if (now() >= deadline) break;
    if (current) {
      if (current.job?.id !== jobId || current.job.version !== version)
        throw new Error('Local update job identity changed before terminal observation');
      if (current.job.phase === 'failed') throw new Error(current.job.error || 'Local update failed');
      if (current.job.phase === 'completed') {
        if (current.current?.version !== version || current.current.buildId !== buildId)
          throw new Error('Local update completed with a different release identity');
        return current;
      }
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(500, remaining));
  }
  throw new Error(`Update observation timed out for job ${jobId}; the server operation may still be running`);
}

export async function updateLocalServer({ version, archive, buildId, tree, manifestSha256,
  url = process.env.OPENCRAFT_WEB_UPDATE_URL || `http://127.0.0.1:${process.env.OPENCRAFT_WEB_PORT || 10000}`,
  stateDirectory = process.env.OPENCRAFT_WEB_STATE || resolve(homedir(), '.local/share/opencraft/web'),
  origin = process.env.OPENCRAFT_PUBLIC_ORIGIN || url,
  output = process.env.OPENCRAFT_WEB_PACKAGE_OUTPUT } = {}) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || address.username || address.password)
    throw new Error('Local update URL must be loopback HTTP');
  const endpoint = `${address.origin}/__opencraft_updates`;
  let cookie = '';
  const status = async (signal = AbortSignal.timeout(10_000)) => {
    const response = await fetch(endpoint, { headers: { cookie }, signal });
    if (!response.ok) throw new Error('Managed updater is unavailable'); return response.json();
  };
  const post = async (action, input, signal = AbortSignal.timeout(10_000)) => {
    const response = await fetch(`${endpoint}/${action}`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(input), signal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Local update request failed');
    return { result, cookie: response.headers.get('set-cookie') };
  };
  const initial = await status();
  if (initial.localInstall !== true) throw new Error('The pinned bootstrap must be upgraded before local source updates are available');
  if (initial.checking || (initial.job && !['completed', 'failed'].includes(initial.job.phase))) throw new Error('Another update operation is running');
  const key = (await readFile(join(stateDirectory, 'admin-key'), 'utf8')).trim();
  const login = await post('login', { key }); cookie = login.cookie.split(';')[0];
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let packed;
  if (tree) {
    if (archive || !version || !buildId || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error('Prepared tree requires exact version, buildId and manifest digest, without archive');
    if (initial.localTreeInstall !== 1) throw new Error('Pinned bootstrap does not support signed local tree installation');
    packed = { tree: resolve(tree), version, buildId, manifestSha256 };
  } else if (archive) {
    if (!version || !buildId) throw new Error('Existing archive requires its exact version and buildId');
    packed = { archive: resolve(archive), version, buildId };
  } else {
    if (!version) throw new Error('Set OPENCRAFT_RELEASE_VERSION or pass --version');
    if (!output) { const parent = join(repository, '.local/server-releases'); await mkdir(parent, { recursive: true }); output = await mkdtemp(join(parent, `${version}-`)); }
    let revision = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
    if ((await promisify(execFile)('git', ['status', '--porcelain'], { cwd: repository })).stdout.trim()) revision += '-dirty';
    const executionProfile = initial.execution?.profile || 'daemon';
    if (!['daemon', 'headless'].includes(executionProfile)) throw new Error('Unsupported installed execution profile');
    const profileEnvironment = executionProfile === 'headless' ? { OPENCRAFT_HEADLESS_SERVER_BUILD: 'true', VITE_HYPERNODE_PLUGIN: 'disabled', VITE_APPSERVER_HOSTS_JSON: JSON.stringify(headlessWebHostDefinitions()) } : {};
    await promisify(execFile)('npm', ['run', 'build:web:release'], { cwd: repository, env: { ...process.env, ...profileEnvironment, OPENCRAFT_SOURCE_REVISION: revision }, maxBuffer: 32 * 1024 * 1024 });
    packed = await packageWebServer({ version, output, execution: initial.execution?.enabled === true, executionProfile });
  }
  const input = tree ? packed : { ...packed, archive: resolve(packed.archive), integrity: `sha512-${createHash('sha512').update(await readFile(packed.archive)).digest('base64')}` };
  const deadline = performance.now() + updateObservationBudgetMs;
  const receipt = await post(tree ? 'install-local-tree' : 'install-local', input,
    AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))));
  const current = await observeLocalUpdate({ jobId: receipt.result.jobId, version,
    buildId: packed.buildId, status, deadline });
  return { version, buildId: current.current.buildId, execution: current.execution,
    ...(tree ? { tree: packed.tree, activationTransport: 'prepared-tree' } : { archive: packed.archive }) };
}
if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  try { console.log(JSON.stringify(await updateLocalServer({ version: argument('--version') || process.env.OPENCRAFT_RELEASE_VERSION,
    tree: argument('--tree'), manifestSha256: argument('--manifest-sha256'), archive: argument('--archive'), buildId: argument('--build-id') }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
