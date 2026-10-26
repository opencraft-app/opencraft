import type { BrowserMetadataStorage, RemoteBrowserCatalog } from './desktop-browser-storage';
import { serverStorageKey, serverUrl } from '../runtime/server-context';
import { browserMetadataKeys, readBrowserMetadataValue } from '@opencraft/workbench-runtime/browser-metadata-identity';

const identity = (key: string) => key;
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
  private revision = 0;
  private keyRevisions: Record<string, number> = {};
  private scope = '';
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private writes = Promise.resolve();
  private closed = false;
  private failure: Error | null = null;
  private listeners = new Set<(error: Error) => void>();
  private initialized = false;
  private initialization: Promise<void> = Promise.resolve();
  get isReady() { return this.initialized && !this.closed && !this.failure; }
  whenReady() { return this.initialization; }
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
      const state = await this.call(); this.values = state.values; this.revision = state.revision; this.scope = state.scope; this.keyRevisions = state.keyRevisions ?? {};
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
      signal?.throwIfAborted(); this.initialized = true;
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
    if (this.values[keys[key]] === value) return;
    this.values[keys[key]] = value;
    const mutationId = crypto.randomUUID();
    this.writes = this.writes.then(async () => {
      const input = { key: keys[key], value, mutationId, scope: this.scope, expectedRevision: this.revision, expectedKeyRevision: this.keyRevisions[keys[key]] ?? 0 };
      for (let attempt = 0; ; attempt++) {
        try { await this.connect(); const result = await this.call(input); this.revision = Math.max(this.revision, result.revision); this.keyRevisions[keys[key]] = result.keyRevision; return; }
        catch (error) {
          if (this.closed || (error as { code?: string }).code !== 'DISCONNECTED' || attempt >= 5) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(5000, 250 * 2 ** attempt)));
        }
      }
    });
    void this.writes.catch(error => {
      if (this.failure || this.closed) return;
      this.failure = error; for (const listener of this.listeners) listener(error);
      console.error('[browser] Remote tab metadata could not be saved');
    });
  }
  onError(listener: (error: Error) => void) { this.listeners.add(listener); if (this.failure) listener(this.failure); return () => { this.listeners.delete(listener); }; }
  flush() { return this.writes; }
  async listResources(): Promise<RemoteBrowserCatalog> { await this.whenReady(); await this.connect(); return this.call(undefined, 'catalog'); }
  async closeResource(lease: string): Promise<void> { await this.whenReady(); await this.connect(); await this.call({ lease }, 'discard'); }
  dispose() { if (this.closed) return; this.closed = true; this.socket?.close(); this.rejectPending(); this.listeners.clear(); }
  private rejectPending() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' })); }
    this.pending.clear();
  }
  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Browser storage closed'));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const url = new URL(serverUrl('/__opencraft_browser/stream'), location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url); this.socket = ws;
    this.connecting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => ws.close(), 20000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => {};
      ws.onmessage = event => {
        const message = JSON.parse(event.data); if (message.type !== 'result') return;
        const p = this.pending.get(message.id); if (!p) return;
        this.pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else p.resolve(message.value);
      };
      ws.onclose = () => { clearTimeout(timer); this.connecting = null; this.rejectPending(); reject(Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' })); };
    });
    return this.connecting;
  }
  private call(input?: unknown, method = 'state'): Promise<any> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' }));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket?.close(); this.pending.delete(id); reject(Object.assign(new Error('Browser state timed out'), { code: 'DISCONNECTED' })); }, 25000);
      this.pending.set(id, { resolve, reject, timer }); this.socket!.send(JSON.stringify({ id, method, input }));
    });
  }
}
