import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openManagedDatabase } from '@opencraft/sqlite-node';
import { PushStore, TurnPushService, openPushStore, type PushBinding } from '@opencraft/web-push-node';
import { barkUrl, publicAddress, parseTarget, sendDestination, DeliveryError } from '../../packages/web-push-node/src/destinations';
const binding:PushBinding={context:{actorId:'human-a',credentialId:null,generation:1,expiresAt:Date.now()+86400000}};
const messages={completed:'Complete',failed:'Failed',interrupted:'Stopped',body:'Return to conversation',test:'Test'};
const target={kind:'bark' as const,url:'https://api.day.app/test-device-key?group=example&ttl=600'};
function fixture(){const directory=mkdtempSync(join(tmpdir(),'notification-destinations-'));return{path:join(directory,'push.sqlite'),remove:()=>rmSync(directory,{recursive:true,force:true})};}
test('Bark accepts copied URLs and curl as data, replaces examples and preserves options',async()=>{
  assert.equal(barkUrl('curl -X GET https://api.day.app/test-device-key/title/body?group=example&ttl=600'),target.url);
  assert.equal(barkUrl("curl -X GET 'https://api.day.app/test-device-key/title/body?group=example&ttl=600'"),target.url);
  for(const url of ['http://api.day.app/key123','https://user:pass@api.day.app/key123','https://127.0.0.1/key123','https://[::1]/key123'])assert.throws(()=>barkUrl(url));
  assert.equal(barkUrl('https://bark.example:8443/key123/title/body'),'https://bark.example:8443/key123');
  assert.throws(()=>barkUrl('curl -X POST https://api.day.app/key123 -d x'));
  assert.throws(()=>parseTarget({kind:'webhook',url:'https://receiver.example',authorization:'a\r\nb'}));
  const requests:any[]=[];
  await sendDestination(target,{id:'event1',event:'turn.ended',title:'A / B',body:'你好',url:'https://workbench.example/local/thread',status:'completed'},async(url,body)=>{requests.push({url:url.href,body});return {code:200};});
  assert.deepEqual(requests,[{url:'https://api.day.app/push',body:{group:'example',ttl:600,device_key:'test-device-key',title:'A / B',body:'你好',url:'https://workbench.example/local/thread'}}]);
  await assert.rejects(sendDestination(target,{id:'x',event:'notification.test',title:'Test',body:'x',url:'https://example.com',status:'test'},async()=>({code:400})),DeliveryError);
});
test('public destinations reject private, mapped, transition and reserved network addresses',()=>{
  for(const ip of ['0.0.0.0','10.1.2.3','100.64.1.2','127.0.0.1','169.254.169.254','172.16.1.2','192.168.1.1','198.18.0.1','224.0.0.1','::','::1','::ffff:127.0.0.1','64:ff9b::7f00:1','2002:7f00:1::','fc00::1','fe80::1'])assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
});
test('version 1 upgrade retains Web Push keys, devices and queued deliveries',()=>{
  const f=fixture();try{
    // The immutable, previously shipped version-1 SQL remains the migration input.
    const original=readFileSync(new URL('../../packages/web-push-node/src/store.ts',import.meta.url),'utf8').match(/const SCHEMA = `([\s\S]*?)`\.trim\(\);/)![1]!.trim();
    const legacy=openManagedDatabase({path:f.path,migrations:[{version:1,name:'web-push-subscriptions-and-outbox',sql:original}]});
    legacy.database.exec("INSERT INTO push_keys VALUES(1,'public','private')");
    legacy.database.prepare('INSERT INTO push_devices VALUES(?,?,?,?,?,?,?,?,?)').run('device','human-a','binding',JSON.stringify(binding),JSON.stringify({endpoint:'https://web.push.apple.com/example',keys:{p256dh:'a',auth:'b'}}),'https://workbench.example','','en-US',JSON.stringify(messages));
    legacy.database.prepare('INSERT INTO push_deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('delivery','device','binding','local-codex','thread','turn','completed',0,Date.now(),Date.now(),'pending');
    legacy.database.close();
    const store=new PushStore(f.path);assert.equal(store.outcome.appliedVersion,3);assert.equal(store.due().length,1);assert.equal(store.get('device')?.enabled,true);assert.equal(store.get('device')?.target,undefined);assert.equal(store.keys(()=>{throw Error();}).privateKey,'private');store.close();
  }finally{f.remove();}
});
test('destination consent, rebind fencing, idempotent saves and paused turns survive restart',()=>{
  const f=fixture();try{
    let store=new PushStore(f.path);
    const first=store.saveTarget(binding,target,'https://workbench.example','','en-US',messages,undefined,'save1');
    const repeated=store.saveTarget(binding,target,'https://workbench.example','','en-US',messages,undefined,'save1');assert.equal(first.id,repeated.id);
    store.watch('human-a','server','local-codex','thread','input');store.finish(store.watches()[0]!,'turn','completed');assert.equal(store.due().length,1);
    store.setMaster('human-a',false);assert.equal(store.due().length,0);store.watch('human-a','server','local-codex','thread','paused');assert.equal(store.watches().length,0);
    store.close();store=new PushStore(f.path);assert.equal(store.master('human-a'),false);store.setMaster('human-a',true);assert.equal(store.due().length,0);
    store.watch('human-a','server','local-codex','thread','input2');store.finish(store.watches()[0]!,'turn2','completed');
    store.saveTarget(binding,{kind:'webhook',url:'https://receiver.example'},'https://workbench.example','','en-US',messages,first.id);assert.equal(store.due().length,0);
    assert.throws(()=>store.saveTarget({...binding,context:{...binding.context,actorId:'human-b'}},target,'https://workbench.example','','en-US',messages,first.id));
    store.setEnabled(first.id,'human-a',false);store.watch('human-a','server','local-codex','thread','disabled');assert.equal(store.watches().length,0);store.close();
  }finally{f.remove();}
});
test('worker owns migrations, SQL, ordered commits and close without main-thread SQL',async()=>{
  const f=fixture(),original=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(){throw Error('main thread SQL forbidden');};
  try {
    const store=await openPushStore(f.path);
    await store.saveTarget(binding,target,'https://workbench.example','','en-US',messages);
    const watch=store.watch('human-a','server','local-codex','thread','input');
    assert.equal((await store.watches()).length,1);await watch;
    await store.setMaster('human-a',false);assert.equal(await store.master('human-a'),false);await store.close();
    const reopened=await openPushStore(f.path);assert.equal(await reopened.master('human-a'),false);await reopened.close();
  }finally{DatabaseSync.prototype.prepare=original;f.remove();}
});
test('authenticated notification API redacts secrets, isolates accounts, reuses queue and retries transient errors',async()=>{
  const f=fixture();let actor=binding,clock=Date.now(),fail=true;const sent:any[]=[];
  const store=new PushStore(f.path,()=>clock);
  const service=new TurnPushService(store,{authenticate:()=>actor,current:()=>true,trustedOrigin:()=> 'https://workbench.example',hosts:['local-codex'],now:()=>clock,
    read:async(_host,method)=>method==='thread/turns/list'?{data:[{id:'turn',status:'completed'}]}:{thread:{id:'thread',name:'My conversation'}},
    sendExternal:async(_target,message)=>{if(fail)throw new DeliveryError(503);sent.push(message);},imTargets:async()=>[]});
  const server=createServer((request,response)=>{void service.handle(request,response).catch(()=>{response.statusCode=500;response.end();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as any).port}/__opencraft_notifications`;
  const post=(data:any,origin='https://workbench.example')=>fetch(url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({expectedActorId:actor.context.actorId,locale:'en-US',basePath:'',messages,...data})});
  try {
    assert.equal((await post({operation:'save',target},'https://evil.example')).status,403);
    const invalid=await post({operation:'save',target:{kind:'bark',url:'secret-invalid-address'}});
    assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'invalid_destination'});
    const response=await post({operation:'save',target,creationId:'request1'});assert.equal(response.status,200);
    const raw=await response.text();assert.ok(!raw.includes('test-device-key'));const id=JSON.parse(raw).savedId;
    const delivery=await post({operation:'test',id});assert.equal(delivery.status,502);assert.deepEqual(await delivery.json(),{error:'notification_delivery_failed'});
    const originalSave=store.saveTarget.bind(store);
    store.saveTarget=()=>{throw Error('notification_storage_unavailable');};
    const storage=await post({operation:'save',target});assert.equal(storage.status,503);assert.deepEqual(await storage.json(),{error:'notification_storage_unavailable'});
    store.saveTarget=()=>{throw Error('sqlite private-token /private/path');};
    const unknown=await post({operation:'save',target});assert.equal(unknown.status,500);assert.deepEqual(await unknown.json(),{error:'notification_operation_failed'});
    store.saveTarget=originalSave;clock+=31000;
    assert.equal((await post({operation:'save',target:{kind:'im',channelId:'forged',senderId:'other'}})).status,400);
    actor={context:{...binding.context,actorId:'human-b'}};
    assert.equal((await post({operation:'test',id})).status,404);assert.equal((await (await fetch(url)).json()).destinations.length,0);actor=binding;
    store.watch('human-a','server','local-codex','thread','input');store.bindTurn(store.watches()[0]!.id,'turn');
    await service.tick();assert.equal(sent.length,0);clock+=11000;fail=false;await service.tick();assert.equal(sent.length,1);assert.equal(sent[0].event,'turn.ended');assert.match(sent[0].title,/My conversation/);await service.tick();assert.equal(sent.length,1);
    assert.equal((await post({operation:'master',enabled:false})).status,200);
    assert.equal((await post({operation:'test',id})).status,200);assert.equal((await post({operation:'test',id})).status,429);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();f.remove();}
});

test('a database lock wait leaves main-thread timers responsive',async()=>{
  const {Worker}=await import('node:worker_threads');const f=fixture();const store=await openPushStore(f.path);
  const lock=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');parentPort.on('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});`,{eval:true,workerData:f.path});
  try {
    await new Promise<void>((resolve,reject)=>{lock.once('message',()=>resolve());lock.once('error',reject);});
    let timerRan=false,settled=false;
    const writing=Promise.resolve(store.setMaster('human-a',false)).finally(()=>{settled=true;});
    await new Promise(resolve=>setTimeout(()=>{timerRan=true;resolve(null);},40));
    assert.equal(timerRan,true);assert.equal(settled,false);lock.postMessage('release');await writing;assert.equal(await store.master('human-a'),false);
  }finally{await lock.terminate();await store.close();f.remove();}
});
test('expired external bindings keep settings for reconnection; uncertain IM delivery is not repeated',async()=>{
  const f=fixture();let current=true;
  const store=new PushStore(f.path);const device=store.saveTarget(binding,{kind:'im',channelId:'channel',senderId:'self',label:'My IM'},'https://workbench.example','','en-US',messages);
  let calls=0;
  const service=new TurnPushService(store,{authenticate:()=>binding,current:()=>current,trustedOrigin:()=> 'https://workbench.example',hosts:['local-codex'],
    read:async(_host,method)=>method==='thread/turns/list'?{data:[{id:'turn',status:'completed'}]}:{thread:{id:'thread'}},sendIm:async()=>{calls++;throw Error('acknowledgement unknown');}});
  try {
    store.watch('human-a','server','local-codex','thread','input');store.bindTurn(store.watches()[0]!.id,'turn');await service.tick();assert.equal(calls,1);assert.equal(store.due().length,0);
    current=false;store.watch('human-a','server','local-codex','thread','input2');await service.tick();assert.ok(store.get(device.id));assert.equal(store.get(device.id)?.enabled,false);assert.equal(store.watches().length,0);
  }finally{await service.close();f.remove();}
});

test('request diagnostics distinguish origin gates, correlate responses and exclude secrets',async()=>{
  const {observeNotificationRequest}=await import('../../packages/web-push-node/src/diagnostics');
  const f=fixture(),events:any[]=[];let trusted:string|null='https://workbench.example',early=false,crash=false;
  const service=new TurnPushService(new PushStore(f.path),{authenticate:()=>binding,current:()=>true,trustedOrigin:()=>trusted,hosts:[],read:async()=>({})});
  const server=createServer((request,response)=>{
    observeNotificationRequest(request,response,event=>{events.push(event);if(crash)throw Error('logger failure');});
    if(early){response.writeHead(403);response.end(JSON.stringify({error:'Matching origin required'}));return;}
    void service.handle(request,response);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as any).port}/__opencraft_notifications?private-query`;
  const cases:[string|null,string,Record<string,string>,string][]=[
    ['https://workbench.example','DELETE',{origin:'https://workbench.example'},'method_not_allowed'],
    [null,'POST',{origin:'https://workbench.example'},'trusted_origin_missing'],
    ['ftp://workbench.example','POST',{origin:'ftp://workbench.example'},'trusted_origin_invalid_protocol'],
    ['https://workbench.example','POST',{},'origin_missing'],
    ['https://workbench.example','POST',{origin:'https://private-token.example'},'origin_mismatch'],
    ['https://workbench.example','POST',{origin:'https://workbench.example','sec-fetch-site':'cross-site'},'cross_site'],
    ['https://workbench.example','POST',{origin:'https://workbench.example','content-type':'text/plain'},'content_type_invalid'],
  ];
  try{
    for(const [origin,method,headers,reason] of cases){
      trusted=origin;
      const response=await fetch(url,{method,headers:{'content-type':'application/json',cookie:'secret-cookie',authorization:'Bearer secret-token','x-opencraft-notification-request-id':'forged',...headers},body:'private-body'});
      assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'same_origin_json_required'});
      const event=events.at(-1);assert.equal(event.reason,reason);assert.equal(event.requestId,response.headers.get('x-opencraft-notification-request-id'));assert.notEqual(event.requestId,'forged');
      assert.equal(events.length,cases.indexOf(cases.find(c=>c[3]===reason)!)+1);
    }
    early=true;crash=true;
    const response=await fetch(url);assert.equal(response.status,403);await response.text();assert.equal(events.at(-1).reason,'matching_origin_required');
    assert.equal(new Set(events.map(e=>e.requestId)).size,events.length);
    const serialized=JSON.stringify(events);for(const secret of ['private-query','private-token','secret-cookie','secret-token','private-body','workbench.example'])assert.ok(!serialized.includes(secret));
    early=false;crash=false;const count=events.length;await (await fetch(url)).text();assert.equal(events.length,count);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();f.remove();}
});

test('authenticated HTTP and HTTPS same-origin saves work without provider origin; cross-origin and forwarded headers cannot authorize writes',async()=>{
  const f=fixture();let trusted:string|null=null,authenticated=true;let externalSends=0;
  const store=await openPushStore(f.path);
  const service=new TurnPushService(store,{authenticate:()=>authenticated?binding:null,current:()=>true,
    trustedOrigin:()=>trusted,hosts:[],read:async()=>({}),sendExternal:async()=>{externalSends++;}});
  const server=createServer((request,response)=>{void service.handle(request,response);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as any).port}/__opencraft_notifications`;
  // Use HTTP directly: Node fetch does not preserve an overridden Host header.
  const post=(headers:Record<string,string>={},data:any={operation:'save',target,creationId:'same-origin-save'})=>new Promise<Response>((resolve,reject)=>{
    const request=httpRequest(url,{method:'POST',headers:{host:'workbench.example',origin:'https://workbench.example','content-type':'application/json',...headers}},response=>{
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('error',reject);
      response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode})));
    });request.on('error',reject);request.end(JSON.stringify({expectedActorId:'human-a',messages,locale:'en-US',...data}));
  });
  try{
    const saved=await post();assert.equal(saved.status,200);const id=(await saved.json()).savedId;
    assert.equal((await store.get(id))?.origin,'https://workbench.example');assert.equal(externalSends,0);
    // HTTP ingress works without a provider origin and persists HTTP links.
    const httpSaved=await post({origin:'http://workbench.example'});assert.equal(httpSaved.status,200);
    assert.equal((await store.get(id))?.origin,'http://workbench.example');
    // Explicit trusted HTTP origins also work when the reverse proxy uses an
    // internal Host, including a non-default port.
    trusted='http://entry.example:8080';
    const httpRelay=await post({host:'internal.example',origin:trusted});assert.equal(httpRelay.status,200);
    assert.equal((await store.get(id))?.origin,trusted);
    assert.equal((await post({host:'internal.example',origin:'http://other.example:8080'})).status,403);
    assert.equal((await post({host:'internal.example',origin:trusted,'sec-fetch-site':'cross-site'})).status,403);
    trusted=null;
    const httpPort=await post({host:'workbench.example:8080',origin:'http://workbench.example:8080'});assert.equal(httpPort.status,200);
    assert.equal((await post({host:'workbench.example:8080',origin:'http://workbench.example:8081'})).status,403);
    // A provider may declare a different canonical origin, or none at all. The
    // ordinary same-host route must remain usable like Actor and IM APIs.
    trusted='https://canonical.example';assert.equal((await post()).status,200);
    trusted=null;
    for(const headers of [
      {origin:'https://evil.example'}, {origin:'http://evil.example'}, {origin:'null'}, {origin:'ftp://workbench.example'},
      {origin:'https://workbench.example.evil'}, {origin:'https://workbench.example:444'},
      {origin:'https://workbench.example',host:'other.example'},
      {origin:'https://evil.example','x-forwarded-host':'evil.example','x-forwarded-proto':'https'},
      {'sec-fetch-site':'cross-site'}, {'content-type':'text/plain'},
    ]){const response=await post(headers);assert.equal(response.status,403,JSON.stringify(headers));await response.text();}
    authenticated=false;assert.equal((await post()).status,401);authenticated=true;
    trusted='https://entry.example';const relay=await post({host:'internal.example',origin:'https://entry.example'});assert.equal(relay.status,200);
    assert.equal((await store.get(id))?.origin,'https://entry.example');
    // Explicit test follows a successful save through the real worker/API path.
    assert.equal((await post({host:'internal.example',origin:'https://entry.example'},{operation:'test',id})).status,200);
    assert.equal(externalSends,1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();f.remove();}
});

