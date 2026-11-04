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

test('initial state survives eight disconnects without exposing empty or writable legacy state', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] }); let reads = 0;
 const f = startupWire(t, { respond(message, socket) { if (++reads <= 8) queueMicrotask(() => socket.end()); else socket.result(message, f.state); } });
 let ready = false; const opening = f.start().then(storage => { ready = true; return storage; });
 for (let attempt = 0; attempt < 8; attempt++) {
  await tick(); assert(!ready); assert.equal(reads, attempt + 1);
  assert.equal(f.legacyReads, 0); assert(f.messages.every(m => m.input === undefined));
  t.mock.timers.tick(Math.min(30000, 250 * 2 ** attempt));
 }
 const storage: any = await opening;
 assert.equal(reads, 9); assert.equal(storage.getItem(key), '["retained"]'); assert.equal(storage.scope, f.state.scope);
 assert.equal(storage.failure, null); assert.equal(f.legacyReads, 0); assert.equal(storage.retryWait, null);
});

test('initial owner handoff retries only an explicitly retryable response', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] }); let reads = 0;
 const f = startupWire(t, { respond(message, socket) { if (++reads < 3) socket.error(message, 'BROWSER_UNAVAILABLE', true); else socket.result(message, f.state); } });
 const opening = f.start(); await tick(); t.mock.timers.tick(250); await tick(); t.mock.timers.tick(500);
 const storage = await opening; assert.equal(reads, 3); assert.equal(f.sockets.length, 1); assert.equal(storage.getItem(key), '["retained"]');
});

for (const phase of ['connect', 'read', 'backoff']) test(`cancel initial ${phase} without awaiting socket close`, async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t, { holdConnect: () => phase === 'connect', silentClose: true,
  respond(_message, socket) { if (phase === 'backoff') queueMicrotask(() => socket.end()); } });
 const controller = new AbortController(), opening = assert.rejects(f.start(controller), { name: 'AbortError' });
 await tick(); controller.abort(); await opening;
 const count = f.messages.length, sockets = f.sockets.length;
 for (const socket of f.sockets) { socket.open(); socket.onmessage?.({ data: 'malformed late state' }); socket.end(1008); }
 t.mock.timers.tick(120000); await tick();
 assert.equal(f.messages.length, count); assert.equal(f.sockets.length, sockets); assert.equal(f.legacyReads, 0);
});

test('blackhole handshake retires without close delivery; old callbacks cannot poison the new owner', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t, { holdConnect: index => index === 0, silentClose: true });
 const opening = f.start(); await tick(); assert.equal(f.messages.length, 0);
 t.mock.timers.tick(20000); await tick(); t.mock.timers.tick(250);
 const storage: any = await opening; assert.equal(f.sockets.length, 2); assert.equal(storage.getItem(key), '["retained"]');
 f.sockets[0].open(); f.sockets[0].end(1008); f.sockets[0].onmessage?.({ data: 'not current' });
 assert.equal(storage.failure, null); storage.setItem(key, '["next"]'); await storage.flush(); assert.equal(storage.getItem(key), '["next"]');
});

test('blackhole first read retires its captured socket even when close never arrives', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] }); let reads = 0;
 const f = startupWire(t, { silentClose: true, respond(message, socket) { if (++reads > 1) socket.result(message, f.state); } });
 const opening = f.start(); await tick(); assert.equal(reads, 1);
 t.mock.timers.tick(25000); await tick(); t.mock.timers.tick(250);
 const storage: any = await opening; assert.equal(reads, 2); assert.equal(f.sockets.length, 2);
 f.sockets[0].result(f.messages[0], { ...f.state, values: { pages: '["late"]' } }); await tick();
 assert.equal(storage.getItem(key), '["retained"]'); assert.equal(storage.pending.size, 0); assert.equal(storage.failure, null);
});

for (const [code, expected] of [[1008,'AUTHORIZATION_REQUIRED'],[1009,'STATE_TOO_LARGE'],[1002,'PROTOCOL_ERROR']] as const)
 test(`initial close ${code} terminates rather than retrying`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = startupWire(t, { respond(_message, socket) { queueMicrotask(() => socket.end(code)); } });
  await assert.rejects(f.start(), { code: expected }); t.mock.timers.tick(120000); await tick();
  assert.equal(f.sockets.length, 1); assert.equal(f.messages.length, 1); assert.equal(f.legacyReads, 0);
 });

for (const value of [null, { revision: 0, values: {} }, { scope: 's', revision: -1, values: {} },
 { scope: 's', revision: 0, values: { pages: [] } }, { scope: 's', revision: 0, values: {}, keyRevisions: { pages: -1 } }])
 test('invalid initial state cannot trigger promotion or transient retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = startupWire(t, { respond(message, socket) { socket.result(message, value); } });
  await assert.rejects(f.start(), { code: 'PROTOCOL_ERROR' }); t.mock.timers.tick(120000); await tick();
  assert.equal(f.messages.length, 1); assert.equal(f.legacyReads, 0);
 });

test('nonretryable state response terminates admission', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] }); const f = startupWire(t, { respond(message, socket) { socket.error(message, 'BROWSER_UNAVAILABLE'); } });
 await assert.rejects(f.start(), { code: 'BROWSER_UNAVAILABLE' }); t.mock.timers.tick(120000); await tick(); assert.equal(f.messages.length, 1);
});

test('already canceled startup creates no transport or legacy projection', async t => {
 const f = startupWire(t), controller = new AbortController(); controller.abort();
 await assert.rejects(f.start(controller), { name: 'AbortError' }); assert.equal(f.sockets.length, 0); assert.equal(f.legacyReads, 0);
});

test('completed startup transfers lifetime to the application', async t => {
 const f = startupWire(t), controller = new AbortController(); const storage: any = await f.start(controller);
 controller.abort(); assert(!storage.closed); storage.setItem(key, '["after-ready"]'); await storage.flush();
 assert.equal(storage.getItem(key), '["after-ready"]'); assert.equal(storage.failure, null);
});

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
