import type { ClientWorkbenchProduct } from '@opencraft/client-product';
import type { ClientPersistenceScope, ClientPersistenceScopeSnapshot } from '@opencraft/workbench-runtime';

interface AccountIdentity { readonly authority: string; readonly actor: { readonly id: string } | null; readonly native: boolean; readonly desktopOwner: boolean }
function partition(value: AccountIdentity, legacy: string): string {
  return value.native && value.desktopOwner && value.actor ? legacy : JSON.stringify(['human', value.authority, value.actor?.id ?? null]);
}
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
  private verified: boolean;
  private snapshot: ClientPersistenceScopeSnapshot;
  constructor(private readonly initial: AccountIdentity, private readonly read: (signal: AbortSignal) => Promise<unknown>,
    private readonly changed: () => void, readonly legacyLocalNamespace = 'local', offlineNamespace?: string,
    private readonly observed?: (value: AccountIdentity, namespace: string) => void) {
    this.verified = offlineNamespace === undefined && initial.actor !== null;
    const namespace = offlineNamespace ?? this.namespace(initial);
    this.snapshot = Object.freeze({ namespace, threadMemoryScope: namespace });
  }
  private namespace(value: AccountIdentity) {
    // The installation's original native owner keeps the existing local drafts.
    return partition(value, this.legacyLocalNamespace);
  }
  getSnapshot = () => this.snapshot;
  isVerified = () => this.verified && !this.controller.signal.aborted;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  refresh = async () => {
    if (this.controller.signal.aborted) return;
    const generation = ++this.generation;
    try {
      const current = identity(await this.read(this.controller.signal));
      if (this.controller.signal.aborted || generation !== this.generation) return;
      const namespace = this.namespace(current);
      const wasVerified = this.verified;
      this.verified = current.actor !== null;
      this.observed?.(current, namespace);
      if (namespace === this.snapshot.namespace) {
        if (wasVerified !== this.verified) for (const listener of this.listeners) listener();
        return;
      }
      this.snapshot = Object.freeze({ namespace, threadMemoryScope: namespace });
      for (const listener of this.listeners) listener();
      this.changed();
    } catch {
      // Preserve local data while withdrawing automatic dispatch admission.
      if (!this.controller.signal.aborted && generation === this.generation && this.verified) {
        this.verified = false; for (const listener of this.listeners) listener();
      }
    }
  };
  dispose() { this.controller.abort(); ++this.generation; this.listeners.clear(); }
}
export async function discoverLocalAccountProduct(fetcher: typeof fetch, options: {
  readonly legacyLocalNamespace?: string;
  readonly events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly changed?: () => void;
  readonly capabilityCache?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly capabilityCacheKey?: string;
} = {}): Promise<ClientWorkbenchProduct | undefined> {
  const cache = options.capabilityCache ?? (typeof window === 'undefined' ? undefined : (() => {
    try { return window.localStorage; } catch { return undefined; }
  })());
  const key = options.capabilityCacheKey ?? 'opencraft.account-authority.v1';
  const partitionKey = key + '.local-partition';
  const remember = (value: AccountIdentity, namespace: string) => {
    try {
      cache?.setItem(key, value.authority);
      if (value.actor) cache?.setItem(partitionKey, JSON.stringify({ authority: value.authority, namespace }));
      else cache?.removeItem(partitionKey);
    } catch { /* A local display hint grants no account authority. */ }
  };
  let authority: string | null = null;
  try { authority = cache?.getItem(key) ?? null; } catch { /* storage can be unavailable */ }
  if (authority && (authority.length > 512 || !authority.trim())) authority = null;
  let current: AccountIdentity;
  let offlineNamespace: string | undefined;
  try {
    const initial = await fetcher('/__opencraft_account/status', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (initial.status === 404 || (initial.ok && !initial.headers.get('content-type')?.includes('application/json'))) {
      try { cache?.removeItem(key); cache?.removeItem(partitionKey); } catch { /* optional capability marker */ }
      return undefined;
    }
    if (initial.status === 401 || initial.status === 403) {
      try { cache?.removeItem(partitionKey); } catch { /* Explicit logout still withdraws admission. */ }
    }
    if (!initial.ok) throw new Error('Account identity unavailable');
    current = identity(await initial.json());
    try { cache?.setItem(key, current.authority); } catch { /* no credentials or Human identity are cached here */ }
    remember(current, partition(current, options.legacyLocalNamespace ?? 'local'));
  } catch {
    if (!authority) return undefined;
    // A remembered local partition may restore input; it is not a cached Actor,
    // native-owner proof or permission to submit to the server.
    current = { authority, actor: null, native: false, desktopOwner: false };
    try {
      const raw = cache?.getItem(partitionKey);
      const hint = raw && raw.length <= 8192 ? JSON.parse(raw) : null;
      if (hint?.authority === authority && typeof hint.namespace === 'string' && hint.namespace.length <= 4096) {
        const value = hint.namespace === (options.legacyLocalNamespace ?? 'local') ? null : JSON.parse(hint.namespace);
        if (value === null || (Array.isArray(value) && value.length === 3 && value[0] === 'human' && value[1] === authority && typeof value[2] === 'string')) offlineNamespace = hint.namespace;
      }
    } catch { /* Corrupt hints cannot select a local partition. */ }
  }
  return { async create() {
    const events = options.events ?? window;
    const scope = new HumanClientScope(current, async signal => {
      const response = await fetcher('/__opencraft_account/status', { credentials: 'same-origin', cache: 'no-store', signal });
      if (response.status === 401 || response.status === 403) return { authority: current.authority, actor: null, native: false, desktopOwner: false };
      if (!response.ok) throw new Error('Account identity unavailable'); return response.json();
    }, options.changed ?? (() => window.location.reload()), options.legacyLocalNamespace, offlineNamespace, remember);
    events.addEventListener('focus', scope.refresh); events.addEventListener('pageshow', scope.refresh); events.addEventListener('online', scope.refresh);
    return { persistenceScope: scope, preflight: scope.refresh, extensions: () => [], dispose() {
      events.removeEventListener('focus', scope.refresh); events.removeEventListener('pageshow', scope.refresh); events.removeEventListener('online', scope.refresh); scope.dispose();
    } };
  } };
}
