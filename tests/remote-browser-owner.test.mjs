import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { connectBrowserOwner, reuseBrowserOwner } from '../scripts/remote-browser-owner.mjs';
import { RemoteBrowserService } from '../scripts/remote-browser-service.mjs';
const { createBrowserOwner } = createRequire(import.meta.url)('../scripts/remote-browser/owner.cjs');

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
