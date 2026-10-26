import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PushStore, TurnPushService, PushObservationTransport, validatePushSubscription, type PushBinding, type PushDevice } from '@opencraft/web-push-node';
import { DatabaseSync } from 'node:sqlite';
const subscription={endpoint:'https://web.push.apple.com/QExample',keys:{p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,7)]).toString('base64url'),auth:Buffer.alloc(16,8).toString('base64url')}};
const authorization: PushBinding={context:{actorId:'human-a',credentialId:null,generation:1,expiresAt:Date.now()+86400000}};
const messages={completed:'Response complete',failed:'Response failed',interrupted:'Response stopped',body:'Return to the conversation.',test:'Notifications enabled'};
function fixture() {const directory=mkdtempSync(join(tmpdir(),'opencraft-push-'));return {path:join(directory,'push.sqlite'),remove:()=>rmSync(directory,{recursive:true,force:true})};}
test('only Apple HTTPS subscriptions and correctly sized keys are admitted',()=>{
 assert.deepEqual(validatePushSubscription(subscription),subscription);
 for(const endpoint of ['http://web.push.apple.com/Q','https://127.0.0.1/Q','https://push.apple.com.attacker.test/Q','https://attacker@web.push.apple.com/Q','https://web.push.apple.com:8443/Q'])assert.throws(()=>validatePushSubscription({...subscription,endpoint}));
 assert.throws(()=>validatePushSubscription({...subscription,keys:{...subscription.keys,auth:'wrong'}}));
});
test('store retains keys, subscriptions and outbox across restart, fences device rebind, rejects checksum drift',()=>{
 const f=fixture();try {
  let store=new PushStore(f.path);const keys=store.keys(()=>({publicKey:'public',privateKey:'private'}));
  const device=store.register(authorization,subscription,'https://workbench.example','','en-US',messages);
  store.watch('human-a','server-a','local-codex','thread-a','input-a');store.finish(store.watches()[0]!,'turn-a','completed');store.close();
  store=new PushStore(f.path);assert.deepEqual(store.keys(()=>{throw Error('keys rotated');}),keys);assert.equal(store.get(device.id)?.actorId,'human-a');assert.equal(store.due().length,1);
  store.watch('human-a','server-a','local-codex','thread-a','input-a');assert.equal(store.watches().length,0);
  store.register({...authorization,context:{...authorization.context,actorId:'human-b'}},subscription,'https://workbench.example','','en-US',messages);assert.equal(store.due().length,0);store.close();
  const db=new DatabaseSync(f.path);const table=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>String(r.name)).find(name=>name.includes('migration'))!;
  const checksum=db.prepare(`PRAGMA table_info("${table}")`).all().map(r=>String(r.name)).find(name=>/checksum/u.test(name))!;
  assert.ok(checksum);db.exec(`UPDATE "${table}" SET "${checksum}"='incorrect'`);db.close();assert.throws(()=>new PushStore(f.path));
 }finally{f.remove();}
});
test('exact input attribution outlives pages, rejects old history, deduplicates steering and resumes after restart',async()=>{
 const f=fixture();let service:TurnPushService|undefined;const sent:any[]=[];let admitted=false,status='inProgress';
 const read=async (_host:string,method:string)=>method==='thread/items/list'?{data:[{turnId:'old-turn',item:{type:'userMessage',clientId:'unrelated'}},...(admitted?[{turnId:'real-turn',item:{type:'userMessage',clientId:'input-a'}},{turnId:'real-turn',item:{type:'userMessage',clientId:'input-b'}}]:[])],nextCursor:null}:{data:[{id:'old-turn',status:'completed'},{id:'real-turn',status}],nextCursor:null};
 const options={authenticate:()=>authorization,current:()=>true,trustedOrigin:()=> 'https://workbench.example',hosts:['local-codex'],read,send:async (_device:PushDevice,payload:string)=>{sent.push(JSON.parse(payload));}};
 try{
  const store=new PushStore(f.path);store.register(authorization,subscription,'https://workbench.example','/servers/one','zh-CN',messages);
  store.watch('human-a','server-a','local-codex','thread-a','input-a');store.watch('human-a','server-a','local-codex','thread-a','input-b');service=new TurnPushService(store,options);
  await service.tick();assert.equal(sent.length,0,'old completion is unrelated');admitted=true;await service.tick();assert.equal(sent.length,0,'running is not complete');await service.close();
  service=new TurnPushService(new PushStore(f.path),options);status='completed';await service.tick();await service.tick();assert.equal(sent.length,1);
  assert.equal(sent[0].web_push,8030);assert.equal(sent[0].notification.navigate,'https://workbench.example/servers/one/local/thread-a?hostId=local-codex');assert.equal(sent[0].notification.title,`#thread-a · ${messages.completed}`);
 }finally{await service?.close();f.remove();}
});
test('background notifications identify the exact thread for all terminal states and survive metadata failure',async()=>{
 const f=fixture(),store=new PushStore(f.path),sent:any[]=[],reads:any[]=[];
 const metadata:any={a:{id:'a',name:'修复通知文案'},b:{id:'b',name:' ',preview:'检查部署结果'},c:{id:'wrong-thread',name:'其他任务'},d:{id:'d',name:'😀'.repeat(100)}};
 store.register(authorization,subscription,'https://workbench.example','','zh-CN',messages);
 const service=new TurnPushService(store,{authenticate:()=>authorization,current:()=>true,trustedOrigin:()=>null,hosts:[],
  read:async(host,method,params)=>{reads.push({host,method,params});if(params.threadId==='e')throw Error('offline');return {thread:metadata[String(params.threadId)]};},
  send:async(_,payload)=>{sent.push(JSON.parse(payload).notification);}});
 try{
  for(const [thread,status] of [['a','completed'],['b','failed'],['c','interrupted'],['d','completed'],['e','failed']]){
   store.watch('human-a','server-a','local-codex',thread!,'input');store.finish(store.watches().find(w=>w.threadId===thread)!,'turn',status!);
  }
  await service.tick();
  const titles=new Map(sent.map(n=>[new URL(n.navigate).pathname.split('/').at(-1),n.title]));
  assert.equal(titles.get('a'),`修复通知文案 · ${messages.completed}`);
  assert.equal(titles.get('b'),`检查部署结果 · ${messages.failed}`);
  assert.equal(titles.get('c'),`#c · ${messages.interrupted}`);
  assert.equal(titles.get('d'),`${'😀'.repeat(80)} · ${messages.completed}`);
  assert.equal(titles.get('e'),`#e · ${messages.failed}`);
  assert.equal(reads.length,5);assert.ok(reads.every(r=>r.host==='local-codex' && r.method==='thread/read' && r.params.includeTurns===false));
  await service.tick();assert.equal(sent.length,5,'metadata lookup does not change terminal deduplication');
 }finally{await service.close();f.remove();}
});
test('expiry prevents delivery, 410 removes subscriptions and transient failure retains retry',async()=>{
 const f=fixture();let allowed=true,code=503,calls=0,now=1_000_000;const store=new PushStore(f.path,()=>now);
 const device=store.register(authorization,subscription,'https://workbench.example','','en-US',messages);store.watch('human-a','server-a','local-codex','thread-a','input-a');store.finish(store.watches()[0]!,'turn-a','failed');
 const service=new TurnPushService(store,{authenticate:()=>authorization,current:()=>allowed,trustedOrigin:()=>null,hosts:[],read:async()=>({}),now:()=>now,send:async()=>{calls++;throw Object.assign(Error('failure'),{statusCode:code});}});
 try{
  await service.tick();assert.equal(calls,1);assert.equal(store.due().length,0);now+=20000;code=410;await service.tick();assert.equal(calls,2);assert.equal(store.get(device.id),null);
  store.register(authorization,subscription,'https://workbench.example','','en-US',messages);store.watch('human-a','server-a','local-codex','thread-a','input-c');store.finish(store.watches()[0]!,'turn-c','interrupted');allowed=false;await service.tick();assert.equal(calls,2);assert.equal(store.get(device.id),null);
 }finally{await service.close();f.remove();}
});
test('HTTP enrollment requires authenticated same-origin actor and bounded input; test confirms provider acceptance',async()=>{
 const f=fixture();let loggedIn=true;const payloads:any[]=[];const store=new PushStore(f.path);
 const service=new TurnPushService(store,{authenticate:()=>loggedIn?authorization:null,current:()=>true,trustedOrigin:()=> 'https://workbench.example',hosts:['local-codex'],read:async()=>({}),send:async(_,payload)=>{payloads.push(JSON.parse(payload));}});
 const server=createServer((req,res)=>{void service.handle(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/__opencraft_push`,body={operation:'subscribe',subscription,expectedActorId:'human-a',locale:'en-US',basePath:'',messages};
 const post=(input:any=body,origin='https://workbench.example')=>fetch(url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(input)});
 try{
  assert.equal((await fetch(url)).status,200);assert.equal((await post(body,'https://evil.example')).status,403);assert.equal((await post({...body,expectedActorId:'other'})).status,409);assert.equal((await post({...body,basePath:'//evil.example'})).status,400);
  assert.equal((await post({...body,messages:{...messages,body:'x'.repeat(20000)}})).status,413);assert.equal((await post()).status,200);assert.equal((await post({...body,operation:'test'})).status,200);assert.equal(payloads.length,1);assert.equal((await post({...body,operation:'test'})).status,429);
  assert.deepEqual(await (await post({...body,operation:'unsubscribe'})).json(),{enabled:false});assert.deepEqual(await (await post({...body,operation:'status'})).json(),{enabled:false});loggedIn=false;assert.equal((await post()).status,401);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();f.remove();}
});
test('transport uses verified attribution and cannot turn a notification failure into a failed submission',async()=>{
 const observed:any[]=[],frames:string[]=[];const inner:any={status:{state:'open'},connect:async()=>{},send:async(frame:string)=>{frames.push(frame);},subscribeMessage:()=>()=>{},subscribeStatus:()=>()=>{},close:async()=>{}};
 const transport=new PushObservationTransport(inner,value=>{observed.push(value);throw Error('notification store unavailable');});
 const frame=JSON.stringify({id:1,__opencraftClient:'trusted-lane',method:'thread/queue/add',params:{threadId:'thread',clientUserMessageId:'input',actorId:'forged'}});
 await transport.sendWithContext(frame,{sender:null,actorContext:authorization.context});assert.deepEqual(observed,[{actorId:'human-a',threadId:'thread',inputId:'input'}]);await transport.sendWithContext(frame,{sender:null});assert.equal(observed.length,1);assert.equal(frames.length,2);
});

test('real AppHost service lane completes after renderer retirement without resubmitting work',async()=>{
 const {AppHostServer}=await import('@opencraft/app-host-server');
 const {callConversationHost}=await import('../../scripts/conversation-execution.mjs');
 const f=fixture(),store=new PushStore(f.path);let complete=false,starts=0,sent=0;const listeners=new Set<(frame:string)=>void>();
 const inner:any={status:{state:'open'},connect:async()=>{},close:async()=>{},subscribeMessage:(listener:(frame:string)=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},subscribeStatus:()=>()=>{},
  send:async(frame:string)=>{
   const value=JSON.parse(frame);if(value.id===undefined)return;
   let result:any={};
   if(value.method==='initialize')result={serverInfo:{name:'synthetic-engine',version:'1'}};
   if(value.method==='turn/start'){starts++;result={turn:{id:'turn-real',status:'inProgress'}};}
   if(value.method==='thread/items/list')result={data:[{turnId:'turn-real',item:{type:'userMessage',clientId:'input-real'}}],nextCursor:null};
   if(value.method==='thread/turns/list')result={data:[{id:'turn-real',status:complete?'completed':'inProgress'}],nextCursor:null};
   for(const listener of listeners)listener(JSON.stringify({id:value.id,result,__opencraftClient:value.__opencraftClient}));
  }};
 const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>new PushObservationTransport(inner,value=>store.watch(value.actorId,'server-real','local-codex',value.threadId,value.inputId))});
 const service=new TurnPushService(store,{authenticate:()=>authorization,current:()=>true,trustedOrigin:()=>null,hosts:['local-codex'],read:(hostId,method,params)=>callConversationHost(host,{hostId,threadId:params.threadId},'push-read',method,params,undefined,1000),send:async()=>{sent++;}});
 let receive:(value:any)=>void=()=>{};const output:any[]=[];
 const connection=host.accept({subscribe(listener){receive=listener;return()=>{};},postMessage(message){output.push(message);},start(){},close(){}},'browser', {sender:null,actorContext:authorization.context});
 const wait=async(test:()=>boolean)=>{for(let i=0;i<100&&!test();i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(test(),true);};
 try{
  store.register(authorization,subscription,'https://workbench.example','','en-US',messages);
  const {APP_HOST_PROTOCOL_VERSION}=await import('@opencraft/app-host-protocol');receive({type:'hello',rendererId:'browser',protocolVersion:APP_HOST_PROTOCOL_VERSION});
  receive({type:'host/connect',requestId:'connect',hostId:'local-codex',leaseId:'browser-lease'});await wait(()=>output.some(v=>v.requestId==='connect'));
  const generation=output.find(v=>v.requestId==='connect').result.generation;
  receive({type:'host/send',requestId:'submit',hostId:'local-codex',leaseId:'browser-lease',generation,frame:JSON.stringify({id:1,method:'turn/start',params:{threadId:'thread-real',clientUserMessageId:'input-real'}})});
  await wait(()=>starts===1);connection.close();assert.equal(host.hostState('local-codex'),'open');
  complete=true;await service.tick();assert.equal(sent,1);assert.equal(starts,1,'notification reads must never replay submission');
 }finally{connection.close();await service.close();await host.close();f.remove();}
});
