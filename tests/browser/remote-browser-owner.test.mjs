import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readlink, readdir, cp, rm, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { publishBrowserOwnerRuntime } from '../../scripts/browser-owner-runtime.mjs';
import { browserRuntimeIdentity, browserRuntimeMatches } from '../../scripts/browser-runtime-identity.mjs';
import { connectBrowserOwner, reuseBrowserOwner, prepareBrowserOwnerConnector } from '../../scripts/remote-browser-owner.mjs';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
const { createBrowserOwner, installOwnerSignals } = createRequire(import.meta.url)('../../scripts/remote-browser/owner.cjs');

const worker = `
const pages=new Map();process.send({type:'ready'});
process.on('message',async m=>{let value;try{
 if(m.method==='inventory')value=[...pages.values()];
 else if(m.method==='create'){value={id:m.page,document:'same-native-document',width:430,height:720,deviceProfile:'iphone',navigation:{url:'https://example.test/',isLoading:false},form:'',scroll:0};pages.set(m.page,value)}
 else {const p=pages.get(m.page);if(!p)throw Error('missing');
  if(m.control!==undefined&&m.control!==p.token)throw Error('stale token');
  if(m.method==='control')p.token=m.input.token;
  if(m.method==='visible')p.visible=m.input.visible;
  if(m.method==='text'){await new Promise(r=>setTimeout(r,80));p.form=m.input.text;p.scroll=300}
  if(m.method==='close')pages.delete(m.page);
  value={...p};
 }
 process.send({type:'result',id:m.id,value});
}catch(e){process.send({type:'result',id:m.id,error:{message:e.message}})}});
`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-owner-')); const workerPath = join(directory, 'worker.cjs');
  await writeFile(workerPath, worker); const socketPath = join(directory, 'owner.sock');
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
    assert.deepEqual(client.inventory, []);
  } finally { client.kill(); }
});

