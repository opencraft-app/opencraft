import test from 'node:test';
import assert from 'node:assert/strict';
import type { DuplexTransport, TransportStatus } from '@opencraft/appserver-client/transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { WORKSPACE_FILE_SCOPE_METHOD,WORKSPACE_CATALOG_METHOD,WORKSPACE_PLACEMENT_EXTENSION,OPENCRAFT_METHOD_ACCESS_EXTENSION } from '@opencraft/appserver-protocol';
import { HostWorkspaceCatalogTransport } from '../../../../scripts/host-workspace-catalog-transport';
const catalog={version:1 as const,environments:[],libraries:[]};
function fixture(t:test.TestContext,read:ConstructorParameters<typeof HostWorkspaceCatalogTransport>[1], scope?:ConstructorParameters<typeof HostWorkspaceCatalogTransport>[2]){
 let status:TransportStatus={state:'open'};
 const messages=new Set<(frame:string)=>void>(),statuses=new Set<(s:TransportStatus)=>void>(),forwarded:any[]=[],responses:any[]=[];
 const inner:DuplexTransport={get status(){return status},async connect(){},async close(){},
  subscribeMessage(l){messages.add(l);return()=>{messages.delete(l)}},subscribeStatus(l){statuses.add(l);return()=>{statuses.delete(l)}},
  async send(frame){forwarded.push(JSON.parse(frame))}};
 const transport=new HostWorkspaceCatalogTransport(inner,read,scope);transport.subscribeMessage(f=>responses.push(JSON.parse(f)));t.after(()=>transport.close());
 const initialize=async(client='a')=>{
  await transport.send(JSON.stringify({id:'init',method:'initialize',params:{},[LOGICAL_CLIENT_FIELD]:client}));
  for(const l of messages)l(JSON.stringify({id:'init',result:{capabilities:{extensions:{[OPENCRAFT_METHOD_ACCESS_EXTENSION]:{methods:['thread/start']}}}},[LOGICAL_CLIENT_FIELD]:client}));
 };
 const request=(id:string,context:any={sender:null},params:unknown={},client='a',signal?:AbortSignal)=>transport.sendWithContext(
  JSON.stringify({id,method:WORKSPACE_CATALOG_METHOD,params,[LOGICAL_CLIENT_FIELD]:client}),context,signal);
 return {transport,initialize,request,responses,forwarded,disconnect(){
  status={state:'closed'};for(const l of statuses)l(status);status={state:'open'};for(const l of statuses)l(status);
 }};
}
test('configured ingress advertises only after matching logical initialization and routes catalog without Native',async t=>{
 const context={sender:null},f=fixture(t,async c=>{assert.strictEqual(c,context);return catalog});
 await f.initialize();
 const ext=f.responses[0].result.capabilities.extensions;
 assert.deepEqual(ext[WORKSPACE_PLACEMENT_EXTENSION],{version:1});
 assert.ok(ext[OPENCRAFT_METHOD_ACCESS_EXTENSION].methods.includes(WORKSPACE_CATALOG_METHOD));
 await f.request('read',context);assert.deepEqual(f.responses.at(-1).result,catalog);
 assert.equal(f.forwarded.length,1);
 await f.request('foreign',context,{},'b');assert.ok(f.responses.at(-1).error);
});
test('catalog errors are generic and caller identity/path parameters cannot change scope',async t=>{
 let reads=0;const f=fixture(t,async()=>{reads++;throw Error('secret fixture')});await f.initialize();
 await f.request('bad',{sender:null},{principalId:'other',path:'/shared'});
 assert.equal(reads,0);
 await f.request('read');assert.equal(reads,1);
 assert.equal(JSON.stringify(f.responses).includes('secret fixture'),false);
 await f.request('expired',{sender:null,validUntil:0});assert.equal(reads,1);
});
test('disconnect and aborted requests cannot deliver catalog into a successor client',async t=>{
 let release!:(value:typeof catalog)=>void,entered!:()=>void;
 const started=new Promise<void>(r=>entered=r);
 const f=fixture(t,()=>{entered();return new Promise(r=>release=r)});await f.initialize();
 const pending=f.request('old');await started;f.disconnect();await f.initialize();release(catalog);await pending;
 assert.equal(f.responses.some(r=>r.id==='old'),false);
 const abort=new AbortController();abort.abort();
 await assert.rejects(f.request('cancelled',{sender:null},{},'a',abort.signal));
 assert.equal(f.responses.some(r=>r.id==='cancelled'),false);
});
test('request owner retirement after reading suppresses success',async t=>{
 let live=true;
 const f=fixture(t,async()=>{live=false;return catalog});await f.initialize();
 await f.request('retired',{sender:null,resourceOwner:{id:'test',assertCurrent(){if(!live)throw Error('retired')}}});
 assert.ok(f.responses.at(-1).error);assert.equal(f.responses.at(-1).result,undefined);
});


