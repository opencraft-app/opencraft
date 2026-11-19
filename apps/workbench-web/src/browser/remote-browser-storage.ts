import { mergeMetadataValue } from '@opencraft/browser-core/metadata-merge';
import { parseSideChatDirectory, serializeSideChatDirectoryV1, sideChatDirectoryBinding } from '@opencraft/workbench-runtime/side-chat-records';
import { browserMetadataValueLimit, browserMetadataWireLimit } from '@opencraft/browser-core/metadata-limits';
import { mergeBrowserMetadata, retireBrowserMetadata, browserMetadataReferences, type BrowserMetadataRetirement, type BrowserMetadataReferences } from '@opencraft/browser-core/metadata-merge';
import type { BrowserMetadataStorage, RemoteBrowserCatalog, BrowserPresentationRequest, BrowserPresentationReason } from './desktop-browser-storage';
import { serverStorageKey, serverUrl } from '../runtime/server-context';
import { browserMetadataKeys, readBrowserMetadataValue } from '@opencraft/workbench-runtime/browser-metadata-identity';

const identity = (key: string) => key;
const transientStateError = (error: unknown) => {
  const failure = error as { code?: string; retryable?: boolean };
  return failure?.code === 'DISCONNECTED' || failure?.code === 'BROWSER_UNAVAILABLE' && failure.retryable === true;
};
const remoteStorageKey = 'opencraft.remote-browser-storage.v1';
const entries = [
  [browserMetadataKeys.resourceSignals, 'resourceSignals', serverStorageKey],
  [browserMetadataKeys.sideChats, 'sideChats', serverStorageKey],
  [browserMetadataKeys.pages, 'pages', identity],
  [browserMetadataKeys.tabs, 'tabs', identity],
  [remoteStorageKey, 'storage', serverStorageKey],
  [browserMetadataKeys.bindings, 'bindings', serverStorageKey],
] as const;
// The remote surface uses a stable API key; only its former local copy is scoped.
const apiKey = (key: string, scope: (key: string) => string) => key === remoteStorageKey ? key : scope(key);
const keys: Record<string, string> = Object.fromEntries(entries.map(([key, field, scope]) => [apiKey(key, scope), field]));
/** Synchronous projection for existing tab owners; the authenticated Server is
 * the durable owner. Revision checks reject concurrent replacement by another
 * client. This contains browser metadata, never webpage editor contents. */
const mergeField = (field: string, base: string | null, local: string | null, remote: string | null) =>
  ['sideChats', 'resourceSignals'].includes(field) ? mergeMetadataValue(field, base ?? undefined, local ?? undefined, remote ?? undefined) ?? null
    : mergeBrowserMetadata(field, base, local, remote);
