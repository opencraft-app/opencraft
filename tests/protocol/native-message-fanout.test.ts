import assert from 'node:assert/strict';
import test from 'node:test';
import { messageAdapters, nativeMessageFixture, messageHostFixture, flushMessages } from './fixtures/native-message';

for(const kind of messageAdapters) {
  test(`${kind} message observer exceptions cannot block peers or fail native transport`,async()=>{
    const f=nativeMessageFixture(kind),seen:string[]=[];
    f.transport.subscribeMessage(()=>{throw Error('external observer');});f.transport.subscribeMessage(frame=>seen.push(frame));
    try{await f.connect();await f.publish('a');await f.publish('b');assert.deepEqual(seen,['a','b']);assert.equal(f.transport.status.state,'open');assert.deepEqual(f.driverErrors,[]);}finally{await f.close();}
  });
  test(`${kind} observers added during a frame enter the next publication`,async()=>{
    const f=nativeMessageFixture(kind),seen:string[]=[];let added=false;
    f.transport.subscribeMessage(()=>{if(!added){added=true;f.transport.subscribeMessage(frame=>seen.push(frame));}});
    try{await f.connect();await f.publish('a');assert.deepEqual(seen,[]);await f.publish('b');assert.deepEqual(seen,['b']);}finally{await f.close();}
  });
  test(`${kind} same-function replacement is outside the admitted cut`,async()=>{
    const f=nativeMessageFixture(kind),seen:string[]=[];let replaced=false,remove=()=>{};
    const listener=(frame:string)=>seen.push(frame);
    f.transport.subscribeMessage(()=>{if(!replaced){replaced=true;remove();remove=f.transport.subscribeMessage(listener);}});
    remove=f.transport.subscribeMessage(listener);
    try{await f.connect();await f.publish('a');assert.deepEqual(seen,[]);await f.publish('b');assert.deepEqual(seen,['b']);}finally{remove();await f.close();}
  });
  test(`${kind} obsolete unsubscribe cannot remove a same-function successor`,async()=>{
    const f=nativeMessageFixture(kind),seen:string[]=[];const listener=(frame:string)=>seen.push(frame);
    const old=f.transport.subscribeMessage(listener),duplicate=f.transport.subscribeMessage(listener);old();const current=f.transport.subscribeMessage(listener);duplicate();duplicate();
    try{await f.connect();await f.publish('a');assert.deepEqual(seen,['a']);}finally{current();await f.close();}
  });
  test(`${kind} preserves live same-function deduplication and bare callback receiver`,async()=>{
    const f=nativeMessageFixture(kind),seen:unknown[]=[];
    const callback=function(this:unknown){seen.push(this);};f.transport.subscribeMessage(callback);f.transport.subscribeMessage(callback);
    try{await f.connect();await f.publish('a');assert.deepEqual(seen,[undefined]);}finally{await f.close();}
  });
  test(`${kind} close during a frame revokes remaining data delivery`,async()=>{
    const f=nativeMessageFixture(kind),seen:string[]=[];let closing:Promise<void>|undefined;
    f.transport.subscribeMessage(()=>{closing=f.transport.close();void closing.catch(()=>{});});f.transport.subscribeMessage(frame=>seen.push(frame));
    try{await f.connect();await f.publish('a');await closing;assert.deepEqual(seen,[]);}finally{await f.close();}
  });
  test(`${kind} native successor during a frame revokes old data even on a reused delegate`,async()=>{
    const f=nativeMessageFixture(kind),seen:string[]=[];let next:Promise<void>|undefined,entered=false;
    f.transport.subscribeMessage(()=>{if(!entered){entered=true;next=f.beginRenew();}});f.transport.subscribeMessage(frame=>seen.push(frame));
    try{await f.connect();await f.publish('a');assert.deepEqual(seen,[]);assert.ok(next);await f.finishRenew(next);await f.publish('b');assert.deepEqual(seen,['b']);}finally{await f.close();await next?.catch(()=>{});}
  });
}
for(const kind of ['memory','websocket','deferred'] as const) test(`${kind} cut is admitted at scheduled or decoded publication`,async()=>{
  const f=nativeMessageFixture(kind),seen:string[]=[];
  try{await f.connect();f.enqueue('a');f.transport.subscribeMessage(frame=>seen.push(frame));await f.flush();assert.deepEqual(seen,['a']);}finally{await f.close();}
});

