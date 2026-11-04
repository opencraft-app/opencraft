#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { cpus, hostname, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handsResources } from './resources.mjs';

export const OWNER_ORDER = Object.freeze(['hands', 'brain', 'gateway']);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dockerDirectory = join(repository, 'docker');

export function parseEnvironment(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) throw new Error(`Invalid environment line: ${raw}`);
    result[line.slice(0, at)] = line.slice(at + 1);
  }
  return result;
}

export function setEnvironmentValue(text, key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || /[\r\n]/u.test(value)) throw new Error('Invalid environment update');
  const lines = text.split(/\r?\n/u); let found = false;
  const updated = lines.map(line => {
    if (!line.startsWith(`${key}=`)) return line;
    if (found) throw new Error(`Duplicate ${key} in .env`);
    found = true; return `${key}=${value}`;
  });
  if (!found) updated.splice(updated.at(-1) === '' ? -1 : updated.length, 0, `${key}=${value}`);
  return updated.join('\n');
}

function runCompose(args, image, options = {}) {
  execFileSync('docker', ['compose', '--env-file', '.env', ...args], {
    cwd: dockerDirectory, stdio: options.capture ? 'pipe' : 'inherit', encoding: options.capture ? 'utf8' : undefined,
    env: { ...process.env, ...(image ? { OPENCRAFT_IMAGE: image } : {}) },
  });
}

export function assertImageReference(image, allowMutable = false) {
  if (!image || /\s/u.test(image)) throw new Error('Specify a non-empty image reference');
  const digest = /@sha256:[a-f0-9]{64}$/u.test(image);
  if (image.includes('@') && !digest) throw new Error('Image digest must be a complete sha256 value');
  const tag = image.split('/').at(-1)?.split(':')[1];
  const mutable = !digest && (!tag || tag === 'latest' || tag === 'local');
  if (mutable && !allowMutable) throw new Error('Refusing a mutable image; use a digest/version tag or --allow-mutable-image');
}

async function inspectDirectory(path, identity) {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${path} is not a directory`);
  if (info.uid !== identity.uid || info.gid !== identity.gid) throw new Error(`${path} is not owned by ${identity.uid}:${identity.gid}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by group or others`);
}

export async function doctor(environment, { allowOversubscription = false } = {}) {
  const required = ['OPENCRAFT_HOST_DATA_DIR', 'OPENCRAFT_DATA_DIR', 'OPENCRAFT_HOST_WORKSPACE_DIR', 'OPENCRAFT_WORKSPACE_DIR', 'OPENCRAFT_UID', 'OPENCRAFT_GID'];
  for (const name of required) if (!environment[name]) throw new Error(`Missing ${name}`);
  for (const name of required.slice(0, 4)) if (!environment[name].startsWith('/')) throw new Error(`${name} must be absolute`);
  const identity = { uid: Number(environment.OPENCRAFT_UID), gid: Number(environment.OPENCRAFT_GID) };
  if (!Number.isSafeInteger(identity.uid) || !Number.isSafeInteger(identity.gid)) throw new Error('OPENCRAFT_UID/GID must be integers');
  if (process.getuid?.() !== identity.uid || process.getgid?.() !== identity.gid)
    throw new Error(`Run this tool as the deployment identity ${identity.uid}:${identity.gid}`);
  await Promise.all([inspectDirectory(environment.OPENCRAFT_HOST_DATA_DIR, identity), inspectDirectory(environment.OPENCRAFT_HOST_WORKSPACE_DIR, identity)]);
  const resources = handsResources(environment);
  const requiredMemory = resources.memoryBytes + 2 * 1024 ** 3;
  if (!allowOversubscription && totalmem() < requiredMemory)
    throw new Error(`Host RAM is below Hands plus 2 GiB headroom (${totalmem()} < ${requiredMemory}); resize or use --allow-oversubscription intentionally`);
  if (!allowOversubscription && cpus().length * 1000 < resources.cpuMillis)
    throw new Error('Host CPU count is below the declared Hands budget');
  const disk = await statfs(environment.OPENCRAFT_HOST_DATA_DIR);
  if (disk.bavail * disk.bsize < 5 * 1024 ** 3) throw new Error('Less than 5 GiB is available in the data filesystem');
  runCompose(['config', '--quiet'], undefined, { capture: true });
  return { hostname: hostname(), resources, memoryBytes: totalmem(), cpuCount: cpus().length,
    availableDataBytes: disk.bavail * disk.bsize };
}

async function acquireLock(dataDirectory) {
  const directory = join(dataDirectory, 'deployment'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'compose.lock');
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another deployment may be active: ${path}`); throw error; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }) + '\n');
  await handle.close();
  return async () => unlink(path).catch(() => {});
}

