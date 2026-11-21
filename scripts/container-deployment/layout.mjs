import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICES = Object.freeze(['brain', 'gateway', 'hands']);

export function hostLayout(environment) {
  const absolute = (key, fallback) => {
    const value = environment[key] ?? fallback;
    if (!value || !isAbsolute(value) || resolve(value) === '/') throw new Error(`Set ${key} to an absolute non-root directory`);
    return resolve(value);
  };
  const state = absolute('OPENCRAFT_HOST_DATA_DIR');
  const workspace = absolute('OPENCRAFT_HOST_WORKSPACE_DIR');
  const execution = absolute('OPENCRAFT_HOST_EXECUTION_DIR', join(state, 'execution'));
  const logs = absolute('OPENCRAFT_HOST_LOG_DIR', join(state, 'logs'));
  const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..' + '/') && path !== '..' && !isAbsolute(path)); };
  if (inside(workspace, state) || inside(state, workspace)) throw new Error('State and workspace directories must not overlap');
  if (inside(workspace, execution) || inside(execution, workspace)) throw new Error('Execution state and workspace directories must not overlap');
  if (inside(workspace, logs) || inside(logs, workspace) || inside(logs, state) || inside(execution, logs) || inside(logs, execution))
    throw new Error('Logs must be separate from workspaces, private execution state and the state root');
  // Compose binds this directory for Git credential helpers without creating it.
  const gitCredentials = join(execution, 'git-credentials');
  return { state, workspace, execution, gitCredentials, logs };
}

export async function inspectPrivateDirectory(path, identity) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} must be a real directory, not a symlink`);
  if (info.uid !== identity.uid || info.gid !== identity.gid) throw new Error(`${path} is not owned by ${identity.uid}:${identity.gid}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by group or others`);
}

export async function inspectWorkspaceDirectory(path, identity, environment) {
  if (environment.OPENCRAFT_LEGACY_SHARED_WORKSPACE !== '1') return inspectPrivateDirectory(path, identity);
  // Explicit adoption may retain an administrator-owned, read-only workspace
  // root. Do not chown a shared host directory merely to satisfy new defaults.
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0)
    throw new Error('Legacy shared workspace must be a real directory without group/other write access');
  await access(path, constants.R_OK | constants.X_OK);
}

export async function prepareLayout(environment, identity) {
  const layout = hostLayout(environment);
  // Never silently create an empty browser profile beside an existing install.
  try {
    await access(join(layout.state, 'hands'));
    if (!environment.OPENCRAFT_HOST_EXECUTION_DIR)
      throw new Error('Legacy Hands state exists. Run layout.mjs adopt-legacy before prepare; existing thread cwd must be retained.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const directory of [layout.state, layout.execution, layout.gitCredentials, layout.logs, ...SERVICES.map(service => join(layout.logs, service))]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await inspectPrivateDirectory(directory, identity);
  }
  await mkdir(layout.workspace, { recursive: true, mode: 0o700 });
  await inspectWorkspaceDirectory(layout.workspace, identity, environment);
  return layout;
}

export function legacyLayoutValues(environment) {
  for (const key of ['OPENCRAFT_HOST_DATA_DIR', 'OPENCRAFT_DATA_DIR', 'OPENCRAFT_WORKSPACE_DIR'])
    if (!environment[key] || !isAbsolute(environment[key])) throw new Error(`Missing absolute ${key}`);
  // A thread's recorded cwd is durable. Pin old identities explicitly instead
  // of rewriting engine databases or guessing aliases during live execution.
  return {
    OPENCRAFT_HOST_EXECUTION_DIR: join(environment.OPENCRAFT_HOST_DATA_DIR, 'hands'),
    OPENCRAFT_EXECUTION_DIR: join(environment.OPENCRAFT_DATA_DIR, 'hands'),
    OPENCRAFT_BROWSER_DATA_DIR: join(environment.OPENCRAFT_DATA_DIR, 'hands'),
    OPENCRAFT_CODEX_PROJECTLESS_DIR: join(environment.OPENCRAFT_DATA_DIR, 'hands', 'projectless-workspaces'),
    OPENCRAFT_DSH_PROJECTLESS_DIR: join(environment.OPENCRAFT_DATA_DIR, 'workspaces'),
    OPENCRAFT_GATEWAY_HOME: join(environment.OPENCRAFT_DATA_DIR, 'container-home'),
    OPENCRAFT_LEGACY_SHARED_WORKSPACE: '1',
  };
}

async function main() {
  const { deploymentIdentity, parseEnvironment, setEnvironmentValue } = await import('./compose-release.mjs');
  const command = process.argv[2];
  if (!['prepare', 'adopt-legacy'].includes(command)) throw new Error('Usage: layout.mjs prepare|adopt-legacy');
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../docker/.env');
  let source = await readFile(path, 'utf8');
  const environment = parseEnvironment(source), identity = deploymentIdentity(environment);
  if (process.getuid() !== identity.uid || process.getgid() !== identity.gid) throw new Error('Run as the deployment UID:GID');
  if (command === 'adopt-legacy') {
    await inspectPrivateDirectory(join(environment.OPENCRAFT_HOST_DATA_DIR, 'hands'), identity);
    const values = legacyLayoutValues(environment);
    for (const [key, value] of Object.entries(values)) {
      if (environment[key] && environment[key] !== value) throw new Error(`Refusing to overwrite existing ${key}`);
      source = setEnvironmentValue(source, key, value);
    }
    // A private backup is required before changing path authority.
    await writeFile(`${path}.before-layout`, await readFile(path), { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const temporary = `${path}.layout-${process.pid}`;
    await writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    console.log('Legacy paths pinned in .env; no state was moved and no service was restarted.');
  } else {
    await access(path, constants.R_OK);
    console.log(JSON.stringify(await prepareLayout(environment, identity), null, 2));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
