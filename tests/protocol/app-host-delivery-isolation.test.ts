import assert from 'node:assert/strict';
import test from 'node:test';
import { AppHostServer, type AppHostServerConnection } from '../../packages/app-host-server/src/index';
import { ThreadAccessSession, type ThreadAccessStore } from '../../packages/access-control/src/thread-access';
import type { AppHostToRendererMessage } from '../../packages/app-host-protocol/src/index';

async function fixture(prepare?: (id: string) => Promise<void>) {
  const listeners = new Set<(frame: string) => void>();
  const native: Record<string, unknown>[] = [];
  const owners = new Map<string, ReturnType<typeof state>>();
  let physicalCloses = 0;
  function state() { return { revoked: false, failWire: false, failCleanup: false, failPortClose: false, cleaned: 0, portCloses: 0, emit: (_frame: string) => {} }; }
  const server = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: 'server',
    createTransport: () => ({ status: { state: 'open' }, connect: async () => {},
      send: async frame => { native.push(JSON.parse(frame)); }, close: async () => { physicalCloses++; },
      subscribeMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, subscribeStatus: () => () => {},
    }),
    createRpcAccessSession: (_host, context, emit) => {
      const owner = owners.get(context.resourceOwner!.id)!;
      owner.emit = emit;
      const store = { subscribe: () => () => { if (owner.failCleanup) throw Error('cleanup failed'); owner.cleaned++; } } as unknown as ThreadAccessStore;
      const session = new ThreadAccessSession(store, () => 'server', undefined, emit, undefined, () => {
        if (owner.revoked) throw Error('App resource authority revoked');
      });
      return prepare ? Object.assign(session, { prepare: () => prepare(context.resourceOwner!.id) }) : session;
    },
  });
  async function page(id: string) {
    const owner = state(); owners.set(id, owner);
    const frames: AppHostToRendererMessage[] = [];
    let receive: (message: unknown) => void = () => {};
    const connection: AppHostServerConnection = server.accept({
      postMessage(message) { if (owner.failWire) throw Error('wire failed'); frames.push(message); },
      subscribe(listener) { receive = listener; return () => { receive = () => {}; }; }, start() {},
      close() { owner.portCloses++; if (owner.failPortClose) throw Error('port cleanup failed'); },
    }, id, { sender: null, resourceOwner: { id, assertCurrent() {} } });
    receive({ type: 'hello', protocolVersion: 2, rendererId: id });
    receive({ type: 'host/connect', requestId: id, hostId: 'local-codex', leaseId: 'lease' });
    for (let i = 0; i < 100 && !frames.some(f => f.type === 'response' && f.requestId === id); i++) await new Promise(r => setImmediate(r));
    const connected = frames.find(f => f.type === 'response' && f.requestId === id);
    assert.ok(connected?.type === 'response' && connected.ok);
    const generation = (connected.result as {generation: number}).generation;
    const count = () => frames.filter(f => f.type === 'host/frame').length;
    return { owner, connection, frames, count, generation, receive };
  }
  const stale = await page('stale'), healthy = await page('healthy');
  const emit = (packet: object) => { for (const listener of listeners) listener(JSON.stringify(packet)); };
  const broadcast = () => emit({method:'diagnostic/test',params:{}});
  broadcast(); if(prepare)await new Promise(r=>setImmediate(r)); assert.equal(healthy.count(), 1); assert.equal(stale.count(), 1);
  return { server, stale, healthy, emit, broadcast, native, physicalCloses: () => physicalCloses };
}

