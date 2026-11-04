import { sandboxMessage } from "@opencraft/sandbox-node/command";
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { prepareSandboxInvocation, sandboxControllerEnvironment } from '@opencraft/sandbox-node/command';

/** The real PTY and its SDK inspection/signalling live together inside the sandbox. */
export async function spawnDshSandboxTerminal({ runner, runnerExecArgv, configuration, agent, sdk, spec, env }) {
  spec.signal?.throwIfAborted();
  const invocation = prepareSandboxInvocation({ runner, runnerExecArgv, configuration, owner: 'dsh-terminal', cwd: spec.cwd,
    command: [process.execPath, agent, sdk], env: { ...sandboxControllerEnvironment(), HOME: process.env.HOME ?? "/" } });
  const child = spawn(invocation.argv[0], invocation.argv.slice(1), { cwd: spec.cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(invocation.input);
  const output = new PassThrough(), pending = new Map();
  let sequence = 0, settled = false, readyResolve, readyReject, doneResolve, doneReject, stopping;
  const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
  const done = new Promise((yes, no) => { doneResolve = yes; doneReject = no; }); void done.catch(() => {});
  const fault = () => {
    const error = new Error('Sandbox terminal transport unavailable'); readyReject(error);
    for (const request of pending.values()) request.reject(error); pending.clear();
    if (!settled) { settled = true; doneReject(error); } child.kill('SIGTERM');
  };
  const send = message => {
    if (!child.stdin.writable || child.stdin.writableLength > 1024 * 1024) throw Error();
    child.stdin.write(sandboxMessage(message), error => { if (error) fault(); });
  };
  const request = message => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    try { send({ ...message, id }); } catch { fault(); }
  });
  const deadline = setTimeout(fault, 45_000);
  let bytes = 0;
  child.stdout.on('data', data => { bytes += data.length; if (bytes > 2 * 1024 * 1024) fault(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', text => {
    bytes = 0;
    try {
      const message = JSON.parse(text);
      if (message.type === 'ready' && Number.isSafeInteger(message.pid) && message.pid > 0) { clearTimeout(deadline); readyResolve(message.pid); }
      else if (message.type === 'output') {
        const data = Buffer.from(message.data, 'base64');
        if (output.writableLength + data.length > 8 * 1024 * 1024) fault(); else output.write(data);
      } else if (message.type === 'result') { const request = pending.get(message.id); pending.delete(message.id); request?.resolve(message.value); }
      else if (message.type === 'exit') { settled = true; doneResolve(message.outcome); output.end(); }
      else fault();
    } catch { fault(); }
  });
  child.stderr.resume(); child.stdin.on('error', fault); child.once('error', fault);
  let exited;
  const exit = new Promise(resolve => { exited = resolve; });
  child.once('close', () => {
    clearTimeout(deadline); lines.close(); output.end();
    if (!settled) fault();
    spec.signal?.removeEventListener('abort', abort); exited();
  });
  const terminate = () => stopping ??= (async () => {
    try { send({ method: 'close' }); } catch { child.kill('SIGTERM'); }
    const timer = setTimeout(() => child.kill('SIGTERM'), Math.max(3000, spec.graceMs));
    try { await exit; } finally { clearTimeout(timer); }
  })();
  const abort = () => { void terminate(); };
  spec.signal?.addEventListener('abort', abort, { once: true });
  if (spec.signal?.aborted) abort();
  try {
    send({ method: 'start', spec: { argv: spec.argv, cwd: spec.cwd, env, rows: spec.rows, cols: spec.cols, graceMs: spec.graceMs } });
    const pid = await ready;
    return { pid, output, done, write: data => request({ method: 'write', data }), inspectForeground: () => request({ method: 'inspect' }),
      signalForeground: signal => request({ method: 'signal', signal }), terminate };
  } catch (error) { await terminate(); throw error; }
}