export class RemoteBrowserStorage implements BrowserMetadataStorage {
  private base: Record<string, string> = {};
  private root = '';
  private snapshotKeyRevisions: Record<string, number> = {};
  private digestSupported = false;
  private pendingMetadataFields = new Set<string>();
  private metadataListeners = new Set<(field: string) => void>();
  private committedListeners = new Set<(field: string) => void>();
  private reconciliationListeners = new Set<() => void>();
  private presentationListeners = new Set<(lease: string) => void>();
  onMetadataChanged(listener: (field: string) => void) { this.metadataListeners.add(listener); return () => { this.metadataListeners.delete(listener); }; }
  onCommittedMetadataChanged(listener: (field: string) => void) { this.committedListeners.add(listener); return () => { this.committedListeners.delete(listener); }; }
  onReconciled(listener: () => void) { this.reconciliationListeners.add(listener); return () => { this.reconciliationListeners.delete(listener); }; }
  onPresentationChanged(listener: (lease: string) => void) { this.presentationListeners.add(listener); return () => { this.presentationListeners.delete(listener); }; }
  async readPresentation(lease: string, revision?: string) { await this.whenReady(); await this.connect(); return this.call({ lease, revision }, 'presentation'); }
  getCommittedItem(key: string) { return this.base[keys[key]] ?? null; }
  async flushKey(key: string) {
    const field = keys[key];
    if (!field) throw new Error('Unknown remote browser storage key');
    // Capture this field's current write, not a moving global drain boundary.
    await this.fieldWrites.get(field);
    const acceptedRevision = this.keyRevisions[field] ?? 0;
    do { await this.synchronize(); } while (!this.closed && !this.failure && (this.snapshotKeyRevisions[field] ?? 0) < acceptedRevision);
    if (this.failure || this.closed) throw this.failure ?? new Error('Browser storage closed');
  }
  async reconcile() { this.synchronize(); await this.flush(); }
  private async pushed(message: any) {
    if (message.scope !== undefined && message.scope !== this.scope) return;
    this.dirtyRevision = Math.max(this.dirtyRevision, Number(message.revision) || 0);
    if (this.dirtyRevision > this.snapshotRevision) this.synchronize();
    await this.flush();
  }
  private committedSnapshot(state: any) {
    const previous = this.base; this.base = { ...state.values }; this.snapshotKeyRevisions = { ...state.keyRevisions };
    this.digestSupported = state.metadataDigestVersion === 2;
    this.root = state.root ?? ''; this.acceptSideChatDirectory(state.sideChatDirectory);
    for (const field of Object.keys({ ...previous, ...this.base })) if (previous[field] !== this.base[field]) this.pendingMetadataFields.add(field);
  }
  private notifyCommitted() {
    const fields = [...this.pendingMetadataFields]; this.pendingMetadataFields.clear();
    for (const field of fields) {
      for (const listener of this.metadataListeners) listener(field);
      for (const listener of this.committedListeners) listener(field);
    }
    for (const listener of this.reconciliationListeners) listener();
  }
  private async readSnapshot() {
    if (!this.digestSupported) return this.call();
    const reply = await this.call({ root: this.root, versions: this.snapshotKeyRevisions }, 'metadata-digest');
    if (reply.scope !== this.scope || !reply.leaves) throw Object.assign(new Error('Invalid browser metadata digest'), { code: 'PROTOCOL_ERROR' });
    return { ...reply, values: { ...this.base, ...reply.values }, keyRevisions: Object.fromEntries(Object.entries(reply.leaves).map(([key, value]: [string, any]) => [key, value.keyRevision])) };
  }

