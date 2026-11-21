import { bindRemoteBrowserInput } from '../../apps/workbench-web/src/browser/remote-browser-input-runtime';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserService } from '../../apps/headless-server/src/remote-browser-service.mjs';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';
const tick = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
const deferred = () => { let resolve!: (value?:any)=>void, reject!: (e:Error)=>void; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {resolve,reject,promise}; };
function serviceFixture() {
  const service:any=Object.create(RemoteBrowserService.prototype), viewer={visible:true};
  const page:any={id:'page',live:true,closing:false,painted:false,viewers:new Map([[{},viewer]])};
  return {service,page,viewer};
}
test('native visibility retries a failed setter and converges to the newest intent in one flight',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {service,page,viewer}=serviceFixture(), first=deferred(), commands:boolean[]=[];
  service.request=(_id:string,_method:string,input:any)=>{commands.push(input.visible);return commands.length===1?first.promise:Promise.resolve();};
  const applying=service.visibility(page);assert.equal(page.painted,false,'pending is not applied');
  viewer.visible=false;assert.equal(service.visibility(page),applying);
  first.reject(new Error('transient'));await tick();assert.equal(page.painted,null);
  t.mock.timers.tick(200);await applying;assert.deepEqual(commands,[true,false]);assert.equal(page.painted,false);
});
test('visibility failure is bounded; close wakes backoff and old native ACK cannot change a replacement',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {service,page}=serviceFixture();let calls=0;
  service.request=async()=>{calls++;throw Error('transient');};
  const failed=service.visibility(page);const check=assert.rejects(failed,{code:'BROWSER_UNAVAILABLE',retryable:true});
  await tick();for(const ms of [200,400,800]){t.mock.timers.tick(ms);await tick();}await check;assert.equal(calls,4);assert.equal(page.painted,null);
  const old=deferred();service.request=()=>old.promise;const stale=service.visibility(page);
  service.resetVisibility(page);service.request=async()=>{};await service.visibility(page);assert.equal(page.painted,true);
  old.resolve();await stale;assert.equal(page.painted,true);
  page.painted=false;service.request=async()=>{throw Error('transient');};const closing=service.visibility(page);await tick();
  page.closing=true;service.resetVisibility(page);await closing;assert.equal(page.visibilityWake,null);
});
function clientFixture(t:any) {
  t.mock.timers.enable({apis:['setTimeout']});
  const host:any=Object.create(RemoteBrowserSurfaceHost.prototype), errors:string[]=[], calls:any[]=[];
  host.root={};host.inputFailed=false;host.controlListeners=new Set();host.keyboardListeners=new Set();host.retireMenu=()=>{};
  const p:any={closed:false,visible:true,opened:true,control:{epoch:1,controller:true,kind:'human',token:'human'},controlGeneration:0,
    gestureActive:false,resizing:false,viewportMeasured:true,resizeTimer:null,connection:1,sentViewport:'',viewport:{width:390,height:600,deviceProfile:'iphone'},
    resetPointers(){},resetInput(){},events:{onError:(e:string)=>errors.push(e)}};
  host.call=async(_p:any,method:string,input:any)=>{calls.push({method,input});};
  return {host,p,errors,calls};
}
test('viewport failed ACK retries same size, coalesces changes and never caches a failed target',async t=>{
  const {host,p,calls}=clientFixture(t);const first=deferred();
  host.call=(_p:any,method:string,input:any)=>{calls.push({method,input});return calls.length===1?first.promise:Promise.resolve();};
  host.queueViewport(p);t.mock.timers.tick(100);await tick();assert.equal(p.sentViewport,'');
  first.reject(Error('transient'));await tick();assert.equal(p.sentViewport,'');
  t.mock.timers.tick(200);await tick();assert.equal(calls.length,2);assert.equal(p.sentViewport,JSON.stringify(p.viewport));
  p.viewport={...p.viewport,height:500};const active=deferred();host.call=(_p:any,_m:string,input:any)=>{calls.push({input});return active.promise;};
  host.queueViewport(p);t.mock.timers.tick(100);await tick();p.viewport={...p.viewport,height:450};host.queueViewport(p);
  host.call=async(_p:any,_m:string,input:any)=>{calls.push({input});};active.resolve();await tick();t.mock.timers.tick(100);await tick();
  assert.equal(calls.at(-1).input.height,450);assert.equal(p.sentViewport,JSON.stringify(p.viewport));
});
test('viewport recovery stops at a bounded failure count and old connection ACK never overwrites new state',async t=>{
  const {host,p,errors}=clientFixture(t);let attempts=0;host.call=async()=>{attempts++;throw Error('transient');};
  host.queueViewport(p);for(const ms of [100,200,400,800,10000]){t.mock.timers.tick(ms);await tick();}
  assert.equal(attempts,4);assert.equal(p.sentViewport,'');assert.equal(errors.length,1);
  p.resizeRetry=undefined;const old=deferred();host.call=()=>old.promise;host.queueViewport(p);t.mock.timers.tick(100);await tick();
  ++p.connection;p.resizing=false;p.sentViewport='replacement';old.resolve();await tick();assert.equal(p.sentViewport,'replacement');
});
function documentFixture(t:any) {
  const originals=new Map(['document','window','cancelAnimationFrame'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const doc:any=new EventTarget();doc.hidden=false;doc.activeElement=null;const win=new EventTarget();
  for(const [key,value] of Object.entries({document:doc,window:win,cancelAnimationFrame(){}}))Object.defineProperty(globalThis,key,{configurable:true,value});
  t.after(()=>{for(const [k,d] of originals)if(d)Object.defineProperty(globalThis,k,d);else delete (globalThis as any)[k];});
  return doc;
}
test('real input binding hides the viewer, retires late human grants, and foreground never reacquires',async t=>{
  const doc=documentFixture(t), {host,p}=clientFixture(t), commands:any[]=[];
  const canvas:any=new EventTarget();canvas.hasPointerCapture=()=>false;
  const receiver:any=new EventTarget();Object.assign(receiver,{value:'',blur(){},setAttribute(){}});
  Object.assign(p,{canvas,receiver,watching:true,container:{dataset:{},style:{pointerEvents:'auto'}},editor:null});
  host.pages=new Map([['page',p]]);host.localMenu={retire(){}};host.run=(_p:any,method:string,input:any)=>commands.push({method,input});
  host.rawCall=async(_p:any,method:string,input:any)=>{commands.push({method,input});return {epoch:2,active:false,controller:false,kind:null};};
  const dispose=bindRemoteBrowserInput(host,p);doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));await tick();
  assert.equal(host.acceptsInput(p),false);assert.equal(p.control.controller,false);
  assert(commands.some(c=>c.method==='visible'&&!c.input.visible));assert(commands.some(c=>c.method==='control'&&c.input.action==='release'));
  doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await tick();assert.equal(p.control.controller,false);
  assert.equal(commands.filter(c=>c.method==='control'&&c.input.action==='human').length,0);
  const grant=deferred();host.rawCall=(_p:any,method:string,input:any)=>{commands.push({method,input});return method==='control'&&input.action==='human'?grant.promise:Promise.resolve({epoch:4,active:false,controller:false,kind:null});};
  const acquiring=host.acquireControl(p,'human');const rejected=assert.rejects(acquiring,{code:'CONTROL_LOST'});
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));
  const late={epoch:3,active:true,controller:true,kind:'human',token:'late'};host.setControl(p,late);grant.resolve(late);await rejected;
  assert.equal(p.control.controller,false,'even a late grant after foreground belongs to retired intent');dispose();
});
test('background lifecycle preserves Agent control and pointer geometry waits for a complete frame',t=>{
  const doc=documentFixture(t), {host,p}=clientFixture(t);let released=0;
  Object.assign(p,{hasPaint:false,paintWaiters:new Set(),watching:true,control:{epoch:1,controller:true,kind:'agent',token:'agent'},container:{dataset:{},style:{pointerEvents:'auto'}},
    receiver:{blur(){},value:'',setAttribute(){}},canvas:{width:1280,height:720,getContext:()=>({drawImage(){}})}});
  host.run=()=>{};host.rawCall=()=>{released++;return Promise.resolve();};host.syncVisibility(p);
  doc.hidden=true;host.syncVisibility(p);assert.equal(p.control.token,'agent');assert.equal(released,0);
  doc.hidden=false;host.syncVisibility(p);assert.equal(p.control.token,'agent');
  p.awaitingFrame=true;assert.equal(host.acceptsPointer(p),false);p.width=390;p.height=600;
  host.paintFrame(p,{},1280,720);assert.equal(host.acceptsPointer(p),false);
  host.paintFrame(p,{},390,600);assert.equal(host.acceptsPointer(p),true);
});


