import { fork } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, realpath, chmod, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { atomicJson } from '../full-upgrade/durable.mjs';
import { acquireDeploymentLock } from './lock.mjs';

const failure = code => Object.assign(new Error(code), { code });
const delay = ms => new Promise(done => setTimeout(done, ms));
async function entryPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || !value.endsWith('/cli.mjs')
    || value.length > 4096 || await realpath(value) !== resolve(value)) throw failure('invalid-entry');
  const info = await lstat(value);
  if (!info.isFile() || (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) throw failure('invalid-entry');
  return value;
}

/** Own listeners, not authentication, execution or application databases. */
export async function createResidentEntry({ entry, stateDirectory, host = '127.0.0.1', port = 10000,
  internalPort = null, environment = process.env, execPath = process.execPath,
  startupTimeoutMs = 60_000, pendingTimeoutMs = 10_000, maxPendingSockets = 256, maxRetired = 2 }) {
  if (process.platform === 'win32' || !isAbsolute(stateDirectory)
    || !Number.isInteger(port) || port < 0 || port > 65535
    || (internalPort !== null && (!Number.isInteger(internalPort) || internalPort < 0 || internalPort > 65535))
    || ![startupTimeoutMs, pendingTimeoutMs, maxPendingSockets, maxRetired].every(n => Number.isSafeInteger(n) && n > 0))
    throw failure('invalid-resident-configuration');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const info = await lstat(stateDirectory);
  if (!info.isDirectory() || (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) throw failure('unsafe-resident-state');
  const ownerDirectory = join(stateDirectory, 'resident-owner'); await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
  const releaseOwner = await acquireDeploymentLock(ownerDirectory);
  const statePath = join(stateDirectory, 'resident-entry.json'), controlPath = join(stateDirectory, 'resident-entry.sock');
  const generations = new Set(), retired = new Set(), pending = new Set(), sending = new Set(), controls = new Set();
  let active = null, selected, operation = null, recovery = null, closing = false, started = false;
  let publicServer, internalServer, controlServer, closingPromise;
  async function savedEntry(fallback) {
    let savedInfo;
    try { savedInfo = await lstat(statePath); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
    if (!savedInfo.isFile() || savedInfo.size > 8192 || (savedInfo.mode & 0o077)
      || (process.getuid && savedInfo.uid !== process.getuid())) throw failure('unsafe-resident-state');
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    if (saved.schemaVersion !== 1) throw failure('invalid-resident-state');
    // Missing selected content is corruption, not an absent initial pointer.
    return await entryPath(saved.entry);
  }
  const status = () => ({ protocol: 1, pid: process.pid, entry: selected, activePid: active?.alive ? active.child.pid : null,
    busy: !!operation || !!recovery, pending: pending.size,
    generations: [...generations].map(g => ({ pid: g.child.pid, entry: g.entry, role: g.role, connections: g.connections })),
    publicAddress: publicServer?.address() ?? null, internalAddress: internalServer?.address() ?? null });
  const notify = (generation, value) => {
    if (!generation.alive || !generation.child.connected) throw failure('entry-exited');
    generation.child.send({ protocol: 1, ...value }, error => {
      const request = error && generation.requests.get(value.id);
      if (request) { clearTimeout(request.timer); generation.requests.delete(value.id); request.reject(failure('entry-ipc-failed')); }
    });
  };
  function command(generation, name, value = {}) {
    return new Promise((accept, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { generation.requests.delete(id); reject(failure('entry-timeout')); }, startupTimeoutMs);
      generation.requests.set(id, { accept, reject, timer });
      try { notify(generation, { command: name, id, ...value }); }
      catch (error) { clearTimeout(timer); generation.requests.delete(id); reject(error); }
    });
  }
  function spawn(candidateEntry) {
    const child = fork(candidateEntry, [], { execPath, execArgv: [],
      env: { ...environment, OPENCRAFT_RESIDENT_ENTRY_CHILD: '1', OPENCRAFT_WEB_STATE: stateDirectory },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let prepared, rejectPreparation, exited;
    const generation = { child, entry: candidateEntry, alive: true, role: 'candidate', connections: 0, requests: new Map(),
      prepared: new Promise((accept, reject) => { prepared = accept; rejectPreparation = reject; }),
      exited: new Promise(accept => { exited = accept; }) };
    const timer = setTimeout(() => rejectPreparation(failure('entry-timeout')), startupTimeoutMs);
    generations.add(generation);
    child.on('message', message => {
      if (message?.protocol !== 1) return;
      if (message.event === 'prepared') { clearTimeout(timer); prepared(); return; }
      if (message.event === 'connections' && Number.isSafeInteger(message.count) && message.count >= 0) {
        generation.connections = message.count; return;
      }
      const request = generation.requests.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); generation.requests.delete(message.id);
      message.ok === true ? request.accept(message.value) : request.reject(failure(message.error === 'entry-busy' ? 'entry-busy' : 'entry-command-failed'));
    });
    const stopped = () => {
      if (!generation.alive) return;
      generation.alive = false; clearTimeout(timer); rejectPreparation(failure('entry-exited'));
      for (const request of generation.requests.values()) { clearTimeout(request.timer); request.reject(failure('entry-exited')); }
      generation.requests.clear(); generations.delete(generation); retired.delete(generation); exited();
      if (active === generation) { active = null; if (started && !closing) queueMicrotask(recover); }
    };
    child.once('exit', stopped); child.once('close', stopped);
    child.on('error', () => {
      if (!child.pid) stopped();
      else {
        clearTimeout(timer); rejectPreparation(failure('entry-ipc-failed'));
        for (const request of generation.requests.values()) { clearTimeout(request.timer); request.reject(failure('entry-ipc-failed')); }
        generation.requests.clear();
      }
    });
    return generation;
  }
  async function terminate(generation) {
    if (!generation?.alive) return;
    generation.child.kill('SIGTERM');
    const timer = setTimeout(() => { if (generation.alive) generation.child.kill('SIGKILL'); }, 10_000);
    try { await generation.exited; } finally { clearTimeout(timer); }
  }
  async function launch(candidateEntry, administratorState = null, reconcileExecution = true) {
    const generation = spawn(candidateEntry);
    try { await generation.prepared; await command(generation, 'activate', { administratorState, reconcileExecution }); return generation; }
    catch (error) { await terminate(generation); throw error; }
  }
  function dispatch(socket, channel) {
    socket.on('error', () => {});
    if (closing || pending.size + sending.size >= maxPendingSockets) { socket.destroy(); return; }
    if (active?.alive) {
      sending.add(socket);
      try {
        active.child.send({ protocol: 1, command: 'socket', channel }, socket, { keepOpen: false }, error => {
          sending.delete(socket); if (error) socket.destroy();
        });
      } catch { sending.delete(socket); socket.destroy(); }
      return;
    }
    const waiting = { socket, channel, timer: null };
    waiting.timer = setTimeout(() => { pending.delete(waiting); socket.destroy(); }, pendingTimeoutMs);
    pending.add(waiting);
    socket.once('close', () => { clearTimeout(waiting.timer); pending.delete(waiting); });
  }
  function flush() {
    if (!active?.alive) return;
    for (const waiting of [...pending]) {
      pending.delete(waiting); clearTimeout(waiting.timer);
      if (!waiting.socket.destroyed) dispatch(waiting.socket, waiting.channel);
    }
  }
  function drain(generation) {
    if (!generation?.alive) return;
    generation.role = 'retired'; retired.add(generation);
    try { notify(generation, { command: 'drain' }); } catch { /* An exiting retired child owns no new admission. */ }
  }
  function recover() {
    if (closing || operation || recovery || active?.alive) return;
    recovery = (async () => {
      while (!closing && !active?.alive) {
        try {
          selected = await savedEntry(selected);
          const replacement = await launch(selected);
          if (closing) { await terminate(replacement); break; }
          replacement.role = 'active'; active = replacement; flush();
        } catch { if (!closing) await delay(1000); }
      }
    })().finally(() => { recovery = null; });
  }
  async function performReload(value) {
    const next = await entryPath(value), previous = active;
    if (closing || !previous?.alive) throw failure('entry-unavailable');
    if (retired.size >= maxRetired) throw failure('retired-generation-limit');
    const candidate = spawn(next);
    let deactivated = false, administratorState = null;
    try {
      await candidate.prepared;
      if (!previous.alive || closing) throw failure('entry-unavailable');
      active = null; // Only unadmitted new sockets wait; old sockets stay in their entry.
      try { administratorState = await command(previous, 'deactivate'); }
      catch (error) {
        if (error.code !== 'entry-busy') {
          // An absent acknowledgement cannot prove that write authority stayed
          // with the old child. Confirm its exit before cold recovery.
          deactivated = true; await terminate(previous);
        }
        throw error;
      }
      deactivated = true; previous.role = 'retired'; retired.add(previous);
      await command(candidate, 'activate', { administratorState, reconcileExecution: false });
      if (closing || !candidate.alive) throw failure('entry-unavailable');
      await atomicJson(statePath, { schemaVersion: 1, entry: next });
      selected = next; candidate.role = 'active'; active = candidate; flush(); drain(previous);
      return status();
    } catch (error) {
      // Confirm the failed candidate has died before another controller may
      // acquire Web state. Retired tunnels never regain installation authority.
      await terminate(candidate);
      if (!closing) {
        if (!deactivated && previous.alive) { previous.role = 'active'; active = previous; flush(); }
        else {
          if (previous.alive) drain(previous);
          // A failed fsync may follow rename. Reconcile the actual private
          // pointer before choosing the cold recovery entry, never user data.
          selected = await savedEntry(selected);
          const fallback = await launch(selected, administratorState, false);
          if (closing) await terminate(fallback);
          else { fallback.role = 'active'; active = fallback; flush(); }
        }
      }
      throw error;
    }
  }
  async function reload(value) {
    if (closing || operation || recovery) throw failure('entry-busy');
    operation = performReload(value);
    try { return await operation; }
    finally { operation = null; if (!active?.alive && !closing) queueMicrotask(recover); }
  }
  const listen = (server, ...args) => new Promise((accept, reject) => {
    server.once('error', reject); server.listen(...args, () => { server.off('error', reject); accept(); });
  });
  function close() {
    if (closingPromise) return closingPromise;
    closing = true;
    // close() synchronously releases each listening handle. Node's transferred
    // socket bookkeeping can leave its callback pending after all children
    // exit; do not use that callback as proof of child/socket termination.
    for (const server of [publicServer, internalServer, controlServer]) if (server?.listening) server.close();
    for (const item of pending) { clearTimeout(item.timer); item.socket.destroy(); } pending.clear();
    for (const socket of sending) socket.destroy(); sending.clear();
    for (const socket of controls) socket.destroy();
    closingPromise = (async () => {
      await Promise.allSettled([...generations].map(terminate));
      await Promise.allSettled([operation, recovery].filter(Boolean));
      await Promise.allSettled([...generations].map(terminate));
      try { const info = await lstat(controlPath); if (info.isSocket()) await unlink(controlPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await releaseOwner();
    })();
    return closingPromise;
  }

  try {
    selected = await entryPath(entry);
    selected = await savedEntry(selected);
    try {
      const socketInfo = await lstat(controlPath);
      if (!socketInfo.isSocket() || (process.getuid && socketInfo.uid !== process.getuid())) throw failure('unsafe-control-path');
      await unlink(controlPath); // The unique resident owner has already been acquired.
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    active = await launch(selected); active.role = 'active';
    await atomicJson(statePath, { schemaVersion: 1, entry: selected });
    publicServer = createServer({ pauseOnConnect: true }, socket => dispatch(socket, 'public'));
    if (internalPort !== null) internalServer = createServer({ pauseOnConnect: true }, socket => dispatch(socket, 'internal'));
    controlServer = createServer(socket => {
      if (controls.size >= 16) { socket.destroy(); return; }
      controls.add(socket); socket.on('error', () => {}); socket.once('close', () => controls.delete(socket));
      socket.setTimeout(240_000, () => socket.destroy());
      let data = '', received = false;
      socket.on('data', chunk => {
        if (received) return;
        data += chunk; if (Buffer.byteLength(data) > 8192) { socket.destroy(); return; }
        if (!data.includes('\n')) return;
        received = true; socket.pause();
        void (async () => {
          try {
            const request = JSON.parse(data.trim());
            if (Object.keys(request).some(key => !['action', 'entry'].includes(key))
              || !['status', 'reload'].includes(request.action)) throw failure('invalid-command');
            const value = request.action === 'status' ? status() : await reload(request.entry);
            socket.end(JSON.stringify({ ok: true, value }) + '\n');
          } catch (error) {
            const allowed = ['entry-busy', 'entry-unavailable', 'invalid-entry', 'retired-generation-limit', 'invalid-command'];
            socket.end(JSON.stringify({ ok: false, error: allowed.includes(error.code) ? error.code : 'entry-reload-failed' }) + '\n');
          }
        })();
      });
    });
    await listen(controlServer, controlPath); await chmod(controlPath, 0o600);
    if (internalServer) await listen(internalServer, internalPort, '127.0.0.1');
    await listen(publicServer, port, host);
    started = true;
    return { status, reload, close, controlPath };
  } catch (error) { await close(); throw error; }
}

export function residentRequest(path, request, timeoutMs = 240_000) {
  return new Promise((accept, reject) => {
    const socket = createConnection({ path }); let data = '';
    socket.on('error', () => reject(failure('resident-control-unavailable')));
    socket.setTimeout(timeoutMs, () => socket.destroy(failure('resident-control-timeout')));
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > 65536) { socket.destroy(); reject(failure('invalid-control-response')); }
    });
    socket.once('end', () => {
      socket.destroy();
      try { const result = JSON.parse(data); if (!result.ok) throw failure(result.error); accept(result.value); }
      catch (error) { reject(error); }
    });
  });
}
