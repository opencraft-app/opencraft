import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
import { BrowserOwnerEvents } from '../../scripts/browser-owner-events.mjs';
import { startBrowserOwnerPool } from '../../scripts/remote-browser-owner-pool.mjs';
import { connectBrowserOwner } from '../../scripts/remote-browser-owner.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'browser-owner-pool-'));
  const dataDirectory = join(root, 'remote-browser'), directory = join(root, 'candidate');
  await mkdir(dataDirectory); await mkdir(join(directory, 'electron'), { recursive: true });
  for (const entry of ['worker.cjs', 'owner.cjs', 'electron/electron']) await writeFile(join(directory, entry), 'fixture');
  await chmod(join(directory, 'electron/electron'), 0o700);
  const natives = new Map(), pools = [], stops = [], calls = [];
  let detachBlock = () => null;
  let version = 'A', pid = 100, block = () => null, loseAck = () => false, attachFailure = () => false;
  async function connector({ dataDirectory }) {
    if (attachFailure(dataDirectory)) throw Error('owner temporarily unavailable');
    let native = natives.get(dataDirectory);
    if (!native || !native.pages.size) {
      if (!native || native.version !== version) native = { version, pid: ++pid, pages: new Map() };
      natives.set(dataDirectory, native);
    }
    const peer = new EventEmitter(); peer.connected = true; peer.workerPid = native.pid;
    peer.runtimeCurrent = native.version === version; peer.inventory = structuredClone([...native.pages.values()]);
    native.peer = peer;
    peer.kill = () => {
      if (!peer.closed) {
        peer.connected = false;
        peer.closed = Promise.resolve().then(() => detachBlock(peer));
        peer.emit('exit');
      }
      return peer.closed;
    };
    peer.send = (message, callback) => {
      calls.push({ ...message, version: native.version }); callback?.(null);
      void (async () => {
        await block(message);
        let value;
        if (message.method === 'inventory') value = structuredClone([...native.pages.values()]);
        else if (message.method === 'create') {
          value = native.pages.get(message.page) ?? { id: message.page, version: native.version, heap: randomUUID() };
          native.pages.set(message.page, value);
        } else if (message.method === 'close') native.pages.delete(message.page);
        else { value = native.pages.get(message.page); if (message.method === 'text') value.text = message.input.text; }
        if (loseAck(message)) { peer.kill(); return; }
        if (peer.connected) peer.emit('message', { type: 'result', id: message.id, value: structuredClone(value) });
      })().catch(error => peer.emit('message', { type: 'result', id: message.id, error: { message: error.message } }));
    };
    return peer;
  }
  const options = { dataDirectory, directory, connector, stop: async path => { stops.push(path); natives.get(path)?.peer.kill(); natives.delete(path); } };
  async function open(allocateGenerations) {
    const pool = await startBrowserOwnerPool({ ...options, allocateGenerations });
    pool.on('error', () => {}); pool.on('exit', () => {}); pool.on('owner-slot-failure', () => {});
    const pending = new Map();
    pool.on('message', message => {
      if (message.type !== 'result') return;
      const job = pending.get(message.id); if (!job) return; pending.delete(message.id);
      message.error ? job.reject(Object.assign(new Error(message.error.message), message.error)) : job.resolve(message.value);
    });
    const request = (page, method, input) => new Promise((resolve, reject) => {
      const id = randomUUID(); pending.set(id, { resolve, reject });
      pool.send({ id, page, method, input }, error => { if (error) { pending.delete(id); reject(error); } });
    });
    pools.push(pool); return { pool, request };
  }
  t.after(async () => { for (const pool of pools) await pool.kill(); await rm(root, { recursive: true, force: true }); });
  return { open, options, natives, calls, stops, dataDirectory, root, setVersion: value => { version = value; },
    blockDetach: value => { detachBlock = value; },
    attachFailure: value => { attachFailure = value; }, block: value => { block = value; }, loseAck: value => { loseAck = value; },
    manifest: async () => JSON.parse(await readFile(join(dataDirectory, 'owner-pool.json'), 'utf8')) };
}

test('phase-one with no manifest retains the original single-owner contract and creates no manifest', async t => {
  const f = await fixture(t), { pool } = await f.open(false);
  assert.equal(pool.runtimeCurrent, true); assert.equal(pool.releasePage, undefined);
  await assert.rejects(readFile(join(f.dataDirectory, 'owner-pool.json')), { code: 'ENOENT' });
});

