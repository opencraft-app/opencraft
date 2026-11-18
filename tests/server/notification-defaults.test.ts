import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {openManagedDatabase,resolveStoreMigrations} from '@opencraft/sqlite-node';
import {PushStore,openPushStore,TurnPushService,type PushBinding} from '@opencraft/web-push-node';
const binding:PushBinding={context:{actorId:'human-a',credentialId:null,generation:1,expiresAt:Date.now()+86400000}};
const messages={completed:'Complete',failed:'Failed',interrupted:'Stopped',body:'Return',test:'Test'};
const target={kind:'im' as const,channelId:'product.connection',senderId:'self',label:'My account',methodId:'product.method'};
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'notification-defaults-'));return {path:join(dir,'push.sqlite'),remove:()=>rmSync(dir,{force:true,recursive:true})};};
const initialize=(store:any,actor=binding,selected=target,policy='product.default')=>store.initializeDefault(actor,policy,selected,'https://workbench.example','','en-US',messages);

test('default decision and target persist per Actor/policy; disabled or deleted destinations never resurrect after restart or relogin',()=>{
 const f=fixture();let store=new PushStore(f.path);
 try{
  initialize(store);initialize(store);assert.equal(store.devices('human-a').length,1);
  const id=store.devices('human-a')[0]!.id;
  store.setEnabled(id,'human-a',false);store.close();store=new PushStore(f.path);
  initialize(store,{context:{...binding.context,generation:2}});assert.equal(store.get(id)?.enabled,false);
  store.remove(id,'human-a');store.prune();store.close();store=new PushStore(f.path);
  initialize(store);initialize(store,binding,{...target,senderId:'changed-binding'});assert.equal(store.devices('human-a').length,0);
  initialize(store,{context:{...binding.context,actorId:'human-b'}});assert.equal(store.devices('human-b').length,1);
 }finally{store.close();f.remove();}
});

test('pre-initialization master off/on, target off/on/removal and manual duplicates preserve consent',()=>{
 for(const action of ['master','disabled','removed','manual','retargeted']){
  const f=fixture(),store=new PushStore(f.path);
  try{
   if(action==='master'){store.setMaster('human-a',false);store.setMaster('human-a',true);}
   else{
    const saved=store.saveTarget(binding,target,'https://workbench.example','','en-US',messages);
    if(action==='disabled')store.setEnabled(saved.id,'human-a',false);
    if(action==='removed')store.remove(saved.id,'human-a');
    if(action==='retargeted')store.saveTarget(binding,{...target,senderId:'other'},'https://workbench.example','','en-US',messages,saved.id);
   }
   initialize(store);
   const rows=store.devices('human-a');assert.equal(rows.length,action==='master'||action==='removed'?0:1,action);
   if(action==='disabled')assert.equal(rows[0]!.enabled,false);
   if(action==='retargeted')assert.equal((rows[0]!.target as any).senderId,'other');
   initialize(store,binding,target,'new-policy');assert.equal(store.devices('human-a').length,rows.length,action);
  }finally{store.close();f.remove();}
 }
});

test('two independent Workers serialize initialize once and deletion; device limit rolls back the decision for later retry',async()=>{
 const f=fixture(),a=await openPushStore(f.path),b=await openPushStore(f.path);
 try{
  await Promise.all(Array.from({length:12},(_,i)=>initialize(i%2?a:b)));
  assert.equal((await a.devices('human-a')).length,1);
  const id=(await a.devices('human-a'))[0]!.id;
  await Promise.all([a.remove(id,'human-a'),initialize(b)]);assert.equal((await b.devices('human-a')).length,0);
  const other={context:{...binding.context,actorId:'human-b'}};
  for(let i=0;i<16;i++)await a.saveTarget(other,{...target,senderId:'manual-'+i},'https://workbench.example','','en-US',messages);
  await assert.rejects(initialize(a,other));
  await a.remove((await a.devices('human-b'))[0]!.id,'human-b');await initialize(b,other);
  assert.equal((await b.devices('human-b')).filter(d=>(d.target as any)?.senderId==='self').length,1);
 }finally{await a.close();await b.close();f.remove();}
});

test('schema 2 upgrade preserves master opt-out history while adding durable decisions',()=>{
 const f=fixture();try{
  const source=readFileSync(new URL('../../packages/web-push-node/src/store.ts',import.meta.url),'utf8');
  const sql=(name:string)=>source.match(new RegExp('const '+name+' = `([\\s\\S]*?)`\\.trim\\(\\);'))![1]!.trim();
  const db=openManagedDatabase({path:f.path,migrations:[{version:1,name:'web-push-subscriptions-and-outbox',sql:sql('SCHEMA')},...resolveStoreMigrations('web-push-node',[{version:1,name:'web-push-subscriptions-and-outbox',sql:sql('SCHEMA')}]).slice(1,2)]});
  db.database.prepare('INSERT INTO push_preferences VALUES(?,?)').run('human-a',0);db.database.close();
  const store=new PushStore(f.path);try{assert.equal(store.outcome.appliedVersion,3);assert.equal(store.master('human-a'),false);store.setMaster('human-a',true);initialize(store);assert.equal(store.devices('human-a').length,0);}finally{store.close();}
 }finally{f.remove();}
});