test('parent Host frame observer exception cannot hide data from channel',async()=>{
  const f=messageHostFixture(),seen:string[]=[];f.client.subscribeHost('a',event=>{if(event.frame)throw Error('parent observer');});const transport=f.client.createTransport('a');transport.subscribeMessage(frame=>seen.push(frame));
  try{await transport.connect();assert.doesNotThrow(()=>f.frame('a','a'));assert.deepEqual(seen,['a']);}finally{await transport.close();f.client.close();}
});
test('parent Host terminal observer exception cannot strand any live Host',async()=>{
  const f=messageHostFixture();f.client.subscribeHost('a',event=>{if(event.terminalReason)throw Error('parent observer');});const a=f.client.createTransport('a'),b=f.client.createTransport('b');
  try{await a.connect();await b.connect();assert.doesNotThrow(()=>f.client.close());assert.equal(f.closed,true);assert.equal(a.status.state,'failed');assert.equal(b.status.state,'failed');}finally{await a.close();await b.close();try{f.client.close();}catch{}}
});
test('parent Host obsolete bucket handle cannot delete the successor bucket',()=>{
  const f=messageHostFixture(),seen:string[]=[];const listener=(event:{frame?:string})=>{if(event.frame)seen.push(event.frame);};
  const old=f.client.subscribeHost('a',listener),duplicate=f.client.subscribeHost('a',listener);old();const current=f.client.subscribeHost('a',listener);duplicate();
  try{f.receive({type:'host/frame',hostId:'a',generation:1,frame:'a'});assert.deepEqual(seen,['a']);}finally{current();f.client.close();}
});
test('parent bridge close during a frame suppresses remaining old data',async()=>{
  const f=messageHostFixture(),seen:string[]=[];f.client.subscribeHost('a',event=>{if(event.frame)f.client.close();});const transport=f.client.createTransport('a');transport.subscribeMessage(frame=>seen.push(frame));
  try{await transport.connect();f.frame('a','a');assert.deepEqual(seen,[]);assert.equal(transport.status.state,'failed');}finally{await transport.close();f.client.close();}
});
test('WebSocket native decode failure still fails its current native connection',async()=>{
  const f=nativeMessageFixture('websocket');
  try{await f.connect();f.sockets[0]!.emitMessage({invalid:true});await flushMessages();assert.equal(f.transport.status.state,'failed');}finally{await f.close();}
});

test('parent termination captures all Host registries before the first callback',async()=>{
  const f=messageHostFixture();let existing=0,late=0;
  f.client.subscribeHost('a',event=>{if(event.terminalReason)f.client.subscribeHost('b',()=>{late++;});});
  f.client.subscribeHost('b',event=>{if(event.terminalReason)existing++;});
  f.client.close();assert.equal(existing,1);assert.equal(late,0);
});

test('parent terminal publication precedes a reentrant bridge termination',()=>{
  const f=messageHostFixture(),seen:string[]=[];
  f.client.subscribeHost('a',event=>{if(event.status?.state==='closed')f.client.close();});
  f.client.subscribeHost('a',event=>seen.push(event.terminalReason?'bridge-failed':event.status!.state));
  f.receive({type:'host/status',hostId:'a',generation:1,status:{state:'closed'}});
  assert.deepEqual(seen,['closed','bridge-failed']);f.client.close();
});

function heldBlob() {
  let resolve!:(data:ArrayBuffer)=>void,reject!:(cause:unknown)=>void,started=false;
  const promise=new Promise<ArrayBuffer>((done,fail)=>{resolve=done;reject=fail;});
  void promise.catch(()=>{});
  class FrameBlob extends Blob {override arrayBuffer():Promise<ArrayBuffer>{started=true;return promise;}}
  return{blob:new FrameBlob(),resolve,reject,get started(){return started;}};
}

