import type { ClientWorkbenchProduct } from '@opencraft/client-product';
import type { ClientPersistenceScope, ClientPersistenceScopeSnapshot } from '@opencraft/workbench-runtime';

interface AccountIdentity { readonly authority: string; readonly actor: { readonly id: string } | null; readonly native: boolean; readonly desktopOwner: boolean }
function identity(value: unknown): AccountIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid account identity');
  const input = value as Partial<AccountIdentity>;
  if (typeof input.authority !== 'string' || !input.authority || (input.actor !== null && (!input.actor || typeof input.actor.id !== 'string' || !input.actor.id.startsWith('human://')))) throw new Error('Invalid account identity');
  return { authority: input.authority, actor: input.actor, native: input.native === true, desktopOwner: input.desktopOwner === true };
}
/** Client cache projection only. The server remains the authority for every resource request. */
export class HumanClientScope implements ClientPersistenceScope {
  private readonly listeners = new Set<() => void>();
  private readonly controller = new AbortController();
  private generation = 0;
  private snapshot: ClientPersistenceScopeSnapshot;
  constructor(private readonly initial: AccountIdentity, private readonly read: (signal: AbortSignal) => Promise<unknown>,
    private readonly changed: () => void, readonly legacyLocalNamespace = 'local') {
    const namespace = this.namespace(initial);
    this.snapshot = Object.freeze({ namespace, threadMemoryScope: namespace });
  }
  private namespace(value: AccountIdentity) {
    // The installation's original native owner keeps the existing local drafts.
    if (value.native && value.desktopOwner && value.actor) return this.legacyLocalNamespace;
    return JSON.stringify(['human', value.authority, value.actor?.id ?? null]);
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  refresh = async () => {
    if (this.controller.signal.aborted) return;
    const generation = ++this.generation;
    try {
      const current = identity(await this.read(this.controller.signal));
      if (this.controller.signal.aborted || generation !== this.generation) return;
      const namespace = this.namespace(current);
      if (namespace === this.snapshot.namespace) return;
      this.snapshot = Object.freeze({ namespace, threadMemoryScope: namespace });
      for (const listener of this.listeners) listener();
      this.changed();
    } catch { /* A transient network failure cannot become a logout or another Human. */ }
  };
  dispose() { this.controller.abort(); ++this.generation; this.listeners.clear(); }
}
export async function discoverLocalAccountProduct(fetcher: typeof fetch, options: {
  readonly legacyLocalNamespace?: string;
  readonly events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly changed?: () => void;
} = {}): Promise<ClientWorkbenchProduct | undefined> {
  const initial = await fetcher('/__opencraft_account/status', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (initial.status === 404 || !initial.headers.get('content-type')?.includes('application/json')) return undefined;
  if (!initial.ok) throw new Error('Account identity unavailable');
  const current = identity(await initial.json());
  if (!current.actor) return undefined;
  return { async create() {
    const events = options.events ?? window;
    const scope = new HumanClientScope(current, async signal => {
      const response = await fetcher('/__opencraft_account/status', { credentials: 'same-origin', cache: 'no-store', signal });
      if (!response.ok) throw new Error('Account identity unavailable'); return response.json();
    }, options.changed ?? (() => window.location.reload()), options.legacyLocalNamespace);
    events.addEventListener('focus', scope.refresh); events.addEventListener('pageshow', scope.refresh);
    return { persistenceScope: scope, preflight: scope.refresh, extensions: () => [], dispose() {
      events.removeEventListener('focus', scope.refresh); events.removeEventListener('pageshow', scope.refresh); scope.dispose();
    } };
  } };
}
