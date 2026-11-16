import { browserMetadataValueLimit, browserMetadataWireLimit } from '@opencraft/browser-core/metadata-limits';
import { mergeBrowserMetadata, retireBrowserMetadata, type BrowserMetadataRetirement } from '@opencraft/browser-core/metadata-merge';
import type { BrowserMetadataStorage, RemoteBrowserCatalog } from './desktop-browser-storage';
import { serverStorageKey, serverUrl } from '../runtime/server-context';
import { browserMetadataKeys, readBrowserMetadataValue } from '@opencraft/workbench-runtime/browser-metadata-identity';

const identity = (key: string) => key;
const transientStateError = (error: unknown) => {
  const failure = error as { code?: string; retryable?: boolean };
  return failure?.code === 'DISCONNECTED' || failure?.code === 'BROWSER_UNAVAILABLE' && failure.retryable === true;
};
const remoteStorageKey = 'opencraft.remote-browser-storage.v1';
const entries = [
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
export class RemoteBrowserStorage implements BrowserMetadataStorage {
  private values: Record<string, string> = {};
  private edits: { field: string; base: string | null; value: string; mutationId: string }[] = [];
  private changes = new Set<() => void>();
  private syncQueued = false;
  private dirtyRevision = 0;
  private snapshotRevision = 0;
  private retirements: readonly BrowserMetadataRetirement[] = [];
  private revision = 0;
  private keyRevisions: Record<string, number> = {};
  private scope = '';
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private writes = Promise.resolve();
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
      this.retirements = state.retiredTabs ?? [];
      // One-time promotion preserves existing tabs on upgraded installations.
      // These records carry no authority; the Server still scopes every tab
      // partition/command to the authenticated owner.
      if (state.revision === 0 && Object.keys(state.values).length === 0) {
        for (const [key, , scope] of entries) {
          let legacy: string | null = null;
          try { legacy = readBrowserMetadataValue(localStorage, key, scope); } catch {}
          if (legacy !== null) this.writeItem(apiKey(key, scope), legacy);
        }
        await this.flush();
      }
      signal?.throwIfAborted(); this.initialized = true; this.fresh = this.socket?.readyState === WebSocket.OPEN;
      this.synchronize();
    } catch (error) { this.dispose(); signal?.throwIfAborted(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  getItem(key: string) { return this.values[keys[key]] ?? null; }
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
    this.writes = this.writes.then(async () => {
      const input = { key: edit.field, value, baseValue: edit.base, mutationId: edit.mutationId, scope: this.scope, expectedRevision: this.revision, expectedKeyRevision: this.keyRevisions[edit.field] ?? 0 };
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
    });
    this.observeFailure();
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
  private observeFailure() {
    void this.writes.catch(error => {
      if (this.failure || this.closed) return;
      this.failure = error; for (const listener of this.listeners) listener(error);
      console.error('[browser] Remote tab metadata could not be saved');
    });
  }
  private project(confirmed: Record<string, string>, retirements: readonly BrowserMetadataRetirement[]) {
    const next = Object.fromEntries(Object.entries(confirmed).map(([field, value]) => [field, retireBrowserMetadata(field, value, retirements)!]));
    for (const edit of this.edits) {
      const value = mergeBrowserMetadata(edit.field, retireBrowserMetadata(edit.field, edit.base, retirements),
        retireBrowserMetadata(edit.field, edit.value, retirements), next[edit.field] ?? null);
      if (value === null) delete next[edit.field]; else next[edit.field] = value;
    }
    const changed = JSON.stringify(retirements) !== JSON.stringify(this.retirements) || Object.keys({ ...next, ...this.values }).some(key => next[key] !== this.values[key]);
    this.values = next; this.retirements = retirements;
    return changed;
  }
  /** Invalidation and writes share ordering. Optimistic edits are rebased as
   * records, never replaced by a fetched whole-account snapshot. */
  private synchronize() {
    if (this.closed || this.failure || !this.initialized || this.syncQueued) return;
    this.syncQueued = true;
    this.writes = this.writes.then(async () => {
      let state;
      for (let attempt = 0; ; attempt++) {
        try { await this.connect(); state = await this.call(); break; }
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
        const changed = this.project(state.values, state.retiredTabs ?? []);
        this.snapshotRevision = state.revision;
        this.fresh = this.socket?.readyState === WebSocket.OPEN;
        this.reconnectAttempt = 0;
        if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (changed || wasReady !== this.isReady) for (const listener of this.changes) listener();
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
    this.observeFailure();
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
  async flush() { for (;;) { const tail = this.writes; await tail; if (tail === this.writes) return; } }
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
  dispose() { if (this.closed) return; this.closed = true; this.cancelConnect?.(); this.cancelConnect = null; for (const finish of this.retryWaiters) finish(); if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.socket?.close(); this.rejectPending(); this.listeners.clear(); this.changes.clear(); }
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
    const id = crypto.randomUUID(), payload = JSON.stringify({ id, method, input, ...(method === 'state' ? { subscribe: true } : {}) });
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
