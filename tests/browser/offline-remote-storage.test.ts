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


test('idle disconnect automatically refreshes its snapshot before becoming ready', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let hold = false; let release: (() => void) | undefined;
 const f = startupWire(t, { respond(message, socket) {
  if (hold) release = () => socket.result(message, f.state);
  else socket.result(message, f.state);
 } });
 const storage = await f.start(); await storage.flush();
 hold = true; f.state.revision = 2; f.state.values.pages = '["created elsewhere"]';
 f.sockets[0].end();
 assert.equal(storage.isReady, false);
 assert.throws(() => storage.setItem(key, '["offline"]'), { code: 'BROWSER_UNAVAILABLE' });
 t.mock.timers.tick(250); await tick();
 assert.equal(f.sockets.length, 2); assert.equal(storage.isReady, false);
 assert.equal(storage.getItem(key), '["retained"]');
 assert(release); hold = false; release(); await storage.flush();
 assert.equal(storage.isReady, true); assert.equal(storage.getItem(key), '["created elsewhere"]');
 assert.equal(f.messages.filter(message => message.input).length, 0);
});

test('authorization closure and disposal cancel automatic reconnect', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t), storage = await f.start(); await storage.flush();
 let errors = 0; storage.onError(() => errors++);
 f.sockets[0].end(1008); t.mock.timers.tick(30000); await tick();
 assert.equal(storage.isReady, false); assert.equal(errors, 1); assert.equal(f.sockets.length, 1);
 const second = await f.start(); await second.flush();
 f.sockets[1].end(); second.dispose(); t.mock.timers.tick(30000); await tick();
 assert.equal(f.sockets.length, 2);
});

test('idle recovery survives repeated transport failures without replaying writes', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let unavailable = false;
 const f = startupWire(t, { respond(message, socket) {
  if (unavailable) queueMicrotask(() => socket.end());
  else socket.result(message, f.state);
 } });
 const storage = await f.start(); await storage.flush();
 unavailable = true; f.sockets[0].end();
 for (let attempt = 0; attempt < 12; attempt++) { t.mock.timers.tick(5000); await tick(); }
 assert.equal(storage.isReady, false); assert(f.sockets.length > 6);
 unavailable = false; f.state.revision = 3; f.state.values.pages = '["caught up"]';
 for (let attempt = 0; attempt < 3 && !storage.isReady; attempt++) { t.mock.timers.tick(5000); await tick(); }
 await storage.flush();
 assert.equal(storage.isReady, true); assert.equal(storage.getItem(key), '["caught up"]');
 assert.equal(f.messages.filter(message => message.input).length, 0);
});

test('pending write survives a long outage and lost ACK using one durable mutation', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let unavailable = false, loseAck = true, applications = 0;
 const committed = new Map<string, unknown>();
 const f = startupWire(t, { respond(message, socket) {
  if (!message.input) { socket.result(message, f.state); return; }
  if (!committed.has(message.input.mutationId)) {
   applications++; committed.set(message.input.mutationId, { revision: 2, keyRevision: 2 });
   f.state.revision = 2; f.state.values.pages = message.input.value;
  }
  if (loseAck || unavailable) { loseAck = false; unavailable = true; queueMicrotask(() => socket.end()); }
  else socket.result(message, committed.get(message.input.mutationId));
 } });
 const storage = await f.start(); await storage.flush();
 let failures = 0; storage.onError(() => failures++);
 storage.setItem(key, '["pending draft"]'); await tick();
 for (let attempt = 0; attempt < 10; attempt++) { t.mock.timers.tick(5000); await tick(); }
 assert.equal(failures, 0); assert.equal(storage.isReady, false);
 assert.equal(storage.getItem(key), '["pending draft"]');
 unavailable = false; t.mock.timers.tick(5000); await tick(); await storage.flush();
 assert.equal(storage.isReady, true); assert.equal(applications, 1);
 assert(f.messages.filter(message => message.input).length > 6);
 assert.equal(new Set(f.messages.filter(message => message.input).map(message => JSON.stringify(message.input))).size, 1);
});

test('recovery publishes readiness with both changed and unchanged snapshots', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t), storage = await f.start(); await storage.flush();
 const observations: { ready: boolean; value: string | null }[] = [];
 storage.subscribe(() => observations.push({ ready: storage.isReady, value: storage.getItem(key) }));
 f.sockets[0].end(); f.state.revision = 2; f.state.values.pages = '["new page"]';
 t.mock.timers.tick(250); await tick(); await storage.flush();
 f.sockets[1].end(); t.mock.timers.tick(250); await tick(); await storage.flush();
 assert.deepEqual(observations, [{ ready: true, value: '["new page"]' }, { ready: true, value: '["new page"]' }]);
});

