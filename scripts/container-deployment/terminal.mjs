import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { startTerminalPtyOwner } from '../../apps/local-agent-host/src/terminal-pty-owner.js';
import { verifyHandsCgroup } from '@opencraft/sandbox-node/hands-unix';
import { validateEnvironmentName } from '@opencraft/execution-environment/account-environment';
import { deploymentPaths, readPrivateToken } from './paths.mjs';
import { handsResources } from './resources.mjs';

const methods = new Set(['process/spawn', 'process/attach', 'process/list', 'process/writeStdin', 'process/resizePty', 'process/kill']);
export async function startHandsTerminal(paths, { verify = true } = {}) {
  if (verify) await verifyHandsCgroup(handsResources());
  await mkdir(paths.terminalDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(paths.terminalDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || directory.mode & 0o077)
    throw new Error('Terminal owner directory must be private');
  await mkdir(paths.codexProjectlessDirectory, { recursive: true, mode: 0o700 });
  try { await writeFile(paths.terminalToken, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const token = await readPrivateToken(paths.terminalToken);
  const roots = await Promise.all([paths.runtimeDirectory, paths.codexProjectlessDirectory].map(path => realpath(path)));
  // A Host that pins an ENV issuer on attach launches through capsules opened
  // here under this owner's reservation; other Hosts are unchanged.
  return startTerminalPtyOwner(paths.terminalDirectory, paths.terminalEndpoint, { token, environmentLaunch: true, prepare: async (method, params, identity) => {
    if (method === 'process/threadScopes' && identity?.lifecycleAuthority === true) return identity;
    if (method === 'process/releaseThread' && identity?.lifecycleAuthority === true
      && typeof identity.scope?.hostId === 'string' && typeof identity.scope?.threadId === 'string') return identity;
    if (!methods.has(method) || !identity || typeof identity.owner !== 'string' || identity.owner.length > 512 ||
      typeof identity.quotaOwner !== 'string' || identity.quotaOwner.length > 512) throw new Error('Invalid terminal authority');
    if (method !== 'process/spawn') return identity;
    if (!params || typeof params.cwd !== 'string' || !isAbsolute(params.cwd) || params.cwd.includes('\0')) throw new Error('Invalid terminal workspace');
    const cwd = await realpath(params.cwd);
    if (!roots.some(root => { const path = relative(root, cwd); return path === '' || path !== '..' && !path.startsWith('../') && !isAbsolute(path); }))
      throw new Error('Terminal workspace is outside execution mounts');
    const env = {};
    // Only the execution owner supplies HOME/PATH. Brain's ambient credentials
    // and loader variables never become terminal process environment.
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR'])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    if (!identity.env || Object.keys(identity.env).length > 100) throw new Error('Invalid terminal environment');
    let bytes = 0;
    for (const [key, value] of Object.entries(identity.env)) {
      validateEnvironmentName(key);
      if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 16384) throw new Error('Invalid terminal environment');
      bytes += Buffer.byteLength(value);
      if (bytes > 65536) throw new Error('Terminal environment exceeds its budget');
      env[key] = value;
    }
    // Without a character locale, Bash/Readline renders UTF-8 input as octal
    // escapes. Default only when neither the execution owner nor caller chose one.
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'C.UTF-8';
    return { ...identity, env: { ...env, TERM: 'xterm-256color' } };
  } });
}

if (process.argv[2] === '--hands-terminal-owner') {
  const stop = await startHandsTerminal(deploymentPaths());
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void stop().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); });
  console.log('OpenCraft Hands terminal owner ready');
}