test('new pages use B while A keeps heap; the compatible rollback reader routes both placements', async t => {
  const f = await fixture(t), first = await f.open();
  const old = await first.request('old', 'create'); await first.request('old', 'text', { text: '中文未提交' });
  await first.pool.kill(); f.setVersion('B');
  const second = await f.open(), fresh = await second.request('new', 'create');
  assert.equal(fresh.version, 'B'); assert.equal((await second.request('old', 'snapshot')).heap, old.heap);
  assert.equal((await second.request('old', 'snapshot')).text, '中文未提交');
  await second.pool.kill();
  const rollback = await f.open(false);
  assert.equal((await rollback.request('old', 'snapshot')).heap, old.heap);
  assert.equal((await rollback.request('new', 'snapshot')).version, 'B');
  assert.equal((await rollback.request('after-rollback', 'create')).version, 'B');
  assert.equal((await rollback.request(undefined, 'inventory')).length, 3);
});

test('explicit retirement removes only its placement and reclaims empty draining owners; recovery close keeps placement', async t => {
  const f = await fixture(t), first = await f.open(); await first.request('old', 'create');
  await first.pool.kill(); f.setVersion('B'); const second = await f.open();
  const fresh = await second.request('new', 'create');
  await second.request('old', 'close');
  assert.equal((await f.manifest()).placements.some(([id]) => id === 'old'), true);
  assert.equal((await second.request('old', 'create')).version, 'A', 'recovery never migrates an old page to B');
  await assert.rejects(second.pool.releasePage('old'));
  await second.request('old', 'close'); await second.pool.releasePage('old');
  assert.equal(f.stops.length, 1); assert.equal((await f.manifest()).slots.length, 1);
  assert.equal((await second.request('new', 'snapshot')).heap, fresh.heap);
  assert.equal((await f.manifest()).placements.some(([id]) => id === 'old'), false);
});

test('generation capacity never evicts live pages and becomes available when an older page closes', async t => {
  const f = await fixture(t); let current;
  for (const version of ['A', 'B', 'C']) {
    await current?.pool.kill(); f.setVersion(version); current = await f.open();
    assert.equal((await current.request(version, 'create')).version, version);
  }
  await current.pool.kill(); f.setVersion('D'); current = await f.open();
  await assert.rejects(current.request('D', 'create'), error => error.retryable === true);
  assert.equal((await current.request(undefined, 'inventory')).length, 3);
  await current.request('A', 'close'); await current.pool.releasePage('A');
  assert.equal((await current.request('D', 'create')).version, 'D');
  assert.equal((await f.manifest()).slots.length, 3);
});

test('unknown create or close outcomes retain their exact placement and never replay an accepted write', async t => {
  const f = await fixture(t), first = await f.open();
  f.loseAck(message => message.method === 'create');
  await assert.rejects(first.request('uncertain', 'create'));
  const before = await f.manifest(); assert.equal(before.placements.length, 1);
  f.loseAck(() => false);
  const native = await first.request('uncertain', 'snapshot');
  assert.equal(native.version, 'A'); assert.equal(f.calls.filter(m => m.method === 'create').length, 1);
  f.loseAck(message => message.method === 'close'); await assert.rejects(first.request('uncertain', 'close'));
  assert.deepEqual((await f.manifest()).placements, before.placements);
  f.loseAck(() => false); await first.request('uncertain', 'close'); await first.pool.releasePage('uncertain');
  assert.equal((await f.manifest()).placements.length, 0);
});

test('one crashed slot invalidates only its pages and another owner remains usable', async t => {
  const f = await fixture(t), first = await f.open(); await first.request('old', 'create');
  await first.pool.kill(); f.setVersion('B'); const second = await f.open();
  const fresh = await second.request('new', 'create'), failures = [];
  second.pool.on('owner-slot-failure', value => failures.push(value.pages));
  f.natives.get(f.dataDirectory).peer.kill();
  assert.deepEqual(failures, [['old']]); assert.equal(second.pool.connected, true);
  assert.equal((await second.request('new', 'snapshot')).heap, fresh.heap);
  assert.equal((await second.request('old', 'snapshot')).version, 'A');
});