test('presentation waits for a drawable frame; abort retires only its own waiter', async () => {
  const host: any = Object.create(RemoteBrowserSurfaceHost.prototype);
  const page: any = {hasPaint:false,paintWaiters:new Set(),ready:Promise.resolve(),closed:false,
    container:{dataset:{}},canvas:{width:390,height:600,getContext:()=>({drawImage(){}})},width:390,height:600};
  host.require=()=>page;
  const port=host.presentationPort('page');
  const first=new AbortController(),second=new AbortController();
  let usable=false;
  const cancelled=port.whenPainted(first.signal);
  const live=port.whenPainted(second.signal).then(()=>{usable=true;});
  await page.ready; await Promise.resolve();
  assert.equal(usable,false,'connection readiness cannot stand in for a decoded frame');
  assert.equal(page.paintWaiters.size,2);
  first.abort();await cancelled;assert.equal(page.paintWaiters.size,1);
  assert.equal(usable,false);
  host.paintFrame(page,{},390,600);await live;
  assert.equal(usable,true);assert.equal(page.paintWaiters.size,0);
  assert.equal(page.container.dataset.browserPainted,"true");
  await port.whenPainted(new AbortController().signal);
  assert.equal(page.paintWaiters.size,0,'an existing painted backing needs no second wait');
});


