'use strict';
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
const { chmod, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { createNativeDiagnostics } = require('./diagnostics.cjs');
const PROTOCOL = 1;

// Private, bounded JSON lines. The filesystem socket is never a public API.
function readMessages(stream, limit, receive, invalid) {
  let buffer = ''; const decoder = new StringDecoder('utf8');
  stream.on('data', chunk => {
    buffer += decoder.write(chunk);
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) { if (buffer.length > limit) { buffer = ''; invalid(); } return; }
      if (end > limit) { buffer = ''; invalid(); return; }
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { receive(JSON.parse(line)); } catch { invalid(); return; }
    }
  });
}

/** The owner, not a Gateway connection, owns Electron and its stderr pipe. */
async function createBrowserOwner({ socketPath, spawnWorker, onFailure = () => {} }) {
  const child = spawnWorker(), pending = new Map(), inflight = new Set();
  const diagnostics = createNativeDiagnostics();
  let peer = null, closing = false, fence = Promise.resolve();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startup = setTimeout(() => readyReject(new Error('Browser startup timed out')), 15000); startup.unref();
  const send = (socket, message) => {
    if (!socket || socket.destroyed) return;
    if (socket.writableLength > 4 * 1024 * 1024) { socket.destroy(); return; }
    socket.write(JSON.stringify(message) + '\n');
  };
  function request(message) {
    const id = randomUUID();
    const operation = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser owner request timed out')); }, 20000); timer.unref();
      pending.set(id, { resolve, reject, timer });
      child.send({ ...message, id }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(new Error('Browser transport failed')); } });
    });
    inflight.add(operation); void operation.finally(() => inflight.delete(operation)).catch(() => {});
    return operation;
  }
  child.stderr?.on('data', chunk => diagnostics.consume(chunk));
  child.stderr?.on('end', () => diagnostics.finish());
  child.on('message', message => {
    if (message.type === 'ready') { clearTimeout(startup); readyResolve(); return; }
    if (message.type === 'result') {
      const job = pending.get(message.id); if (!job) return;
      clearTimeout(job.timer); pending.delete(message.id);
      message.error ? job.reject(Object.assign(new Error(message.error.message), message.error)) : job.resolve(message.value);
    } else if (peer?.attached) send(peer, message);
  });
  const fail = () => {
    if (closing) return;
    closing = true; clearTimeout(startup); readyReject(new Error('Browser owner exited'));
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Browser owner exited')); }
    pending.clear(); diagnostics.finish();
    if (peer) { send(peer, { type: 'owner-failure', native: diagnostics.snapshot() }); peer.end(); }
    server.close(); child.kill(); onFailure();
  };
  child.on('error', fail); child.on('exit', fail);
  // A departed Gateway's accepted operations settle once; never replay writes.
  // Native control/visible commands drain the per-page queue before adoption.
  async function resetSession() {
    await Promise.allSettled([...inflight]);
    const pages = await request({ method: 'inventory' });
    await Promise.all(pages.map(async ({ id }) => {
      await request({ page: id, method: 'control', input: { token: null } });
      await request({ page: id, method: 'visible', input: { visible: false } });
    }));
  }
  const server = createServer(socket => {
    socket.on('error', () => socket.destroy());
    if (peer || closing) { socket.end(JSON.stringify({ type: 'owner-busy' }) + '\n', () => socket.destroy()); return; }
    peer = socket; let accepted = false, count = 0;
    const greeting = setTimeout(() => socket.destroy(), 5000); greeting.unref();
    readMessages(socket, 256 * 1024, message => {
      if (!accepted) {
        if (message.type !== 'attach' || message.protocol !== PROTOCOL) {
          send(socket, { type: 'owner-incompatible', protocol: PROTOCOL }); socket.end(); return;
        }
        accepted = true; clearTimeout(greeting);
        void fence.then(() => ready).then(async () => {
          if (peer !== socket || socket.destroyed) return;
          const pages = await request({ method: 'inventory' });
          if (peer !== socket || socket.destroyed) return;
          socket.attached = true;
          send(socket, { type: 'attached', protocol: PROTOCOL, pages, workerPid: child.pid });
        }).catch(() => socket.destroy());
        return;
      }
      if (!socket.attached || typeof message.id !== 'string' || message.id.length > 100 || ++count > 128) { socket.destroy(); return; }
      const id = message.id;
      void request(message).then(value => send(socket, { type: 'result', id, value }), error => send(socket, {
        type: 'result', id, error: { code: error.code || 'BROWSER_UNAVAILABLE', message: error.message, retryable: error.retryable !== false },
      })).finally(() => --count);
    }, () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(greeting);
      if (peer !== socket) return;
      peer = null;
      fence = fence.then(() => ready).then(resetSession);
      // Fail closed if native control cannot be retired; never grant a new
      // Gateway access alongside an unknown old input transaction.
      void fence.catch(fail);
    });
  });
  try { await ready; } catch (error) { closing = true; clearTimeout(startup); child.kill(); throw error; }
  // Only the service manager may start this owner. A live socket is never
  // unlinked by an attaching Gateway; stale endpoints belong to this process.
  try {
    await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) { closing = true; child.kill(); server.close(); throw error; }
  return { server, child, diagnostics, async close() {
    closing = true; clearTimeout(startup); peer?.destroy();
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Browser owner closed')); } pending.clear();
    child.kill(); await new Promise(resolve => server.close(resolve));
    await unlink(socketPath).catch(() => {});
  } };
}
module.exports = { PROTOCOL, readMessages, createBrowserOwner };

if (require.main === module) {
  const executable = join(__dirname, 'electron/electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const flags = ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  void createBrowserOwner({ socketPath: join(env.OPENCRAFT_BROWSER_DATA_DIR, 'owner.sock'),
    spawnWorker: () => spawn(executable, [...flags, join(__dirname, 'worker.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' }),
    onFailure: () => { process.exitCode = 1; },
  }).catch(() => { process.exitCode = 1; });
}
