#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { headlessWebHostDefinitions } from './package-headless-linux.mjs';
import { packageWebServer } from './package-web-server.mjs';

export async function updateLocalServer({ version, archive, buildId,
  url = process.env.OPENCRAFT_WEB_UPDATE_URL || `http://127.0.0.1:${process.env.OPENCRAFT_WEB_PORT || 10000}`,
  stateDirectory = process.env.OPENCRAFT_WEB_STATE || resolve(homedir(), '.local/share/opencraft/web'),
  origin = process.env.OPENCRAFT_PUBLIC_ORIGIN || url,
  output = process.env.OPENCRAFT_WEB_PACKAGE_OUTPUT } = {}) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || address.username || address.password)
    throw new Error('Local update URL must be loopback HTTP');
  const endpoint = `${address.origin}/__opencraft_updates`;
  let cookie = '';
  const status = async () => {
    const response = await fetch(endpoint, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Managed updater is unavailable'); return response.json();
  };
  const post = async (action, input) => {
    const response = await fetch(`${endpoint}/${action}`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000) });
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
  if (archive) {
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
  const integrity = `sha512-${createHash('sha512').update(await readFile(packed.archive)).digest('base64')}`;
  const receipt = await post('install-local', { ...packed, archive: resolve(packed.archive), integrity });
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const current = await status();
    if (current.job?.id === receipt.result.jobId && current.job.phase === 'failed') throw new Error(current.job.error || 'Local update failed');
    if (current.current.version === version && current.job?.id === receipt.result.jobId && current.job.phase === 'completed')
      return { version, buildId: current.current.buildId, execution: current.execution, archive: packed.archive };
    await delay(500);
  }
  throw new Error('Update status timed out; the server operation may still be running');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  try { console.log(JSON.stringify(await updateLocalServer({ version: argument('--version') || process.env.OPENCRAFT_RELEASE_VERSION,
    archive: argument('--archive'), buildId: argument('--build-id') }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
