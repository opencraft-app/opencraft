import { serverStorageKey, serverFetch } from '../runtime/server-context';

const unavailable = () => Object.assign(new Error('Browser capability service unavailable; reconnecting'), { code: 'BROWSER_UNAVAILABLE', retryable: true });
const protocolError = () => Object.assign(new Error('Invalid browser capability response'), { code: 'PROTOCOL_ERROR' });

async function readAvailability(response: Response, signal: AbortSignal): Promise<boolean> {
  if (response.type === 'opaqueredirect' || [301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
    if (response.body) void response.body.cancel().catch(() => {});
    throw Object.assign(new Error('Browser capability authorization expired; reload OpenCraft'), { code: 'AUTHORIZATION_REQUIRED' });
  }
  if (response.status !== 200) {
    if (response.body) void response.body.cancel().catch(() => {});
    if (response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599) throw unavailable();
    throw protocolError();
  }
  const reader = response.body?.getReader();
  if (!reader) throw protocolError();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let done = false, size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { done = true; break; }
      size += next.value.byteLength;
      if (size > 4096) throw protocolError();
      chunks.push(next.value);
    }
    const data = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { throw protocolError(); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'available')
      || typeof (value as { available?: unknown }).available !== 'boolean') throw protocolError();
    return (value as { available: boolean }).available;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!done) cancel();
    reader.releaseLock();
  }
}

function probe(signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = new AbortController(); let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      request.abort(); complete();
    };
    const abort = () => finish(() => reject(signal!.reason));
    const timer = setTimeout(() => finish(() => reject(unavailable())), 2000);
    signal?.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(() => {
      request.signal.throwIfAborted();
      return serverFetch('/__opencraft_browser/capabilities', {
        signal: request.signal, cache: 'no-store', credentials: 'same-origin', redirect: 'manual',
      });
    }).then(response => {
      if (request.signal.aborted) {
        if (response.body) void response.body.cancel().catch(() => {});
        request.signal.throwIfAborted();
      }
      return readAvailability(response, request.signal);
    }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

function backoff(attempt: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = (complete: () => void) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); complete();
    };
    const abort = () => finish(() => reject(signal!.reason));
    const timer = setTimeout(() => finish(resolve), Math.min(30000, 250 * 2 ** Math.min(attempt, 7)));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Only an authoritative boolean selects a backend; transient transport errors
 * retain startup admission instead of permanently choosing a local iframe. */
export async function discoverRemoteBrowser(signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await probe(signal); }
    catch (error) {
      signal?.throwIfAborted();
      const failure = error as { code?: string; retryable?: boolean; name?: string };
      if (!(failure.code === 'BROWSER_UNAVAILABLE' && failure.retryable === true)
        && !['TypeError', 'AbortError', 'TimeoutError'].includes(failure.name ?? '')) throw error;
      await backoff(attempt, signal);
    }
  }
}

export function isOfflineShellStartup(): boolean {
  const build = document.querySelector<HTMLMetaElement>('meta[name="opencraft-build-id"]')?.content;
  return navigator.onLine === false || (!!build
    && document.querySelector<HTMLMetaElement>('meta[name="opencraft-offline-build"]')?.content === build);
}

/** A same-build backend hint only unblocks offline presentation. It grants no
 * browser lease, metadata write, or input authority. Online probes stay live. */
export async function discoverRemoteBrowserForStartup(signal?: AbortSignal): Promise<boolean> {
  const build = document.querySelector<HTMLMetaElement>('meta[name="opencraft-build-id"]')?.content;
  const key = serverStorageKey('opencraft.browser-backend-hint.v1');
  const offlineHint = () => {
    try {
      const hint = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (build && hint?.build === build && typeof hint.remote === 'boolean') return hint.remote;
    } catch {}
    // Unknown is conservatively remote; an unavailable backend never selects iframe.
    return true;
  };
  const offlineNow = isOfflineShellStartup;
  if (offlineNow()) return offlineHint();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  const offline = () => controller.abort(new Error('Offline browser bootstrap'));
  signal?.addEventListener('abort', abort, { once: true });
  window.addEventListener('offline', offline, { once: true });
  try {
    const remote = await discoverRemoteBrowser(controller.signal);
    if (build) try { localStorage.setItem(key, JSON.stringify({ build, remote })); } catch {}
    return remote;
  } catch (error) {
    signal?.throwIfAborted();
    if (offlineNow()) return offlineHint();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    window.removeEventListener('offline', offline);
  }
}
