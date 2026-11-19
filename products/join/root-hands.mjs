// Root execution is explicit. Browser and client credentials keep their own UID.
import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { startContainerHands } from '../../scripts/container-deployment/hands-application.mjs';

function privateDirectory(path, uid, gid) {
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || s.gid !== gid || s.mode & 0o077)
    throw Error('Root Hands requires existing private role-owned directories');
  // Never follow a writable/symlinked ancestor into a different state root.
  for (let current = dirname(path);; current = dirname(current)) {
    const parent = fs.lstatSync(current);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022 && !(parent.uid === 0 && parent.mode & 0o1000)))
      throw Error('Root Hands directory ancestors must be trusted');
    if (current === dirname(current)) break;
  }
}
export function rootHandsConfiguration(env = process.env) {
  const requiredPath = key => {
    const value = env[key];
    if (!value || !isAbsolute(value) || resolve(value) !== value || value === '/') throw Error('Invalid root Hands path: ' + key);
    return value;
  };
  const number = key => {
    const value = env[key];
    if (!/^[1-9][0-9]*$/.test(value ?? '') || (!Number.isSafeInteger(Number(value)) || Number(value) > 2147483647)) throw Error('Invalid root Hands client identity');
    return Number(value);
  };
  const server = requiredPath('OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY');
  const client = requiredPath('OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY');
  const publicClient = requiredPath('OPENCRAFT_HANDS_CLIENT_DIRECTORY');
  const browserName = env.OPENCRAFT_HANDS_BROWSER_NAME ?? 'browser';
  if (!['browser', '.'].includes(browserName)) throw Error('Invalid root Hands browser directory');
  const browserDirectory = env.OPENCRAFT_HANDS_BROWSER_DIRECTORY ? requiredPath('OPENCRAFT_HANDS_BROWSER_DIRECTORY') : undefined;
  if (browserDirectory && (browserDirectory === server || browserDirectory.startsWith(server + '/')))
    throw Error('Browser profile must stay outside private root execution state');
  if (server === client || server.startsWith(client + '/') || client.startsWith(server + '/') || env.OPENCRAFT_EXECUTION_DIR !== server)
    throw Error('Root Hands server/client roots must be separate');
  return { server, client, publicClient, browserName, ...(browserDirectory ? {browserDirectory} : {}), uid: number('OPENCRAFT_HANDS_CLIENT_UID'), gid: number('OPENCRAFT_HANDS_CLIENT_GID') };
}
// A declared legacy root preserves the existing Chromium profile and socket.
// No arbitrary path, recursive chown or profile copy is accepted.
function clientBrowser(c, root) { return c.browserDirectory ?? (c.browserName === '.' ? root : join(root, 'browser')); }
function token(path, uid, gid) {
  let fd;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== uid || s.gid !== gid || s.mode & 0o077 || s.size > 4096) throw Error('Invalid root Hands credential file');
    const value = fs.readFileSync(fd, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw Error('Invalid root Hands credential');
    return value;
  } finally { fs.closeSync(fd); }
}
function writeToken(path, value, uid, gid) {
  const fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.fchownSync(fd, uid, gid); fs.writeFileSync(fd, value + '\n'); } finally { fs.closeSync(fd); }
}
export function prepareRootHands(c) {
  if (process.getuid() !== 0) throw Error('Root Hands requires UID 0');
  privateDirectory(c.server, 0, 0); privateDirectory(c.client, c.uid, c.gid); privateDirectory(c.publicClient, c.uid, c.gid);
  if (c.browserDirectory) privateDirectory(c.browserDirectory, c.uid, c.gid);
  const a = fs.statSync(c.client), b = fs.statSync(c.publicClient);
  if (a.dev !== b.dev || a.ino !== b.ino) throw Error('Root Hands client mount does not match the common bridge directory');
  // Check hardlink compatibility before starting any owner (no silent EXDEV fallback).
  const probe = join(c.server, '.bridge-probe-' + process.pid + '-' + randomBytes(6).toString('hex'));
  const linked = join(c.client, '.bridge-probe-' + process.pid + '-' + randomBytes(6).toString('hex'));
  try { fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }); fs.linkSync(probe, linked); }
  finally { for (const path of [linked, probe]) try { fs.unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  if (c.browserDirectory) {
    const browserProbe = join(c.browserDirectory, '.browser-bridge-probe-' + process.pid + '-' + randomBytes(6).toString('hex'));
    try { fs.writeFileSync(probe, '', { flag:'wx', mode:0o600 }); fs.linkSync(probe, browserProbe); }
    finally { for (const path of [browserProbe, probe]) try { fs.unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  for (const name of ['exec-owner.token', 'files.token', 'terminal.token']) {
    const source = join(c.server, name), target = join(c.client, name);
    const rootValue = token(source, 0, 0), clientValue = token(target, c.uid, c.gid);
    if (rootValue && clientValue && !timingSafeEqual(Buffer.from(rootValue), Buffer.from(clientValue))) throw Error('Root Hands credential copies disagree');
    const value = rootValue ?? clientValue ?? randomBytes(32).toString('hex');
    if (!rootValue) writeToken(source, value, 0, 0);
    if (!clientValue) writeToken(target, value, c.uid, c.gid);
  }
  for (const [path, uid, gid] of [[join(c.server, 'browser'), 0, 0], [clientBrowser(c, c.client), c.uid, c.gid]]) {
    if (path === c.browserDirectory) { privateDirectory(path, uid, gid); continue; }
    try { fs.mkdirSync(path, { mode: 0o700 }); fs.chownSync(path, uid, gid); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    privateDirectory(path, uid, gid);
  }
}
function publish(source, target, expectedUid) {
  let s; try { s = fs.lstatSync(source); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!s.isSocket() || s.uid !== expectedUid) throw Error('Unexpected root Hands socket owner');
  let d; try { d = fs.lstatSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (d && (!d.isSocket() || d.isSymbolicLink())) throw Error('Refusing to replace non-socket root Hands endpoint');
  // Tokens and 0700 client directories remain mandatory; only the socket is shared.
  fs.chmodSync(source, 0o666);
  if (d && d.dev === s.dev && d.ino === s.ino) return;
  const temp = target + '.bridge-' + process.pid;
  try { fs.linkSync(source, temp); fs.renameSync(temp, target); }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
export function synchronizeRootHands(c) {
  for (const name of ['exec-owner.sock', 'files.sock', 'terminal.sock']) publish(join(c.server, name), join(c.client, name), 0);
  publish(join(clientBrowser(c, c.client), 'owner.sock'), join(c.server, 'browser/owner.sock'), c.uid);
}
export function prepareRootWorkspace(c, env) {
  const workspace = env.OPENCRAFT_WORKSPACE_DIR;
  if (!workspace || !isAbsolute(workspace)) throw Error('Root Hands requires an explicit workspace');
  for (const target of [env.OPENCRAFT_CODEX_PROJECTLESS_DIR ?? join(workspace, 'sessions/codex'), env.OPENCRAFT_DSH_PROJECTLESS_DIR ?? join(workspace, 'sessions/dsh')]) {
    // Legacy external cwds are retained, not moved/re-owned by environment startup.
    if (!target.startsWith(workspace + '/')) continue;
    let path = workspace;
    for (const part of target.slice(workspace.length + 1).split('/')) {
      if (!part || part === '.' || part === '..') throw Error('Invalid shared projectless workspace');
      path = join(path, part);
      try { fs.mkdirSync(path, { mode: 0o700 }); fs.chownSync(path, c.uid, c.gid); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      const info = fs.lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Invalid shared workspace directory');
    }
  }
}
export async function startRootHands() {
  const c = rootHandsConfiguration(); prepareRootHands(c); prepareRootWorkspace(c, process.env);
  await startContainerHands({
    // A trusted runtime composition hook, never a plugin directory or user module.
    spawnOwner(command, args, options) {
      return spawn(command, args, args[0].endsWith('/browser/owner.cjs') ? {
        ...options, uid: c.uid, gid: c.gid,
        env: { ...options.env, OPENCRAFT_BROWSER_DATA_DIR: clientBrowser(c, c.publicClient), HOME: c.browserDirectory ?? c.publicClient },
      } : options);
    },
    startServices(fail) {
      const timer = setInterval(() => {
        try { synchronizeRootHands(c); }
        catch { console.error('Root Hands IPC bridge failed; refusing degraded operation'); clearInterval(timer); fail(); }
      }, 100);
      return [{ close: async () => clearInterval(timer) }];
    },
  });
}
