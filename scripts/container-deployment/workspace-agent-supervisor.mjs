import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { isSandboxEndpointName } from '@opencraft/sandbox/endpoint';

/** One workspace-agent process lifetime. A new random id per start; the evidence digest
 * binds it to this kernel boot and process birth so a recycled PID never matches. */
export async function createAgentIncarnation({ readText = path => readFile(path, 'utf8'), pid = process.pid } = {}) {
  const bootId = (await readText('/proc/sys/kernel/random/boot_id')).trim();
  const stat = await readText(`/proc/${pid}/stat`);
  // Field 22 (starttime) follows the parenthesised command, which may contain spaces.
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^[0-9a-f-]{36}$/u.test(bootId) || !/^\d+$/u.test(startTicks ?? '')) throw new Error('Process birth evidence is unavailable');
  return Object.freeze({
    id: randomBytes(16).toString('hex'),
    evidence: createHash('sha256').update(`${bootId}:${pid}:${startTicks}`).digest('hex'),
    startedAt: new Date().toISOString(),
  });
}

/** The container-private run directory: owned by this user, mode 0700, not a symlink.
 * Entries from a previous incarnation (tmpfs is normally fresh) are removed. */
export async function prepareAgentRunDirectory(path) {
  if (!isAbsolute(path) || path === '/' || Buffer.byteLength(path) > 64) throw new Error('The agent run directory must be a short absolute path');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error('The agent run directory must be a private directory owned by this user');
  for (const entry of await readdir(path)) await rm(join(path, entry), { recursive: true, force: true });
  await mkdir(join(path, 'endpoints'), { mode: 0o700 });
  return path;
}

const CONTROL_PROTOCOL = 1;

/** Generic supervisor for the in-container `workspace-agent`. Roles (composition) start
 * children through it; it knows no provider, image or role. Any critical child that exits
 * or fails to start stops every other child and ends the agent with code 1: a new agent
 * incarnation is the only recovery (interrupted-turn recovery upstream), never a local
 * restart. A deliberate `replace` is not a failure. */
