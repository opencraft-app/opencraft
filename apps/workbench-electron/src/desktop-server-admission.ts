import { remoteServerOrigin } from '@opencraft/plugin-local-account/connections';

export class ServerSignInRequired extends Error {}
export class ServerAccessDenied extends Error {}
/** Execution admission belongs to the target server, including its identity plugins.
 * A private identity endpoint is neither required nor interpreted by the desktop. */
export async function verifyDesktopServer(originInput: string, fetcher: (input: string, init?: RequestInit) => Promise<Response>, signal?: AbortSignal): Promise<string> {
  const origin = remoteServerOrigin(originInput);
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const response = await fetcher(origin + '/appserver', { credentials: 'include', cache: 'no-store', redirect: 'manual', signal, headers: { origin, accept: 'application/json' } });
  signal.throwIfAborted();
  if (response.status === 401 || (response.status >= 300 && response.status < 400)) throw new ServerSignInRequired();
  if (response.status === 403) throw new ServerAccessDenied();
  if (response.status !== 426 || !response.headers.get('content-type')?.includes('application/json')) throw new Error(`Server execution interface unavailable (HTTP ${response.status})`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('error' in value) || value.error !== 'WebSocket upgrade required') throw new Error('Unsupported server execution interface');
  return origin;
}
