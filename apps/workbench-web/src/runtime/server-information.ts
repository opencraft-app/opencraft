import { serverFetch } from './server-context';
export interface ServerInformation { readonly revision: number; readonly publicUrl: string; }
export interface ServerInformationAuthority { readonly actorId: string; readonly canManage: boolean; }
export interface ServerInformationSnapshot {
  readonly information: ServerInformation | null;
  readonly authority: ServerInformationAuthority | null;
  readonly phase: 'loading' | 'ready' | 'error' | 'expired' | 'unavailable';
  readonly busy: 'read' | 'save' | null;
  readonly error: 'address' | 'conflict' | 'forbidden' | 'network' | 'unknown' | null;
  readonly mustReload: boolean;
}
// Only server-wide, non-secret link configuration is cached. Never cache identity or write authority.
const cache = new Map<string, ServerInformation>();
export class ServerInformationController {
  private state: ServerInformationSnapshot;
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private retainers = 0;
  constructor(private readonly scope: string, private readonly fetcher: typeof fetch = serverFetch) {
    this.state = { information: cache.get(scope) ?? null, authority: null, phase: 'loading', busy: null, error: null, mustReload: false };
  }
  retain() { this.retainers++; return () => { this.retainers--; queueMicrotask(() => { if (!this.retainers) this.dispose(); }); }; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: Partial<ServerInformationSnapshot>) { if (this.disposed) return; this.state = { ...this.state, ...next }; for (const listener of this.listeners) listener(); }
  async read() { return this.request(); }
  async save(publicUrl: string) {
    if (!this.state.authority?.canManage || !this.state.information || this.state.busy || this.state.mustReload) return false;
    return this.request({ revision: this.state.information.revision, publicUrl, expectedActorId: this.state.authority.actorId });
  }
  private async request(input?: { revision: number; publicUrl: string; expectedActorId: string }) {
    if (this.disposed || this.state.busy) return false;
    const generation = ++this.generation, abort = this.abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    this.publish({ busy: input ? 'save' : 'read', error: null, ...(!input ? { authority: null } : {}) });
    try {
      const response = await this.fetcher('/__opencraft_server_information', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        ...(input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) });
      if (this.disposed || generation !== this.generation) return false;
      let value: any; try { value = await response.json(); } catch { /* A proxy may return HTML. */ }
      if (this.disposed || generation !== this.generation) return false;
      if (response.status === 401 || value?.error === 'account_changed') {
        cache.delete(this.scope); this.publish({ information: null, authority: null, phase: 'expired', mustReload: true }); return false;
      }
      if (response.status === 404) { cache.delete(this.scope); this.publish({ information: null, authority: null, phase: 'unavailable' }); return false; }
      if (!response.ok) {
        this.publish({ phase: 'error', error: value?.error === 'invalid_public_url' ? 'address' : response.status === 409 ? 'conflict' : response.status === 403 ? 'forbidden' : 'unknown',
          mustReload: !!input && value?.error !== 'invalid_public_url', ...(response.status === 403 ? { authority: null } : {}) }); return false;
      }
      if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.publicUrl !== 'string'
        || typeof value.actorId !== 'string' || !value.actorId || typeof value.canManage !== 'boolean') throw Error('invalid_information');
      if (input && value.actorId !== input.expectedActorId) { cache.delete(this.scope); this.publish({ information: null, authority: null, phase: 'expired', mustReload: true }); return false; }
      const information = { revision: value.revision, publicUrl: value.publicUrl };
      cache.set(this.scope, information);
      this.publish({ information, authority: { actorId: value.actorId, canManage: value.canManage }, phase: 'ready', error: null, mustReload: false }); return true;
    } catch {
      if (!this.disposed && generation === this.generation) this.publish({ phase: 'error', error: 'network', mustReload: !!input }); return false;
    } finally { clearTimeout(timer); if (generation === this.generation) this.publish({ busy: null }); }
  }
  dispose() { this.disposed = true; ++this.generation; this.abort?.abort(); this.listeners.clear(); }
}