export function createWorkspaceAgentSupervisor({
  runDirectory, incarnation, roles = [], spawnProcess = spawn, log = value => console.log(JSON.stringify(value)),
  stopTimeoutMs = 10_000,
}) {
  if (!incarnation?.id) throw new Error('Workspace agent incarnation is required');
  const children = [], endpoints = new Map(), descriptors = new Map(), cleanups = [], lifecycle = new AbortController();
  let state = 'starting', stopping, control, settle, endpointGeneration = 0;
  const exited = new Promise(resolve => { settle = resolve; });

  const describe = () => ({
    protocol: CONTROL_PROTOCOL, state, roles: [...roles], incarnation,
    components: children.map(child => ({ name: child.name, pid: child.pid ?? null, critical: child.critical })),
    endpoints: [...endpoints.keys()].sort(),
    endpointGeneration,
  });

  function stop(code = 0, reason = 'stop') {
    return stopping ??= (async () => {
      state = 'stopping';
      lifecycle.abort();
      log({ type: 'workspace-agent-stopping', incarnation: incarnation.id, reason, code });
      // Reverse start order: dependants (engines, AppServer) end before what they use.
      for (const child of [...children].reverse()) child.signal('SIGTERM');
      const timer = setTimeout(() => { for (const child of children) child.signal('SIGKILL'); }, stopTimeoutMs);
      timer.unref?.();
      try { await Promise.all(children.map(child => child.exited)); }
      finally { clearTimeout(timer); }
      await new Promise(resolve => control ? control.close(() => resolve()) : resolve());
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup(); }
        catch (error) { code = code || 1; log({ type: 'workspace-agent-cleanup-failed', incarnation: incarnation.id, error: error.message }); }
      }
      settle(code);
      return code;
    })();
  }

  /** `identity` ({ uid, gid }) runs the child under that numeric identity (validated
   * by the role's composition); `owner` ({ role }) is passed to `spawnProcess` as its
   * fourth argument so a spawn wrapper can select policy by stable role. */
  function start(name, command, args = [], { env = process.env, cwd, critical = true, processGroup = false, identity, owner } = {}) {
    if (stopping) throw new Error('Workspace agent is stopping');
    const options = { cwd, env, stdio: 'inherit', shell: false, ...(processGroup ? { detached: true } : {}),
      ...(identity ? { uid: identity.uid, gid: identity.gid } : {}) };
    const child = spawnProcess(command, args, options, owner);
    const record = {
      name, critical, process: child, pid: child.pid, replacing: false,
      signal(value) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (processGroup && child.pid) process.kill(-child.pid, value);
          else child.kill(value);
        } catch (error) { if (error.code !== 'ESRCH') throw error; }
      },
    };
    record.exited = new Promise(resolve => {
      const ended = (code, signal, error) => {
        resolve();
        if (stopping || record.replacing) return;
        log({ type: 'workspace-agent-child-failed', incarnation: incarnation.id, name, code: code ?? null, signal: signal ?? null, error: error?.message });
        if (critical) void stop(1, `critical child ${name} ended`);
      };
      child.once('error', error => ended(null, null, error));
      child.once('exit', (code, signal) => ended(code, signal));
    });
    children.push(record);
    return record;
  }

  /** Ends one child deliberately (SIGTERM, then SIGKILL after `timeoutMs`); not a
   * failure. Its process group goes with it when it was started as one. */
  async function retire(record, { timeoutMs = 10_000 } = {}) {
    record.replacing = true;
    record.signal('SIGTERM');
    const timer = setTimeout(() => record.signal('SIGKILL'), timeoutMs);
    try { await record.exited; } finally { clearTimeout(timer); }
    const index = children.indexOf(record);
    if (index >= 0) children.splice(index, 1);
  }

  /** Ends one child deliberately and starts its successor; not a failure. */
  async function replace(record, startNext, options) {
    await retire(record, options);
    if (stopping) return undefined;
    return startNext();
  }

  async function waitUntil(probe, { attempts = 60, delayMs = 500, description = 'component' } = {}) {
    let last;
    for (let attempt = 0; attempt < attempts && !stopping; attempt++) {
      try { return await probe(lifecycle.signal); }
      catch (error) { last = error; }
      await new Promise(resolve => { const timer = setTimeout(resolve, delayMs); timer.unref?.(); });
    }
    throw new Error(stopping ? 'Workspace agent is stopping' : `${description} did not become ready: ${last?.message ?? 'unknown'}`);
  }

  /** Publishes `name` in the fixed endpoint directory. Only allow-listed names; the
   * target is chosen by the role, never by a caller. `describe` returns what the
   * endpoint's client needs besides bytes (bearer tokens, engine descriptor); it is
   * answered only on the control endpoint, which the Host reaches through its
   * authenticated provider channel. */
  async function publishEndpoint(name, target, describe) {
    if (!isSandboxEndpointName(name) || name === 'control') throw new Error(`Endpoint ${name} is not allowed`);
    if (!isAbsolute(target) || target.includes('\0')) throw new Error('Endpoint target must be an absolute socket path');
    if (describe !== undefined && typeof describe !== 'function') throw new Error('Endpoint description must be a function');
    await symlink(target, join(runDirectory, 'endpoints', name));
    endpoints.set(name, target);
    if (describe) descriptors.set(name, describe);
  }

  async function serveControl() {
    const path = join(runDirectory, 'control.sock');
    control = createServer(socket => {
      let buffered = '';
      socket.setEncoding('utf8');
      socket.setTimeout(5_000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buffered += chunk;
        if (buffered.length > 4096) { socket.destroy(); return; }
        const end = buffered.indexOf('\n');
        if (end < 0) return;
        let request;
        try { request = JSON.parse(buffered.slice(0, end)); } catch { socket.destroy(); return; }
        if (request?.protocol !== CONTROL_PROTOCOL) { socket.end(JSON.stringify({ type: 'error', error: 'unsupported protocol' }) + '\n'); return; }
        if (request.type === 'probe') { socket.end(JSON.stringify({ type: state === 'ready' ? 'healthy' : state, ...describe() }) + '\n'); return; }
        if (request.type === 'describe') {
          const describe = descriptors.get(request.name);
          if (state !== 'ready' || !describe) { socket.end(JSON.stringify({ type: 'error', protocol: CONTROL_PROTOCOL, error: 'endpoint not described' }) + '\n'); return; }
          void Promise.resolve().then(describe).then(
            descriptor => socket.end(JSON.stringify({ type: 'endpoint', protocol: CONTROL_PROTOCOL, name: request.name, descriptor }) + '\n'),
            () => socket.end(JSON.stringify({ type: 'error', protocol: CONTROL_PROTOCOL, error: 'endpoint unavailable' }) + '\n'));
          return;
        }
        if (request.type === 'drain') {
          socket.end(JSON.stringify({ type: 'draining', protocol: CONTROL_PROTOCOL, incarnation }) + '\n');
          void stop(0, 'drain');
          return;
        }
        socket.end(JSON.stringify({ type: 'error', error: 'unsupported request' }) + '\n');
      });
    });
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(path, resolve); });
    await chmod(path, 0o600);
    await symlink(path, join(runDirectory, 'endpoints', 'control'));
    endpoints.set('control', path);
  }

  function markReady() {
    if (stopping) return;
    state = 'ready';
    log({ type: 'workspace-agent-ready', incarnation: incarnation.id, roles, components: children.map(child => child.name), endpoints: [...endpoints.keys()].sort() });
  }

  return {
    incarnation, signal: lifecycle.signal, exited, children,
    get state() { return state; },
    describe, start, retire, replace, waitUntil, publishEndpoint, serveControl, markReady, stop,
    /** A role replaced owners behind described endpoints in place (new descriptor or
     * credential, same incarnation): clients observing the agent read descriptions again. */
    endpointsReplaced() { endpointGeneration += 1; },
    /** Runs after every child has exited, in reverse registration order. */
    defer(cleanup) { cleanups.push(cleanup); },
  };
}

/** One probe of an agent's control endpoint; creates no lease and starts nothing. */
export function probeWorkspaceAgent(path, { timeoutMs = 4000, request = { type: 'probe' } } = {}) {
  return new Promise((resolve, reject) => {
    {
      const socket = createConnection(path);
      let buffered = '', finished = false;
      const finish = (error, value) => {
        if (finished) return; finished = true; clearTimeout(timer); socket.destroy();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Workspace agent probe timed out')), timeoutMs);
      timer.unref?.();
      socket.setEncoding('utf8');
      socket.once('error', finish);
      socket.once('end', () => finish(new Error('Workspace agent probe ended without an answer')));
      socket.once('connect', () => socket.write(JSON.stringify({ ...request, protocol: CONTROL_PROTOCOL }) + '\n'));
      socket.on('data', chunk => {
        buffered += chunk;
        if (buffered.length > 65536) { finish(new Error('Workspace agent probe exceeds its budget')); return; }
        const end = buffered.indexOf('\n');
        if (end < 0) return;
        try {
          const value = JSON.parse(buffered.slice(0, end));
          if (value.protocol !== CONTROL_PROTOCOL || typeof value.incarnation?.id !== 'string') throw new Error('Workspace agent identity is unavailable');
          finish(null, value);
        } catch (error) { finish(error); }
      });
    }
  });
}
