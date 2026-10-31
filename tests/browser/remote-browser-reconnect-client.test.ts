import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveInputWindow } from '@opencraft/remote-interaction';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';

test('transient failures keep recovering past five attempts without navigation or control', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets: FakeSocket[] = [], errors: string[] = [];
  let loaded = 0;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1; sent: any[] = [];
    onopen?: () => void; onclose?: (event: { code: number; reason: string }) => void; onmessage?: (event: { data: string }) => void;
    constructor(_url: URL) { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code, reason }); }
    reply(error?: object) { this.onmessage?.({ data: JSON.stringify({type:'result',id:this.sent[0].id,error,value:error?undefined:{
      multiView:true,width:430,height:932,resumed:true,navigation:{url:'https://example.test/live',isLoading:false},
      control:{epoch:7,active:true,controller:false,kind:'human'},
    }}) }); }
  }
  const originals = new Map(['WebSocket','window','location'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for (const [key,value] of Object.entries({WebSocket:FakeSocket,window:{},location:{href:'https://example.test/'}}))
    Object.defineProperty(globalThis,key,{configurable:true,value});
  const host:any = new RemoteBrowserSurfaceHost('mse',{getItem:()=>null,setItem(){}},'proof');
  const p:any={inputPolicy:new AdaptiveInputWindow(),control:{epoch:0,active:false,controller:false,kind:null},controlGeneration:0,lease:'browser-12345678901234567890',connection:0,
    closed:false,displaced:false,viewportMeasured:false,pending:new Map(),retries:0,visible:true,navigation:0,url:'https://example.test/stale',
    events:{onError:(s:string)=>errors.push(s),onLoaded(){loaded++;},onNavigation(){}}};
  host.resetTransport=(page:any)=>{host.rejectPending(page);page.opened=false;};
  host.keyboardChanged=host.applyViewport=host.queueViewport=host.run=host.setControl=()=>{};
  const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  const connect=()=>{p.ready=host.connect(p);void p.ready.catch(()=>{});};
  try {
    connect();
    // A deployment/network outage can outlast the old five-attempt budget.
    for(let i=0;i<7;i++){
      assert.equal(sockets.length,i+1);sockets[i].close(i===2?1013:1006);await flush();
      t.mock.timers.tick(5000);await flush();
    }
    assert.equal(sockets.length,8,'recovery remains active beyond five failures');
    sockets[7].onopen?.();sockets[7].reply({code:'BROWSER_UNAVAILABLE',message:'Browser unavailable',retryable:true});await flush();
    t.mock.timers.tick(5000);await flush();assert.equal(sockets.length,9,'transient open rejection also retries');
    sockets[8].onopen?.();sockets[8].reply();await flush();await p.ready;
    assert.equal(p.opened,true);assert.equal(p.retries,0);assert.equal(loaded,1);
    assert.deepEqual(sockets[8].sent.map(x=>x.method),['open'],'recovery never navigates or claims input');
    sockets[8].close(1000);await flush();t.mock.timers.tick(5000);await flush();
    assert.equal(sockets.length,10,'generic clean transport close is not a logical Tab close');
    sockets[9].onopen?.();sockets[9].reply({code:'BROWSER_ERROR',message:'Browser page limit reached',retryable:false});await flush();
    t.mock.timers.tick(60000);await flush();assert.equal(sockets.length,10,'permanent admission failure stops retrying');
    assert.equal(errors.at(-1),'Browser page limit reached','keep the actionable cause instead of overwriting it');
    connect();sockets[10].close(1000,'Browser tab closed');await flush();t.mock.timers.tick(60000);await flush();
    assert.equal(sockets.length,11,'explicit close cannot resurrect a remote Tab');
    connect();sockets[11].close(1008,'Browser admission expired');await flush();t.mock.timers.tick(60000);await flush();
    assert.equal(sockets.length,12,'authorization failure cannot retry around admission');
    assert.equal(errors.at(-1),'Browser authorization expired; reload OpenCraft');
    connect();const generation=p.connection;sockets[12].close(1006);await flush();
    ++p.connection;p.opened=true;t.mock.timers.tick(60000);await flush();
    assert.equal(sockets.length,13,'a retired generation cannot reconnect later');assert.equal(p.connection,generation+1);
  } finally {
    p.closed=true;if(p.reconnect)clearTimeout(p.reconnect);for(const s of sockets)s.close();host.rejectPending(p);
    for(const [key,descriptor] of originals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];
  }
});

