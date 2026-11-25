#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { cpus, hostname, totalmem } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handsResources } from './resources.mjs';
import { hostLayout, inspectPrivateDirectory, inspectWorkspaceDirectory, SERVICES } from './layout.mjs';

// The proxy (account Core) precedes Brain, which waits for it; Gateway follows the engines it fronts.
export const OWNER_ORDER = Object.freeze(['hands', 'proxy', 'brain', 'gateway']);

/** Whether a Brain container's environment still embeds the account Core (pre-proxy default or explicit embedded). */
export function brainEmbedsAccountCore(environment) {
  if (!Array.isArray(environment)) return false;
  return !environment.includes('OPENCRAFT_PROXY_MODE=external');
}

/**
 * Apply steps for one image. A Brain that embeds the account Core holds the Codex account writer lock, so it is
 * stopped before the proxy starts (one-time switch from the old default). Otherwise Brain keeps running while the
 * proxy is replaced; it reconnects to the fixed proxy port and is recreated only for its own image change.
 */
export function ownerSteps({ brainEmbedsCore }) {
  return [...(brainEmbedsCore ? [['stop', 'brain']] : []), ...OWNER_ORDER.map(service => ['up', service])];
}

/** Compose variables that select Brain's proxy mode and port. Only an automatic restore sets them; `.env` must not. */
export const RESTORE_PROXY_MODE_VARIABLE = 'OPENCRAFT_BRAIN_PROXY_MODE';
export const RESTORE_PROXY_PORT_VARIABLE = 'OPENCRAFT_BRAIN_PROXY_PORT';
/** Pre-proxy Brain: embedded Core on a free loopback port (no fixed port, which a failed proxy may still hold). */
export const EMBEDDED_CORE_ENVIRONMENT = Object.freeze({ [RESTORE_PROXY_MODE_VARIABLE]: 'embedded', [RESTORE_PROXY_PORT_VARIABLE]: '' });

/**
 * Steps that restore the previous image after a failed release. Restoring the image alone is not enough when the
 * release was the one-time switch from an embedded account Core: the previous deployment had no `proxy` owner, and
 * the previous image may not provide one. So the restore returns to that topology: Brain is stopped, the `proxy`
 * container is removed (it may hold the account writer), and Brain is started with the embedded Core. Gateway is
 * recreated last: a Gateway the failed release never reached is unchanged, and after Brain was stopped twice its health
 * can already be failing, which `up --wait` reports at once instead of waiting for its reconnect backoff.
 */