test('outer consumers retain epoch-scoped delivery guards across reconnect',async t=>{
 const f=fixture(t,async()=>catalog);await f.initialize();
 const old=f.transport.captureMessageScope();assert.equal(old(),true);
 f.disconnect();await f.initialize();
 assert.equal(old(),false);assert.equal(f.transport.captureMessageScope()(),true);
 await f.transport.close();assert.equal(old(),false);
});

test('concurrent closes share the actual pending inner disposal',async()=>{
 let release!:()=>void,closes=0;
 const gate=new Promise<void>(r=>release=r);
 const inner:DuplexTransport={status:{state:'open'},async connect(){},async send(){},
  subscribeMessage(){return()=>{}},subscribeStatus(){return()=>{}},async close(){closes++;await gate}};
 const transport=new HostWorkspaceCatalogTransport(inner,async()=>catalog);
 const first=transport.close(),second=transport.close();
 try{
  assert.strictEqual(first,second);assert.equal(closes,1);
  let finished=false;void second.then(()=>{finished=true});
  await Promise.resolve();assert.equal(finished,false);
 }finally{release();await first}
});


test('file scope uses admitted callback, declares implemented capability and rejects caller authority', async t=>{
 const context={sender:null};let reads=0;
 const f=fixture(t,async()=>catalog,async(c,id)=>{assert.strictEqual(c,context);reads++;return {kind:'workspace',threadId:id,root:'/workspace'};});
 await f.initialize();
 assert.equal(f.responses[0].result.capabilities.extensions[WORKSPACE_PLACEMENT_EXTENSION].fileScopeVersion,1);
 const request=(id:string,params:unknown)=>f.transport.sendWithContext(JSON.stringify({id,method:WORKSPACE_FILE_SCOPE_METHOD,params,[LOGICAL_CLIENT_FIELD]:'a'}),context);
 await request('scope',{threadId:'thread-a'});
 assert.deepEqual(f.responses.at(-1).result,{kind:'workspace',threadId:'thread-a',root:'/workspace'});
 await request('injection',{threadId:'thread-a',principalId:'alice'});
 assert.ok(f.responses.at(-1).error);assert.equal(reads,1);assert.equal(f.forwarded.length,1);
});
test('file scope never falls through Native when unconfigured and retires delayed replies', async t=>{
 const local=fixture(t,async()=>catalog);await local.initialize();
 await local.transport.send(JSON.stringify({id:'no-scope',method:WORKSPACE_FILE_SCOPE_METHOD,params:{threadId:'x'},[LOGICAL_CLIENT_FIELD]:'a'}));
 assert.ok(local.responses.at(-1).error);assert.equal(local.forwarded.length,1);
 let release!:(v:{kind:'host'})=>void,started!:()=>void;const entered=new Promise<void>(r=>started=r);
 const f=fixture(t,async()=>catalog,()=>{started();return new Promise(r=>release=r)});await f.initialize();
 const work=f.transport.send(JSON.stringify({id:'old-scope',method:WORKSPACE_FILE_SCOPE_METHOD,params:{threadId:'x'},[LOGICAL_CLIENT_FIELD]:'a'}));
 await entered;f.disconnect();await f.initialize();release({kind:'host'});await work;
 assert.equal(f.responses.some(x=>x.id==='old-scope'),false);
});