test('disposal cancels a pending write backoff immediately', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t, { respond(message, socket) {
  if (message.input) queueMicrotask(() => socket.end()); else socket.result(message, f.state);
 } });
 const storage = await f.start(); await storage.flush();
 storage.setItem(key, '["pending"]'); await tick();
 const flushed = storage.flush(); storage.dispose();
 await assert.rejects(flushed, /closed/);
 const attempts = f.sockets.length; t.mock.timers.tick(30000); await tick();
 assert.equal(f.sockets.length, attempts);
});

test('authorization revocation terminates a pending write without retry', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t, { respond(message, socket) {
  if (message.input) queueMicrotask(() => socket.end(1008)); else socket.result(message, f.state);
 } });
 const storage = await f.start(); await storage.flush(); let failures = 0;
 storage.onError(() => failures++); storage.setItem(key, '["pending"]');
 await assert.rejects(storage.flush(), /authorization rejected/);
 const attempts = f.sockets.length; t.mock.timers.tick(30000); await tick();
 assert.equal(f.sockets.length, attempts); assert.equal(failures, 1); assert.equal(storage.isReady, false);
});

test('a synchronous send failure leaves no timer to close a recovered connection', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let failSend = true;
 const f = startupWire(t, { respond(message, socket) {
  if (message.input && failSend) { failSend = false; throw Object.assign(new Error('send disconnected'), { code: 'DISCONNECTED' }); }
  if (message.input) { f.state.revision = 2; f.state.values.pages = message.input.value; }
  socket.result(message, message.input ? { revision: 2, keyRevision: 2 } : f.state);
 } });
 const storage = await f.start(); await storage.flush();
 storage.setItem(key, '["saved"]'); await tick();
 t.mock.timers.tick(250); await tick(); await storage.flush();
 assert.equal(storage.isReady, true); const connections = f.sockets.length;
 t.mock.timers.tick(30000); await tick();
 assert.equal(storage.isReady, true); assert.equal(f.sockets.length, connections);
 assert(f.sockets.every(socket => socket.readyState === 1));
});

test('disposal promptly settles a snapshot retry backoff', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let unavailable = false;
 const f = startupWire(t, { respond(message, socket) {
  if (unavailable) queueMicrotask(() => socket.end()); else socket.result(message, f.state);
 } });
 const storage = await f.start(); await storage.flush();
 unavailable = true; f.sockets[0].end(); t.mock.timers.tick(250); await tick();
 const flushed = storage.flush(); storage.dispose();
 await assert.rejects(flushed, /closed/);
 const connections = f.sockets.length; t.mock.timers.tick(30000); await tick();
 assert.equal(f.sockets.length, connections);
});

test('a late socket open after startup cancellation sends no metadata request', async t => {
 const f = startupWire(t, { holdConnect: () => true });
 const controller = new AbortController(), started = f.start(controller);
 await tick(); assert.equal(f.sockets.length, 1);
 controller.abort(); f.sockets[0].open();
 await assert.rejects(started, { name: 'AbortError' });
 assert.equal(f.messages.length, 0);
});

test('application metadata shutdown drains healthy writes and bounds offline teardown', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let offline = false;
 const f = startupWire(t, { respond(message, socket) {
  if (message.input && offline) { queueMicrotask(() => socket.end()); return; }
  if (message.input) { f.state.revision++; f.state.values.pages = message.input.value; }
  socket.result(message, message.input ? { revision: f.state.revision, keyRevision: f.state.revision } : f.state);
 } });
 const healthy = await f.start(); await healthy.flush();
 healthy.setItem(key, '["saved before shutdown"]'); await healthy.flushAndDispose();
 assert.equal(f.state.values.pages, '["saved before shutdown"]'); assert.equal(healthy.isReady, false);
 const offlineOwner = await f.start(); await offlineOwner.flush();
 offline = true; offlineOwner.setItem(key, '["pending offline"]'); await tick();
 let finished = false;
 const shutdown = offlineOwner.flushAndDispose().then(() => { finished = true; }); await tick();
 assert.equal(finished, false);
 t.mock.timers.tick(1000); await tick(); await shutdown;
 assert.equal(finished, true); assert.equal(offlineOwner.isReady, false);
 const attempts = f.sockets.length; t.mock.timers.tick(30000); await tick(); assert.equal(f.sockets.length, attempts);
});

