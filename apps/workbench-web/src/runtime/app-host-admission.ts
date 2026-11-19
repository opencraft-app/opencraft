import type { TransportFailureDisposition } from '@opencraft/appserver-client/transport';
import { serverFetch } from './server-context';

/** Only an HTTP admission response can classify authentication. Browser
 * WebSocket error/1006 events cannot distinguish a 401 from a broken route. */
export class AppHostAdmissionError extends Error {
  readonly failure: TransportFailureDisposition;
  constructor(status: 401 | 403) {
    super(status === 401 ? 'Sign in is required to reconnect' : 'Access to this server was denied');
    this.failure = { code: status === 401 ? 'APP_HOST_AUTH_REQUIRED' : 'APP_HOST_ACCESS_DENIED', recovery: 'manual' };
  }
}

/** Read-only check through the existing Relay/Hub admission owners. No cached
 * login grants, token refresh or user-write replay lives here. The browser shell
 * may observe a confirmed response to initiate its guarded login navigation. */
export function createAppHostAdmission(fetcher: typeof fetch = serverFetch, observeResponse?: (status: number) => void) {
  let operation: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let disposed = false;
  return {
    prepare(): Promise<void> {
      if (disposed) return Promise.reject(new Error('App Host admission is closed'));
      if (operation) return operation;
      const request = new AbortController(); controller = request;
      const timeout = setTimeout(() => request.abort(new DOMException('Admission check timed out', 'TimeoutError')), 5_000);
      const run = async () => {
        const response = await fetcher('/__opencraft_access/admission', {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { accept: 'application/json' }, signal: request.signal,
        });
        void response.body?.cancel().catch(() => undefined);
        request.signal.throwIfAborted();
        observeResponse?.(response.status);
        if (response.status === 401 || response.status === 403) throw new AppHostAdmissionError(response.status);
        // Legacy sites without the probe retain their existing WS behavior.
        if (response.status !== 204 && response.status !== 404) throw new Error('App Host admission check is unavailable');
      };
      const pending = run().finally(() => {
        clearTimeout(timeout);
        if (operation === pending) operation = null;
        if (controller === request) controller = null;
      });
      operation = pending;
      return pending;
    },
    dispose() { disposed = true; controller?.abort(); controller = null; },
  };
}