test('GET is read-only; defaults POST defers readiness, uses trusted targets, fences account/origin changes and never sends a notification',async()=>{
 const f=fixture(),store=await openPushStore(f.path);let ready=false,current=true,actor=binding,policyCalls=0;
 let release:(()=>void)|undefined,hold:Promise<void>|undefined;
 const service=new TurnPushService(store,{authenticate:()=>actor,current:()=>current,trustedOrigin:()=> 'https://workbench.example',hosts:[],read:async()=>({}),
  imTargets:async()=>{await hold;return ready?[target]:[];},
  defaultTarget:(_request,_binding,targets)=>{policyCalls++;return targets.length?{policyId:'product.default',target:targets[0]!}:null;},
  sendIm:async()=>{throw Error('Initialization must not send');}});
 const server=createServer((req,res)=>{void service.handle(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as any).port}/__opencraft_notifications`;
 const post=(fields:any={},origin='https://workbench.example')=>fetch(url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({operation:'defaults',expectedActorId:actor.context.actorId,messages,locale:'en-US',...fields})});
 try{
  assert.equal((await(await fetch(url)).json()).destinations.length,0);assert.equal(policyCalls,0);
  assert.equal((await post({},'https://evil.example')).status,403);assert.equal(policyCalls,0);
  assert.equal((await(await post()).json()).defaultsStatus,'deferred');assert.equal((await store.devices('human-a')).length,0);
  ready=true;
  assert.equal((await post({expectedActorId:'human-b'})).status,409);
  const values=await Promise.all(Array.from({length:6},async()=>{const r=await post({target:{...target,senderId:'FORGED'}});assert.equal(r.status,200);return r.json();}));
  assert.ok(values.every(v=>v.defaultsStatus==='complete'));assert.equal((await store.devices('human-a')).length,1);
  assert.equal(((await store.devices('human-a'))[0]!.target as any).senderId,'self');
  const id=(await store.devices('human-a'))[0]!.id;await store.remove(id,'human-a');await post();assert.equal((await store.devices('human-a')).length,0);
  actor={context:{...binding.context,actorId:'human-b'}};
  hold=new Promise<void>(resolve=>{release=resolve;});const pending=post();await new Promise(resolve=>setTimeout(resolve,30));current=false;release!();const response=await pending;assert.notEqual(response.status,200);assert.equal((await store.devices('human-b')).length,0);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();f.remove();}
});

test('an initialized default uses the existing completed Turn outbox exactly once; pausing it cancels pending delivery',async()=>{
 const f=fixture(),store=await openPushStore(f.path);let sends=0;
 const service=new TurnPushService(store,{authenticate:()=>binding,current:()=>true,trustedOrigin:()=>null,hosts:['local-codex'],
  read:async(_host,method)=>method==='thread/turns/list'?{data:[{id:'turn',status:'completed'}]}:{thread:{id:'thread',name:'Default notification'}},
  sendIm:async()=>{sends++;}});
 try{
  await initialize(store);assert.equal(sends,0);
  await store.watch('human-a','server','local-codex','thread','input');await store.bindTurn((await store.watches())[0]!.id,'turn');
  await service.tick();await service.tick();assert.equal(sends,1);
  await store.watch('human-a','server','local-codex','thread','input2');await store.bindTurn((await store.watches())[0]!.id,'turn');
  await store.setEnabled((await store.devices('human-a'))[0]!.id,'human-a',false);await initialize(store);await service.tick();assert.equal(sends,1);
 }finally{await service.close();f.remove();}
});


test('admitted human connection initializes product defaults without opening notification settings, sending, or blocking',async()=>{
 const f=fixture(),store=await openPushStore(f.path);let ready=false,current=true,actor=binding,clock=1000,policyCalls=0;
 let release!:(()=>void),hold:Promise<void>|undefined;
 const request:any={headers:{origin:'https://workbench.example',host:'workbench.example','accept-language':'zh-CN'}};
 const service=new TurnPushService(store,{authenticate:()=>actor,current:()=>current,trustedOrigin:()=> 'https://workbench.example',hosts:[],read:async()=>({}),now:()=>clock,
  imTargets:async()=>{await hold;return ready?[target]:[];},defaultTarget:(_r,_b,targets)=>{policyCalls++;return targets.length?{policyId:'product.default',target:targets[0]!}:null;},
  sendIm:async()=>{throw Error('Enrollment must never send');}});
 const settle=()=>Promise.all([...(service as any).defaultJobs.values()]);
 try{
  service.initializeDefaultsForRequest(request);await settle();assert.equal((await store.devices('human-a')).length,0);assert.equal((service as any).defaultRetries.size,1,'wait for verified receiver readiness');
  ready=true;clock+=30001;hold=new Promise<void>(r=>release=r);assert.equal(service.initializeDefaultsForRequest(request),undefined);assert.equal((await store.devices('human-a')).length,0,'intake does not wait on target lookup');
  service.initializeDefaultsForRequest(request);release();await settle();assert.equal((await store.devices('human-a')).length,1);assert.equal((await store.devices('human-a'))[0]!.locale,'zh-CN');assert.equal(policyCalls,2,'concurrent connections coalesce');
  await store.remove((await store.devices('human-a'))[0]!.id,'human-a');clock+=30001;service.initializeDefaultsForRequest(request);await settle();assert.equal((await store.devices('human-a')).length,0,'user removal is not resurrected');
  actor={context:{...binding.context,actorId:'human-b'}};clock+=30001;hold=new Promise<void>(r=>release=r);service.initializeDefaultsForRequest(request);current=false;release();await settle();assert.equal((await store.devices('human-b')).length,0,'recheck current identity after async lookup');
 }finally{await service.close();f.remove();}
});

test('default renewal keeps the existing recipient, route, locale and opt-outs while refreshing only current authorization',()=>{
 const f=fixture(),store=new PushStore(f.path);
 try{
  initialize(store);const old=store.devices('human-a')[0]!,renewed={context:{...binding.context,expiresAt:Date.now()+172800000}};
  initialize(store,renewed);const current=store.get(old.id)!;assert.equal(store.devices('human-a').length,1);assert.equal(current.authorization.context.expiresAt,renewed.context.expiresAt);assert.equal(current.origin,old.origin);assert.equal(current.basePath,old.basePath);
  store.setEnabled(old.id,'human-a',false);initialize(store,binding);assert.equal(store.get(old.id)!.enabled,false);assert.equal(store.get(old.id)!.authorization.context.expiresAt,renewed.context.expiresAt);
  store.setEnabled(old.id,'human-a',true);store.setMaster('human-a',false);initialize(store,binding);assert.equal(store.master('human-a'),false);assert.equal(store.get(old.id)!.authorization.context.expiresAt,renewed.context.expiresAt);
  store.remove(old.id,'human-a');initialize(store,renewed);assert.equal(store.devices('human-a').length,0);
 }finally{store.close();f.remove();}
});

test('server defaults reject sessions, unauthenticated/revoked actors and untrusted origin without a policy lookup',async()=>{
 const f=fixture(),store=await openPushStore(f.path);let actor:any=binding,current=true,calls=0;
 const service=new TurnPushService(store,{authenticate:()=>actor,current:()=>current,trustedOrigin:()=> 'https://workbench.example',hosts:[],read:async()=>({}),
  imTargets:async()=>{calls++;return [target];},defaultTarget:()=>({policyId:'product.default',target}),sendIm:async()=>{throw Error('No send');}});
 const valid:any={headers:{origin:'https://workbench.example',host:'workbench.example'}};
 try{
  service.initializeDefaultsForRequest({headers:{...valid.headers,origin:'https://evil.invalid'}}as any);service.initializeDefaultsForRequest({headers:{...valid.headers,'sec-fetch-site':'cross-site'}}as any);
  actor=null;service.initializeDefaultsForRequest(valid);actor={context:{...binding.context,credentialId:'session'}};service.initializeDefaultsForRequest(valid);actor=binding;current=false;service.initializeDefaultsForRequest(valid);
  await Promise.all([...(service as any).defaultJobs.values()]);assert.equal(calls,0);assert.equal((await store.devices('human-a')).length,0);
 }finally{await service.close();f.remove();}
});

test('an unresponsive optional target lookup is bounded and leaves enrollment retryable, not execution or shutdown hung',{timeout:10000},async()=>{
 const f=fixture(),store=new PushStore(f.path);
 const service=new TurnPushService(store,{authenticate:()=>binding,current:()=>true,trustedOrigin:()=> 'https://workbench.example',hosts:[],read:async()=>({}),
  imTargets:()=>new Promise(()=>{}),defaultTarget:()=>({policyId:'product.default',target})});
 try{
  service.initializeDefaultsForRequest({headers:{origin:'https://workbench.example',host:'workbench.example'}}as any);
  await Promise.all([...(service as any).defaultJobs.values()]);assert.equal(store.devices('human-a').length,0);assert.equal((service as any).defaultRetries.size,1);
 }finally{await service.close();f.remove();}
});