test('idle AI presentation resizes without taking input control and deferral cannot poll', async t => {
  const {host,p,calls}=clientFixture(t);
  Object.assign(p,{layoutViewport:true,control:{epoch:1,active:false,controller:false,kind:null}});
  host.acquireControl=()=>assert.fail('presentation cannot acquire input control');
  host.call=async(_p:any,method:string,input:any)=>{calls.push({method,input});return {deferred:true};};
  host.queueViewport(p);t.mock.timers.tick(100);await tick();
  assert.equal(calls[0].method,'layoutViewport');assert.equal(p.viewportDeferred,true);
  t.mock.timers.tick(10000);await tick();assert.equal(calls.length,1,'a nonleader waits for a real state change');
  host.call=async(_p:any,method:string,input:any)=>{calls.push({method,input});return {deferred:false};};
  host.setControl(p,{epoch:1,active:false,controller:false,kind:null});
  t.mock.timers.tick(100);await tick();assert.equal(calls.length,2);assert.equal(p.sentViewport,JSON.stringify(p.viewport));
});

test('AI execution freezes layout and its release applies the measured panel height', async t => {
  const {host,p,calls}=clientFixture(t);
  Object.assign(p,{layoutViewport:true,control:{epoch:2,active:true,controller:false,kind:'agent'},viewport:{width:1280,height:1040,deviceProfile:'desktop'}});
  host.queueViewport(p);t.mock.timers.tick(1000);await tick();assert.equal(calls.length,0);
  host.setControl(p,{epoch:3,active:false,controller:false,kind:null});
  t.mock.timers.tick(100);await tick();assert.equal(calls[0].method,'layoutViewport');assert.equal(calls[0].input.height,1040);
});

test('a control change during a queued resize cannot strand the idle viewport', async t => {
  const {host,p,calls}=clientFixture(t);p.layoutViewport=true;
  host.queueViewport(p);
  p.control={epoch:2,active:false,controller:false,kind:null};
  t.mock.timers.tick(100);await tick();t.mock.timers.tick(100);await tick();
  assert.equal(calls.length,1);assert.equal(calls[0].method,'layoutViewport');
});

test('old gateways do not receive idle layout commands', async t => {
  const {host,p,calls}=clientFixture(t);p.control={epoch:0,active:false,controller:false,kind:null};
  host.queueViewport(p);t.mock.timers.tick(1000);await tick();assert.equal(calls.length,0);
});