async function applyOwners(image) {
  for (const service of OWNER_ORDER) runCompose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', service], image);
}

async function atomicWrite(path, text, mode = 0o600) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, text, { mode, flag: 'wx' });
  await rename(temporary, path);
}

async function applyImage({ image, envPath, allowMutable, allowOversubscription }) {
  assertImageReference(image, allowMutable);
  const original = await readFile(envPath, 'utf8'), environment = parseEnvironment(original);
  await doctor(environment, { allowOversubscription });
  const previous = environment.OPENCRAFT_IMAGE;
  if (!previous) throw new Error('OPENCRAFT_IMAGE is missing from .env');
  const release = await acquireLock(environment.OPENCRAFT_HOST_DATA_DIR);
  const statePath = join(environment.OPENCRAFT_HOST_DATA_DIR, 'deployment', 'compose-state.json');
  let previousState = null;
  try {
    try { previousState = await readFile(statePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!allowMutable) runCompose(['pull', 'hands'], image);
    try { await applyOwners(image); }
    catch (error) {
      console.error(`Upgrade failed; restoring ${previous}`);
      try { await applyOwners(previous); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Upgrade and automatic code rollback both failed'); }
      throw error;
    }
    try {
      await atomicWrite(statePath, JSON.stringify({ schemaVersion: 1, currentImage: image, previousImage: previous,
        appliedAt: new Date().toISOString() }, null, 2) + '\n');
      await atomicWrite(envPath, setEnvironmentValue(original, 'OPENCRAFT_IMAGE', image), (await stat(envPath)).mode & 0o777);
    } catch (persistence) {
      console.error('Deployment metadata could not be committed; restoring the previous image.');
      const failures = [persistence];
      try { await applyOwners(previous); } catch (error) { failures.push(error); }
      try { previousState === null ? await unlink(statePath).catch(error => { if (error.code !== 'ENOENT') throw error; }) : await atomicWrite(statePath, previousState); }
      catch (error) { failures.push(error); }
      if (failures.length > 1) throw new AggregateError(failures, 'Deployment persistence and recovery failed');
      throw persistence;
    }
    console.log(`OpenCraft owners now use ${image}. Previous image: ${previous}.`);
    console.log('Code rollback does not restore a database migration. Keep the pre-upgrade data backup.');
  } finally { await release(); }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0], flags = new Set(argv.slice(1));
  if (!['doctor', 'upgrade', 'rollback'].includes(command))
    throw new Error('Usage: compose-release.mjs doctor | upgrade IMAGE | rollback [--allow-oversubscription] [--allow-mutable-image]');
  const envPath = resolve(dockerDirectory, '.env');
  await access(envPath, constants.R_OK | constants.W_OK);
  const environment = parseEnvironment(await readFile(envPath, 'utf8'));
  if (command === 'doctor') {
    console.log(JSON.stringify(await doctor(environment, { allowOversubscription: flags.has('--allow-oversubscription') }), null, 2));
    return;
  }
  if (command === 'upgrade') {
    const image = argv[1];
    await applyImage({ image, envPath, allowMutable: flags.has('--allow-mutable-image'), allowOversubscription: flags.has('--allow-oversubscription') });
    return;
  }
  if (command === 'rollback') {
    const state = JSON.parse(await readFile(join(environment.OPENCRAFT_HOST_DATA_DIR, 'deployment', 'compose-state.json'), 'utf8'));
    await applyImage({ image: state.previousImage, envPath, allowMutable: flags.has('--allow-mutable-image'), allowOversubscription: flags.has('--allow-oversubscription') });
    return;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error); process.exitCode = 1; });
