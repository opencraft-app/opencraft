import { openTerminalAdmission } from './terminal-admission-owner.js';
import { randomBytes } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { timingSafeEqual } from 'node:crypto';
import { HostProcessService, TerminalCapacityError, type PreparedProcessIdentity } from './process-service.js';
import { readOwnerFrames, sendOwnerFrame, TERMINAL_OWNER_PROTOCOL } from './terminal-owner-wire.js';

/** Independent PTY owner. Losing every Host connection never closes a PTY. */
export async function startTerminalPtyOwner(directory: string, endpoint: string, options: {
  token?: string; prepare?: (method: string, params: unknown, identity: PreparedProcessIdentity) => Promise<PreparedProcessIdentity>;
  /** Called once no Host has been attached and no PTY has been running for `idleMs`; nothing remains to own. */
  onIdle?: () => void; idleMs?: number;
} = {}) {
  const release = await lockfile.lock(directory, { realpath: true, stale: 30_000, update: 5000, retries: 0 });
  let admission: Awaited<ReturnType<typeof openTerminalAdmission>>;
  try { admission = await openTerminalAdmission(directory); } catch (error) { await release(); throw error; }
  const incarnation = randomBytes(32).toString('hex');
  let admissionFailed = false;
  const processes = new HostProcessService(), peers = new Set<Socket>(), admittedPeers = new Set<Socket>();
  const server = createServer(socket => {
    if (peers.size >= 32) { socket.destroy(); return; }
    peers.add(socket);
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    let admitted = false;
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); peers.delete(socket); admittedPeers.delete(socket); idleCheck(); });
    let requests = 0;
    readOwnerFrames(socket, message => {
      if (!admitted) {
        const validToken = !options.token || typeof message?.token === 'string' && Buffer.byteLength(message.token) === Buffer.byteLength(options.token)
          && timingSafeEqual(Buffer.from(message.token), Buffer.from(options.token));
        if (!validToken) { socket.destroy(); return; }
        if (message?.type === 'probe' && message.protocol === TERMINAL_OWNER_PROTOCOL) {
          clearTimeout(timer); sendOwnerFrame(socket, { type: 'healthy', protocol: TERMINAL_OWNER_PROTOCOL }); socket.end(); return;
        }
        if (message?.type !== 'attach' || message.protocol !== TERMINAL_OWNER_PROTOCOL) {
          sendOwnerFrame(socket, { type: 'incompatible' }); socket.end(); return;
        }
        admitted = true; admittedPeers.add(socket); clearTimeout(timer); idleCheck();
        sendOwnerFrame(socket, { type: 'attached', protocol: TERMINAL_OWNER_PROTOCOL, pid: process.pid, terminalAdmission: 1 }); return;
      }
      if (!Number.isSafeInteger(message?.id) || message.id < 1 || typeof message.method !== 'string' || !message.method.startsWith('process/')
        || !message.identity || typeof message.identity.quotaOwner !== 'string') { socket.destroy(); return; }
      if (++requests > 128) { socket.destroy(); return; }
      void (async () => {
        try {
          // Private quota control has no cwd, environment or executable. It uses
          // the authenticated owner socket, never the product's process adapter.
          // Actual local spawns still pass that adapter before any reservation.
          const quotaControl = message.method.startsWith('process/quota');
          const identity = !quotaControl && options.prepare ? await options.prepare(message.method, message.params, message.identity) : message.identity;
          if (socket.destroyed) return;
          if (identity.lifecycleAuthority === true && message.method.startsWith('process/quota')) {
            const p = message.params;
            let result: unknown;
            if (message.method === 'process/quotaProbe') result = await admission.probe();
            else if (message.method === 'process/quotaReserve') result = await admission.reserve('remote', identity.quotaOwner, p?.resource, p?.operation);
            else if (message.method === 'process/quotaRelease' && ['exited','not-created'].includes(p?.proof)) result = await admission.release(p.token);
            else if (message.method === 'process/quotaResourceDestroyed') result = await admission.destroyRemoteResource(identity.quotaOwner, p?.resource);
            else throw Error('Invalid terminal admission operation');
            sendOwnerFrame(socket, { id: message.id, result }); return;
          }
          if (message.method.startsWith('process/quota')) throw Error('Private terminal admission required');
          let token: string | undefined, physical = false;
          if (message.method === 'process/spawn') {
            token = await admission.reserve('local', identity.quotaOwner, incarnation, message.params?.processHandle);
            // A disconnected requester cannot authorize a later physical spawn.
            if (socket.destroyed) { await admission.release(token); return; }
          }
          try {
            const receipt = token;
            const result = processes.dispatchPrepared(message.method, message.params, identity, receipt ? {
              started: () => { physical = true; },
              exited: () => { void admission.release(receipt).catch(() => { admissionFailed = true; }); },
            } : undefined);
            sendOwnerFrame(socket, { id: message.id, result });
          } catch (error) {
            if (token && !physical) await admission.release(token);
            throw error;
          }
        } catch (error) {
          sendOwnerFrame(socket, { id: message.id, error: error instanceof TerminalCapacityError ? 'capacity' : 'unavailable' });
        } finally { requests--; }
      })();
    });
  });
  // Running PTYs survive every Host disconnect; with none left and no Host attached, the
  // owner leaves too instead of outliving the app (exited replay goes with it).
  let idleTimer: ReturnType<typeof setTimeout> | undefined, stopping = false;
  const idleCheck = () => {
    if (!options.onIdle || stopping) return;
    if (admittedPeers.size || processes.runningCount) { clearTimeout(idleTimer); idleTimer = undefined; return; }
    idleTimer ??= setTimeout(() => {
      idleTimer = undefined;
      if (!stopping && !admittedPeers.size && !processes.runningCount) options.onIdle!();
    }, options.idleMs ?? 60_000);
  };
  processes.subscribe((method, params) => {
    for (const peer of admittedPeers) if (!peer.destroyed) sendOwnerFrame(peer, { method, params });
    if (method === 'process/exited') idleCheck();
  });
  try {
    await unlink(endpoint).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); }); });
    if (process.platform !== 'win32') await chmod(endpoint, 0o600);
  } catch (error) { processes.close(); await admission.close(); await release(); throw error; }
  idleCheck();
  return async () => {
    if (stopping) return; stopping = true; clearTimeout(idleTimer);
    await processes.shutdown(); for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(endpoint).catch(() => {});
    try { await admission.close(); if (admissionFailed) throw Error('Terminal admission settlement unconfirmed'); } finally { await release(); }
  };
}

if (process.argv[2] === '--terminal-pty-owner') {
  let stopOwner: (() => Promise<void>) | undefined;
  const exit = () => { void stopOwner?.().then(() => process.exit(0), () => process.exit(1)); };
  startTerminalPtyOwner(process.argv[3]!, process.argv[4]!, { onIdle: exit }).then(stop => {
    stopOwner = stop;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, exit);
  }).catch(() => { process.exitCode = 1; });
}