test('blocked reads leave native edit credit available and cannot exceed its peer inflight limit', async t => {
  const f = await fixture(t), { pool, request } = await f.open(); await request('tab', 'create');
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  f.block(m => m.method === 'automation' ? gate : null);
  const waits = Array.from({ length: 150 }, () => request('tab', 'automation'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.filter(m => m.method === 'automation').length, 16);
  assert.equal((await request('tab', 'text', { text: 'future input completes wait' })).text, 'future input completes wait');
  unblock(); await Promise.all(waits); await pool.kill();
});

test('bounded queue overflow retires the affected input transport rather than dropping a gesture end', async t => {
  const f = await fixture(t), { pool, request } = await f.open(); await request('tab', 'create');
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  f.block(m => m.method === 'input' ? gate : null);
  const failures = []; pool.on('owner-slot-failure', value => failures.push(value.pages));
  const jobs = Array.from({ length: 1025 }, () => request('tab', 'input', { type: 'touchMove' }).catch(error => error));
  const outcomes = await Promise.all(jobs);
  assert.ok(outcomes.every(value => value instanceof Error)); assert.deepEqual(failures, [['tab']]);
  assert.ok(f.calls.filter(m => m.method === 'input').length <= 64);
  unblock();
});

test('unknown schema, duplicate placements, unsafe paths and a competing writer fail closed', async t => {
  const f = await fixture(t), first = await f.open(); await first.request('tab', 'create');
  await assert.rejects(f.open(), error => error.code === 'BROWSER_UNAVAILABLE');
  await first.pool.kill(); const valid = await f.manifest();
  for (const invalid of [{ ...valid, schemaVersion: 2 }, { ...valid, slots: ['../outside'] },
    { ...valid, placements: [...valid.placements, ...valid.placements] }]) {
    await writeFile(join(f.dataDirectory, 'owner-pool.json'), JSON.stringify(invalid));
    await assert.rejects(f.open(false));
  }
  await writeFile(join(f.dataDirectory, 'owner-pool.json'), JSON.stringify(valid));
  assert.equal((await (await f.open(false)).request('tab', 'snapshot')).version, 'A');
});

test('native events in the greeting packet survive delayed consumer installation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'browser-owner-early-')), path = join(root, 'sock');
  const server = createServer(socket => socket.once('data', () => socket.write([
    { type: 'attached', protocol: 1, pages: [], workerPid: 1 },
    { type: 'navigation', page: 'tab', value: { url: 'https://example.test/' } },
    { type: 'ime-state', page: 'tab', value: { editable: true } },
  ].map(value => JSON.stringify(value) + '\n').join(''))));
  await new Promise(resolve => server.listen(path, resolve));
  const peer = await connectBrowserOwner(path);
  t.after(async () => { peer.kill(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => setTimeout(resolve, 20));
  const events = []; peer.on('error', () => {}); peer.on('exit', () => {}); peer.on('message', value => events.push(value.type));
  await Promise.resolve(); assert.deepEqual(events, ['navigation', 'ime-state']);
});


test('Service isolates slot failure, keeps other viewers and awaits pool writer release on shutdown', async t => {
  const f = await fixture(t), keys = ['old', 'new'].map(id => JSON.stringify(['synthetic-owner', 'browser-' + id]));
  const ids = keys.map(key => createHash('sha256').update(key).digest('hex'));
  const first = await f.open(); await first.request(ids[0], 'create'); await first.pool.kill(); f.setVersion('B');
  const second = await f.open(); await second.request(ids[1], 'create'); await second.pool.kill();
  await writeFile(join(f.dataDirectory, 'tabs.json'), JSON.stringify({ schemaVersion: 1, retired: [], states: [], pages: keys.map((key, i) => ({ key, id: ids[i], ownerId: 'synthetic-owner', zoom: 100, lifecycle: 'open', runtime: { kind: 'live', generation: 1 } })) }));
  const service = new RemoteBrowserService({ root: f.root, dataDirectory: f.root,
    ownerConnector: options => startBrowserOwnerPool({ ...f.options, ...options, directory: f.options.directory }) });
  service.available = async () => true;
  t.after(async () => { service.close(); await service.persistence; });
  await service.start();
  const closed = [0, 0];
  for (let i = 0; i < keys.length; i++) service.viewers(service.pages.get(keys[i])).set({ close() { closed[i]++; } }, {});
  const other = service.pages.get(keys[1]), epoch = other.runtimeEpoch;
  const detail = { signal: 'SIGSEGV', stderrBytes: 120 };
  f.natives.get(f.dataDirectory).peer.emit('message', { type: 'owner-failure', native: detail });
  await service.store.tail;
  assert.deepEqual(service.lastBrowserFailure, { event: 'owner_exited', native: detail });
  assert.deepEqual(closed, [1, 0]); assert.equal(other.live, true); assert.equal(other.runtimeEpoch, epoch);
  assert.equal(service.pages.get(keys[0]).live, false);
  assert.equal(service.store.current.pages.find(p => p.id === ids[0]).runtime.kind, 'unknown');
  assert.equal(service.store.current.pages.find(p => p.id === ids[1]).runtime.kind, 'live');
  assert.equal((await service.request(ids[1], 'snapshot')).version, 'B');
  service.close(); await service.persistence;
  f.attachFailure(path => path === f.dataDirectory);
  const next = new RemoteBrowserService({ root: f.root, dataDirectory: f.root,
    ownerConnector: options => startBrowserOwnerPool({ ...f.options, ...options, directory: f.options.directory }) });
  next.available = async () => true;
  try {
    await next.start();
    assert.equal(next.store.current.pages.find(p => p.id === ids[0]).runtime.kind, 'unknown', 'unreachable old inventory must keep its quota reservation');
    assert.equal(next.pages.get(keys[1]).live, true);
    assert.equal((await next.request(ids[1], 'snapshot')).version, 'B');
  } finally { next.close(); await next.persistence; }
  f.attachFailure(() => false);
  const replacement = await f.open(false); assert.equal((await replacement.request(ids[1], 'snapshot')).version, 'B');
});


test('adoption buffering is bounded and consumer exceptions retire the transport safely', async () => {
  const peer = new BrowserOwnerEvents(); let kills = 0;
  peer.kill = () => { kills++; };
  for (let i = 0; i < 257; i++) peer.publish('message', { type: 'navigation', page: String(i) });
  assert.equal(kills, 1); assert.ok(peer.early.length <= 1);
  const errors = []; peer.on('error', error => errors.push(error)); await Promise.resolve(); assert.equal(errors.length, 1);
  const late = new BrowserOwnerEvents(); late.kill = () => { kills++; };
  late.publish('message', { type: 'native-event' });
  late.on('message', () => { throw Error('consumer failed'); });
  await Promise.resolve(); assert.equal(kills, 2); assert.equal(late.early.length, 0);
});


test('unreachable initial legacy inventory cannot publish an empty placement manifest', async t => {
  const f = await fixture(t); f.attachFailure(() => true);
  await assert.rejects(f.open());
  await assert.rejects(readFile(join(f.dataDirectory, 'owner-pool.json')), { code: 'ENOENT' });
  f.attachFailure(() => false);
  assert.equal((await (await f.open()).request('first', 'create')).version, 'A');
});


test('pool shutdown keeps its writer until every native transport confirms detach', async t => {
  const f = await fixture(t), first = await f.open();
  const original = await first.request('retained', 'create');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.blockDetach(() => blocked);
  let settled = false;
  const closing = first.pool.kill().then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'placement writer cannot precede physical transport close');
    await assert.rejects(f.open(false), { code: 'BROWSER_UNAVAILABLE', retryable: true });
  } finally { release(); await closing; f.blockDetach(() => null); }
  const next = await f.open(false);
  assert.equal((await next.request('retained', 'snapshot')).heap, original.heap);
});

