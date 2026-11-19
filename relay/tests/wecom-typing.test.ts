import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';import{createHash,randomBytes,randomUUID}from'node:crypto';import{once}from'node:events';import{mkdtemp,rm}from'node:fs/promises';import{createServer,type Server}from'node:http';import{tmpdir}from'node:os';import{join}from'node:path';import test from'node:test';import{setTimeout as sleep}from'node:timers/promises';
import{RelayRedis}from'../../apps/relay-server/src/redis.js';
import{MirrorStore,humanKey}from'../../products/join/plugins/wecom/mirror/store.mjs';
import{MirrorService,streamIdFor,FOLLOW_UP_PLACEHOLDER_DELAY_MS,PLACEHOLDER_TIMEOUT_MS,MIRROR_PATH,STILL_WORKING}from'../../products/join/plugins/wecom/mirror/service.mjs';
async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return(server.address()as{port:number}).port;}
const close=(server:Server)=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
async function redisFixture(t:test.TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'wecom-mirror-')),reserve=createServer(),port=await listen(reserve);await close(reserve);
  let child:ChildProcess;const clients:RelayRedis[]=[];
  const config={host:'127.0.0.1',port,mode:'standalone' as const,password:'synthetic-fixture',namespace:randomUUID(),credential:randomBytes(32).toString('base64url'),internalPort:port};
  const start=async()=>{
    child=spawn(process.env.REDIS_SERVER??'redis-server',['--bind','127.0.0.1','--port',String(port),'--requirepass',config.password,'--dir',dir,'--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction'],{stdio:['ignore','pipe','pipe']});
    await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>reject(Error('Redis fixture exited')));child.stdout!.on('data',data=>{if(String(data).includes('Ready to accept connections'))resolve();});});
  };
  const stop=async()=>{const exited=once(child,'exit');child.kill('SIGTERM');await exited;};
  const connect=async()=>{const client=await RelayRedis.connect(config);clients.push(client);return client;};
  t.after(async()=>{clients.forEach(c=>c.close());if(child?.exitCode===null)await stop();await rm(dir,{recursive:true,force:true});});
  await start();return {connect,stop,start,clients,config};
}
const room=(id='room')=>JSON.stringify(['wecom-customer-service','wxfixture','fwfixture',id]);
async function fixture(t:test.TestContext,autoWake=false){
 const redis=await redisFixture(t),stores=[new MirrorStore(await redis.connect()),new MirrorStore(await redis.connect())],calls:any[]=[],members=['Wei','Other'];
 const humans=Object.fromEntries(members.map(id=>[humanKey('wxfixture',id),'human-'+id])),credential=randomBytes(32).toString('base64url');
 await stores[0].register('one','One',humans,true,true);for(const source of [room(),room('two')])await stores[0].bind(source,humanKey('wxfixture','Wei'),'one','Group');
 let response:(...args:any[])=>Promise<number>=async()=>0;
 const services=stores.map(store=>new MirrorService({store,transport:{subscribe:()=>()=>{},respond:async(...a:any[])=>{calls.push(a);return response(...a);},send:async()=> 'delivered',sendFile:async()=> 'delivered',chatMembers:async()=>members},corpId:'wxfixture',servers:[{id:'one',name:'One',credential}],streamReplies:true,followUps:true,allowLoopbackInsecure:true}));
 if(!autoWake)for(const service of services)service.wakeTyping=()=>{};
 t.after(async()=>{await Promise.all(services.map(s=>s.close()));});
 const event=(id:string,author='Wei',source=room())=>({source,id,author,text:'问题 '+id,mentioned:true,at:1000});
 const ingest=(id:string,author='Wei',source=room())=>services[0].ingest(event(id,author,source));
 const state=(author='Wei',source=room())=>stores[0].typing.read(stores[0].typing.member(source,author));
 const reply=(id:string,text='答案',service=services[0])=>service.reply({source:room(),replyTo:id,requestId:'r-'+id+'-'+text,author:'主人的助理',text},AbortSignal.timeout(5000));
 return{redis,stores,services,calls,members,humans,credential,event,ingest,state,reply,setResponse:(f:typeof response)=>response=f};
}
test('immediate waiting rotates the sender bubble; text/image bursts collapse to the newest pending input',async t=>{
 const f=await fixture(t);assert.equal(FOLLOW_UP_PLACEHOLDER_DELAY_MS,0);await f.ingest('first');const first=await f.state();
 assert.equal(first.dueAt,first.createdAt);await f.services[0].pumpTyping(first.dueAt);
 assert.deepEqual(f.calls[0].slice(0,4),['first',streamIdFor(room(),'first'),'',false]);
 await f.services[0].ingest({...f.event('picture'),mentioned:false,text:'[图片]'});await f.services[0].ingest({...f.event('caption'),mentioned:false,text:'这是啥'});
 assert.equal((await f.stores[0].snapshot(room())).count,3,'all input admitted immediately');
 const r=await f.state();assert.equal(r.id,'caption');assert.equal(r.retiring.anchor,'first');
 await Promise.all(f.services.map(s=>s.pumpTyping(r.dueAt)));
 assert.deepEqual(f.calls.map(c=>[c[0],c[2],c[3]]),[['first','',false],['first','',true],['caption','',false]]);
 await f.reply('caption','回答最新补充',f.services[1]);assert.equal(f.calls.at(-1)[0],'caption');assert.equal(f.calls.at(-1)[3],true);assert.match(f.calls.at(-1)[2],/回答最新补充/);assert.equal(await f.state(),null);
 assert.equal(await f.stores[0].windowOpen(room(),'Wei'),true);
});
test('fast answers cancel pending dots; late output cannot settle the next turn',async t=>{
 const f=await fixture(t);await f.ingest('fast');const old=await f.state();await f.reply('fast');await f.services[1].pumpTyping(old.dueAt);assert.equal(f.calls.length,1);assert.equal(f.calls[0][3],true);
 await f.ingest('next');const next=await f.state();await f.reply('fast','旧任务补充',f.services[1]);assert.equal((await f.state()).id,next.id);
 await f.services[1].pumpTyping(next.dueAt);assert.equal(f.calls.filter(c=>!c[3]).length,1);assert.equal(f.calls.at(-1)[0],'next');
});
test('different senders and rooms have independent pending presentation; duplicates and controls do not add turns',async t=>{
 const f=await fixture(t);await f.ingest('a');const first=await f.state();assert.equal(await f.ingest('a'),'duplicate');assert.equal((await f.state()).createdAt,first.createdAt);
 await assert.rejects(f.services[0].ingest({...f.event('a'),text:'changed'}),/conflict/);
 await f.ingest('b','Other');await f.ingest('c','Wei',room('two'));await f.services[0].ingest({...f.event('control'),text:'帮助'});await f.ingest('bot','wbci');
 await f.services[0].pumpTyping(Date.now()+120010);assert.equal(f.calls.filter(c=>!c[3]).length,3);assert.equal(await f.state('wbci'),null);
});
test('failure/cancellation replies finish the original bubble; file/card terminal output closes without canned text',async t=>{
 const f=await fixture(t);for(const [id,text]of[['failed','这条消息未能处理成功，请重试。'],['cancelled','已停止任务。']]){await f.ingest(id);const r=await f.state();await f.services[0].pumpTyping(r.dueAt);await f.reply(id,text);assert.equal(f.calls.at(-1)[3],true);assert.match(f.calls.at(-1)[2],new RegExp(text));assert.equal(await f.state(),null);}
 await f.ingest('file');const r=await f.state();await f.services[0].pumpTyping(r.dueAt);
 const server=createServer((req,res)=>f.services[1].ingress(req,res)),port=await listen(server);t.after(()=>close(server));
 const response=await fetch('http://127.0.0.1:'+port+MIRROR_PATH+'/file-send',{method:'POST',headers:{authorization:'Bearer '+f.credential,'x-opencraft-mirror-server':'one','content-type':'application/json'},body:JSON.stringify({source:room(),replyTo:'file',name:'report.txt',bytes:Buffer.from('report').toString('base64')})});assert.equal(response.status,200);assert.equal((await response.json()).status,'delivered');await Promise.all([...f.services[1].pending]);assert.equal(await f.state(),null);assert.deepEqual(f.calls.at(-1).slice(2,4),['',true]);
 await f.ingest('fast-file');await f.services[1].settleTyping({source:room(),replyTo:'fast-file'},AbortSignal.timeout(1000));assert.equal(await f.state(),null);assert.equal(f.calls.at(-1)[0],'file','no empty bubble is created if no dots were opened');
});
test('concurrent opening and answer are serialized across replicas while follow-up admission stays immediate',async t=>{
 const f=await fixture(t);let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 f.setResponse(async(id,stream,content,finish)=>{if(!finish){started();await gate;}return 0;});await f.ingest('q');const r=await f.state();
 const opening=f.services[0].pumpTyping(r.dueAt);await ready;await f.ingest('followup');const answer=f.reply('followup','完成',f.services[1]);await sleep(40);assert.equal(f.calls.length,1);assert.equal((await f.stores[0].snapshot(room())).count,2);
 release();await Promise.all([opening,answer]);assert.deepEqual(f.calls.map(c=>c[3]),[false,true,true]);assert.deepEqual(f.calls.map(c=>c[0]),['q','q','followup']);assert.equal(f.calls[1][2],'');assert.equal(await f.state(),null);
});
test('an answer that wins before capability lookup completes cannot be followed by a late cosmetic open',async t=>{
 const f=await fixture(t);await f.ingest('q');const r=await f.state();let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r),original=f.stores[0].serverCapabilities.bind(f.stores[0]);
 f.stores[0].serverCapabilities=async(id:string)=>{started();await gate;return original(id);};const opening=f.services[0].pumpTyping(r.dueAt);await ready;
 // Simulate lease expiry while the old worker is suspended; the old token cannot mutate or send.
 await f.stores[1].command('DEL',f.stores[1].typing.key(r.member)+':lock');await f.reply('q','快回复',f.services[1]);release();await opening;assert.equal(f.calls.length,1);assert.equal(f.calls[0][3],true);
});
test('unknown open acknowledgement is persisted and never reopened after another replica takes over',async t=>{
 const f=await fixture(t);await f.ingest('q');const r=await f.state();f.setResponse(async()=>{throw Error('lost acknowledgement');});await f.services[0].pumpTyping(r.dueAt);assert.equal(f.calls.length,1);
 await f.services[1].pumpTyping(r.dueAt+1000);assert.equal(f.calls.length,1);f.setResponse(async()=>0);await f.reply('q','结果',f.services[1]);assert.equal(f.calls.length,2);assert.equal(f.calls[1][3],true);
});
test('Redis restart preserves the original deadline; stale dots end only display state and late output is separate',async t=>{
 const f=await fixture(t);await f.ingest('q');const r=await f.state();f.redis.clients.forEach(c=>c.close());await f.redis.stop();await f.redis.start();
 const recovered=new MirrorStore(await f.redis.connect());f.services[1].store=recovered;await f.services[1].pumpTyping(r.dueAt);assert.equal(f.calls.length,1);
 await f.services[1].pumpTyping(r.dueAt+PLACEHOLDER_TIMEOUT_MS);assert.equal(f.calls.length,2);assert.equal(f.calls[1][2],STILL_WORKING);assert.equal(await recovered.typing.read(r.member),null);
 await f.reply('q','迟到结果',f.services[1]);assert.equal(f.calls.length,3);assert.notEqual(f.calls[2][1],f.calls[0][1]);
});
test('binding changes, departed members and people absent from receiver identity never get binder fallback dots',async t=>{
 const f=await fixture(t);await f.ingest('q');const r=await f.state();await f.stores[0].command('HDEL',f.stores[0].keys(room()).meta,'binding');await f.stores[0].bind(room(),humanKey('wxfixture','Wei'),'one','Again');await f.services[1].pumpTyping(r.dueAt);assert.equal(f.calls.length,0);assert.equal(await f.state(),null);
 await f.ingest('other','Other');const other=await f.state('Other');await f.stores[0].register('one','One',{[humanKey('wxfixture','Wei')]:'human-Wei'},true,true);await f.services[0].pumpTyping(other.dueAt);assert.equal(f.calls.length,0);
 await f.ingest('gone');const gone=await f.state();f.members.splice(f.members.indexOf('Wei'),1);await f.services[0].pumpTyping(gone.dueAt);assert.equal(f.calls.length,0);assert.equal(await f.state(),null);
});
test('definitive open refusal is not retried; bounded presentation capacity never rejects native input',async t=>{
 const f=await fixture(t);await f.ingest('refused');const r=await f.state();f.setResponse(async()=>780013);await f.services[0].pumpTyping(r.dueAt);assert.equal(await f.state(),null);await f.services[1].pumpTyping(r.dueAt+1000);assert.equal(f.calls.length,1);
 const due=f.stores[0].typing.prefix+'due',entries=Array.from({length:16384},(_,i)=>[Date.now()+86400000,'fixture-full-'+i]).flat();await f.stores[0].command('ZADD',due,...entries);
 assert.equal(await f.ingest('at-capacity'),'stored');assert.equal(await f.state(),null);assert.equal((await f.stores[0].snapshot(room())).count,2);
});
test('non-text provider receipt and Relay control ticks do not wait on cosmetic cleanup',async t=>{
 const f=await fixture(t);let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 f.setResponse(async(id,stream,content,finish)=>{if(!finish){started();await gate;}return 0;});await f.ingest('file');const r=await f.state();const opening=f.services[0].pumpTyping(r.dueAt);await ready;
 const server=createServer((req,res)=>f.services[1].ingress(req,res)),port=await listen(server);t.after(()=>close(server));
 try{
  f.services[1].pumpTyping=async()=>{await gate;};
  await Promise.race([f.services[1].tick(),sleep(300).then(()=>{throw Error('cosmetic work delayed Relay control tick');})]);
  const response=await fetch('http://127.0.0.1:'+port+MIRROR_PATH+'/file-send',{method:'POST',headers:{authorization:'Bearer '+f.credential,'x-opencraft-mirror-server':'one','content-type':'application/json'},body:JSON.stringify({source:room(),replyTo:'file',name:'report.txt',bytes:Buffer.from('report').toString('base64')}),signal:AbortSignal.timeout(1000)});
  assert.equal((await response.json()).status,'delivered');assert.equal(f.calls.length,1,'opening remains blocked, but receipt has already returned');
 }finally{release();await opening;await Promise.all([...f.services[1].pending]);}
 assert.deepEqual(f.calls.map(c=>c[3]),[false,true]);assert.equal(await f.state(),null);
});