test('WebSocket observers arriving during Blob decode enter its decoded publication',async()=>{
  const f=nativeMessageFixture('websocket'),frame=heldBlob(),seen:string[]=[];
  try{
    await f.connect();f.sockets[0]!.emitMessage(frame.blob);await flushMessages();assert.equal(frame.started,true);
    f.transport.subscribeMessage(value=>seen.push(value));frame.resolve(new TextEncoder().encode('a').buffer);await flushMessages();assert.deepEqual(seen,['a']);
  }finally{frame.resolve(new ArrayBuffer(0));await f.close();}
});
for(const outcome of ['success','failure'] as const)test(`WebSocket retired Blob ${outcome} cannot deliver or fail its successor`,async()=>{
  const f=nativeMessageFixture('websocket'),frame=heldBlob(),seen:string[]=[];
  f.transport.subscribeMessage(value=>seen.push(value));
  try{
    await f.connect();f.sockets[0]!.emitMessage(frame.blob);await flushMessages();assert.equal(frame.started,true);
    const next=f.beginRenew();await f.finishRenew(next);await f.publish('new');
    if(outcome==='success')frame.resolve(new TextEncoder().encode('old').buffer);else frame.reject(Error('retired native decode'));
    await flushMessages();assert.deepEqual(seen,['new']);assert.equal(f.transport.status.state,'open');
  }finally{frame.resolve(new ArrayBuffer(0));await f.close();}
});

test('Deferred observed open/version cannot authorize a frame across a queued native ABA',async()=>{
  const {DeferredDuplexTransport}=await import('@opencraft/appserver-client/transport');
  const {ReplayTransport}=await import('@opencraft/appserver-transport-replay');
  const native=new ReplayTransport({match:'exact',recording:[
    {sequence:0,direction:'client-to-server',timestampMs:0,payload:'request'},
    {sequence:1,direction:'server-to-client',timestampMs:1,payload:'old'},
  ]});
  const transport=new DeferredDuplexTransport(async()=>native),seen:string[]=[],operations:Promise<unknown>[]=[];let entered=false;
  transport.subscribeStatus(status=>{if(status.state==='open'&&!entered){entered=true;const sent=native.send('request');void sent.catch(()=>{});operations.push(sent);}});
  transport.subscribeMessage(()=>{const closing=native.close(),next=native.connect();void next.catch(()=>{});operations.push(closing,next);});
  transport.subscribeMessage(frame=>seen.push(frame));
  try{await transport.connect().catch(()=>{});assert.deepEqual(seen,[]);}finally{await Promise.allSettled(operations);await transport.close();}
});

test('Recording attachment identity cannot authorize a frame after native peer replacement',async()=>{
  const {RecordingTransport}=await import('@opencraft/appserver-transport-replay');
  const {MemoryTransport}=await import('@opencraft/appserver-transport-memory');
  let peer!:import('@opencraft/appserver-transport-memory').InMemoryAppServerPeer,renew:Promise<void>|undefined;
  const native=new MemoryTransport({server:{connected(next){peer=next;},receive(){}},schedule:callback=>callback()});
  const transport=new RecordingTransport({transport:native}),seen:string[]=[];
  transport.subscribeMessage(()=>{peer.close();renew=transport.connect();void renew.catch(()=>{});});transport.subscribeMessage(frame=>seen.push(frame));
  try{await transport.connect();peer.send('old');assert.deepEqual(seen,[]);}finally{await renew;await transport.close();}
});


for(const kind of messageAdapters) {
  test(`${kind} a throwing native message observer cannot strand an actual Client RPC`,async()=>{
    const {JsonRpcAppServerClient}=await import('@opencraft/appserver-client');
    const f=nativeMessageFixture(kind);let armed=false,outcome='pending';
    f.transport.subscribeMessage(()=>{if(armed)throw Error('external observer');});
    const client=new JsonRpcAppServerClient({hostId:'native-message-client',transport:f.transport,requestTimeoutMs:0});
    let request:Promise<unknown>|undefined;
    try{
      const connecting=client.connect({clientInfo:{name:'native-message-client',version:'1'}});void connecting.catch(()=>{});
      await f.connect();await f.flush();await connecting;armed=true;
      request=client.requestRaw('echo',{nonce:1}).then(()=>{outcome='resolved';},()=>{outcome='rejected';});
      await f.flush();assert.equal(outcome,'resolved');assert.equal(client.getPendingRequestCount(),0);assert.equal(f.transport.status.state,'open');assert.deepEqual(f.driverErrors,[]);
    }finally{await client.close();await f.close();await request;}
  });
  test(`${kind} a throwing terminal observer cannot hide native loss from an actual Client`,async()=>{
    const {JsonRpcAppServerClient}=await import('@opencraft/appserver-client');
    const f=nativeMessageFixture(kind);let armed=false,outcome='pending';
    const remove=f.transport.subscribeStatus(status=>{if(armed&&['closing','closed','failed'].includes(status.state))throw Error('external terminal observer');});
    const client=new JsonRpcAppServerClient({hostId:'native-loss-client',transport:f.transport,requestTimeoutMs:0});
    let request:Promise<unknown>|undefined;
    try{
      const connecting=client.connect({clientInfo:{name:'native-loss-client',version:'1'}});void connecting.catch(()=>{});
      await f.connect();await f.flush();await connecting;armed=true;
      request=client.requestRaw('held',{}).then(()=>{outcome='resolved';},()=>{outcome='rejected';});await f.flush();assert.equal(outcome,'pending');
      f.lose();await f.flush();assert.equal(outcome,'rejected');assert.equal(client.getPendingRequestCount(),0);
    }finally{remove();await client.close();await f.close();await request;}
  });
}