test('a failed slot drains its old transport before reconnecting', async t => {
  const f = await fixture(t), first = await f.open();
  const original = await first.request('retained', 'create');
  const peer = f.natives.get(f.dataDirectory).peer;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.blockDetach(() => blocked);
  peer.emit('message', { type: 'owner-failure' });
  let recovered = false;
  const pending = first.request('retained', 'snapshot').then(value => { recovered = true; return value; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recovered, false);
    assert.equal(f.natives.get(f.dataDirectory).peer, peer, 'no replacement connector may race the prior detach');
  } finally { release(); f.blockDetach(() => null); }
  assert.equal((await pending).heap, original.heap);
});

test('shutdown also waits for a failed peer no longer installed on its slot', async t => {
  const f = await fixture(t), first = await f.open();
  await first.request('retained', 'create');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.blockDetach(() => blocked);
  f.natives.get(f.dataDirectory).peer.emit('message', { type: 'owner-failure' });
  let settled = false;
  const closing = first.pool.kill().then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(f.open(false), { code: 'BROWSER_UNAVAILABLE' });
  } finally { release(); await closing; f.blockDetach(() => null); }
  assert.equal((await (await f.open(false)).request('retained', 'snapshot')).id, 'retained');
});

test('late connector results finish physical detach before the shutdown writer can transfer', async t => {
  const f = await fixture(t), connect = f.options.connector;
  let armed = false, entered, releaseConnect, releaseDetach;
  const connecting = new Promise(resolve => { entered = resolve; });
  const connectGate = new Promise(resolve => { releaseConnect = resolve; });
  const detachGate = new Promise(resolve => { releaseDetach = resolve; });
  f.options.connector = async options => { if (armed) { entered(); await connectGate; } return connect(options); };
  const first = await f.open(), original = await first.request('retained', 'create');
  f.natives.get(f.dataDirectory).peer.emit('message', { type: 'owner-failure' });
  armed = true;
  first.pool.send({ id: randomUUID(), page: 'retained', method: 'snapshot' });
  await connecting;
  f.blockDetach(() => detachGate);
  let settled = false;
  const closing = first.pool.kill().then(() => { settled = true; });
  try {
    releaseConnect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(f.open(false), { code: 'BROWSER_UNAVAILABLE' });
  } finally { releaseConnect(); releaseDetach(); await closing; armed = false; f.blockDetach(() => null); }
  const next = await f.open(false);
  assert.equal((await next.request('retained', 'snapshot')).heap, original.heap);
});
