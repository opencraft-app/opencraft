import { createServer, type Socket } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { timingSafeEqual } from 'node:crypto';
import { HostProcessService, TerminalCapacityError, type PreparedProcessIdentity } from './process-service.js';
import { readOwnerFrames, sendOwnerFrame, TERMINAL_OWNER_PROTOCOL } from './terminal-owner-wire.js';

/** Independent PTY owner. Losing every Host connection never closes a PTY. */
export async function startTerminalPtyOwner(directory: string, endpoint: string, options: {
  token?: string; prepare?: (method: string, params: unknown, identity: PreparedProcessIdentity) => Promise<PreparedProcessIdentity>;
} = {}) {
  const release = await lockfile.lock(directory, { realpath: true, stale: 30_000, update: 5000, retries: 0 });
  const processes = new HostProcessService(), peers = new Set<Socket>(), admittedPeers = new Set<Socket>();
  const server = createServer(socket => {
    if (peers.size >= 32) { socket.destroy(); return; }
    peers.add(socket);
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    let admitted = false;
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); peers.delete(socket); admittedPeers.delete(socket); });
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
        admitted = true; admittedPeers.add(socket); clearTimeout(timer);
        sendOwnerFrame(socket, { type: 'attached', protocol: TERMINAL_OWNER_PROTOCOL, pid: process.pid }); return;
      }
      if (!Number.isSafeInteger(message?.id) || message.id < 1 || typeof message.method !== 'string' || !message.method.startsWith('process/')
        || !message.identity || typeof message.identity.quotaOwner !== 'string') { socket.destroy(); return; }
      if (++requests > 128) { socket.destroy(); return; }
      void (async () => {
        try {
          const identity = options.prepare ? await options.prepare(message.method, message.params, message.identity) : message.identity;
          if (socket.destroyed) return;
          const result = processes.dispatchPrepared(message.method, message.params, identity);
          sendOwnerFrame(socket, { id: message.id, result });
        } catch (error) {
          sendOwnerFrame(socket, { id: message.id, error: error instanceof TerminalCapacityError ? 'capacity' : 'unavailable' });
        } finally { requests--; }
      })();
    });
  });
  processes.subscribe((method, params) => {
    for (const peer of admittedPeers) if (!peer.destroyed) sendOwnerFrame(peer, { method, params });
  });
  try {
    await unlink(endpoint).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); }); });
    if (process.platform !== 'win32') await chmod(endpoint, 0o600);
  } catch (error) { processes.close(); await release(); throw error; }
  let stopping = false;
  return async () => {
    if (stopping) return; stopping = true;
    await processes.shutdown(); for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(endpoint).catch(() => {}); await release();
  };
}

if (process.argv[2] === '--terminal-pty-owner') {
  startTerminalPtyOwner(process.argv[3]!, process.argv[4]!).then(stop => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
  }).catch(() => { process.exitCode = 1; });
}