test('shared Host open cannot revive a retired lease or grant sends without its own acknowledgement',async()=>{
  const f=messageHostFixture(),transport=f.client.createTransport('a'),seen:string[]=[];
  transport.subscribeMessage(frame=>seen.push(frame));
  try{
    await transport.connect();const old=f.grant('a');f.lost('a');
    f.receive({type:'host/status',hostId:'a',generation:old.generation,status:{state:'open'}});f.frame('a','old');
    assert.equal(transport.status.state,'closed');assert.deepEqual(seen,[]);await assert.rejects(transport.send('forbidden'));
    await transport.connect();f.frame('a','new');assert.deepEqual(seen,['new']);
  }finally{await transport.close();f.client.close();}
});


test('Host retirement during its open publication rejects startup with its native manual failure',async()=>{
  const f=messageHostFixture(),transport=f.client.createTransport('a');let entered=false;
  transport.subscribeStatus(status=>{if(status.state==='open'&&!entered){entered=true;f.receive({type:'host/status',hostId:'a',generation:f.grant('a').generation,
    status:{state:'failed',reason:'synthetic native policy',failure:{code:'APP_HOST_POLICY',recovery:'manual'}}});}});
  try{await assert.rejects(transport.connect(),/synthetic native policy/);assert.equal(transport.status.state,'failed');assert.equal(transport.status.failure?.code,'APP_HOST_POLICY');assert.equal(transport.status.failure?.recovery,'manual');}
  finally{await transport.close();f.client.close();}
});

for(const kind of ['apphost','browser'] as const)test(`${kind} same-frame renewal conserves native retirement of a pending Client RPC`,async()=>{
  const {JsonRpcAppServerClient}=await import('@opencraft/appserver-client');
  const f=nativeMessageFixture(kind);let armed=false,entered=false,next:Promise<void>|undefined,outcome='pending',request:Promise<unknown>|undefined;
  f.transport.subscribeMessage(()=>{if(armed&&!entered){entered=true;next=f.beginRenew();}});
  const client=new JsonRpcAppServerClient({hostId:'same-frame-loss',transport:f.transport,requestTimeoutMs:0});
  try{
    const connecting=client.connect({clientInfo:{name:'same-frame-loss',version:'1'}});void connecting.catch(()=>{});await f.connect();await f.flush();await connecting;
    request=client.requestRaw('held',{}).then(()=>{outcome='resolved';},()=>{outcome='rejected';});await f.flush();assert.equal(outcome,'pending');armed=true;
    await f.publish(JSON.stringify({method:'fixture/pulse',params:{}}));assert.equal(outcome,'rejected');assert.equal(client.getPendingRequestCount(),0);assert.ok(next);
    await f.finishRenew(next);assert.equal(f.transport.status.state,'open');
  }finally{await client.close();await f.close();await next?.catch(()=>{});await request;}
});

for(const state of ['connecting','idle'] as const)test(`non-open Host ${state} invalidates an in-progress frame before queued observation`,async()=>{
  const f=messageHostFixture(),transport=f.client.createTransport('a'),seen:string[]=[];let entered=false;
  transport.subscribeMessage(()=>{if(!entered){entered=true;f.receive({type:'host/status',hostId:'a',generation:f.grant('a').generation,status:{state}});}});
  transport.subscribeMessage(frame=>seen.push(frame));
  try{await transport.connect();f.frame('a','old');assert.deepEqual(seen,[]);await transport.connect();f.frame('a','new');assert.deepEqual(seen,['new']);}
  finally{await transport.close();f.client.close();}
});
