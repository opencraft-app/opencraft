import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { browserRuntimeIdentity } from '../../scripts/browser-runtime-identity.mjs';
import { connectBrowserOwner, reuseBrowserOwner } from '../../scripts/remote-browser-owner.mjs';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
const { createBrowserOwner, installOwnerSignals } = createRequire(import.meta.url)('../../scripts/remote-browser/owner.cjs');

const worker = `
const pages=new Map(),automation=new Map();process.send({type:'ready'});
process.on('message',async m=>{let value;try{
 if(m.method==='cancelAutomation'){const job=automation.get(m.input.requestId);if(job?.page===m.page)job.cancel();return;}
 if(m.method==='inventory')value=[...pages.values()];
 else if(m.method==='create'){value={id:m.page,document:'same-native-document',width:430,height:720,deviceProfile:'iphone',navigation:{url:'https://example.test/',isLoading:false},form:'',scroll:0};pages.set(m.page,value)}
 else {const p=pages.get(m.page);if(!p)throw Error('missing');
  if(m.control!==undefined&&m.control!==p.token)throw Error('stale token');
  if(m.method==='control')p.token=m.input.token;
  if(m.method==='visible')p.visible=m.input.visible;
  if(m.method==='text'){await new Promise(r=>setTimeout(r,80));p.form=m.input.text;p.scroll=300}
  if(m.method==='automation'){await new Promise(resolve=>automation.set(m.id,{page:m.page,cancel(){p.cancelled=true;automation.delete(m.id);resolve();}}))}
  if(m.method==='close')pages.delete(m.page);
  value={...p};
 }
 process.send({type:'result',id:m.id,value});
}catch(e){process.send({type:'result',id:m.id,error:{message:e.message}})}});
`;
async function fixture(t, automationNavigation) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-owner-')); const workerPath = join(directory, 'worker.cjs');
  await writeFile(workerPath, automationNavigation === undefined ? worker : worker.replace("{type:'ready'}", `{type:'ready',automationNavigation:${JSON.stringify(automationNavigation)}}`)); const socketPath = join(directory, 'owner.sock');
  const owner = await createBrowserOwner({ socketPath, spawnWorker: () => spawn(process.execPath, [workerPath], { stdio: ['ignore','ignore','pipe','ipc'] }) });
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
  const service = () => {
    const s = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: () => connectBrowserOwner(socketPath) });
    s.available = async () => true; return s;
  };
  return { owner, socketPath, service };
}

test('service-manager signals close the owner once and report the result', async () => {
  const runtime = new EventEmitter(); let closes = 0, release;
  const closed = new Promise(resolve => { release = resolve; });
  installOwnerSignals({ close: async () => { closes++; release(); } }, runtime);
  runtime.emit('SIGTERM'); runtime.emit('SIGINT'); await closed; await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1); assert.equal(runtime.exitCode, 0);
});

async function probe(socketPath) {
  const socket = connect(socketPath); await once(socket, 'connect');
  const received = once(socket, 'data');
  socket.write(JSON.stringify({ type: 'probe', protocol: 1 }) + '\n');
  const response = JSON.parse(String((await received)[0]).trim());
  socket.destroy(); return response;
}

test('health probes validate the worker without taking over the Gateway attachment', async t => {
  const f = await fixture(t);
  assert.deepEqual(await probe(f.socketPath), { type: 'healthy', protocol: 1, workerPid: f.owner.child.pid });
  const client = await connectBrowserOwner(f.socketPath);
  try {
    assert.deepEqual(await probe(f.socketPath), { type: 'healthy', protocol: 1, workerPid: f.owner.child.pid });
    assert.equal(client.workerPid, f.owner.child.pid);
    assert.equal(client.automationNavigation, 0, 'new Owner cannot invent capabilities for an older Worker');
    assert.deepEqual(client.inventory, []);
  } finally { client.kill(); }
});

test('navigation feature handshake comes from the Worker, including empty owners', async t => {
  const f = await fixture(t, 1), client = await connectBrowserOwner(f.socketPath);
  try { assert.equal(client.automationNavigation, 1); assert.deepEqual(client.inventory, []); }
  finally { client.kill(); }
});

