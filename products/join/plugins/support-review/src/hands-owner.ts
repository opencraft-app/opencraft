import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { access, chmod, chown, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { readReviewToken, reviewConfiguration, type ReviewHandsConfiguration } from './config';
import { REVIEW_INPUT_LIMIT, REVIEW_OUTPUT_LIMIT, REVIEW_TIMEOUT_MS, reviewInput, reviewResult, type ReviewInput, type ReviewResult } from './contract';

/** Vela-owned Hands companion. The existing worker remains the only ledger/mail writer. */
export async function startReviewHandsOwner(configuration: ReviewHandsConfiguration,
  options: { onFailure?: () => void; timeoutMs?: number; revision?: string; drainOnClose?: boolean } = {}) {
  if (![configuration.socketPath, configuration.tokenFile, configuration.workerRoot, configuration.pythonExecutable].every(isAbsolute))
    throw Error('Invalid support review Hands paths');
  if(options.revision!==undefined&&!/^[a-f0-9]{64}$/u.test(options.revision))throw Error('Invalid review plugin revision');
  const parent = await lstat(dirname(configuration.socketPath));
  // Parent is provisioned by the deployer; never chmod/chown a shared execution directory.
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || parent.mode & 0o027)
    throw Error('Review socket directory must be private and not group-writable');
  const tokenHash = createHash('sha256').update(await readReviewToken(configuration.tokenFile)).digest();
  try { await lstat(configuration.socketPath); throw Error('Review socket already exists; verify its owner before recovery'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const active = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  let closing = false;
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { ...(options.revision?{'x-opencraft-plugin-revision':options.revision}:{}), 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    req.setTimeout(10_000, () => req.destroy());
    if (req.method !== 'POST' || req.url !== '/review') return reply(res, 404, { error: 'missing' });
    const supplied = createHash('sha256').update(String(req.headers.authorization ?? '').replace(/^Bearer /u, '')).digest();
    if (!req.headers.authorization?.startsWith('Bearer ') || !timingSafeEqual(tokenHash, supplied))
      return reply(res, 403, { error: 'forbidden' });
    if(options.revision!==undefined&&req.headers['x-opencraft-plugin-revision']!==options.revision)return reply(res,409,{error:'review_plugin_revision_mismatch'});
    if (closing || controllers.size >= 4) return reply(res, 503, { error: 'review_unavailable' });
    if (req.headers['content-type'] !== 'application/json') return reply(res, 400, { error: 'invalid_request' });
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const raw of req) {
      const chunk = Buffer.from(raw); bytes += chunk.length;
      if (bytes > REVIEW_INPUT_LIMIT) return reply(res, 413, { error: 'request_too_large' });
      chunks.push(chunk);
    }
    req.setTimeout(0);
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, { error: 'invalid_json' }); }
    if (!reviewInput(input)) return reply(res, 400, { error: 'invalid_review_operation' });
    // Recheck after reading the body; slow uploads cannot reserve unbounded workers.
    if (closing || controllers.size >= 4) return reply(res, 503, { error: 'review_unavailable' });
    try { await access(join(configuration.workerRoot, 'support-review.py')); }
    catch { return reply(res, 503, { error: 'review_worker_entry_unavailable' }); }
    if (closing || controllers.size >= 4) return reply(res, 503, { error: 'review_unavailable' });
    const controller = new AbortController(); controllers.add(controller);
    try {
      // A disconnected caller does NOT cancel or retry a possibly committed send.
      const value = await runWorker(configuration, input, controller.signal, options.timeoutMs ?? REVIEW_TIMEOUT_MS);
      reply(res, value ? 200 : 503, value ?? { error: 'review_operation_result_unknown' });
    } finally { controllers.delete(controller); }
  };
  const server = createServer((req, res) => {
    const work = handle(req, res).catch(() => reply(res, 503, { error: 'review_operation_result_unknown' }));
    active.add(work); void work.finally(() => active.delete(work));
  });
  server.maxConnections = 16; server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(configuration.socketPath, () => { server.off('error', reject); resolve(); });
  });
  try {
    if (configuration.socketGid !== undefined) await chown(configuration.socketPath, process.getuid!(), configuration.socketGid);
    await chmod(configuration.socketPath, 0o660);
  } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  server.on('error', () => options.onFailure?.());
  let close: Promise<void> | undefined;
  return { close: () => close ??= (async () => {
    closing = true;
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    if (!options.drainOnClose) for (const controller of controllers) controller.abort();
    server.closeIdleConnections();
    if (!options.drainOnClose) server.closeAllConnections();
    await Promise.allSettled([...active]); server.closeAllConnections(); await stopped;

  })() };
}

async function runWorker(configuration: ReviewHandsConfiguration, input: ReviewInput, signal: AbortSignal, timeoutMs: number): Promise<ReviewResult | null> {
  return new Promise(resolve => {
    let failed = false, settled = false, bytes = 0;
    const chunks: Buffer[] = [];
    // Fixed interpreter and script, JSON on stdin, no PTY and no shell interpolation.
    const child = spawn(configuration.pythonExecutable, [join(configuration.workerRoot, 'support-review.py')], {
      cwd: configuration.workerRoot, env: { ...process.env, LIGHTVELA_SUPPORT_ROOT: configuration.workerRoot },
      stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false,
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (name: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, name); } catch {} };
    const stop = () => {
      if (failed) return; failed = true; kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    const finish = (value: ReviewResult | null) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer);
      signal.removeEventListener('abort', stop); kill('SIGKILL'); resolve(value);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > REVIEW_OUTPUT_LIMIT) stop(); else chunks.push(chunk);
    });
    child.stderr.on('data', () => {}); // Never log customer payload, credentials or drafts.
    child.stdin.on('error', () => {});
    child.once('error', () => finish(null));
    child.once('close', code => {
      if (failed || code !== 0) return finish(null);
      try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); finish(reviewResult(value) ? value : null); }
      catch { finish(null); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function startConfiguredReviewHands(onFailure: () => void) {
  const configuration = await reviewConfiguration('hands');
  return configuration ? startReviewHandsOwner(configuration, { onFailure }) : null;
}