test('plugin method labels are server-selected and survive storage; ended Turns reuse the original outbox exactly once',async()=>{
 const f=fixture(),store=new PushStore(f.path),sent:any[]=[];let clock=Date.now();
 const selected={channelId:'product.connection',senderId:'self',label:'My account',methodId:'product.notifications',methodLabel:'Product channel'};
 const service=new TurnPushService(store,{authenticate:()=>binding,current:()=>true,trustedOrigin:()=> 'https://workbench.example',hosts:['local-codex'],now:()=>clock,imTargets:async()=>[selected],
  sendIm:async(_binding,target,message)=>{sent.push({target,message});},read:async(_host,method)=>method==='thread/turns/list'?{data:[{id:'turn',status:'completed'}]}:{thread:{id:'thread',name:'Test conversation'}}});
 const server=createServer((req,res)=>{void service.handle(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as any).port}/__opencraft_notifications`;
 const post=(input:any)=>fetch(url,{method:'POST',headers:{origin:'https://workbench.example','content-type':'application/json'},body:JSON.stringify({expectedActorId:'human-a',locale:'en-US',messages,...input})});
 try {
  const denied=await post({operation:'save',target:{kind:'im',channelId:selected.channelId,senderId:'other'}});assert.equal(denied.status,400);
  const response=await post({operation:'save',creationId:'product-method',target:{kind:'im',...selected,methodLabel:'FORGED'}});assert.equal(response.status,200);
  const saved=await response.json();assert.equal(saved.destinations[0].methodLabel,'Product channel');assert.equal(saved.destinations[0].methodId,selected.methodId);assert.equal(saved.destinations[0].label,'My account');assert.equal(sent.length,0);
  const testResponse=await post({operation:'test',id:saved.savedId});assert.equal(testResponse.status,200);assert.equal(sent[0].message.event,'notification.test');
  clock+=31000;assert.equal((await post({operation:'test',id:saved.savedId})).status,200);assert.notEqual(sent[0].message.id,sent[1].message.id,'Separate explicit tests must not be deduplicated as one event');
  store.watch('human-a','server','local-codex','thread','input');store.bindTurn(store.watches()[0]!.id,'turn');await service.tick();await service.tick();
  assert.equal(sent.length,3);assert.equal(sent[2].message.event,'turn.ended');assert.match(sent[2].message.title,/Test conversation/);assert.equal(sent[2].message.status,'completed');assert.equal(sent[2].target.senderId,'self');assert.equal(store.due().length,0);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();f.remove();}
});