  readonly presentationClientId = crypto.randomUUID();
  private presentations: readonly BrowserPresentationRequest[] = [];
  presentationRequests() { return this.presentations; }
  acknowledgePresentation(id: string, action: 'claim' | 'visible' | 'failed' | 'observe', reason?: BrowserPresentationReason): Promise<BrowserPresentationRequest> {
    return this.call({ id, action, clientId: this.presentationClientId, ...(reason ? { reason } : {}) }, 'presentation-ack');
  }
  private receivePresentations(state: any) {
    const requests = Array.isArray(state.presentationRequests) ? state.presentationRequests : [];
    const changed = JSON.stringify(this.presentations) !== JSON.stringify(requests);
    this.presentations = requests; return changed;
  }
  private values: Record<string, string> = {};
  private edits: { field: string; base: string | null; value: string; mutationId: string }[] = [];
  private changes = new Set<() => void>();
  private syncQueued = false;
  private dirtyRevision = 0;
  private snapshotRevision = 0;
  private referenceProjection = false;
  private admitted = { pages: new Set<string>(), tabs: new Set<string>(), leases: new Set<string>() };
  private legacyValues: Record<string, string> = {};
  private retirementCursor: unknown;
  private retirements: readonly BrowserMetadataRetirement[] = [];
  private sideChatDirectory: { keyRevision: number; value: string; wire: string } | null = null;
  private sideChatWriteDirectory: string | null = null;
  private acceptSideChatDirectory(value: any): void {
    if (value === undefined) return; // Legacy Server: no closed binding projection.
    if (value?.version !== 1 || !Number.isSafeInteger(value.keyRevision) || value.keyRevision < 0
      || typeof value.value !== 'string' || value.value.length > browserMetadataValueLimit('sideChats')) throw new Error('Invalid side chat projection');
    if (this.sideChatDirectory && value.keyRevision < this.sideChatDirectory.keyRevision) return;
    const rows = parseSideChatDirectory(JSON.parse(value.value));
    this.sideChatDirectory = { keyRevision: value.keyRevision, value: JSON.stringify(rows), wire: serializeSideChatDirectoryV1(rows) };
  }
  getCommittedSideChatDirectory(): string | null {
    const projection = this.sideChatDirectory;
    if (projection && projection.keyRevision === (this.keyRevisions.sideChats ?? 0)
      && projection.wire === (this.base.sideChats ?? '[]')) return projection.value;
    return this.base.sideChats ?? null;
  }
  setSideChatDirectory(value: string): void {
    if (value.length > browserMetadataValueLimit('sideChats')) throw new Error('Side chat directory is too large');
    const rows = parseSideChatDirectory(JSON.parse(value));
    this.sideChatWriteDirectory = JSON.stringify(rows);
    this.setItem(serverStorageKey(browserMetadataKeys.sideChats), serializeSideChatDirectoryV1(rows));
  }
  private sideChatWriteProjection(value: string): string | undefined {
    if (this.sideChatWriteDirectory === null || this.sideChatDirectory === null) return undefined;
    const bindings = new Map(parseSideChatDirectory(JSON.parse(this.sideChatWriteDirectory)).map(row => [row.id, sideChatDirectoryBinding(row)]));
    return JSON.stringify(parseSideChatDirectory(JSON.parse(value)).map(row => {
      const binding = bindings.get(row.id);
      return 'closed' in row && binding ? { ...binding, closed: true } : row;
    }));
  }
  private revision = 0;
  private keyRevisions: Record<string, number> = {};
  private scope = '';
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private writes = Promise.resolve();
  private fieldWrites = new Map<string, Promise<void>>();
  private syncOperation = Promise.resolve();
  private retryWaiters = new Set<() => void>();
  private closed = false;
  private failure: Error | null = null;
  private listeners = new Set<(error: Error) => void>();
  private initialized = false;
  private fresh = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private initialization: Promise<void> = Promise.resolve();
  get isReady() { return this.initialized && this.fresh && !this.closed && !this.failure; }
  async whenReady() {
    await this.initialization;
    if (!this.isReady) {
      await this.connect(); this.synchronize(); await this.flush();
      if (!this.isReady) throw this.failure ?? Object.assign(new Error('Browser metadata awaits a fresh snapshot'), { code: 'BROWSER_UNAVAILABLE', retryable: true });
    }
  }
  static async create(signal?: AbortSignal, deferredAdmission?: () => Promise<void>) {
    signal?.throwIfAborted();
    const storage = new RemoteBrowserStorage();
    storage.initialization = storage.initialize(signal, deferredAdmission);
    if (!deferredAdmission) await storage.initialization;
    else void storage.initialization.catch(() => undefined);
    return storage;
  }
  private async initialize(signal?: AbortSignal, admission?: () => Promise<void>) {
    const abort = () => this.dispose();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await admission?.(); signal?.throwIfAborted();
      if (this.closed) throw new Error('Browser storage closed');
      for (const [key, field, scope] of entries) {
        try { const value = readBrowserMetadataValue(localStorage, key, scope); if (value !== null) this.legacyValues[field] = value; } catch {}
      }
      await this.connect();
      let state;
      for (let attempt = 0; ; attempt++) {
        try { state = await this.call(); break; }
        catch (error) {
          if (this.closed || (error as { code?: string }).code !== 'BROWSER_UNAVAILABLE' || !transientStateError(error)) throw error;
          await this.retryDelay(attempt);
        }
      }
      if (this.closed) throw new Error('Browser storage closed');
      signal?.throwIfAborted();
      if (Object.entries(state.values).some(([key, value]) => typeof value !== 'string' || value.length > browserMetadataValueLimit(key))) throw new Error('Invalid browser state response');
      this.values = { ...state.values }; this.revision = state.revision; this.scope = state.scope; this.keyRevisions = state.keyRevisions ?? {};
      this.snapshotRevision = state.revision;
      this.committedSnapshot(state);
      this.updateAdmission(state);
      this.retirements = this.receiveRetirements(state); this.receivePresentations(state);
      // One-time promotion preserves existing tabs on upgraded installations.
      // These records carry no authority; the Server still scopes every tab
      // partition/command to the authenticated owner.
      if (state.revision === 0 && Object.keys(state.values).length === 0) {
        for (const [key, , scope] of entries) {
          if (key === browserMetadataKeys.sideChats || key === browserMetadataKeys.resourceSignals) continue;
          const legacy = this.legacyValues[keys[apiKey(key, scope)]];
          if (legacy !== undefined) this.writeItem(apiKey(key, scope), legacy);
        }
        await this.flush();
        if (this.referenceProjection) {
          const promoted = await this.call(); signal?.throwIfAborted();
          this.values = { ...promoted.values }; this.revision = promoted.revision; this.keyRevisions = promoted.keyRevisions ?? {};
          this.snapshotRevision = promoted.revision; this.updateAdmission(promoted); this.retirements = this.receiveRetirements(promoted);
        }
      }
      this.legacyValues = {};
      signal?.throwIfAborted(); this.initialized = true; this.fresh = this.socket?.readyState === WebSocket.OPEN;
      this.synchronize();
    } catch (error) { this.dispose(); signal?.throwIfAborted(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  getItem(key: string) {
    const field = keys[key], value = this.values[field] ?? null;
    if (!this.referenceProjection) return value;
    // Unknown identities remain drafts until an authoritative snapshot admits
    // them. This bounds history delivery without showing retired offline rows.
    return retireBrowserMetadata(field, value, {
      pages: { has: id => !this.admitted.pages.has(id) }, tabs: { has: id => !this.admitted.tabs.has(id) }, leases: { has: id => !this.admitted.leases.has(id) },
    });
  }
  setItem(key: string, value: string) {
    if (!this.isReady) throw this.failure ?? Object.assign(new Error('Browser metadata awaits authenticated initialization'), { code: 'BROWSER_UNAVAILABLE', retryable: true });
    this.writeItem(key, value);
  }
  private writeItem(key: string, value: string) {
    if (!keys[key]) throw new Error('Unknown remote browser storage key');
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('Browser storage closed');
    if (typeof value !== 'string' || value.length > browserMetadataValueLimit(keys[key])) throw Object.assign(new Error('Browser metadata is too large'), { code: 'STATE_TOO_LARGE' });
    value = retireBrowserMetadata(keys[key], value, this.retirements)!;
    if (this.values[keys[key]] === value) return;
    const edit = { field: keys[key], base: this.values[keys[key]] ?? null, value, mutationId: crypto.randomUUID() };
    this.edits.push(edit); this.values[edit.field] = value;
    const operation = (this.fieldWrites.get(edit.field) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const input = { ...(edit.field === 'sideChats' ? { sideChatDirectory: this.sideChatWriteProjection(value) } : {}), key: edit.field, value, baseValue: edit.base, mutationId: edit.mutationId, scope: this.scope, expectedRevision: this.revision, expectedKeyRevision: this.keyRevisions[edit.field] ?? 0 };
      for (let attempt = 0; ; attempt++) {
        try {
          await this.connect(); const result = await this.call(input);
          this.revision = Math.max(this.revision, result.revision); this.keyRevisions[edit.field] = result.keyRevision;
          this.edits = this.edits.filter(pending => pending !== edit);
          // A merged key can refer to pages/bindings absent from our last full
          // snapshot. Publish only after all dependencies are read together.
          this.synchronize(); return;
        }
        catch (error) {
          if (this.closed || this.failure || !transientStateError(error)) throw this.failure ?? error;
          this.fresh = false;
          // Retry only the same durable mutation; a lost ACK must not create a new edit.
          await this.retryDelay(attempt);
        }
      }
    }).catch(error => {
      // A rejected edit must not poison unrelated fields or every future save.
      // Ambiguous transport errors keep retrying the same mutation above.
      if (!this.failure && ['BROWSER_UNAVAILABLE', 'PROTOCOL_ERROR'].includes((error as { code?: string }).code ?? '')) {
        this.failure = error as Error;
        for (const listener of this.listeners) listener(this.failure);
      }
      this.edits = this.edits.filter(pending => pending !== edit);
      this.project(this.base, this.retirements);
      throw error;
    });
    this.fieldWrites.set(edit.field, operation);
    this.writes = Promise.all([this.writes.catch(() => {}), operation]).then(() => {});
    void this.writes.catch(() => {});
    void operation.catch(() => {});
  }
  private retryDelay(attempt: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer); this.retryWaiters.delete(finish);
        if (this.closed || this.failure) reject(this.failure ?? new Error('Browser storage closed'));
        else resolve();
      };
      const timer = setTimeout(finish, Math.min(5000, 250 * 2 ** Math.min(attempt, 5)));
      this.retryWaiters.add(finish);
    });
  }
  private observeFailure(operation = this.writes) {
    void operation.catch(error => {
      if (this.failure || this.closed) return;
      this.failure = error; for (const listener of this.listeners) listener(error);
      console.error('[browser] Remote tab metadata could not be saved');
    });
  }
  private retirementReferences(): BrowserMetadataReferences {
    const sets = { pages: new Set<string>(), tabs: new Set<string>(), leases: new Set<string>() };
    const add = (key: string, value: string | null) => {
      const refs = browserMetadataReferences(key, value);
      for (const kind of ['pages', 'tabs', 'leases'] as const) for (const id of refs[kind]) sets[kind].add(id);
    };
    for (const [field, value] of Object.entries({ ...this.legacyValues, ...this.values })) add(field, value);
    for (const edit of this.edits) { add(edit.field, edit.base); add(edit.field, edit.value); }
    return { pages: [...sets.pages], tabs: [...sets.tabs], leases: [...sets.leases] };
  }
  private updateAdmission(state: any) {
    this.referenceProjection = state.retirementProjection === 'references';
    if (!this.referenceProjection) return false;
    const previous = JSON.stringify(Object.fromEntries(Object.entries(this.admitted).map(([kind, ids]) => [kind, [...ids]])));
    this.admitted = { pages: new Set(), tabs: new Set(), leases: new Set() };
    for (const [key, value] of Object.entries(state.values) as [string, string][]) {
      const refs = browserMetadataReferences(key, value);
      for (const kind of ['pages', 'tabs', 'leases'] as const) for (const id of refs[kind]) this.admitted[kind].add(id);
    }
    return previous !== JSON.stringify(Object.fromEntries(Object.entries(this.admitted).map(([kind, ids]) => [kind, [...ids]])));
  }
  private receiveRetirements(state: any): readonly BrowserMetadataRetirement[] {
    let facts: readonly BrowserMetadataRetirement[] = state.retiredTabs ?? [];
    if (state.retiredTabsMode === 'append') facts = facts.length ? [...this.retirements, ...facts] : this.retirements;
    this.retirementCursor = state.retirementCursor;
    return facts;
  }
  private project(confirmed: Record<string, string>, retirements: readonly BrowserMetadataRetirement[]) {
    const next = Object.fromEntries(Object.entries(confirmed).map(([field, value]) => [field, retireBrowserMetadata(field, value, retirements)!]));
    for (const edit of this.edits) {
      const value = mergeField(edit.field, retireBrowserMetadata(edit.field, edit.base, retirements),
        retireBrowserMetadata(edit.field, edit.value, retirements), next[edit.field] ?? null);
      if (value === null) delete next[edit.field]; else next[edit.field] = value;
    }
    const retirementsChanged = retirements !== this.retirements && JSON.stringify(retirements) !== JSON.stringify(this.retirements);
    const changed = retirementsChanged || Object.keys({ ...next, ...this.values }).some(key => next[key] !== this.values[key]);
    this.values = next; this.retirements = retirements;
    return changed;
  }
  /** Invalidation and writes share ordering. Optimistic edits are rebased as
   * records, never replaced by a fetched whole-account snapshot. */
  private synchronize(): Promise<void> {
    if (this.closed || this.failure || !this.initialized || this.syncQueued) return this.syncOperation;
    this.syncQueued = true;
    this.syncOperation = this.syncOperation.then(async () => {
      let state;
      for (let attempt = 0; ; attempt++) {
        try { await this.connect(); state = await this.readSnapshot(); break; }
        catch (error) {
          if (this.closed) return;
          if (!transientStateError(error) || attempt >= 5) throw error;
          this.fresh = false;
          await this.retryDelay(attempt);
        }
      }
      if (this.closed) return;
      if (state.scope !== this.scope) throw Object.assign(new Error('Browser account changed'), { code: 'STATE_CONFLICT' });
      if (Object.entries(state.values).some(([key, value]) => typeof value !== 'string' || value.length > browserMetadataValueLimit(key))) throw new Error('Invalid browser state response');
      if (state.revision >= this.revision) {
        const wasReady = this.isReady;
        this.revision = state.revision; this.keyRevisions = state.keyRevisions ?? {};
        const admitted = this.updateAdmission(state);
        const presentationChanged = this.receivePresentations(state);
        const changed = this.project(state.values, this.receiveRetirements(state)) || admitted || presentationChanged;
        this.committedSnapshot(state);
        this.snapshotRevision = state.revision;
        this.fresh = this.socket?.readyState === WebSocket.OPEN;
        this.reconnectAttempt = 0;
        if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (changed || wasReady !== this.isReady) for (const listener of this.changes) listener();
        this.notifyCommitted();
      }
    }).then(() => {
      this.syncQueued = false;
      if (this.dirtyRevision > this.snapshotRevision) this.synchronize();
    }, error => {
      this.syncQueued = false;
      if (!this.closed && !this.failure && transientStateError(error)) {
        this.scheduleReconnect(); return;
      }
      throw error;
    });
    this.observeFailure(this.syncOperation);
    return this.syncOperation;
  }
  private scheduleReconnect() {
    if (this.closed || this.failure || !this.initialized || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.synchronize();
    }, Math.min(5000, 250 * 2 ** Math.min(this.reconnectAttempt++, 5)));
  }
  subscribe(listener: () => void) { this.changes.add(listener); return () => { this.changes.delete(listener); }; }
  retiredResources() { return this.retirements; }
  onError(listener: (error: Error) => void) { this.listeners.add(listener); if (this.failure) listener(this.failure); return () => { this.listeners.delete(listener); }; }
  async flush() { for (;;) { const tail = this.writes, sync = this.syncOperation; await Promise.all([tail, sync]); if (tail === this.writes && sync === this.syncOperation) return; } }
  async listResources(): Promise<RemoteBrowserCatalog> { await this.whenReady(); await this.connect(); return this.call(undefined, 'catalog'); }
  async closeResource(lease: string): Promise<void> { await this.whenReady(); await this.connect(); await this.call({ lease }, 'discard'); }
  /** Give accepted edits a bounded drain window; offline retries cannot hold Application teardown. */
  async flushAndDispose() {
    const timer = setTimeout(() => this.dispose(), 1000);
    try { await this.flush(); }
    catch (error) {
      if (!this.closed || !['DISCONNECTED'].includes((error as { code?: string }).code ?? '') && (error as Error).message !== 'Browser storage closed') throw error;
    }
    finally { clearTimeout(timer); this.dispose(); }
  }
  dispose() { if (this.closed) return; this.closed = true; this.cancelConnect?.(); this.cancelConnect = null; for (const finish of this.retryWaiters) finish(); if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.socket?.close(); this.rejectPending(); this.listeners.clear(); this.changes.clear(); this.metadataListeners.clear(); this.committedListeners.clear(); this.reconciliationListeners.clear(); this.presentationListeners.clear(); }
  private rejectPending() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' })); }
    this.pending.clear();
  }
  private connect(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('Browser storage closed'));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const url = new URL(serverUrl('/__opencraft_browser/stream'), location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url); this.socket = ws;
    this.connecting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.socket !== ws) return;
        this.socket = null; this.connecting = null; this.cancelConnect = null; this.fresh = false;
        this.rejectPending();
        reject(Object.assign(new Error('Browser state connection timed out'), { code: 'DISCONNECTED' }));
        this.scheduleReconnect(); ws.close();
      }, 20000);
      this.cancelConnect = () => { clearTimeout(timer); reject(new Error('Browser storage closed')); };
      ws.onopen = () => {
        clearTimeout(timer);
        if (this.closed || this.socket !== ws) {
          ws.close(); reject(new Error('Browser storage closed')); return;
        }
        this.cancelConnect = null;
        resolve(); if (this.initialized) this.synchronize();
      };
      ws.onerror = () => {};
      ws.onmessage = event => {
        if (this.closed || this.socket !== ws) return;
        const message = JSON.parse(event.data);
        if (message.type === 'presentation-changed' && typeof message.lease === 'string') { for (const listener of this.presentationListeners) listener(message.lease); return; }
        if (message.type === 'metadata-changed') {
          this.dirtyRevision = Math.max(this.dirtyRevision, Number(message.revision) || 0);
          if (this.dirtyRevision > this.snapshotRevision) this.synchronize(); return;
        }
        if (message.type !== 'result') return;
        const p = this.pending.get(message.id); if (!p) return;
        this.pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.reject(Object.assign(new Error(message.error.message), { code: message.error.code, retryable: message.error.retryable === true })); else p.resolve(message.value);
      };
      ws.onclose = event => {
        clearTimeout(timer);
        if (this.socket !== ws) return;
        this.cancelConnect = null; this.fresh = false; this.connecting = null; this.rejectPending();
        if (!this.closed && event.code === 1008) {
          this.failure = Object.assign(new Error('Browser storage authorization rejected'), { code: 'BROWSER_UNAVAILABLE' });
          for (const finish of this.retryWaiters) finish();
          for (const listener of this.listeners) listener(this.failure);
        } else this.scheduleReconnect();
        reject(this.failure ?? Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' }));
      };
    });
    return this.connecting;
  }
  private call(input?: unknown, method = 'state'): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Browser storage closed'));
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' }));
    const socket = this.socket;
    const id = crypto.randomUUID(), payload = JSON.stringify({ id, method, input, ...(method === 'state' ? { subscribe: true, retirementCursor: this.retirementCursor } : {}), ...((method === 'state' && input === undefined || method === 'metadata-digest') ? { retirementReferences: this.retirementReferences() } : {}) });
    if (new TextEncoder().encode(payload).byteLength > browserMetadataWireLimit) return Promise.reject(Object.assign(new Error('Browser metadata is too large'), { code: 'STATE_TOO_LARGE' }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.socket === socket) {
          this.socket = null; this.connecting = null; this.cancelConnect = null; this.fresh = false;
          this.rejectPending(); this.scheduleReconnect();
        }
        socket.close();
        reject(Object.assign(new Error('Browser state timed out'), { code: 'DISCONNECTED' }));
      }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      try { socket.send(payload); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
}