export function restoreSteps({ embeddedCoreBefore }) {
  if (!embeddedCoreBefore) return ownerSteps({ brainEmbedsCore: false });
  return [['stop', 'brain'], ['remove', 'proxy'], ['up', 'hands'], ['up-embedded', 'brain'], ['recreate', 'gateway']];
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dockerDirectory = join(repository, 'deploy', 'docker');

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

export function deploymentIdentity(environment) {
  const identity = { uid: Number(environment.OPENCRAFT_UID), gid: Number(environment.OPENCRAFT_GID) };
  if (!Number.isSafeInteger(identity.uid) || !Number.isSafeInteger(identity.gid) || identity.uid < 0 || identity.gid < 0)
    throw new Error('OPENCRAFT_UID/GID must be non-negative integers');
  if (identity.uid === 0 || identity.gid === 0)
    throw new Error('OpenCraft containers require a non-root deployment UID and GID so Chromium sandboxing remains enabled');
  return identity;
}

function runCompose(args, image, options = {}) {
  const env = { ...process.env, ...(image ? { OPENCRAFT_IMAGE: image } : {}) };
  // The shell value wins over `.env`; only a restore to the embedded Core passes these.
  for (const name of Object.keys(EMBEDDED_CORE_ENVIRONMENT)) delete env[name];
  if (options.embeddedCore) Object.assign(env, EMBEDDED_CORE_ENVIRONMENT);
  return execFileSync('docker', ['compose', '--env-file', '.env', ...args], {
    cwd: dockerDirectory, stdio: options.capture ? 'pipe' : [options.input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    encoding: options.capture ? 'utf8' : undefined, input: options.input, env,
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

/**
 * A release commits `.env` (in the Compose directory) and `deployment/compose-state.json` (in the data directory) only
 * after every owner was replaced. Both are written by atomic rename, so their directories must be writable by the
 * deployment identity now; otherwise the transaction would fail after all services were already applied.
 */
export async function inspectDeploymentWritable(environment, deployDirectory = dockerDirectory) {
  const state = hostLayout(environment).state, deployment = join(state, 'deployment');
  const directories = [[deployDirectory, '.env']];
  try {
    const info = await lstat(deployment);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${deployment} must be a real directory, not a symlink`);
    directories.push([deployment, 'compose-state.json']);
  } catch (error) { if (error.code !== 'ENOENT') throw error; directories.push([state, 'deployment/compose-state.json']); }
  for (const [directory, file] of directories) {
    try { await access(directory, constants.W_OK | constants.X_OK); }
    catch (error) {
      throw new Error(`${directory} is not writable by the deployment identity (${error.code}); a release could not commit ${file} after applying services. Fix its ownership or permissions first.`);
    }
  }
}

/** Brain and Hands run the workspace agent, whose run directory must be container-private
 * (a tmpfs per container, never a shared bind mount). Older Compose files lack it. */
export const AGENT_RUN_DIRECTORY = '/run/opencraft-agent';
export const AGENT_LINK_DIRECTORY = '/run/opencraft-link';
export const GATEWAY_LINK_ROOT = '/run/opencraft-links';
export function inspectWorkspaceAgentServices(config) {
  for (const name of ['brain', 'hands']) {
    const service = config?.services?.[name];
    if (!service) throw new Error(`Compose configuration has no ${name} service`);
    const tmpfs = [service.tmpfs ?? []].flat();
    if (!tmpfs.some(entry => String(entry).split(':')[0] === AGENT_RUN_DIRECTORY))
      throw new Error(`${name} has no private ${AGENT_RUN_DIRECTORY} tmpfs; update deploy/docker to this release's Compose files`);
    if ((service.volumes ?? []).some(volume => volume.target === AGENT_RUN_DIRECTORY || String(volume.target ?? '').startsWith(AGENT_RUN_DIRECTORY + '/')))
      throw new Error(`${name} must not share ${AGENT_RUN_DIRECTORY} through a volume`);
    if (service.environment?.OPENCRAFT_AGENT_RUN_DIR !== undefined && service.environment.OPENCRAFT_AGENT_RUN_DIR !== AGENT_RUN_DIRECTORY)
      throw new Error(`${name} must use ${AGENT_RUN_DIRECTORY} as its agent run directory`);
    // static-docker: the agent's link is a named volume shared with the Gateway only.
    const link = (service.volumes ?? []).find(volume => volume.target === AGENT_LINK_DIRECTORY);
    if (service.environment?.OPENCRAFT_AGENT_LINK_DIR !== AGENT_LINK_DIRECTORY || link?.type !== 'volume' || !link.source)
      throw new Error(`${name} has no private static-docker link volume at ${AGENT_LINK_DIRECTORY}`);
    const gatewayLink = (config.services.gateway?.volumes ?? []).find(volume => volume.target === `${GATEWAY_LINK_ROOT}/${name}`);
    if (gatewayLink?.type !== 'volume' || gatewayLink.source !== link.source)
      throw new Error(`gateway does not mount the ${name} link at ${GATEWAY_LINK_ROOT}/${name}`);
    for (const [other, value] of Object.entries(config.services))
      if (!['gateway', name].includes(other) && (value.volumes ?? []).some(volume => volume.type === 'volume' && volume.source === link.source))
        throw new Error(`${other} must not mount the ${name} link`);
  }
}

export function inspectRollbackComposeHelp(help) {
  if (!/^\s+--pull\s+string\s/mu.test(help))
    throw new Error('Docker Compose cannot run rollback helpers with --pull never. Update the Compose plugin before upgrading.');
}

const rollbackRoles = ['gateway', 'hands'];

export function rollbackMounts(config) {
  return rollbackRoles.map(role => {
    const service = config.services?.[role];
    const root = service?.environment?.[role === 'hands' ? 'OPENCRAFT_EXECUTION_DIR' : 'OPENCRAFT_DATA_DIR'];
    const user = service?.user;
    if (typeof root !== 'string' || !posix.isAbsolute(root) || root === '/' || posix.normalize(root) !== root
      || !/^\d+:\d+$/u.test(user ?? ''))
      throw new Error(`Invalid ${role} runtime lock path or user in Compose configuration`);
    const dependency = service.network_mode?.match(/^service:(.+)$/u)?.[1];
    if (OWNER_ORDER.includes(dependency))
      throw new Error(`${role} rollback helper cannot share the network of ${dependency}, which must stop before rollback`);
    const [mount] = (service.volumes ?? []).filter(({ target }) =>
      typeof target === 'string' && (root === target || root.startsWith(target === '/' ? '/' : target + '/')))
      .sort((a, b) => b.target.length - a.target.length);
    if (mount?.type !== 'bind' || mount.read_only || !isAbsolute(mount.source ?? ''))
      throw new Error(`${role} runtime lock directory must be in a writable host bind: ${root}`);
    return { role, root, source: mount.source, hostPath: join(mount.source, posix.relative(mount.target, root)), user };
  });
}

export async function doctor(environment, { allowOversubscription = false, deployDirectory = dockerDirectory } = {}) {
  const required = ['OPENCRAFT_HOST_DATA_DIR', 'OPENCRAFT_DATA_DIR', 'OPENCRAFT_HOST_WORKSPACE_DIR', 'OPENCRAFT_WORKSPACE_DIR', 'OPENCRAFT_UID', 'OPENCRAFT_GID'];
  for (const name of required) if (!environment[name]) throw new Error(`Missing ${name}`);
  for (const name of Object.keys(EMBEDDED_CORE_ENVIRONMENT)) if (Object.hasOwn(environment, name))
    throw new Error(`Remove ${name} from .env; only an automatic restore selects the embedded account Core`);
  for (const name of required.slice(0, 4)) if (!environment[name].startsWith('/')) throw new Error(`${name} must be absolute`);
  const identity = deploymentIdentity(environment);
  if (process.getuid?.() !== identity.uid || process.getgid?.() !== identity.gid)
    throw new Error(`Run this tool as the deployment identity ${identity.uid}:${identity.gid}`);
  const layout = hostLayout(environment);
  await inspectDeploymentWritable(environment, deployDirectory);
  await inspectWorkspaceDirectory(layout.workspace, identity, environment);
  await Promise.all([layout.state, layout.execution, layout.gitCredentials, layout.logs, ...SERVICES.map(service => join(layout.logs, service))]
    .map(path => inspectPrivateDirectory(path, identity)));
  const resources = handsResources(environment);
  const requiredMemory = resources.memoryBytes + 2 * 1024 ** 3;
  if (!allowOversubscription && totalmem() < requiredMemory)
    throw new Error(`Host RAM is below Hands plus 2 GiB headroom (${totalmem()} < ${requiredMemory}); resize or use --allow-oversubscription intentionally`);
  if (!allowOversubscription && cpus().length * 1000 < resources.cpuMillis)
    throw new Error('Host CPU count is below the declared Hands budget');
  const disk = await statfs(environment.OPENCRAFT_HOST_DATA_DIR);
  if (disk.bavail * disk.bsize < 5 * 1024 ** 3) throw new Error('Less than 5 GiB is available in the data filesystem');
  inspectRollbackComposeHelp(runCompose(['run', '--help'], undefined, { capture: true }));
  const config = JSON.parse(runCompose(['config', '--format', 'json'], undefined, { capture: true }));
  inspectWorkspaceAgentServices(config);
  rollbackMounts(config);
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

function runningBrainEnvironment() {
  const id = execFileSync('docker', ['compose', '--env-file', '.env', 'ps', '-q', 'brain'], { cwd: dockerDirectory, encoding: 'utf8' }).trim();
  if (!id) return null;
  return JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Config.Env}}', id], { encoding: 'utf8' }));
}

function runSteps(steps, image) {
  for (const [action, service] of steps) {
    if (action === 'stop') {
      console.log(`Stopping ${service}.`);
      runCompose(['stop', '--timeout', '60', service], image);
    } else if (action === 'remove') runCompose(['rm', '--stop', '--force', service], image);
    else runCompose(['up', '-d', '--no-deps', ...(action === 'recreate' ? ['--force-recreate'] : []), '--wait', '--wait-timeout', '180', service], image,
      { embeddedCore: action === 'up-embedded' });
  }
}

async function applyOwners(image) {
  // A Brain that embeds the account Core is stopped so the proxy service can take the account writer.
  runSteps(ownerSteps({ brainEmbedsCore: brainEmbedsAccountCore(runningBrainEnvironment()) }), image);
}

async function rollbackPlan(image) {
  const config = JSON.parse(runCompose(['config', '--format', 'json'], image, { capture: true }));
  return Promise.all(rollbackMounts(config).map(async ({ role, root, source, hostPath, user }) => {
    const canonical = await realpath(hostPath);
    const path = relative(await realpath(source), canonical);
    if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path))
      throw new Error(`${role} runtime lock directory resolves outside its Compose bind: ${root}`);
    const info = await stat(canonical, { bigint: true });
    if (!info.isDirectory()) throw new Error(`${role} runtime lock bind is not a directory: ${hostPath}`);
    return { role, expected: JSON.stringify({ root, user, dev: String(info.dev), ino: String(info.ino) }) };
  }));
}

async function runRollbackHelpers(image, mode, plan) {
  const input = await readFile(new URL('./rollback-runtime-locks.mjs', import.meta.url));
  for (const { role, expected } of plan)
    runCompose(['run', '--rm', '--no-deps', '-T', '--pull', 'never', '--entrypoint', '/opt/opencraft/bin/node',
      role, '--input-type=module', '-', role, mode, expected], image, { input });
}

async function prepareOwnerRollback(image, plan) {
  // Some newer owners retain a file at the pathname older owners need as a
  // directory. Stop every writer before preparing the shared mounts.
  runCompose(['stop', '--timeout', '60', ...OWNER_ORDER], image);
  if (runCompose(['ps', '-q', ...OWNER_ORDER], image, { capture: true }).trim())
    throw new Error('OpenCraft owners are still running; cannot prepare runtime locks for rollback');
  await runRollbackHelpers(image, 'archive', plan);
}

async function restoreOwners(image, embeddedCoreBefore, plan) {
  await prepareOwnerRollback(image, plan);
  if (embeddedCoreBefore) console.error('Returning to the embedded account Core that ran before this release.');
  runSteps(restoreSteps({ embeddedCoreBefore }), image);
}

async function atomicWrite(path, text, mode = 0o600) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, text, { mode, flag: 'wx' });
  await rename(temporary, path);
}