test('shutdown cancels an unfinished reconnect handshake without waiting for close', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t, { holdConnect: index => index > 0, silentClose: true });
 const storage = await f.start(); await storage.flush();
 f.sockets[0].end(); t.mock.timers.tick(250); await tick();
 assert.equal(f.sockets.length, 2); assert.equal(f.sockets[1].readyState, 0);
 const shutdown = storage.flushAndDispose();
 t.mock.timers.tick(1000); await tick(); await shutdown;
 assert.equal(storage.isReady, false);
 f.sockets[1].open(); await tick();
 assert.equal(f.messages.length, 2);
});

test('startup handshake timeout rejects without requiring a socket close event', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t, { holdConnect: () => true, silentClose: true });
 const started = f.start(); await tick();
 const rejection = assert.rejects(started, { code: 'DISCONNECTED' });
 t.mock.timers.tick(20000); await tick(); await rejection;
 assert.equal(f.messages.length, 0);
 f.sockets[0].open(); await tick(); assert.equal(f.messages.length, 0);
});

test('timed-out reconnect is replaced and late events cannot cancel its successor', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t, { holdConnect: index => index > 0, silentClose: true });
 const storage = await f.start(); await storage.flush();
 f.sockets[0].end(); t.mock.timers.tick(250); await tick();
 const stale = f.sockets[1];
 t.mock.timers.tick(20000); await tick();
 t.mock.timers.tick(500); await tick();
 assert.equal(f.sockets.length, 3); const successor = f.sockets[2];
 stale.open(); stale.end(); await tick();
 assert.equal(successor.readyState, 0);
 const shutdown = storage.flushAndDispose();
 t.mock.timers.tick(1000); await tick(); await shutdown;
 assert.equal(storage.isReady, false); assert.equal(f.messages.length, 2);
});

test('replacement after a silent handshake timeout restores a fresh snapshot', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = startupWire(t, { holdConnect: index => index === 1, silentClose: true });
 const storage = await f.start(); await storage.flush();
 f.sockets[0].end(); t.mock.timers.tick(250); await tick();
 f.state.revision = 2; f.state.values.pages = '["recovered after timeout"]';
 t.mock.timers.tick(20000); await tick(); t.mock.timers.tick(500); await tick(); await storage.flush();
 assert.equal(storage.isReady, true); assert.equal(f.sockets.length, 3);
 assert.equal(storage.getItem(key), '["recovered after timeout"]');
 f.sockets[1].open(); f.sockets[1].end(1008); await tick();
 assert.equal(storage.isReady, true);
});

test('RPC timeout detaches a silent socket and recovers through a new connection', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let dropRead = false;
 const f = startupWire(t, { silentClose: true, respond(message, socket) {
  if (dropRead) return;
  socket.result(message, f.state);
 } });
 const storage = await f.start(); await storage.flush();
 dropRead = true;
 f.sockets[0].onmessage({ data: JSON.stringify({ type: 'metadata-changed', revision: 2 }) }); await tick();
 t.mock.timers.tick(25000); await tick();
 assert.equal(storage.isReady, false);
 dropRead = false; f.state.revision = 2; f.state.values.pages = '["fresh after RPC timeout"]';
 t.mock.timers.tick(250); await tick(); await storage.flush();
 assert.equal(f.sockets.length, 2); assert.equal(storage.isReady, true);
 assert.equal(storage.getItem(key), '["fresh after RPC timeout"]');
 f.sockets[0].end(1008); await tick(); assert.equal(storage.isReady, true);
});

test('a write with lost ACK recovers after timeout without waiting for close', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let dropAck = true; const mutationIds: string[] = [];
 const f = startupWire(t, { silentClose: true, respond(message, socket) {
  if (message.input) {
   mutationIds.push(message.input.mutationId); f.state.revision = 2; f.state.values.pages = message.input.value;
   if (dropAck) { dropAck = false; return; }
  }
  socket.result(message, message.input ? { revision: 2, keyRevision: 2 } : f.state);
 } });
 const storage = await f.start(); await storage.flush();
 storage.setItem(key, '["committed"]'); await tick();
 t.mock.timers.tick(25000); await tick(); assert.equal(storage.isReady, false);
 t.mock.timers.tick(250); await tick(); await storage.flush();
 assert.equal(storage.isReady, true); assert.equal(f.sockets.length, 2);
 assert.equal(mutationIds.length, 2); assert.equal(new Set(mutationIds).size, 1);
});
