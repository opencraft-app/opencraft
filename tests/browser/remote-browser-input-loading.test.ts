import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';
const deferred=()=>{let resolve!: (v:any)=>void,reject!:(e:Error)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
function fixture(){
 const host:any=Object.create(RemoteBrowserSurfaceHost.prototype), loading=deferred();let loads=0,binds=0,syncs=0;
 const p:any={id:'page',mediaRuntime:{},closed:false,inputBound:false,inputReady:null,connection:1,inputDispose:()=>{}};
 Object.assign(host,{pages:new Map([[p.id,p]]),inputFailed:false,loadInputRuntime:()=>{loads++;return loading.promise},syncVisibility:()=>{syncs++}});
 const runtime={bindRemoteBrowserInput:()=>{binds++;return ()=>{}}};
 return {host,p,loading,runtime,counts:()=>({loads,binds,syncs})};
}
test('input code is demand loaded and binds once per page across concurrent connection waiters',async()=>{
 const f=fixture();assert.deepEqual(f.counts(),{loads:0,binds:0,syncs:0});
 const first=f.host.ensureInputBound(f.p),second=f.host.ensureInputBound(f.p);assert.equal(first,second);
 f.loading.resolve(f.runtime);await first;assert.equal(f.p.inputBound,true);
 await f.host.ensureInputBound(f.p);assert.deepEqual(f.counts(),{loads:1,binds:1,syncs:1});
});
for(const reason of ['closed','failure','replacement'])test('late input code cannot bind after '+reason,async()=>{
 const f=fixture(),pending=f.host.ensureInputBound(f.p);
 if(reason==='closed')f.p.closed=true;
 if(reason==='failure'){f.host.inputFailed=true;f.host.storageError=Error('metadata failed')}
 if(reason==='replacement')f.host.pages.set(f.p.id,{id:f.p.id});
 const rejected=assert.rejects(pending,/closed|metadata failed/);f.loading.resolve(f.runtime);await rejected;
 assert.equal(f.counts().binds,0);assert.equal(f.p.inputBound,false);
});
test('failed code load is actionable and an explicit retry may load again',async()=>{
 const f=fixture(),pending=f.host.ensureInputBound(f.p),rejected=assert.rejects(pending,/chunk unavailable/);
 f.loading.reject(Error('chunk unavailable'));await rejected;assert.equal(f.p.inputReady,null);assert.equal(f.p.inputBound,false);
 f.host.loadInputRuntime=async()=>f.runtime;await f.host.ensureInputBound(f.p);assert.equal(f.counts().binds,1);
});
test('replaced connection cannot open a socket when shared input preparation finishes',async()=>{
 const f=fixture(),pending=f.host.connectTransport(f.p,1),rejected=assert.rejects(pending,/superseded/);
 f.p.connection=2;f.loading.resolve(f.runtime);await rejected;
 assert.equal(f.counts().binds,1,'binding belongs to the still-live page, not the retired socket');
 assert.equal(f.p.inputBound,true);
});
test('transport never opens while input preparation is pending or failed',async()=>{
 const f=fixture(),pending=f.host.connectTransport(f.p,1),rejected=assert.rejects(pending,/chunk unavailable/);
 assert.equal(f.p.socket,undefined);assert.equal(f.counts().binds,0);
 f.loading.reject(Error('chunk unavailable'));await rejected;assert.equal(f.p.socket,undefined);
});