async function applyImage({ image: requestedImage, rollback, envPath, allowMutable, allowOversubscription }) {
  const environment = parseEnvironment(await readFile(envPath, 'utf8'));
  await doctor(environment, { allowOversubscription });
  const release = await acquireLock(environment.OPENCRAFT_HOST_DATA_DIR);
  const statePath = join(environment.OPENCRAFT_HOST_DATA_DIR, 'deployment', 'compose-state.json');
  let previousState = null;
  try {
    const original = await readFile(envPath, 'utf8');
    const previous = parseEnvironment(original).OPENCRAFT_IMAGE;
    if (!previous) throw new Error('OPENCRAFT_IMAGE is missing from .env');
    try { previousState = await readFile(statePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (rollback && !previousState) throw new Error('No previous Compose release is recorded');
    const image = rollback ? JSON.parse(previousState).previousImage : requestedImage;
    assertImageReference(image, allowMutable);
    // Observed before any step: the topology a failed release must return to.
    const embeddedCoreBefore = brainEmbedsAccountCore(runningBrainEnvironment());
    if (!allowMutable) runCompose(['pull', 'hands'], image);
    // Exercise the exact one-off container before changing any running owner.
    const previousRollback = await rollbackPlan(previous), nextRollback = await rollbackPlan(image);
    await runRollbackHelpers(previous, 'check', previousRollback);
    await runRollbackHelpers(image, 'check', nextRollback);
    try {
      if (rollback) await prepareOwnerRollback(image, nextRollback);
      await applyOwners(image);
    }
    catch (error) {
      console.error(`Upgrade failed; restoring ${previous}`);
      try { await restoreOwners(previous, embeddedCoreBefore, previousRollback); }
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
      try { await restoreOwners(previous, embeddedCoreBefore, previousRollback); } catch (error) { failures.push(error); }
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
    await applyImage({ rollback: true, envPath, allowMutable: flags.has('--allow-mutable-image'), allowOversubscription: flags.has('--allow-oversubscription') });
    return;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error); process.exitCode = 1; });
