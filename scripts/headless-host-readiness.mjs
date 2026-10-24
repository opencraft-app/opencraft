import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import { randomUUID } from 'node:crypto';

/** Initialize the existing Host owner, then release this transient logical client.
 * This enables durable queue/Goal recovery even when no browser reconnects. */
export function initializeHeadlessCodexHost(appHostServer, { timeoutMs = 10_000, signal } = {}) {
  const clientId = `headless-readiness:${randomUUID()}`, leaseId = randomUUID();
  return new Promise((accept, reject) => {
    let connection, receive, generation, finished = false;
    const finish = error => {
      if (finished) return; finished = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", aborted);
      try { connection?.close(); } catch (closeError) { error ??= closeError; }
      error ? reject(error) : accept();
    };
    const aborted = () => finish(signal.reason ?? new Error('Headless Codex initialization cancelled'));
    const deadline = setTimeout(() => finish(new Error('Headless Codex initialization timed out')), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    try {
      connection = appHostServer.accept({
        subscribe(listener) { receive = listener; return () => { receive = undefined; }; },
        start() {}, close() {},
        postMessage(message) {
          if (finished) return;
          if (message.type === 'ready') receive?.({ type: 'host/connect', requestId: 'connect', hostId: 'local-codex', leaseId });
          else if (message.type === 'response' && message.requestId === 'connect') {
            if (!message.ok || !Number.isSafeInteger(message.result?.generation)) { finish(new Error('Headless Codex Host is unavailable')); return; }
            generation = message.result.generation;
            receive?.({ type: 'host/send', requestId: 'send-init', hostId: 'local-codex', leaseId, generation,
              frame: JSON.stringify({ id: 'init', method: 'initialize', params: {
                clientInfo: { name: 'opencraft-headless-readiness', version: '1' }, capabilities: { experimentalApi: true },
              } }) });
          } else if (message.type === 'response' && message.requestId === 'send-init' && !message.ok) finish(new Error('Headless Codex initialization was not admitted'));
          else if (message.type === 'host/frame' && message.hostId === 'local-codex' && message.generation === generation) {
            try { const frame = JSON.parse(message.frame); if (frame.id === 'init' && !frame.method) finish(frame.error ? new Error('Headless Codex initialization failed') : null); }
            catch { finish(new Error('Invalid Headless Codex initialization response')); }
          } else if (message.type === 'fatal' || message.type === 'host/status' && ['failed','closed'].includes(message.status.state)) finish(new Error('Headless Codex Host closed before readiness'));
        },
      }, clientId);
      receive?.({ type: 'hello', protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: clientId });
    } catch (error) { finish(error); }
  });
}

/** The gateway owns a connection, never the independent execution process.
 * HTTP startup does not wait for this worker. Each attempt owns one cancellable
 * logical client; failed attempts back off, successful connections are monitored.
 */
export function maintainHeadlessCodexHost(appHostServer, {
  timeoutMs = 10_000, retryMs = 1_000, maxRetryMs = 30_000, pollMs = 30_000,
  report = state => console.info('[headless-codex-readiness]', JSON.stringify(state)),
} = {}) {
  const controller = new AbortController();
  let timer, attempt = 0, current = { state: 'connecting', attempt: 0 };
  const publish = value => {
    const changed = value.state !== current.state;
    current = value;
    if (changed) report(value);
  };
  const schedule = (wait, callback) => {
    if (controller.signal.aborted) return;
    timer = setTimeout(callback, wait); timer.unref?.();
  };
  const monitor = () => {
    if (controller.signal.aborted) return;
    if (appHostServer.hostState('local-codex') === 'open') schedule(pollMs, monitor);
    else void initialize();
  };
  const initialize = async () => {
    attempt++;
    try {
      await initializeHeadlessCodexHost(appHostServer, { timeoutMs, signal: controller.signal });
      if (controller.signal.aborted) return;
      attempt = 0; publish({ state: 'ready', attempt: 0 }); schedule(pollMs, monitor);
    } catch {
      if (controller.signal.aborted) return;
      const delayMs = Math.min(maxRetryMs, retryMs * 2 ** Math.min(attempt - 1, 20));
      publish({ state: 'unavailable', code: 'codex-host-unavailable', attempt, retryAt: Date.now() + delayMs });
      schedule(delayMs, () => { void initialize(); });
    }
  };
  void initialize();
  return {
    snapshot: () => ({ ...current }),
    close() { controller.abort(); clearTimeout(timer); },
  };
}