test('private owner maps cancellation to native request identity and cancels departed Gateway work', async t => {
  const f = await fixture(t), service = f.service(); await service.start();
  try {
    assert.equal(service.child.automationCancellation, 1);
    await service.request('page', 'create');
    const controller = new AbortController();
    const pending = service.request('page', 'automation', { method: 'wait', input: { timeoutMs: 60000 } }, undefined, undefined, { signal: controller.signal });
    const rejection = assert.rejects(pending, { code: 'CDP_ABORTED', outcome: 'unknown' });
    await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(); await rejection;
    for (let attempt = 0; attempt < 30; attempt++) {
      const [page] = await service.request(undefined, 'inventory'); if (page.cancelled) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await service.request(undefined, 'inventory'))[0].cancelled, true);
    const old = service.request('page', 'automation', { method: 'wait', input: { timeoutMs: 60000 } });
    const oldRejected = assert.rejects(old);
    await new Promise(resolve => setTimeout(resolve, 20)); service.child.kill(); await oldRejected;
    const started = Date.now(), replacement = await connectBrowserOwner(f.socketPath);
    assert(Date.now() - started < 3000); replacement.kill();
  } finally { service.close(); await service.persistence; }
});

test('a replacement Gateway adopts the same native document/form/scroll and retires old input control', async t => {
  const f = await fixture(t), first = f.service(); await first.start();
  const key = JSON.stringify(['synthetic-owner', 'browser-logical-tab']), id = createHash('sha256').update(key).digest('hex');
  await first.commit(draft => { draft.pages.push({ id, key, ownerId: 'synthetic-owner', zoom: 100, lifecycle: 'open', runtime: { kind: 'starting', generation: 1 } }); });
  first.pages.set(key, { id, key, ownerId: 'synthetic-owner', zoom: 100, live: true });
  await first.request(id, 'create'); await first.request(id, 'control', { token: 'old-human' });
  // Accepted old writes finish once before the owner permits a new attachment.
  const last = first.request(id, 'text', { text: '未提交的中文表单' }, 'old-human');
  await new Promise(resolve => setTimeout(resolve, 10)); first.close(); await assert.rejects(last);
  await first.persistence;
  const second = f.service();
  try {
    await second.start(); const adopted = second.pages.get(key);
    assert.equal(second.child.workerPid, f.owner.child.pid); assert.equal(adopted.document, 'same-native-document'); assert.equal(adopted.live, true);
    const [native] = await second.request(undefined, 'inventory');
    assert.equal(native.form, '未提交的中文表单'); assert.equal(native.scroll, 300);
    assert.equal(native.token, null); assert.equal(native.visible, false);
    await assert.rejects(second.request(id, 'text', { text: 'must not replay' }, 'old-human'), /stale token/);
    await second.request(id, 'close'); assert.equal((await second.request(undefined, 'inventory')).length, 0);
    assert.equal((await stat(f.socketPath)).mode & 0o777, 0o600);
  } finally { second.pages.clear(); second.close(); await second.persistence; }
});

test('an incompatible owner handshake is rejected without replacing the live native process', async t => {
  const f = await fixture(t), socket = connect(f.socketPath); await once(socket, 'connect');
  const received = once(socket, 'data'); socket.write(JSON.stringify({ type: 'attach', protocol: 999 }) + '\n');
  assert.equal(JSON.parse((await received)[0]).type, 'owner-incompatible');
  socket.destroy(); await new Promise(resolve => setTimeout(resolve, 20));
  const client = await connectBrowserOwner(f.socketPath); assert.equal(client.workerPid, f.owner.child.pid); client.kill();
});