test('a replacement Gateway adopts the same native document/form/scroll and retires old input control', async t => {
  const f = await fixture(t), first = f.service(); await first.start();
  const key = JSON.stringify(['synthetic-owner', 'browser-logical-tab']), id = createHash('sha256').update(key).digest('hex');
  await first.commit(store => { store.saveSession({ id, key, ownerId: 'synthetic-owner', zoom: 100, lifecycle: 'open', runtime: { kind: 'starting', generation: 1 } }); });
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


test('runtime identity follows immutable bytes and normalized executable semantics across a private install umask', async () => {
  const root=await mkdtemp(join(tmpdir(),'browser-runtime-umask-'));
  try {
    const candidate=join(root,'candidate'),retained=join(root,'retained');
    for(const directory of [candidate,retained]){
      await mkdir(join(directory,'electron'),{recursive:true});
      await writeFile(join(directory,'worker.cjs'),'same immutable worker');
      await writeFile(join(directory,'electron/electron'),'same executable bytes');
    }
    await chmod(join(candidate,'electron/electron'),0o700);
    await chmod(join(retained,'electron/electron'),0o755);
    assert.equal(await browserRuntimeIdentity(candidate),await browserRuntimeIdentity(retained), 'owner mount normalization must not masquerade as a native update');
    await chmod(join(retained,'electron/electron'),0o644);
    assert.notEqual(await browserRuntimeIdentity(candidate),await browserRuntimeIdentity(retained), 'losing executable capability remains a real identity change');
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('candidate identity errors cannot authorize an attachment or an empty-owner upgrade', async () => {
  const root=await mkdtemp(join(tmpdir(),'browser-runtime-admission-'));
  try {
    const missing=join(root,'missing'),valid=join(root,'valid');await mkdir(valid);await writeFile(join(valid,'worker.cjs'),'valid immutable bytes');
    for(const inventory of [[],[{id:'retained-live-tab'}]]){
      let stops=0,kills=0;const peer={inventory,kill(){kills++;}};
      await assert.rejects(reuseBrowserOwner(peer,()=>browserRuntimeMatches(missing,valid),async()=>{stops++;}),/ENOENT/);
      assert.equal(stops,0);assert.equal(kills,0);assert.notEqual(peer.runtimeCurrent,true);
    }
    await symlink(valid,join(root,'candidate-link'));
    await assert.rejects(browserRuntimeMatches(root,valid),/regular files/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('unidentified retained bytes keep live documents but allow verified candidates to replace an empty owner',async()=>{
  const root=await mkdtemp(join(tmpdir(),'browser-runtime-retained-'));
  try{
    const candidate=join(root,'candidate');await mkdir(candidate);await writeFile(join(candidate,'worker.cjs'),'candidate bytes');
    for(const inventory of [[],[{id:'live'}]]){
      let stops=0,kills=0;const peer={inventory,kill(){kills++;}};
      const reused=await reuseBrowserOwner(peer,()=>browserRuntimeMatches(candidate,join(root,'unknown-retained')),async()=>{stops++;});
      assert.equal(peer.runtimeCurrent,false);assert.equal(stops,inventory.length?0:1);assert.equal(kills,inventory.length?0:1);assert.equal(reused,inventory.length?peer:null);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});


test('prepared immutable candidates validate all entries and executable capability before returning an owner connector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-prepared-candidate-'));
  try {
    await assert.rejects(prepareBrowserOwnerConnector(root), { code: 'ENOENT' });
    await mkdir(join(root, 'electron')); await writeFile(join(root, 'worker.cjs'), 'worker'); await writeFile(join(root, 'owner.cjs'), 'owner'); await writeFile(join(root, 'electron/electron'), 'native');
    await assert.rejects(prepareBrowserOwnerConnector(root), { code: 'EACCES' });
    await chmod(join(root, 'electron/electron'), 0o700);
    assert.equal(typeof await prepareBrowserOwnerConnector(root), 'function');
    await symlink(join(root, 'worker.cjs'), join(root, 'untrusted-link'));
    await assert.rejects(prepareBrowserOwnerConnector(root), /regular files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed orphan reconciliation releases the exclusive attachment and retries against the same native owner', async t => {
  const f = await fixture(t), seed = f.service(); await seed.start();
  await seed.request('synthetic-orphan', 'create'); seed.close(); await seed.persistence;
  const service = f.service(), connect = service.ownerConnector; let failClose = true;
  service.ownerConnector = async options => {
    const peer = await connect(options), send = peer.send;
    peer.send = (message, callback) => {
      if (failClose && message.method === 'close') {
        failClose = false; callback?.(null);
        queueMicrotask(() => peer.emit('message', { type: 'result', id: message.id, error: { message: 'Synthetic orphan close failed', retryable: true } }));
      } else send(message, callback);
    };
    return peer;
  };
  t.after(async () => { service.close(); await service.persistence; });
  await assert.rejects(service.start(), /Synthetic orphan close failed/);
  assert.equal(service.child, null);
  await service.start(); assert.equal(service.child.workerPid, f.owner.child.pid);
  assert.deepEqual(await service.request(undefined, 'inventory'), []);
});

test('failed adoption persistence detaches its peer and leaves native ownership available for retry', async t => {
  const f = await fixture(t), service = f.service(), commit = service.commit.bind(service); let fail = true;
  service.commit = reduce => { if (fail) { fail = false; return Promise.reject(Error('Synthetic adoption persistence failed')); } return commit(reduce); };
  t.after(async () => { service.close(); await service.persistence; });
  await assert.rejects(service.start(), /Synthetic adoption persistence failed/); assert.equal(service.child, null);
  await service.start(); assert.equal(service.child.workerPid, f.owner.child.pid);
});

test('shutdown retains the logical writer until an in-progress owner attachment has detached', async t => {
  const f = await fixture(t), first = f.service(), second = f.service(), connect = first.ownerConnector;
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  first.ownerConnector = async options => { enter(); await gate; return connect(options); };
  t.after(async () => { release(); first.close(); second.close(); await first.persistence; await second.persistence; });
  const opening = first.start(); void opening.catch(() => {}); await entered;
  first.close(); let released = false; void first.persistence.then(() => { released = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(released, false);
  await assert.rejects(second.load(), error => error.code === 'BROWSER_UNAVAILABLE');
  release(); await assert.rejects(opening, /Browser service closed/); await first.persistence;
  await second.start(); assert.equal(second.child.workerPid, f.owner.child.pid);
});

test('adoption cannot report success after its transport retires during a pending commit', async t => {
  const f = await fixture(t), service = f.service(), commit = service.commit.bind(service);
  let enter, release, first = true; const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  service.commit = reduce => { if (first) { first = false; enter(); return gate.then(() => commit(reduce)); } return commit(reduce); };
  t.after(async () => { release(); service.close(); await service.persistence; });
  const opening = service.start(); void opening.catch(() => {}); await entered;
  const peer = service.child; await peer.kill(); assert.equal(service.child, null);
  release(); await assert.rejects(opening, /Browser owner disconnected/);
  await service.start(); assert.equal(service.child.workerPid, f.owner.child.pid);
});

test('an adopted transport must finish draining before shutdown releases the logical writer', async t => {
  const f = await fixture(t), first = f.service(), second = f.service(); await first.start();
  const peer = first.child, kill = peer.kill; let release; const gate = new Promise(resolve => { release = resolve; });
  peer.kill = () => Promise.all([kill(), gate]);
  t.after(async () => { release(); first.close(); second.close(); await first.persistence; await second.persistence; });
  first.close(); await peer.closed;
  await assert.rejects(second.load(), error => error.code === 'BROWSER_UNAVAILABLE');
  release(); await first.persistence; await second.start(); assert.equal(second.child.workerPid, f.owner.child.pid);
});

// Filesystem-backed payload races are independent of the manager protocol.
// A mount can outlive its pathname; publishing must never remove retained bytes.
async function publicationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'browser-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data'), candidate = join(root, 'candidate');
  await mkdir(join(candidate, 'electron'), { recursive: true });
  await writeFile(join(candidate, 'worker.cjs'), 'candidate-worker');
  await writeFile(join(candidate, 'electron/electron'), 'candidate-executable', { mode: 0o700 });
  return { root, data, candidate, identity: await browserRuntimeIdentity(candidate) };
}

test('immutable publication preserves an existing retained payload and normalizes only the new copy', async t => {
  const { data, candidate, identity } = await publicationFixture(t), old = join(data, 'owner-runtime');
  await mkdir(old, { recursive: true }); await writeFile(join(old, 'retained'), 'unsaved-runtime');
  const runtime = await publishBrowserOwnerRuntime(candidate, data, identity);
  assert.equal(await readFile(join(old, 'retained'), 'utf8'), 'unsaved-runtime');
  assert.equal(await browserRuntimeIdentity(runtime), identity);
  assert.equal((await stat(join(runtime, 'electron/electron'))).mode & 0o777, 0o755);
  assert.equal((await stat(join(candidate, 'electron/electron'))).mode & 0o777, 0o700);
});

test('concurrent publication of one identity converges without destructive replacement or staging leftovers', async t => {
  const { data, candidate, identity } = await publicationFixture(t);
  const paths = await Promise.all(Array.from({length: 8}, () => publishBrowserOwnerRuntime(candidate, data, identity)));
  assert.equal(new Set(paths).size, 1); assert.equal(await browserRuntimeIdentity(paths[0]), identity);
  assert.deepEqual(await readdir(join(data, 'owner-runtimes')), [identity]);
  assert.equal(await readlink(join(data, 'owner-runtime')), paths[0]);
  const before = await stat(paths[0]); await publishBrowserOwnerRuntime(candidate, data, identity);
  const after = await stat(paths[0]); assert.equal(after.ino, before.ino);
});

test('different concurrent identities retain both payloads and a stable compatibility alias', async t => {
  const { root, data, candidate, identity } = await publicationFixture(t), second = join(root, 'second');
  await cp(candidate, second, { recursive: true }); await writeFile(join(second, 'worker.cjs'), 'other-worker');
  const other = await browserRuntimeIdentity(second);
  const [a,b] = await Promise.all([publishBrowserOwnerRuntime(candidate, data, identity), publishBrowserOwnerRuntime(second, data, other)]);
  assert.notEqual(a,b); assert.equal(await browserRuntimeIdentity(a), identity); assert.equal(await browserRuntimeIdentity(b), other);
  const alias = await readlink(join(data, 'owner-runtime')); assert.ok([a,b].includes(alias));
  await publishBrowserOwnerRuntime(second, data, other); assert.equal(await readlink(join(data, 'owner-runtime')), alias);
});

test('a directory name is not proof of its content and a mismatched winner is preserved on rejection', async t => {
  const { data, candidate, identity } = await publicationFixture(t), runtime = await publishBrowserOwnerRuntime(candidate, data, identity);
  await writeFile(join(runtime, 'worker.cjs'), 'unexpected-retained-bytes');
  await assert.rejects(publishBrowserOwnerRuntime(candidate, data, identity), /identity mismatch/);
  assert.equal(await readFile(join(runtime, 'worker.cjs'), 'utf8'), 'unexpected-retained-bytes');
  assert.deepEqual(await readdir(join(data, 'owner-runtimes')), [identity]);
});

test('candidate mutation after preparation fails before publication and cleans only its own staging copy', async t => {
  const { data, candidate, identity } = await publicationFixture(t);
  await writeFile(join(candidate, 'worker.cjs'), 'changed-after-identity');
  await assert.rejects(publishBrowserOwnerRuntime(candidate, data, identity), /identity mismatch/);
  assert.deepEqual(await readdir(join(data, 'owner-runtimes')), []);
  await assert.rejects(stat(join(data, 'owner-runtime')), { code: 'ENOENT' });
  assert.equal(await readFile(join(candidate, 'worker.cjs'), 'utf8'), 'changed-after-identity');
});

test('publication rejects invalid identity before creating a destination', async t => {
  const { data, candidate } = await publicationFixture(t);
  await assert.rejects(publishBrowserOwnerRuntime(candidate, data, '../escape'), /Invalid browser runtime identity/);
  await assert.rejects(stat(data), { code: 'ENOENT' });
});


test('an identity directory cannot alias mutable candidate storage', async t => {
  const { data, candidate, identity } = await publicationFixture(t);
  await mkdir(join(data, 'owner-runtimes'), { recursive: true });
  await symlink(candidate, join(data, 'owner-runtimes', identity));
  await assert.rejects(publishBrowserOwnerRuntime(candidate, data, identity), /Invalid browser retained runtime directory/);
  assert.equal(await readlink(join(data, 'owner-runtimes', identity)), candidate);
  assert.equal(await readFile(join(candidate, 'worker.cjs'), 'utf8'), 'candidate-worker');
});
