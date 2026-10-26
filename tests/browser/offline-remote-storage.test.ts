import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserStorage } from '../../apps/workbench-web/src/browser/remote-browser-storage';
const key = 'opencraft.browser-pages.v1';
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

// Replace only WebSocket: the real storage owner controls startup, retries,
// timeouts, disposal and generation checks under a deterministic clock.
function startupWire(t: TestContext, options: { holdConnect?: (index: number) => boolean; silentClose?: boolean;
  respond?: (message: any, socket: any) => void } = {}) {
 const sockets: any[] = [], messages: any[] = [], owners: RemoteBrowserStorage[] = [], controllers: AbortController[] = [];
 let legacyReads = 0;
 const state = { scope: 'fixture-scope', revision: 1, keyRevisions: { pages: 1 }, values: { pages: '["retained"]' } };
 class Socket {
  static OPEN = 1; readyState = 0; onopen?: () => void; onmessage?: (event: any) => void; onclose?: (event: any) => void; onerror?: () => void;
  constructor() { sockets.push(this); if (!options.holdConnect?.(sockets.length - 1)) queueMicrotask(() => this.open()); }
  open() { this.readyState = 1; this.onopen?.(); }
  result(message: any, value: any = state) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'result', id: message.id, value }) })); }
  error(message: any, code: string, retryable = false) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'result', id: message.id, error: { code, message: code, retryable } }) })); }
  end(code = 1012) { this.readyState = 3; this.onclose?.({ code }); }
  close() { this.readyState = 2; if (!options.silentClose) queueMicrotask(() => this.end(1000)); }
  send(bytes: string) { const message = JSON.parse(bytes); messages.push(message);
   if (options.respond) options.respond(message, this);
   else this.result(message, message.input ? { revision: 2, keyRevision: 2 } : state);
  }
 }
 const saved = new Map(['WebSocket','location','localStorage'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
 Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
 Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://fixture.test/' } });
 Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { legacyReads++; return null; } } });
 t.after(() => { for (const c of controllers) c.abort(); for (const owner of owners) owner.dispose();
  for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; });
 return { state, sockets, messages, get legacyReads() { return legacyReads; }, start(controller = new AbortController()) {
  controllers.push(controller); return RemoteBrowserStorage.create(controller.signal).then(owner => { owners.push(owner); return owner; });
 } };
}

test('deferred browser metadata exposes no writable local authority before live admission', async t => {
 const f = startupWire(t); let admit!: () => void;
 const admission = new Promise<void>(resolve => { admit = resolve; });
 const storage = await RemoteBrowserStorage.create(undefined, () => admission);
 t.after(() => storage.dispose());
 assert.equal(storage.isReady, false); assert.equal(f.sockets.length, 0);
 assert.throws(() => storage.setItem(key, '["offline replacement"]'), { code: 'BROWSER_UNAVAILABLE' });
 assert.equal(storage.getItem(key), null); assert.equal(f.legacyReads, 0);
 admit(); await storage.whenReady();
 assert.equal(storage.isReady, true); assert.equal(storage.getItem(key), '["retained"]');
 storage.setItem(key, '["authenticated change"]'); await storage.flush();
 assert.equal(f.messages.filter(m => m.input).length, 1);
});
