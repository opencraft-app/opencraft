import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { RemoteBrowserService } from '../scripts/remote-browser-service.mjs';

// Replace only Electron process transport. Real admission-scoped service, WS,
// persistence and reconnect behavior are exercised against a deterministic page.
class FixtureService extends RemoteBrowserService {
  constructor(options) { super({ ...options, ownerConnector: null }); }
  commands = []; physical = new Map(); pendingNavigation = false;
  async start() { await this.load(); }
  async request(id, method, input, control, document) {
    this.commands.push({ id, method, input, control, document });
    let p = this.physical.get(id);
    if (method === 'create') {
      if (!p) this.physical.set(id, p = { width: 1280, height: 720, deviceProfile: 'desktop', url: 'about:blank', memory: randomUUID() });
      Object.assign(p, input); return { ...p, navigation: { url: p.url, title: 'Fixture', isLoading: false } };
    }
    if (method === 'close') { this.physical.delete(id); return; }
    if (!p) throw Object.assign(new Error('Browser page closed'), { code: 'BROWSER_ERROR' });
    if (method === 'navigate') { if (input.url && !['https:', 'http:'].includes(new URL(input.url).protocol)) throw new Error('Unsupported browser URL'); if (!this.pendingNavigation) p.url = input.url ?? 'about:blank'; this.receive({ type: 'navigation', page: id, state: { url: p.url, title: 'Fixture', isLoading: this.pendingNavigation } }); }
    if (method === 'snapshot') return { ...p, navigation: { url: p.url, title: 'Fixture', isLoading: false } };
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'remote-tab-session-'));
  let service = new FixtureService({ root: directory, dataDirectory: directory });
  const server = createServer();
  let revoked = false;
  server.on('upgrade', (request, socket, head) => service.upgrade(request, socket, head, {
    ownerId: request.url.slice(1), authorize() { if (revoked) throw new Error('Revoked'); },
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  async function connect(owner) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/${owner}`); await once(ws, 'open');
    const pending = new Map();
    const events = [], frames = [];
    ws.on('message', (bytes, binary) => { if (binary) { frames.push(bytes); return; } const m = JSON.parse(bytes); events.push(m); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.resolve(m.value); } });
    ws.on('close', () => { for(const p of pending.values())p.reject(new Error('Connection closed')); pending.clear(); });
    const call = (method, input, control, document) => new Promise((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, input, control, document })); });
    return { ws, call, events, frames, quiet(method, input, control) { ws.send(JSON.stringify({id:randomUUID(),method,input,control})); }, async detach() { if(ws.readyState===WebSocket.CLOSED)return; ws.close(); await once(ws, 'close'); await new Promise(resolve => setImmediate(resolve)); } };
  }
  return { directory, get service() { return service; }, connect,
    revoke() { revoked = true; },
    async restart() { service.close(); await service.persistence; service = new FixtureService({ root: directory, dataDirectory: directory }); },
    async close() { service.close(); await service.persistence; await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); },
  };
}

test('detach keeps the same live page; restart restores URL/config while explicit close retires it', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), first = await f.connect('owner-a');
    assert.equal((await first.call('open', { lease, viewport: { width: 430, height: 932, deviceProfile: 'iphone' } })).resumed, false);
    await first.call('navigate', { url: 'https://example.test/actual' });
    const record = [...f.service.pages.values()][0], memory = f.service.physical.get(record.id).memory;
    await first.detach();
    assert.equal(record.controller, null); assert.equal(record.timer, undefined, 'no timer may evict a disconnected live tab');
    assert(f.service.commands.some(c => c.method === 'visible' && c.input.visible === false));
    const second = await f.connect('owner-a');
    const resumed = await second.call('open', { lease });
    assert.equal(resumed.resumed, true); assert.equal(resumed.memory, memory);
    assert.equal(f.service.commands.filter(c => c.method === 'navigate').length, 1, 'reattach must not navigate');
    await second.detach(); await f.restart();
    const third = await f.connect('owner-a'), restored = await third.call('open', { lease });
    assert.equal(restored.resumed, false); assert.equal(restored.restored, true);
    assert.notEqual(restored.memory, memory); assert.equal(restored.navigation.url, 'https://example.test/actual');
    assert.equal(restored.width, 430); assert.equal(restored.deviceProfile, 'iphone');
    await third.call('close'); await third.detach();
    assert.equal(f.service.pages.size, 0);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'remote-browser/tabs.json'), 'utf8')).pages, []);
    assert.equal((await stat(join(f.directory, 'remote-browser/tabs.json'))).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test('first unmeasured navigation gets client device identity without overriding a stored or explicit viewport', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), first = await f.connect('owner');
    assert.equal((await first.call('open', { lease, defaultDeviceProfile: 'iphone' })).deviceProfile, 'iphone');
    await first.detach(); await f.restart();
    const restored = await f.connect('owner');
    assert.equal((await restored.call('open', { lease, defaultDeviceProfile: 'desktop' })).deviceProfile, 'iphone');
    await restored.detach();
    const explicit = await f.connect('owner');
    assert.equal((await explicit.call('open', { lease, defaultDeviceProfile: 'iphone', viewport: { width: 1024, height: 768, deviceProfile: 'desktop' } })).deviceProfile, 'desktop');
    await explicit.detach();
  } finally { await f.close(); }
});

test('metadata survives restart, is owner scoped and rejects stale/unauthorized writes; lost ACK is idempotent', async () => {
  const f = await fixture();
  try {
    const a = await f.connect('owner-a'), b = await f.connect('owner-b');
    const scope = (await a.call('state')).scope;
    const mutation = { scope, key: 'tabs', value: '["a-tab"]', expectedRevision: 0, mutationId: randomUUID() };
    assert.equal((await a.call('state', mutation)).revision, 1);
    assert.equal((await a.call('state', mutation)).revision, 1);
    assert.deepEqual((await b.call('state')).values, {});
    await assert.rejects(b.call('state', {...mutation,mutationId:randomUUID()}), {code:'STATE_CONFLICT'});
    await assert.rejects(a.call('state', { ...mutation, mutationId: randomUUID() }), { code: 'STATE_CONFLICT' });
    await assert.rejects(a.call('state', { ...mutation, key: '../secret', expectedRevision: 1 }), /Invalid browser metadata/);
    await a.detach(); await b.detach(); await f.restart();
    const resumed = await f.connect('owner-a');
    assert.equal((await resumed.call('state')).values.tabs, '["a-tab"]');
    f.revoke();
    await assert.rejects(resumed.call('state', { ...mutation, expectedRevision: 1, mutationId: randomUUID() }), /closed/);
    await resumed.detach();
  } finally { await f.close(); }
});

test('another owner with the same lease gets a separate page and cannot discard its peer', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), a = await f.connect('a'), b = await f.connect('b'), duplicate = await f.connect('a');
    await a.call('open', { lease });
    await assert.rejects(duplicate.call('open', { lease }), /already attached/);
    await duplicate.call('discard', { lease: randomUUID() });
    assert.equal(f.service.pages.size, 1);
    await b.call('open', { lease }); assert.equal(f.service.pages.size, 2);
    await b.call('close'); assert.equal(f.service.pages.size, 1);
    await a.call('close'); await a.detach(); await b.detach(); await duplicate.detach();
  } finally { await f.close(); }
});

test('explicit viewer handoff keeps the live document and fences the displaced socket', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), a = await f.connect('owner'), b = await f.connect('owner');
    const original = await a.call('open', { lease });
    await a.call('navigate', { url: 'https://example.test/unsaved-document' });
    const record = [...f.service.pages.values()][0], oldSocket = record.controller;
    // Keep the displaced transport open to exercise delayed close and stale
    // requests rather than relying on the local TCP close arriving promptly.
    const close = oldSocket.close.bind(oldSocket); let transfer;
    oldSocket.close = (code, reason) => { transfer = { code, reason }; };
    const resumed = await b.call('open', { lease, takeover: true });
    assert.equal(resumed.memory, original.memory); assert.equal(resumed.resumed, true);
    assert.equal(resumed.navigation.url, 'https://example.test/unsaved-document');
    assert.equal(transfer.code, 4009);
    const count = f.service.commands.length;
    await assert.rejects(a.call('navigate', { url: 'https://example.test/stale' }), /page not opened/);
    await assert.rejects(a.call('close'), /page not opened/);
    assert.equal(f.service.commands.length, count, 'stale viewer cannot mutate or retire the winner');
    const winner = record.controller; close(4009, 'Browser viewer transferred'); await once(a.ws, 'close');
    assert.equal(record.controller, winner, 'late close cannot detach replacement');
    assert.equal(f.service.commands.filter(c => c.method === 'navigate').length, 1);
    assert.equal(f.service.commands.filter(c => c.method === 'close').length, 0);
    assert.equal(f.service.attachments.size, 0);
    await b.call('close'); await b.detach();
  } finally { await f.close(); }
});

test('concurrent takeover waits for bootstrap and a disconnected queued viewer cannot block its successor', async () => {
  const f = await fixture(); let finish;
  try {
    const lease = randomUUID(), a = await f.connect('owner'), abandoned = await f.connect('owner'), b = await f.connect('owner');
    let signal; const started = new Promise(resolve => signal = resolve), gate = new Promise(resolve => finish = resolve);
    const request = f.service.request.bind(f.service); let creates = 0;
    f.service.request = async (id, method, input) => {
      if (method === 'create' && ++creates === 1) { signal(); await gate; }
      return request(id, method, input);
    };
    const initial = a.call('open', { lease }); await started;
    const failed = abandoned.call('open', { lease, takeover: true }).catch(() => {});
    await abandoned.detach(); await failed;
    const replacement = b.call('open', { lease, takeover: true });
    finish();
    const first = await initial, next = await replacement;
    assert.equal(next.memory, first.memory); assert.equal(next.resumed, true);
    assert.equal(f.service.physical.size, 1); assert.equal(f.service.pages.size, 1);
    assert.equal(creates, 2, 'one initial bootstrap plus one ordered reconfiguration');
    assert.equal(f.service.attachments.size, 0);
    await b.call('close'); await b.detach();
  } finally { finish?.(); await f.close(); }
});

test('takeover remains scoped to the authenticated owner', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), a = await f.connect('owner-a'), b = await f.connect('owner-b');
    const first = await a.call('open', { lease }), second = await b.call('open', { lease, takeover: true });
    assert.notEqual(second.memory, first.memory); assert.equal(f.service.pages.size, 2);
    assert.equal(a.ws.readyState, WebSocket.OPEN);
    await a.call('close'); await b.call('close'); await a.detach(); await b.detach();
  } finally { await f.close(); }
});

test('corrupt state fails closed and is preserved instead of being replaced with an empty catalog', async () => {
  const f = await fixture();
  try {
    await f.service.load();
    const path = join(f.directory, 'remote-browser/tabs.json'); await writeFile(path, '{broken');
    await f.restart();
    // restart checkpoints valid state first; corrupt the new instance before its first load.
    await writeFile(path, '{broken');
    const a = await f.connect('a'); await assert.rejects(a.call('state'), /could not be read/); await a.detach();
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally { await f.close(); }
});


test('blank bootstrap checkpoints reopen without navigating an unsupported external URL', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), first = await f.connect('owner-a');
    await first.call('open', { lease });
    assert.equal([...f.service.pages.values()][0].url, null);
    await first.detach(); await f.restart();
    const second = await f.connect('owner-a');
    const restored = await second.call('open', { lease });
    assert.equal(restored.navigation.url, 'about:blank');
    assert.equal(f.service.commands.filter(c => c.method === 'navigate').length, 0);
    await second.call('navigate', { url: 'https://example.test/after-reopen' });
    assert.equal([...f.service.pages.values()][0].url, 'https://example.test/after-reopen');
    await second.call('navigate', { url: null });
    assert.equal([...f.service.pages.values()][0].url, null);
    await second.detach();
  } finally { await f.close(); }
});

test('legacy about:blank recovery records migrate on read without clearing tab identities', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), first = await f.connect('owner-a');
    await first.call('open', { lease }); await first.detach(); await f.restart();
    const path = join(f.directory, 'remote-browser/tabs.json');
    const saved = JSON.parse(await readFile(path, 'utf8')); saved.pages[0].url = 'about:blank';
    await writeFile(path, JSON.stringify(saved));
    const second = await f.connect('owner-a');
    const restored = await second.call('open', { lease });
    assert.equal(restored.restored, true); assert.equal(restored.navigation.url, 'about:blank');
    assert.equal(f.service.pages.size, 1); assert.equal([...f.service.pages.values()][0].url, null);
    assert.equal(f.service.commands.filter(c => c.method === 'navigate').length, 0);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pages[0].id, saved.pages[0].id);
    await assert.rejects(second.call('navigate', { url: 'file:///tmp/private' }), /Unsupported browser URL/);
    await second.call('navigate', { url: 'https://example.test/recovered' }); await second.detach();
  } finally { await f.close(); }
});


test('recovery keeps the saved remote target before navigation commits, then follows native redirects', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), first = await f.connect('owner-a');
    await first.call('open', { lease });
    await first.call('navigate', { url: 'https://example.test/remote-authority' });
    await first.detach(); await f.restart();
    f.service.pendingNavigation = true;
    const second = await f.connect('owner-a');
    const restored = await second.call('open', { lease });
    assert.equal(restored.restored, true);
    assert.equal(restored.navigation.url, 'https://example.test/remote-authority');
    assert.equal(restored.navigation.isLoading, true);
    await f.service.persistence;
    let saved = JSON.parse(await readFile(join(f.directory, 'remote-browser/tabs.json'), 'utf8'));
    assert.equal(saved.pages[0].url, 'https://example.test/remote-authority');
    const record = [...f.service.pages.values()][0];
    f.service.receive({ type: 'navigation', page: record.id, state: { url: 'https://example.test/redirected', isLoading: false } });
    assert.equal(record.url, 'https://example.test/redirected');
    await second.detach();
  } finally { await f.close(); }
});

test('accepted close completes after the viewer disconnects before native acknowledgement', async () => {
  const f = await fixture(); let finish;
  try {
    const first = await f.connect('owner'), lease = randomUUID(); await first.call('open', { lease });
    let signal; const started = new Promise(resolve => signal = resolve), gate = new Promise(resolve => finish = resolve);
    const request = f.service.request.bind(f.service);
    f.service.request = async (id, method, input) => { if (method === 'close') { signal(); await gate; } return request(id, method, input); };
    const closed = first.call('close').catch(() => {}); await started; await first.detach(); finish(); await closed;
    for (let i=0;i<100 && f.service.physical.size;i++) await new Promise(resolve=>setTimeout(resolve,5));
    await new Promise(resolve=>setImmediate(resolve)); await f.service.persistence;
    assert.equal(f.service.physical.size, 0, 'native page destroyed');
    assert.equal(f.service.pages.size, 0, 'closed page must stop occupying quota after detach');
    assert.deepEqual(JSON.parse(await readFile(join(f.directory,'remote-browser/tabs.json'),'utf8')).pages,[]);
    await f.restart(); const next = await f.connect('owner');
    await assert.rejects(next.call('open',{lease}), /closed/);
    assert.equal((await next.call('open',{lease:randomUUID()})).restored,false); await next.call('close'); await next.detach();
  } finally { finish?.(); await f.close(); }
});

test('discard waits for an in-flight create and cannot leave an orphan native page', async () => {
  const f=await fixture();let finish;
  try {
    const first=await f.connect('owner'), control=await f.connect('owner'), lease=randomUUID();
    let signal;const started=new Promise(resolve=>signal=resolve),gate=new Promise(resolve=>finish=resolve);
    const request=f.service.request.bind(f.service);
    f.service.request=async(id,method,input)=>{if(method==='create'){signal();await gate;}return request(id,method,input)};
    const opening=first.call('open',{lease}).catch(()=>{});await started;
    const discarding=control.call('discard',{lease});await new Promise(resolve=>setTimeout(resolve,15));finish();await discarding;await opening;
    await f.service.persistence;
    assert.equal(f.service.pages.size,0);assert.equal(f.service.physical.size,0,'created native page must be retired before discard acknowledges');
    assert.deepEqual(JSON.parse(await readFile(join(f.directory,'remote-browser/tabs.json'),'utf8')).pages,[]);
    await first.detach();await control.detach();
  }finally{finish?.();await f.close()}
});

const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Lifecycle work did not finish');
};

test('accepted mapping removal retires only that lease without a viewer close request', async () => {
  const f = await fixture();
  try {
    const a = await f.connect('owner'), b = await f.connect('other'), state = await f.connect('owner');
    const keep = 'browser-' + randomUUID(), drop = 'browser-' + randomUUID();
    await a.call('open', { lease: keep }); await b.call('open', { lease: drop });
    const viewer = await f.connect('owner'); await viewer.call('open', { lease: drop }); await viewer.detach();
    const scope = (await state.call('state')).scope;
    const write = (value, revision) => state.call('state', { scope, key: 'storage', value: JSON.stringify(value), expectedRevision: revision, mutationId: randomUUID() });
    await write({ keep, drop }, 0); await write({ keep }, 1);
    await until(() => f.service.pages.size === 2); await f.service.persistence;
    assert.equal(f.service.physical.size, 2, 'keep and other-owner tabs survive');
    assert.equal([...f.service.pages.values()].filter(p => p.ownerId === 'owner').length, 1);
    await assert.rejects(state.call('open', { lease: drop }), /closed/);
    await a.detach(); await b.detach(); await state.detach();
  } finally { await f.close(); }
});

test('closure before native startup completes fences late creation, including after restart', async () => {
  const f = await fixture(); let release;
  try {
    const viewer = await f.connect('owner'), control = await f.connect('owner'), lease = randomUUID();
    let entered; const started = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
    f.service.start = async () => { entered(); await gate; };
    const opening = viewer.call('open', { lease }).catch(error => error); await started;
    await control.call('discard', { lease }); release();
    assert.match((await opening).message, /closed/);
    assert.equal(f.service.physical.size, 0); assert.equal(f.service.pages.size, 0);
    await viewer.detach(); await control.detach(); await f.restart();
    const next = await f.connect('owner'); await assert.rejects(next.call('open', { lease }), /closed/); await next.detach();
  } finally { release?.(); await f.close(); }
});

test('failed native destruction remains durably closing and resumes after a server restart', async () => {
  const f = await fixture();
  try {
    const viewer = await f.connect('owner'), lease = randomUUID(); await viewer.call('open', { lease });
    const request = f.service.request.bind(f.service);
    f.service.request = async (id, method, input) => { if (method === 'close') throw new Error('temporary native failure'); return request(id, method, input); };
    await assert.rejects(viewer.call('close'), /temporary/);
    const saved = JSON.parse(await readFile(join(f.directory, 'remote-browser/tabs.json'), 'utf8'));
    assert.equal(saved.pages[0].closing, true);
    await viewer.detach();
    const reconnect = await f.connect('owner'); await assert.rejects(reconnect.call('open', { lease }), /closed/);
    await reconnect.detach(); await viewer.detach(); await f.restart();
    const state = await f.connect('owner'); await state.call('state');
    await until(() => f.service.pages.size === 0); await f.service.persistence;
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'remote-browser/tabs.json'), 'utf8')).pages, []);
    await state.detach();
  } finally { await f.close(); }
});

test('missing or malformed historical mappings never trigger a sweep of unwatched tabs', async () => {
  const f = await fixture();
  try {
    const viewer = await f.connect('owner'), state = await f.connect('owner'); await viewer.call('open', { lease: randomUUID() }); await viewer.detach();
    const scope = (await state.call('state')).scope;
    for (const [revision, value] of ['{}', '[]', '{}'].entries()) {
      await state.call('state', { scope, key: 'storage', value, expectedRevision: revision, mutationId: randomUUID() });
    }
    assert.equal(f.service.physical.size, 1); assert.equal(f.service.pages.size, 1);
    await state.detach();
  } finally { await f.close(); }
});


const settle = () => new Promise(resolve => setTimeout(resolve, 20));
test('modern viewers share one document/stream, keep viewport authority and aggregate visibility', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), a = await f.connect('owner'), b = await f.connect('owner');
    const first = await a.call('open', { lease, multiView:true, initialUrl:'https://example.test/unsaved', viewport:{width:390,height:640} });
    assert.equal(first.control.controller,false); assert.equal(first.initialized,true);
    a.quiet('visible',{visible:true}); await settle();
    const page = [...f.service.pages.values()][0];
    const second = await b.call('open',{lease,multiView:true,initialUrl:'https://example.test/stale',viewport:{width:1200,height:800}});
    assert.equal(second.memory,first.memory); assert.equal(second.width,390); assert.equal(second.navigation.url,'https://example.test/unsaved');
    assert.equal(f.service.commands.filter(c=>c.method==='create').length,1);
    assert.equal(f.service.commands.filter(c=>c.method==='navigate').length,1);
    assert.equal(page.controller,null);
    b.quiet('visible',{visible:true}); await settle();
    f.service.receive({type:'frame',page:page.id,bytes:Buffer.from([1,2,3]).toString('base64')}); await settle();
    assert.equal(a.frames.length,1); assert.equal(b.frames.length,1);
    const state=await a.call('control',{action:'human',takeover:true}); assert(state.token);
    await assert.rejects(b.call('viewport',{width:1200,height:800},state.token),{code:'CONTROL_LOST'});
    const before=f.service.commands.filter(c=>c.method==='visible'&&!c.input.visible).length;
    await a.detach(); await settle();
    assert.equal(page.controller,null); assert.equal(f.service.viewers(page).size,1); assert.equal(page.painted,true);
    assert.equal(f.service.commands.filter(c=>c.method==='visible'&&!c.input.visible).length,before);
    f.service.receive({type:'frame',page:page.id,bytes:Buffer.from([0,4,5]).toString('base64')}); await settle(); assert.equal(b.frames.length,2);
    await b.detach(); await settle(); assert.equal(page.painted,false); assert.equal(f.service.physical.size,1);
  } finally { await f.close(); }
});

test('control generations fence writes, Agent never preempts a human, and only controller receives private events', async () => {
  const f=await fixture();
  try {
    const lease=randomUUID(),a=await f.connect('owner'),b=await f.connect('owner');
    await a.call('open',{lease,multiView:true,visible:true}); await b.call('open',{lease,multiView:true,visible:true});
    const page=[...f.service.pages.values()][0],one=await a.call('control',{action:'human',takeover:true});
    await assert.rejects(b.call('control',{action:'agent'}),{code:'CONTROL_BUSY'});
    assert.equal(await b.call('automation',{method:'inspect'}),undefined); assert.equal(page.controlToken,one.token);
    const two=await b.call('control',{action:'human',takeover:true}); assert(two.epoch>one.epoch); assert.notEqual(two.token,one.token);
    await assert.rejects(a.call('navigate',{url:'https://example.test/stale'},one.token),{code:'CONTROL_LOST'});
    await a.call('control',{action:'release',token:one.token}); assert.equal(page.controlToken,two.token,'late release cannot revoke new controller');
    f.service.receive({type:'ime-state',page:page.id,editable:true,editor:'private-editor'}); await settle();
    assert.equal(a.events.filter(e=>e.type==='ime-state').length,0); assert.equal(b.events.filter(e=>e.type==='ime-state').length,1);
    assert(a.events.some(e=>e.type==='control'&&e.active&&!e.controller&&!e.token));
    await b.call('control',{action:'release',token:two.token});
    const agent=await a.call('control',{action:'agent'}); assert.equal(agent.kind,'agent');
    await assert.rejects(b.call('control',{action:'agent'}),{code:'CONTROL_BUSY'});
    await a.call('automation',{method:'fill',input:{value:'你好'}},agent.token);
    await a.call('control',{action:'release',token:agent.token}); assert.equal(page.controller,null);
    const old=await f.connect('owner'); await assert.rejects(old.call('open',{lease,takeover:true}),/reload OpenCraft/); await old.detach();
    const peerClosed=once(b.ws,'close'); await a.call('close'); assert.equal((await peerClosed)[0],1000);
    assert.equal(f.service.physical.size,0); assert.equal(f.service.pages.size,0);
  } finally { await f.close(); }
});

test('native renderer loss retires only that physical page and all its viewers recover the saved Tab', async () => {
  const f = await fixture();
  try {
    const lease = randomUUID(), a = await f.connect('owner'), b = await f.connect('owner'), other = await f.connect('owner');
    await a.call('open', {lease, multiView:true, visible:true, initialUrl:'https://example.test/kept'});
    await b.call('open', {lease, multiView:true, visible:true});
    await other.call('open', {lease:randomUUID(),multiView:true,visible:true});
    const p=[...f.service.pages.values()].find(p=>p.url==='https://example.test/kept'), old=f.service.physical.get(p.id).memory;
    const closes=[once(a.ws,'close',{signal:AbortSignal.timeout(1500)}),once(b.ws,'close',{signal:AbortSignal.timeout(1500)})];
    const rejected=new Promise((resolve,reject)=>f.service.requests.set('dead-request',{page:p.id,timer:setTimeout(()=>reject(Error('request was not retired')),1500),reject:resolve}));
    f.service.physical.delete(p.id); // the worker destroys the crashed WebContents before this event
    f.service.receive({type:'renderer-gone',page:p.id,reason:'crashed',exitCode:139});
    assert.equal((await rejected).code,'BROWSER_UNAVAILABLE');
    assert.deepEqual((await Promise.all(closes)).map(x=>x[0]),[1011,1011]);
    assert.equal(other.ws.readyState,WebSocket.OPEN);assert.equal(p.live,false);assert.equal(p.controller,null);
    const next=await f.connect('owner'), recovered=await next.call('open',{lease,multiView:true,visible:true,initialUrl:'https://example.test/stale'});
    assert.equal(recovered.restored,true);assert.equal(recovered.resumed,false);assert.equal(recovered.navigation.url,'https://example.test/kept');
    assert.notEqual(recovered.memory,old);assert.equal(recovered.control.active,false);
    await next.call('close');await next.detach();await other.detach();
  } finally {await f.close();}
});

test('native request pressure is a transient transport close; malformed binary traffic remains terminal', async () => {
  const f=await fixture();let release;
  try {
    const a=await f.connect('owner');await a.call('open',{lease:randomUUID()});
    const request=f.service.request.bind(f.service), gate=new Promise(r=>release=r);
    f.service.request=(id,method,...args)=>method==='input'?gate:request(id,method,...args);
    const closed=once(a.ws,'close',{signal:AbortSignal.timeout(2000)});
    for(let x=0;x<140;x++)a.quiet('input',{type:'mouseMove',x,y:1});
    const [code,reason]=await closed;assert.equal(code,1013);assert.equal(reason.toString(),'Browser input backlog; reconnecting');
    assert.equal(f.service.pages.size,1,'backpressure cannot discard the logical Tab');release();
    const malformed=await f.connect('owner');const badClose=once(malformed.ws,'close');malformed.ws.send(Buffer.from([0]));
    assert.equal((await badClose)[0],1008);
  } finally {release?.();await f.close();}
});

test('input acknowledgements are negotiated per viewer and follow native dispatch rather than arrival', async () => {
  const f = await fixture(); let release;
  try {
    const a = await f.connect('owner'), b = await f.connect('owner');
    const opened = await a.call('open', { lease: randomUUID(), multiView: true, visible: true, inputAcknowledgements: true });
    assert.equal(opened.inputAcknowledgements, true);
    const grant = await a.call('control', { action: 'human', takeover: true });
    const request = f.service.request.bind(f.service), gate = new Promise(resolve => { release = resolve; });
    f.service.request = (id, method, ...args) => method === 'input' ? gate : request(id, method, ...args);
    let acknowledged = false;
    const input = a.call('input', { type: 'mouseWheel', deltaY: -10 }, grant.token).then(() => { acknowledged = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(acknowledged, false);
    release(); await input; assert.equal(acknowledged, true);
    await assert.rejects(a.call('input', { type: 'mouseMove' }, 'stale-token'), { code: 'CONTROL_LOST' });
    const legacy = await b.call('open', { lease: randomUUID(), multiView: true, visible: true });
    assert.equal(legacy.inputAcknowledgements, false);
    const legacyGrant = await b.call('control', { action: 'human', takeover: true });
    const results = b.events.filter(x => x.type === 'result').length;
    b.quiet('input', { type: 'mouseMove' }, legacyGrant.token);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(b.events.filter(x => x.type === 'result').length, results);
    await a.detach(); await b.detach();
  } finally { release?.(); await f.close(); }
});

test('hiding invalidates an in-flight human grant, even after reveal; invisible Agent still works', async () => {
  for(const reveal of [false,true]) {
    const f=await fixture();let release,entered;
    const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
    try {
      const a=await f.connect('owner'),b=await f.connect('owner'),lease=randomUUID();
      await a.call('open',{lease,multiView:true,visible:true});await b.call('open',{lease,multiView:true,visible:true});
      const original=f.service.request.bind(f.service);let held=false;
      f.service.request=async(...args)=>{if(args[1]==='control'&&args[2].token&&!held){held=true;entered();await gate}return original(...args)};
      const failed=assert.rejects(a.call('control',{action:'human',takeover:true}),{code:'CONTROL_LOST'});await started;
      a.quiet('visible',{visible:false});
      const p=[...f.service.pages.values()][0];
      while([...f.service.viewers(p).values()].every(v=>v.visible))await new Promise(r=>setImmediate(r));
      if(reveal){a.quiet('visible',{visible:true});while([...f.service.viewers(p).values()].some(v=>!v.visible))await new Promise(r=>setImmediate(r));}
      release();await failed;assert.equal(p.controller,null);
      b.quiet('visible',{visible:false});while([...f.service.viewers(p).values()].every(v=>v.visible))await new Promise(r=>setImmediate(r));
      const agent=await b.call('control',{action:'agent'});assert.equal(agent.kind,'agent');assert.equal(agent.controller,true);
      await a.detach();await b.detach();
    }finally{release?.();await f.close()}
  }
});

test('document-aware peers cannot send missing or old document input; legacy admission still captures identity', async () => {
  const f=await fixture();
  try{
    const request=f.service.request.bind(f.service),document=randomUUID(),lease=randomUUID();
    f.service.request=async(...args)=>{const result=await request(...args);return ['create','snapshot'].includes(args[1])?{...result,document}:result};
    const a=await f.connect('owner');await a.call('open',{lease,multiView:true,visible:true,documentInput:true,inputAcknowledgements:true});
    const grant=await a.call('control',{action:'human',takeover:true});
    await assert.rejects(a.call('input',{type:'char',keyCode:'x'},grant.token),{code:'DOCUMENT_CHANGED'});
    const p=[...f.service.pages.values()][0];assert.equal(p.document,document);
    assert(!f.service.commands.some(c=>c.method==='input'));
    await assert.rejects(a.call('input',{type:'char',keyCode:'x'},grant.token,randomUUID()),{code:'DOCUMENT_CHANGED'});
    await a.call('input',{type:'char',keyCode:'x'},grant.token,document);
    assert.equal(f.service.commands.at(-1).document,document);
    const replacement=randomUUID();f.service.receive({type:'input-reset',page:p.id,document:replacement});
    await assert.rejects(a.call('input',{type:'char',keyCode:'y'},grant.token,document),{code:'DOCUMENT_CHANGED'});
    const modernInputs=f.service.commands.filter(c=>c.method==='input').length;
    assert.equal(modernInputs,1,'stale and missing input never reaches native transport');
    await a.call('control',{action:'release',token:grant.token});
    const legacy=await f.connect('owner');await legacy.call('open',{lease,multiView:true,visible:true,inputAcknowledgements:true});
    const legacyGrant=await legacy.call('control',{action:'human',takeover:true});
    await legacy.call('input',{type:'char',keyCode:'z'},legacyGrant.token);
    assert.equal(f.service.commands.at(-1).document,replacement,'legacy identity is captured at service admission');
    await legacy.detach();await a.detach();
  }finally{await f.close()}
});

test('file-backed reservations serialize 15 + 2 concurrent account opens', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 15; i++) { const c = await f.connect('owner'); await c.call('open', { lease: randomUUID() }); await c.detach(); }
    const a = await f.connect('owner'), b = await f.connect('owner');
    const results = await Promise.allSettled([a.call('open', { lease: randomUUID() }), b.call('open', { lease: randomUUID() })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'ACCOUNT_CAPACITY');
    assert.equal(f.service.physical.size, 16);
    assert.equal((await a.call('catalog')).capacity.accountUsed, 16);
    await a.detach(); await b.detach();
  } finally { await f.close(); }
});

test('committed catalog survives failed create without phantom live occupancy or lost ownership', async () => {
  const f = await fixture(); let finish;
  try {
    const a = await f.connect('owner-a'), b = await f.connect('owner-b');
    let started; const waiting = new Promise(r => started = r), gate = new Promise(r => finish = r);
    const request = f.service.request.bind(f.service); let badId;
    f.service.request = async (id, method, ...rest) => {
      if (method === 'create' && !badId) { badId = id; started(); await gate; throw new Error('Native initialization failed'); }
      return request(id, method, ...rest);
    };
    const lease = randomUUID(), failed = a.call('open', { lease }).catch(e => e); await waiting;
    const starting = await a.call('catalog');
    assert.equal(starting.sessions[0].runtime, 'starting'); assert.equal(starting.sessions[0].link, null);
    await b.call('open', { lease: randomUUID() });
    const before = JSON.parse(await readFile(join(f.directory, 'remote-browser/tabs.json'), 'utf8'));
    assert.equal(before.pages.find(p => p.ownerId === 'owner-a').runtime.kind, 'starting');
    finish(); assert.match((await failed).message, /initialization failed/);
    const committed = JSON.parse(await readFile(join(f.directory, 'remote-browser/tabs.json'), 'utf8'));
    assert.equal(committed.pages.find(p => p.ownerId === 'owner-a').runtime.kind, 'absent');
    assert.equal((await a.call('catalog')).capacity.accountUsed, 0);
    assert.equal((await b.call('catalog')).sessions.length, 1, 'account isolation');
    await a.detach(); await b.detach(); await f.restart();
    const restored = await f.connect('owner-a');
    assert.equal((await restored.call('catalog')).sessions[0].lease, lease);
    await restored.call('discard', { lease });
    assert.equal((await restored.call('catalog')).sessions.length, 0);
    await assert.rejects(restored.call('open', { lease }), /closed/);
    await restored.detach();
  } finally { finish?.(); await f.close(); }
});

test('missing committed metadata cannot create native pages; per-key CAS and retained receipts survive intervening writes/restart', async () => {
  const f = await fixture();
  try {
    const c = await f.connect('owner'), { scope } = await c.call('state');
    await assert.rejects(c.call('open', { lease: randomUUID(), metadataRequired: true }), { code: 'STATE_CONFLICT' });
    assert.equal(f.service.physical.size, 0); assert.equal((await c.call('catalog')).sessions.length, 0);
    const first = { scope, key: 'tabs', value: '[]', expectedKeyRevision: 0, mutationId: randomUUID() };
    assert.equal((await c.call('state', first)).keyRevision, 1);
    await c.call('state', { scope, key: 'bindings', value: '[]', expectedKeyRevision: 0, mutationId: randomUUID() });
    assert.equal((await c.call('state', first)).revision, 1);
    await assert.rejects(c.call('state', { ...first, value: '[1]' }), { code: 'OPERATION_CONFLICT' });
    await c.detach(); await f.restart();
    const next = await f.connect('owner'); assert.equal((await next.call('state', first)).revision, 1); await next.detach();
  } finally { await f.close(); }
});

test('unknown create keeps its slot until a positive native snapshot, without replaying create', async () => {
  const f = await fixture();
  try {
    const request = f.service.request.bind(f.service); let fail = true;
    f.service.request = async (id, method, ...args) => {
      const value = await request(id, method, ...args);
      if (method === 'create' && fail) { fail = false; throw Object.assign(new Error('Lost ACK'), { code: 'BROWSER_UNAVAILABLE' }); }
      return value;
    };
    const c = await f.connect('owner'), lease = randomUUID();
    await assert.rejects(c.call('open', { lease }), { code: 'BROWSER_UNAVAILABLE' });
    const unknown = await c.call('catalog'); assert.equal(unknown.sessions[0].runtime, 'unknown'); assert.equal(unknown.capacity.accountUsed, 1);
    assert.equal((await c.call('open', { lease, multiView: true })).resumed, true);
    assert.equal(f.service.commands.filter(c => c.method === 'create').length, 1);
    await c.detach();
  } finally { await f.close(); }
});

test('failed file draft and rejected physical epoch never leak into a later committed snapshot', async () => {
  const f = await fixture();
  try {
    await f.service.load();
    await assert.rejects(f.service.commit(draft => { draft.pages.push({ id: 'uncommitted' }); throw Error('Abort draft'); }), /Abort draft/);
    const c = await f.connect('owner'); await c.call('open', { lease: randomUUID() });
    const saved = JSON.parse(await readFile(join(f.directory, 'remote-browser/tabs.json'), 'utf8'));
    assert.equal(saved.pages.length, 1); assert.notEqual(saved.pages[0].id, 'uncommitted');
    const page = [...f.service.pages.values()][0], epoch = page.runtimeEpoch ?? 0;
    f.service.resetVisibility(page); await f.service.runtimeState(page, 'unknown');
    await f.service.runtimeState(page, 'live', epoch);
    assert.equal((await c.call('catalog')).sessions[0].runtime, 'unknown');
    await c.detach();
  } finally { await f.close(); }
});

test('complete metadata registers a dormant logical session in the same commit without starting native', async () => {
  const f = await fixture();
  try {
    const c = await f.connect('owner'), { scope } = await c.call('state'), lease = 'browser-' + randomUUID();
    const values = { pages: JSON.stringify([{ id: 'page-a', ownerId: 'scope-a', entries: [{url:'https://example.test/saved'}], index:0 }]),
      tabs: JSON.stringify([{ id: 'tab-a', pageId: 'page-a', ownerId: 'scope-a' }]), storage: JSON.stringify({ 'page-a': lease }) };
    for (const [key, value] of Object.entries(values)) await c.call('state', { scope, key, value, expectedKeyRevision: 0, mutationId: randomUUID() });
    const catalog = await c.call('catalog');
    assert.equal(catalog.sessions.length, 1); assert.equal(catalog.sessions[0].runtime, 'absent'); assert.equal(catalog.capacity.accountUsed, 0);
    assert.equal(catalog.sessions[0].link.pageId, 'page-a'); assert.equal(f.service.commands.length, 0);
    await c.detach();
  } finally { await f.close(); }
});