test('forwarded document retries retain their first directory labels; actual content changes remain conflicts',async t=>{
 const f=await fixture(t),doc={version:1,title:'讨论',entries:[{path:'1',sender:{id:'T624',name:'cissymao'},parts:[{kind:'text',text:'接口超时'}]}]},event={...f.event('forward'),text:'cissymao: 接口超时',forwardedRecord:doc};
 assert.equal(await f.services[0].ingest(event),'stored');const renamed=structuredClone(event);renamed.text='T624: 接口超时';renamed.forwardedRecord.entries[0].sender.name='T624';assert.equal(await f.services[1].ingest(renamed),'duplicate');renamed.forwardedRecord.entries[0].parts[0].text='different';await assert.rejects(f.services[1].ingest(renamed),/conflict/);
});

test('a late answer to the superseded input cannot finish the latest spinner',async t=>{
 const f=await fixture(t);await f.ingest('old');await f.services[0].pumpTyping();await f.ingest('new');await f.services[1].pumpTyping();
 const current=await f.state();await f.reply('old','旧答案');assert.equal((await f.state()).id,current.id);assert.equal((await f.state()).anchor,'new');
 assert.equal(f.calls.at(-1)[0],'old');assert.notEqual(f.calls.at(-1)[1],streamIdFor(room(),'old'),'closed old stream is not overwritten with late text');
 await f.reply('new');assert.equal(await f.state(),null);
});
test('close acknowledgement lost across replicas/restart is never replayed and never opens another spinner',async t=>{
 const f=await fixture(t);await f.ingest('old');await f.services[0].pumpTyping();await f.ingest('new');
 f.setResponse(async()=>{throw Error('unknown close outcome');});await f.services[0].pumpTyping();assert.equal(f.calls.length,2);assert.equal((await f.state()).retiring.closing,true);
 await f.ingest('newest');await f.services[1].pumpTyping(Date.now()+10000);assert.equal(f.calls.length,2);
 f.redis.clients.forEach(c=>c.close());await f.redis.stop();await f.redis.start();const recovered=new MirrorStore(await f.redis.connect());f.services[1].store=recovered;
 await f.services[1].pumpTyping(Date.now()+15000);assert.equal(f.calls.length,2);
 f.setResponse(async()=>0);await f.reply('newest','真实结果不被装饰故障阻断',f.services[1]);assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1)[0],'newest');
 assert.equal((await recovered.typing.read(recovered.typing.member(room(),'Wei'))).settled,true,'retain the uncertain predecessor barrier after the real answer');
 await f.services[1].pumpTyping(Date.now()+PLACEHOLDER_TIMEOUT_MS);assert.equal(f.calls.length,3,'bounded expiry does not replay close or create another spinner');assert.equal(await recovered.typing.read(recovered.typing.member(room(),'Wei')),null);
});
test('new intake during predecessor close waits for confirmation and opens only the newest input',async t=>{
 const f=await fixture(t);await f.ingest('a');await f.services[0].pumpTyping();await f.ingest('b');
 let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 f.setResponse(async(id,stream,content,finish)=>{if(id==='a'&&finish){started();await gate;}return 0;});
 const closing=f.services[0].pumpTyping();await ready;await f.ingest('c');assert.equal((await f.stores[0].snapshot(room())).count,3);await f.services[1].pumpTyping();assert.equal(f.calls.length,2);
 release();await closing;await f.services[1].pumpTyping();assert.deepEqual(f.calls.map(c=>[c[0],c[3]]),[['a',false],['a',true],['c',false]]);
});
test('immediate intake wakes cosmetic work without waiting for its provider call',async t=>{
 const f=await fixture(t,true);let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 f.setResponse(async(id,stream,content,finish)=>{if(!finish){started();await gate;}return 0;});
 try{assert.equal(await Promise.race([f.ingest('instant'),sleep(500).then(()=>{throw Error('provider delayed intake');})]),'stored');await ready;assert.equal(f.calls[0][0],'instant');await f.ingest('latest');}finally{release();}
 for(let i=0;i<100&&(await f.state())?.anchor!=='latest';i++)await sleep(10);
 assert.equal((await f.state()).anchor,'latest');assert.deepEqual(f.calls.map(c=>[c[0],c[3]]),[['instant',false],['instant',true],['latest',false]]);
});
test('replacement is confined to the same sender and room, and a duplicate callback cannot retire it',async t=>{
 const f=await fixture(t);await f.ingest('a');await f.ingest('b','Other');await f.ingest('c','Wei',room('two'));await f.services[0].pumpTyping();
 await f.ingest('a2');await f.services[1].pumpTyping();assert.equal(f.calls.filter(c=>c[3]).length,1);assert.equal(f.calls.find(c=>c[3])[0],'a');
 const before=f.calls.length;assert.equal(await f.ingest('a'),'duplicate');await f.services[0].pumpTyping();assert.equal(f.calls.length,before);assert.equal((await f.state()).anchor,'a2');assert.equal((await f.state('Other')).anchor,'b');
});
test('definitive close refusal suppresses replacement rather than creating two active dots',async t=>{
 const f=await fixture(t);await f.ingest('a');await f.services[0].pumpTyping();await f.ingest('b');f.setResponse(async()=>780013);await f.services[1].pumpTyping();await f.services[0].pumpTyping(Date.now()+1000);assert.equal(f.calls.length,2);assert.equal((await f.state()).retiring.closing,true);
});
test('staged rollout mode retains the legacy deadline/admission until all replicas understand supersession',async t=>{
 const f=await fixture(t);for(const service of f.services){service.immediateWaiting=false;service.followUpDelay=120000;}
 await f.ingest('a');const first=await f.state();await f.ingest('b');const second=await f.state();assert.equal(first.id,second.id);assert.equal(second.dueAt,first.createdAt+120000);
 await f.services[0].pumpTyping(first.createdAt+119999);assert.equal(f.calls.length,0);await f.services[1].pumpTyping(second.dueAt);assert.equal(f.calls[0][0],'b');
});