test('only authoritative closure terminates the logical tab, fenced against old connections', async t => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1; sent: any[] = [];
    onopen?: () => void; onclose?: (event: {code: number; reason: string}) => void; onmessage?: (event: {data: string}) => void;
    constructor(_url: URL) { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({code, reason}); }
    closedSession() { this.onmessage?.({data: JSON.stringify({type:'result',id:this.sent[0].id,
      error:{code:'SESSION_CLOSED',message:'Browser tab is closed',retryable:false}})}); }
  }
  const originals = new Map(['WebSocket','window','location'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for (const [key,value] of Object.entries({WebSocket:FakeSocket,window:{},location:{href:'https://example.test/'}}))
    Object.defineProperty(globalThis,key,{configurable:true,value});
  t.mock.timers.enable({apis:['setTimeout']});
  const host:any = new RemoteBrowserSurfaceHost('mse',{getItem:()=>null,setItem(){}},'proof');
  let closed = 0;
  const p:any = {inputPolicy:new AdaptiveInputWindow(),control:{epoch:0,active:false,controller:false,kind:null},controlGeneration:0,
    lease:'browser-12345678901234567890',connection:0,closed:false,displaced:false,viewportMeasured:false,pending:new Map(),retries:0,
    events:{onError(){},onLoaded(){},onSessionClosed(){closed++;}},visible:true};
  host.resetTransport=(page:any)=>host.rejectPending(page);
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  const connect=()=>{p.serverClosed=false;p.ready=host.connect(p);host.watchConnection(p);};
  try {
    connect();sockets[0].close(1006);await flush();assert.equal(closed,0);
    clearTimeout(p.reconnect);p.reconnect=null;
    connect();sockets[1].close(1008,'Browser admission expired');await flush();assert.equal(closed,0);
    connect();const previous=sockets[2];connect();
    previous.onclose?.({code:1000,reason:'Browser tab closed'});await flush();assert.equal(closed,0,'old generation cannot retire replacement');
    sockets[3].close(1000,'Browser tab closed');await flush();assert.equal(closed,1);
    connect();sockets[4].onopen?.();sockets[4].closedSession();await flush();assert.equal(closed,2,'retired lease open rejection also closes owner');
    t.mock.timers.tick(60000);await flush();assert.equal(sockets.length,5,'retirement does not silently create a fresh lease');
    p.serverClosed=false;
    p.ready=Promise.reject(Object.assign(new Error('Browser tab is closed'),{code:'SESSION_CLOSED'}));
    host.watchConnection(p);await flush();assert.equal(closed,3,'metadata fence failure before transport also reaches owner');
    p.serverClosed=false;
    let rejectOld!:(error:Error)=>void;
    p.ready=new Promise<void>((_,reject)=>{rejectOld=reject;});host.watchConnection(p);
    p.ready=Promise.resolve();rejectOld(Object.assign(new Error('old close'),{code:'SESSION_CLOSED'}));await flush();
    assert.equal(closed,3,'old metadata fence cannot close replacement connection');
  } finally {
    p.closed=true;if(p.reconnect)clearTimeout(p.reconnect);for(const socket of sockets)socket.close();host.rejectPending(p);
    for(const [key,value] of originals)if(value)Object.defineProperty(globalThis,key,value);else delete (globalThis as any)[key];
  }
});
