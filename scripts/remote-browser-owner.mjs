import { connect } from 'node:net';
import { BrowserOwnerEvents } from './browser-owner-events.mjs';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import owner from './remote-browser/owner.cjs';
import { publishBrowserOwnerRuntime } from './browser-owner-runtime.mjs';
import { browserRuntimeIdentity } from './browser-runtime-identity.mjs';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', code => resolve(code));
  });
}

// Caller must hold the exclusive attachment and reconcile an empty inventory.
export async function stopEmptyBrowserOwner(dataDirectory) {
  const state = 'opencraft-browser-' + createHash('sha256').update(dataDirectory).digest('hex').slice(0, 16);
  if (await run('systemctl', ['stop', state + '-owner-v' + owner.PROTOCOL]) !== 0)
    throw new Error('Empty browser owner could not stop');
}

/** An ephemeral, fenced Gateway transport to the private persistent owner. */
export async function connectBrowserOwner(socketPath) {
  const socket = connect(socketPath), transport = new BrowserOwnerEvents();
  transport.connected = true;
  transport.closed = new Promise(resolve => socket.once('close', resolve));
  transport.send = (message, callback) => socket.write(JSON.stringify(message) + '\n', callback);
  transport.kill = () => { socket.destroy(); return transport.closed; };
  let attached = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Browser owner attach timed out')); socket.destroy(); }, 15000); timer.unref();
    const failed = error => { if (!attached) { clearTimeout(timer); reject(error); } else transport.publish('error', error); };
    socket.on('error', failed);
    socket.on('close', () => { transport.connected = false; clearTimeout(timer); if (!attached) reject(new Error('Browser owner attach closed')); else transport.publish('exit'); });
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'attach', protocol: owner.PROTOCOL }) + '\n'));
    owner.readMessages(socket, 32 * 1024 * 1024, message => {
      if (!attached) {
        if (message.type === 'owner-incompatible') {
          const error = Object.assign(new Error('Browser runtime protocol changed; close its tabs before upgrading the owner'), { code: 'BROWSER_OWNER_INCOMPATIBLE', retryable: false });
          clearTimeout(timer); reject(error); socket.destroy(); return;
        }
        if (message.type !== 'attached' || message.protocol !== owner.PROTOCOL || !Array.isArray(message.pages)) { clearTimeout(timer); reject(new Error('Browser owner unavailable')); socket.destroy(); return; }
        attached = true; clearTimeout(timer); transport.inventory = message.pages; transport.workerPid = message.workerPid; resolve(transport);
      } else transport.publish('message', message);
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
export async function prepareBrowserOwnerConnector(directory) {
  // Keep full payload reads before attachment; the bounded greeting buffer
  // covers only the short managed-incarnation recheck before handoff.
  await Promise.all([access(join(directory, 'worker.cjs')), access(join(directory, 'owner.cjs')),
    access(join(directory, 'electron/electron'), constants.X_OK)]);
  const identity = await browserRuntimeIdentity(directory);
  return ({ dataDirectory }) => startPreparedBrowserOwner(directory, dataDirectory, identity);
}

export async function startBrowserOwner({ directory, dataDirectory }) {
  return (await prepareBrowserOwnerConnector(directory))({ dataDirectory });
}

const unavailableOwner = () => Object.assign(new Error('Browser owner unavailable'), { code: 'BROWSER_UNAVAILABLE', retryable: true });

// Only bounded manager metadata is read here; no environment or command line.
export async function managedOwnerState(unit) {
  const { code, text } = await new Promise((resolve, reject) => {
    const child = spawn('systemctl', ['show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'InvocationID'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '', settled = false;
    function fail() {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // A deadline cannot wait for a cooperative exit from the query process.
      reject(unavailableOwner()); child.kill('SIGKILL');
    }
    const timer = setTimeout(fail, 5000); timer.unref();
    child.stdout.on('data', bytes => {
      if (settled) return;
      if (Buffer.byteLength(text) + bytes.length > 4096) fail(); else text += bytes;
    });
    child.stdout.once('error', fail);
    child.once('error', error => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.once('close', code => { clearTimeout(timer); if (!settled) { settled = true; resolve({ code, text }); } });
  });
  const values = Object.create(null);
  for (const row of text.trim().split('\n')) {
    const i = row.indexOf('='), key = row.slice(0, i);
    if (i < 0 || !['LoadState', 'ActiveState', 'MainPID', 'InvocationID'].includes(key) || key in values) throw unavailableOwner();
    values[key] = row.slice(i + 1);
  }
  if (values.LoadState === 'not-found' && values.MainPID === '0' && values.ActiveState === 'inactive')
    return { state: 'inactive', pid: 0, invocation: '' };
  if (code !== 0 || !values.LoadState || !values.ActiveState || !/^\d+$/.test(values.MainPID ?? '')) throw unavailableOwner();
  const pid = Number(values.MainPID), invocation = values.InvocationID;
  if (!Number.isSafeInteger(pid) || pid < 0 || (pid > 0 && !/^[0-9a-f]{32}$/.test(invocation ?? ''))) throw unavailableOwner();
  return { state: values.ActiveState, pid, invocation };
}

async function startPreparedBrowserOwner(directory, dataDirectory, identity) {
  const state = 'opencraft-browser-' + createHash('sha256').update(dataDirectory).digest('hex').slice(0, 16);
  const unit = state + '-owner-v' + owner.PROTOCOL;
  const socketPath = '/var/lib/' + state + '/owner.sock';
  let until = Date.now() + 15000, starts = 0;
  do {
    const before = await managedOwnerState(unit);
    // Read the mounted winner, not a candidate path or compatibility alias.
    // Hash before attachment; native events are bounded-buffered only during
    // the short incarnation check after the owner greeting.
    const current = before.pid > 0
      ? await browserRuntimeIdentity(`/proc/${before.pid}/root/opt/opencraft-browser`).then(value => value === identity)
      : false;
    try {
      const attached = await connectBrowserOwner(socketPath);
      try {
        const after = await managedOwnerState(unit);
        if (!attached.connected || !before.pid || before.pid !== after.pid || before.invocation !== after.invocation) throw unavailableOwner();
        const reused = await reuseBrowserOwner(attached, () => current, () => stopEmptyBrowserOwner(dataDirectory));
        if (reused) return reused;
        await attached.closed;
      } catch (error) {
        attached.on('error', () => {}); await attached.kill(); throw error;
      }
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    }
    const now = await managedOwnerState(unit);
    if (['inactive', 'failed'].includes(now.state)) {
      if (starts++ >= 2) throw unavailableOwner();
      const runtime = await publishBrowserOwnerRuntime(directory, dataDirectory, identity);
      const code = await run('systemd-run', ['--collect', '--quiet', '--service-type=exec', '--unit=' + unit,
        '-p', 'DynamicUser=yes', '-p', 'PrivateTmp=yes', '-p', 'NoNewPrivileges=yes',
        '-p', 'StateDirectory=' + state, '-p', 'StateDirectoryMode=0700', '-p', 'UMask=0077',
        '-p', 'StandardOutput=null', '-p', 'StandardError=null',
        '-p', 'BindReadOnlyPaths=' + runtime + ':/opt/opencraft-browser',
        '-p', 'Environment=OPENCRAFT_BROWSER_DATA_DIR=/var/lib/' + state,
        '-p', 'Environment=HOME=/var/lib/' + state,
        '/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', '/opt/opencraft-browser/electron/electron', '/opt/opencraft-browser/owner.cjs']);
      // Another start can win between observation and submission. Its actual
      // mounted payload and incarnation still decide identity on attachment.
      if (code !== 0 && !['active', 'activating', 'reloading'].includes((await managedOwnerState(unit)).state))
        throw new Error('Browser owner could not start');
      until = Date.now() + 15000;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw new Error('Browser owner startup timed out');
}