test('lease expiry during predecessor close cannot let a second replica open fresh dots',async t=>{
 const f=await fixture(t);await f.ingest('a');await f.services[0].pumpTyping();await f.ingest('b');
 let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 f.setResponse(async(id,stream,content,finish)=>{if(id==='a'&&finish){started();await gate;}return 0;});
 const closing=f.services[0].pumpTyping();await ready;const r=await f.state();await f.stores[1].command('DEL',f.stores[1].typing.key(r.member)+':lock');await f.services[1].pumpTyping();release();await closing;
 assert.equal(f.calls.length,2);assert.equal((await f.state()).retiring.closing,true);assert.equal((await f.state()).anchor,undefined);
});
test('timeout snapshot cannot finish a spinner superseded during the binding lookup',async t=>{
 const f=await fixture(t);await f.ingest('a');await f.services[0].pumpTyping();const old=await f.state();
 let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r),snapshot=f.stores[1].snapshot.bind(f.stores[1]);
 f.stores[1].snapshot=async(source:string)=>{started();await gate;return snapshot(source);};const timeout=f.services[1].pumpTyping(old.dueAt);await ready;await f.ingest('b');release();await timeout;
 assert.equal(f.calls.length,1,'stale timeout must not emit timeout text or claim the predecessor stream');await f.services[0].pumpTyping();assert.deepEqual(f.calls.map(c=>[c[0],c[3]]),[['a',false],['a',true],['b',false]]);
});
