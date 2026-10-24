import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import owner from './remote-browser/owner.cjs';
import { prepareBrowserRuntimeAccess } from './remote-browser-access.mjs';
import { browserRuntimeIdentity } from './browser-runtime-identity.mjs';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', code => resolve(code));
  });
}

/** An ephemeral, fenced Gateway transport to the private persistent owner. */
export async function connectBrowserOwner(socketPath) {
  const socket = connect(socketPath), transport = new EventEmitter();
  transport.connected = true;
  transport.send = (message, callback) => socket.write(JSON.stringify(message) + '\n', callback);
  transport.kill = () => socket.destroy();
  let attached = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Browser owner attach timed out')); socket.destroy(); }, 15000); timer.unref();
    const failed = error => { if (!attached) { clearTimeout(timer); reject(error); } else transport.emit('error', error); };
    socket.on('error', failed);
    socket.on('close', () => { transport.connected = false; clearTimeout(timer); if (!attached) reject(new Error('Browser owner attach closed')); else transport.emit('exit'); });
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'attach', protocol: owner.PROTOCOL }) + '\n'));
    owner.readMessages(socket, 32 * 1024 * 1024, message => {
      if (!attached) {
        if (message.type === 'owner-incompatible') {
          const error = Object.assign(new Error('Browser runtime protocol changed; close its tabs before upgrading the owner'), { code: 'BROWSER_OWNER_INCOMPATIBLE', retryable: false });
          clearTimeout(timer); reject(error); socket.destroy(); return;
        }
        if (message.type !== 'attached' || message.protocol !== owner.PROTOCOL || !Array.isArray(message.pages)) { clearTimeout(timer); reject(new Error('Browser owner unavailable')); socket.destroy(); return; }
        attached = true; clearTimeout(timer); transport.inventory = message.pages; transport.workerPid = message.workerPid; resolve(transport);
      } else transport.emit('message', message);
    }, () => socket.destroy());
  });
}

export async function reuseBrowserOwner(transport, current, stop) {
  // This transport is the sole attached peer. Its inventory was taken after
  // draining the previous Gateway, so no other writer can create a page here.
  transport.runtimeCurrent = await current();
  if (transport.runtimeCurrent || transport.inventory.length) return transport;
  // This transport is intentionally retired and is never handed to Gateway.
  // A socket error racing the managed stop must remain a local close outcome.
  transport.on?.('error', () => {});
  try { await stop(); } finally { transport.kill(); }
  return null;
}

/** Managed Linux only. The manager owns process lifetime; immutable runtime
 * files live outside releases, so release cleanup cannot break a retained tab. */
export async function startBrowserOwner({ directory, dataDirectory }) {
  const state = 'opencraft-browser-' + createHash('sha256').update(dataDirectory).digest('hex').slice(0, 16);
  const unit = state + '-owner-v' + owner.PROTOCOL;
  const socketPath = '/var/lib/' + state + '/owner.sock';
  // Do filesystem work before attachment: once attached, native events must
  // reach the Gateway immediately, without an unobserved asynchronous gap.
  let runtimeCurrent = true;
  try { runtimeCurrent = await browserRuntimeIdentity(directory) === await browserRuntimeIdentity(join(dataDirectory, 'owner-runtime')); }
  catch { /* Unknown runtime identity must never destroy tabs. */ }
  try {
    const attached = await connectBrowserOwner(socketPath);
    const reused = await reuseBrowserOwner(attached, () => runtimeCurrent, async () => {
      if (await run('systemctl', ['stop', unit]) !== 0) throw new Error('Empty browser owner could not stop');
    });
    if (reused) return reused;
  } catch (error) {
    if (error.code === 'BROWSER_OWNER_INCOMPATIBLE') throw error;
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  // Do not replace the mounted runtime of a live/starting owner.
  if (await run('systemctl', ['is-active', '--quiet', unit]) !== 0) {
    const runtime = join(dataDirectory, 'owner-runtime');
    const staged = join(dataDirectory, 'owner-runtime-' + randomUUID());
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    try {
      await cp(directory, staged, { recursive: true });
      await prepareBrowserRuntimeAccess(staged);
      await rm(runtime, { recursive: true, force: true }); await rename(staged, runtime);
      const code = await run('systemd-run', ['--collect', '--quiet', '--service-type=exec', '--unit=' + unit,
        '-p', 'DynamicUser=yes', '-p', 'PrivateTmp=yes', '-p', 'NoNewPrivileges=yes',
        '-p', 'StateDirectory=' + state, '-p', 'StateDirectoryMode=0700', '-p', 'UMask=0077',
        '-p', 'StandardOutput=null', '-p', 'StandardError=null',
        '-p', 'BindReadOnlyPaths=' + runtime + ':/opt/opencraft-browser',
        '-p', 'Environment=OPENCRAFT_BROWSER_DATA_DIR=/var/lib/' + state,
        '-p', 'Environment=HOME=/var/lib/' + state,
        '/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', '/opt/opencraft-browser/electron/electron', '/opt/opencraft-browser/owner.cjs']);
      if (code !== 0) throw new Error('Browser owner could not start');
    } finally { await rm(staged, { recursive: true, force: true }); }
  }
  const until = Date.now() + 15000;
  do {
    try { const attached = await connectBrowserOwner(socketPath); attached.runtimeCurrent = true; return attached; } catch (error) {
      if (error.code === 'BROWSER_OWNER_INCOMPATIBLE') throw error;
      if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw new Error('Browser owner startup timed out');
}
