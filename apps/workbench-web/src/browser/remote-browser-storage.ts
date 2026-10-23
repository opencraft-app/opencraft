import type { BrowserMetadataStorage, RemoteBrowserCatalog } from './desktop-browser-storage';
import { serverStorageKey, serverUrl } from '../runtime/server-context';

const keys: Record<string, string> = {
  'vela.browser-pages.v1': 'pages', 'vela.browser-tabs.v1': 'tabs',
  'opencraft.remote-browser-storage.v1': 'storage',
  [serverStorageKey('vela.conversation-bindings.v1')]: 'bindings',
};
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
  static async create() {
    const storage = new RemoteBrowserStorage();
    try {
      await storage.connect();
      const state = await storage.call(); storage.values = state.values; storage.revision = state.revision; storage.scope = state.scope; storage.keyRevisions = state.keyRevisions ?? {};
      // One-time promotion preserves existing tabs on upgraded installations.
      // These records carry no authority; the Server still scopes every tab
      // partition/command to the authenticated owner.
      if (state.revision === 0 && Object.keys(state.values).length === 0) {
        for (const [key] of Object.entries(keys)) {
          let legacy: string | null = null;
          try { legacy = localStorage.getItem(key === 'opencraft.remote-browser-storage.v1' ? serverStorageKey(key) : key); } catch {}
          if (legacy !== null) storage.setItem(key, legacy);
        }
        await storage.flush();
      }
      return storage;
    } catch (error) { storage.dispose(); throw error; }
  }
  getItem(key: string) { return this.values[keys[key]] ?? null; }
  setItem(key: string, value: string) {
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
  async listResources(): Promise<RemoteBrowserCatalog> { await this.connect(); return this.call(undefined, 'catalog'); }
  async closeResource(lease: string): Promise<void> { await this.connect(); await this.call({ lease }, 'discard'); }
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