for (const targeted of [false, true]) test(`expired connection isolates ${targeted ? 'targeted response' : 'broadcast'} and preserves its peer`, async () => {
  const f = await fixture();
  try {
    let client: unknown;
    if (targeted) {
      f.stale.receive({type:'host/send',requestId:'read',hostId:'local-codex',leaseId:'lease',generation:f.stale.generation,frame:JSON.stringify({id:7,method:'initialize',params:{}})});
      for (let i=0;i<100&&!f.native.some(p=>p.id===7);i++) await new Promise(r=>setImmediate(r));
      client=f.native.find(p=>p.id===7)?.__opencraftClient; assert.equal(typeof client,'string');
    }
    f.stale.owner.revoked = true;
    assert.doesNotThrow(() => targeted ? f.emit({id:7,result:{},__opencraftClient:client}) : f.broadcast());
    assert.equal(f.stale.connection.isClosed,true);
    assert.equal(f.stale.connection.ownsHost('local-codex',f.stale.generation),false);
    assert.equal(f.stale.owner.cleaned,1); assert.equal(f.stale.owner.portCloses,1);
    assert.equal(f.stale.count(),1); assert.equal(f.healthy.count(),targeted?1:2);
    f.broadcast(); assert.equal(f.healthy.count(),targeted?2:3); assert.equal(f.stale.count(),1);
    assert.equal(f.physicalCloses(),0);
    await new Promise(r=>setImmediate(r));
    assert.ok(f.native.some(p=>p.method==='runtime/client/disconnect'));
  } finally { await f.server.close(); }
});

for (const emitFromSession of [false,true]) test(`wire failure in ${emitFromSession?'policy emission':'broadcast'} retires only its connection`, async () => {
  const f=await fixture();
  try {
    f.stale.owner.failWire=true;
    assert.doesNotThrow(()=>emitFromSession?f.stale.owner.emit('{"method":"policy/changed"}'):f.broadcast());
    assert.equal(f.stale.connection.isClosed,true);assert.equal(f.stale.owner.cleaned,1);
    f.broadcast();assert.equal(f.healthy.count(),emitFromSession?2:3);
    assert.equal(f.physicalCloses(),0);
  } finally {await f.server.close();}
});

for (const failure of ['failCleanup','failPortClose'] as const) test(`delivery retirement retains ${failure} for explicit retry without disrupting peers`, async () => {
  const f=await fixture();
  f.stale.owner[failure]=true;f.stale.owner.revoked=true;
  assert.doesNotThrow(f.broadcast);
  assert.equal(f.stale.connection.isClosed,true);assert.equal(f.stale.owner.portCloses,1);
  assert.equal(f.stale.connection.ownsHost('local-codex',f.stale.generation),false);
  assert.equal(f.healthy.count(),2);f.broadcast();assert.equal(f.healthy.count(),3);
  await assert.rejects(f.server.close());
  f.stale.owner[failure]=false;
  await f.server.close();
  assert.equal(f.stale.owner.cleaned,1);
});


for (const failure of ['prepare', 'wire-and-cleanup'] as const) test(`async ${failure} failure isolates its connection and keeps cleanup retryable`, async () => {
  let fail=false;
  const f=await fixture(async id=>{if(fail&&id==='stale'&&failure==='prepare')throw Error('preparation failed');});
  fail=true;
  if(failure==='wire-and-cleanup'){f.stale.owner.failWire=true;f.stale.owner.failCleanup=true;}
  try{
    f.broadcast();
    for(let i=0;i<100&&!f.stale.connection.isClosed;i++)await new Promise(r=>setImmediate(r));
    assert.equal(f.stale.connection.isClosed,true);assert.equal(f.physicalCloses(),0);
    assert.equal(f.stale.count(),1);assert.equal(f.healthy.count(),2);
    f.broadcast();await new Promise(r=>setImmediate(r));assert.equal(f.healthy.count(),3);
    if(failure==='wire-and-cleanup')await assert.rejects(f.server.close());
  }finally{f.stale.owner.failCleanup=false;await f.server.close();}
  assert.equal(f.stale.owner.cleaned,1);
});

test('late async preparation cannot project or deliver after connection close',async()=>{
 let pause=false,release!:()=>void,reached!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{reached=resolve;});
 const f=await fixture(async id=>{if(pause&&id==='stale'){reached();await gate;}});
 try{
  pause=true;f.broadcast();await started;f.stale.connection.close();f.stale.owner.revoked=true;
  release();await new Promise(r=>setImmediate(r));
  assert.equal(f.stale.count(),1);assert.equal(f.healthy.count(),2);assert.equal(f.physicalCloses(),0);
  assert.equal(f.stale.owner.cleaned,1);
 }finally{release();await f.server.close();}
});