test('an overlapping Gateway receives a retryable open failure while the prior owner transport remains intact', async t => {
  const f = await fixture(t), first = f.service(); await first.start();
  const second = f.service(), server = createServer();
  server.on('upgrade', (req, socket, head) => second.upgrade(req, socket, head, { ownerId: 'synthetic-overlap' }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`); await once(client, 'open');
  try {
    const response = once(client, 'message');
    client.send(JSON.stringify({ id: 'overlap', method: 'open', input: { lease: 'synthetic-overlapping-lease', multiView: true } }));
    const message = JSON.parse((await response)[0]);
    assert.equal(message.error?.code, 'BROWSER_UNAVAILABLE'); assert.equal(message.error?.retryable, true);
    assert.equal(first.child.workerPid, f.owner.child.pid);
    assert.deepEqual(await first.request(undefined, 'inventory'), []);
    first.close(); await first.persistence;
    const recovered = once(client, 'message');
    client.send(JSON.stringify({ id: 'after-writer-exit', method: 'state' }));
    const state = JSON.parse((await recovered)[0]);
    assert.equal(state.error, undefined); assert.equal(state.value.revision, 0);
  } finally {
    client.terminate(); first.close(); second.close();
    await first.persistence; await second.persistence;
    await new Promise(resolve => server.close(resolve));
  }
});


test('runtime script upgrade only stops empty owners under their exclusive attachment', async () => {
  for (const [pages, current, stopped] of [[[{id:'live'}],false,false],[[],true,false],[[],false,true]]) {
    let stops=0,kills=0;const peer={inventory:pages,kill(){kills++;}};
    const reused=await reuseBrowserOwner(peer,async()=>current,async()=>{stops++;});
    assert.equal(stops,stopped?1:0);assert.equal(kills,stopped?1:0);
    assert.equal(reused,stopped?null:peer);
  }
  let kills=0;const peer={inventory:[],kill(){kills++;}};
  await assert.rejects(reuseBrowserOwner(peer,async()=>false,async()=>{throw Error('stop rejected');}),/stop rejected/);
  assert.equal(kills,1,'failed upgrade must release its exclusive transport');
});


test('socket errors racing intentional empty-owner replacement cannot escape into Gateway', async () => {
  const peer=Object.assign(new EventEmitter(),{inventory:[],kill(){this.emit('error',Error('late reset'));}});
  assert.equal(await reuseBrowserOwner(peer,async()=>false,async()=>{peer.emit('error',Error('reset during stop'));}),null);
});


test('native-only runtime changes keep live owners but replace an empty stale owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-native-identity-'));
  try {
    const previous = join(root, 'previous'), candidate = join(root, 'candidate');
    for (const directory of [previous, candidate]) {
      await mkdir(join(directory, 'electron'), { recursive: true });
      await writeFile(join(directory, 'worker.cjs'), '// identical worker');
      await writeFile(join(directory, 'electron/electron'), 'old-binary');
    }
    assert.equal(await browserRuntimeIdentity(previous), await browserRuntimeIdentity(candidate));
    await writeFile(join(candidate, 'electron/electron'), 'new-binary');
    const current = async () => await browserRuntimeIdentity(previous) === await browserRuntimeIdentity(candidate);
    assert.equal(await current(), false);
    for (const pages of [[{ id: 'live-tab' }], []]) {
      let stops = 0;
      const peer = { inventory: pages, kill() {} };
      const reused = await reuseBrowserOwner(peer, current, async () => { stops++; });
      assert.equal(peer.runtimeCurrent, false);
      assert.equal(stops, pages.length ? 0 : 1);
      assert.equal(reused, pages.length ? peer : null);
    }
    const before = await browserRuntimeIdentity(candidate);
    await chmod(join(candidate, 'electron/electron'), 0o755);
    assert.notEqual(await browserRuntimeIdentity(candidate), before, 'executable permission is part of runtime identity');
    const executable = await browserRuntimeIdentity(candidate);
    await writeFile(join(candidate, 'electron/new-resource.pak'), 'native resource');
    assert.notEqual(await browserRuntimeIdentity(candidate), executable);
    await rm(join(candidate, 'electron/new-resource.pak'));
    assert.equal(await browserRuntimeIdentity(candidate), executable, 'removed resources affect identity too');
    await symlink(join(previous, 'electron/electron'), join(candidate, 'external'));
    await assert.rejects(browserRuntimeIdentity(candidate), /regular files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const boundary of ['publish', 'orphan']) test(`owner disconnect during inventory ${boundary} retains uncertain capacity`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-inventory-fence-'));
  const peer = Object.assign(new EventEmitter(), { inventory: boundary === 'orphan' ? [{ id: 'orphan-one' }, { id: 'orphan-two' }] : [], kill() {} });
  const service = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: async () => peer });
  service.available = async () => true;
  t.after(async () => { service.close(); await service.persistence; await rm(directory, { recursive: true, force: true }); });
  await service.load();
  const key = JSON.stringify(['owner', 'browser-uncertain']), id = createHash('sha256').update(key).digest('hex');
  await service.commit(draft => { draft.pages.push({ id, key, ownerId: 'owner', lifecycle: 'open', zoom: 100,
    runtime: { kind: 'unknown', generation: 1 } }); });
  service.pages.set(key, { id, key, ownerId: 'owner', zoom: 100, live: false });
  const commit = service.commit.bind(service); let disconnect = true;
  service.commit = reduce => commit(draft => {
    if (disconnect && boundary === 'publish') { disconnect = false; peer.emit('exit'); }
    return reduce(draft);
  });
  let closes = 0;
  if (boundary === 'orphan') service.request = async () => { closes++; peer.emit('exit'); };
  await assert.rejects(service.start(), { code: 'BROWSER_UNAVAILABLE' });
  assert.equal(closes, boundary === 'orphan' ? 1 : 0);
  await service.store.tail;
  assert.equal(service.store.current.pages[0].runtime.kind, 'unknown');
  assert.equal((await service.catalog('owner', () => {})).capacity.accountUsed, 1);
});

for (const failure of ['orphan', 'commit']) test(`failed owner recovery releases its transport after ${failure} error`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-owner-start-failure-'));
  const key = JSON.stringify(['owner', 'browser-kept']), id = createHash('sha256').update(key).digest('hex');
  const config = { id, document: 'kept-native-document', width: 800, height: 600, navigation: { url: 'https://example.test/' } };
  let released = 0, connections = 0;
  const first = Object.assign(new EventEmitter(), { inventory: [config, ...failure === 'orphan' ? [{ id: 'orphan' }] : []], kill() { released++; } });
  const second = Object.assign(new EventEmitter(), { inventory: [config], kill() {} });
  const service = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: async () => ++connections === 1 ? first : second });
  service.available = async () => true;
  t.after(async () => { service.close(); await service.persistence; await rm(directory, { recursive: true, force: true }); });
  await service.load(); await service.commit(draft => { draft.pages.push({ id, key, ownerId: 'owner', lifecycle: 'open', zoom: 100,
    runtime: { kind: 'unknown', generation: 1 } }); });
  service.pages.set(key, { id, key, ownerId: 'owner', zoom: 100, live: false });
  if (failure === 'orphan') service.request = async () => { throw Error('orphan cleanup failed'); };
  else {
    const commit = service.commit.bind(service); let fail = true;
    service.commit = reduce => {
      if (fail) { fail = false; return Promise.reject(Error('inventory publish failed')); }
      return commit(reduce);
    };
  }
  await assert.rejects(service.start(), /failed/);
  assert.equal(released, 1); assert.equal(service.child, null); assert.equal(service.pages.get(key).live, false);
  await service.store.tail; assert.equal(service.store.current.pages[0].runtime.kind, 'unknown');
  await service.start(); assert.equal(service.child, second); assert.equal(connections, 2);
  assert.equal(service.pages.get(key).live, true);
});

test('service close during runtime availability check prevents late Electron spawn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-late-spawn-'));
  let checked, release;
  const entered = new Promise(resolve => { checked = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let spawned = 0;
  const service = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: null, allowNoSandbox: true,
    spawnImpl() {
      spawned++; const child = Object.assign(new EventEmitter(), { kill() {}, connected: false });
      queueMicrotask(() => child.emit('message', { type: 'ready' })); return child;
    } });
  service.available = async () => { checked(); await gate; return true; };
  t.after(async () => { release(); service.close(); await service.persistence; await rm(directory, { recursive: true, force: true }); });
  const starting = service.start(), rejected = assert.rejects(starting, /closed/);
  await entered; service.close(); await service.persistence;
  release(); await rejected;
  assert.equal(spawned, 0); assert.equal(service.child, undefined);
});
