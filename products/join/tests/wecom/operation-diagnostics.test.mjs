import test from 'node:test';
import assert from 'node:assert/strict';
import {createWeComChannelTransport} from '../../plugins/wecom/channel-transport.mjs';
import {groupSyncProvider} from '../../plugins/wecom/mirror/group-sync-provider.mjs';
import {cleanProviderMessage,safeDiagnostics} from '../../plugins/wecom/operation-diagnostics.mjs';
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
function fixture({mode='reject',matches=false,readFailure=false,legacy=false}={}) {
 let writes=0,reads=0;const data=new Map(),binding={serverId:'s',generation:'g',humanKey:'h'};
 const transport=createWeComChannelTransport({corpId:'wxfixture',serviceId:'fwfixture',corpSecret:'private-secret',token:'fixturetoken',aesKey:Buffer.alloc(32,7).toString('base64').replace(/=$/u,''),relayIngress:true,
 fetcher:async url=>{
  if(url.pathname.endsWith('/gettoken'))return Response.json({errcode:0,access_token:'private-access',expires_in:7200});
  if(url.pathname.endsWith('/chat/update')){writes++;if(mode==='timeout')throw new DOMException('https://bad/?access_token=private-access','TimeoutError');if(mode==='network')throw new TypeError('sensitive network stack');return Response.json({errcode:mode==='success'?0:85008,errmsg:'denied private-access private-secret https://host/path?access_token=secret\n"authorization":"Bearer hidden"'});}
  reads++;if(readFailure&&writes)return Response.json({errcode:60011,errmsg:'read failed https://host/?secret=hidden'});
  return Response.json({errcode:0,chat_info:{chatid:'room',name:writes&&matches?'new':'old',userlist:['WA','fwfixture']}});
 }});
 if(legacy)delete transport.updateChatDetailed;
 const svc={transport,authorizedSource:async()=>binding,store:{prefix:'test:',command:async(cmd,key,value,...args)=>{if(cmd==='GET')return data.get(key);if(args.includes('NX')&&data.has(key))return null;data.set(key,value);return 'OK';}}};
 const input={action:'apply',source,binding,id:'a'.repeat(64),sourceEpoch:'epoch',writeDeadline:Date.now()+30000,ownerUserId:'WA',base:'old',change:{kind:'name',name:'new'}};
 return {svc,input,data,recoverRead:(match=false)=>{readFailure=false;matches=match;},writes:()=>writes,run:()=>groupSyncProvider(svc,'s',input,AbortSignal.timeout(1000))};
}
test('real transport rejection persists cleaned errcode and survives replay without a second write',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.state,'rejected');assert.equal(r.diagnostics.write.errcode,85008);assert.equal(r.diagnostics.readback.confirmation,'not_matched');
 const encoded=JSON.stringify([...f.data.values()]);for(const secret of ['private-access','private-secret','hidden','https://','\\n'])assert.ok(!encoded.includes(secret),secret);
 f.input.action='verify';const replay=await f.run();assert.deepEqual(replay.diagnostics,r.diagnostics);f.input.action='apply';await f.run();assert.equal(f.writes(),1);
});
test('readback confirmation wins over a rejected response while retaining the write evidence',async()=>{
 const f=fixture({matches:true});const r=await f.run();assert.equal(r.state,'confirmed');assert.equal(r.diagnostics.write.errcode,85008);assert.equal(r.diagnostics.readback.confirmation,'matched');
});
for(const mode of ['timeout','network','success'])test(`${mode} without readback match remains unknown and never resends`,async()=>{
 const f=fixture({mode});const r=await f.run();assert.equal(r.state,'unknown');assert.equal(r.diagnostics.write.category,{timeout:'timeout',network:'type_or_network',success:'accepted'}[mode]);await f.run();f.input.action='verify';await f.run();assert.equal(f.writes(),1);
});
test('successful write and readback report confirmed',async()=>{const r=await fixture({mode:'success',matches:true}).run();assert.equal(r.state,'confirmed');assert.equal(r.diagnostics.write.errcode,0);});
test('failed confirmation remains unknown without exposing the prewrite roster',async()=>{const f=fixture({readFailure:true}),r=await f.run();assert.equal(r.state,'unknown');assert.equal(r.snapshot,null);assert.equal(r.snapshotUnavailable,true);assert.equal(r.memberEvidence,undefined);assert.equal(r.diagnostics.write.errcode,85008);assert.equal(r.diagnostics.readback.errcode,60011);assert.equal(r.diagnostics.readback.confirmation,'unavailable');assert.equal(JSON.parse([...f.data.values()][0]).state,'unknown');await assert.rejects(f.run());f.input.action='verify';await assert.rejects(f.run());assert.equal(f.writes(),1);f.recoverRead();assert.equal((await f.run()).state,'unknown');f.input.action='apply';assert.equal((await f.run()).state,'unknown');f.recoverRead(true);assert.equal((await f.run()).state,'confirmed');assert.equal(f.writes(),1);});
test('legacy string transport works and old public updateChat remains string/throw',async()=>{
 const f=fixture({legacy:true});assert.equal((await f.run()).state,'rejected');assert.equal(await f.svc.transport.updateChat(source,{name:'new'},AbortSignal.timeout(1000)),'rejected');
 const g=fixture({mode:'timeout'});await assert.rejects(g.svc.transport.updateChat(source,{name:'new'},AbortSignal.timeout(1000)),{name:'TimeoutError'});
});
test('message redaction bounds and diagnostic allowlist discard payloads and credentials',()=>{
 const s=cleanProviderMessage('access_token=hidden "secret":"quoted" authorization: Bearer hidden https://host/?q=hidden\r\n\u2028'+ 'x'.repeat(9000));assert.ok(s.length<=300);for(const bad of ['hidden','quoted','https://','\n','\r','\u2028'])assert.ok(!s.includes(bad),bad);
 assert.deepEqual(safeDiagnostics({payload:{token:'x'},stack:'private',apiPath:'/path?token=x',errcode:123,write:{secret:'x',write:{errcode:3}}}),{errcode:123,write:{}});
});
test('generic CLI errors return a correlation id and never arbitrary error codes or stacks',async t=>{
 const {openScopedWecomCli}=await import('../../plugins/wecom/scoped-cli-server.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const dir=await mkdtemp(tmpdir()+'/wcdiag-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const cli=await openScopedWecomCli({directory:dir+'/cli',socketDirectory:dir+'/run',scope:'d'.repeat(64),request:async()=>{throw Object.assign(new TypeError('secret credential'),{code:'https://host/?token=secret'});}});t.after(()=>cli.close());
 try {await promisify(execFile)(cli.launcher,['chat','get']);assert.fail('must fail');}catch(error){const result=JSON.parse(error.stderr);assert.equal(result.error,'wecom_cli_failed');assert.match(result.correlationId,/^[a-f0-9]{32}$/u);assert.ok(!error.stderr.includes('secret'));}
});
test('real Redis AOF restart replays the same receipt without another provider write',{skip:!process.env.WECOM_TEST_REDIS_SERVER},async t=>{
 const {mkdtemp,rm,access}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{spawn}=await import('node:child_process'),{once}=await import('node:events');
 const {default:Redis}=await import('ioredis'),{MirrorStore}=await import('../../plugins/wecom/mirror/store.mjs');
 const dir=await mkdtemp(tmpdir()+'/wc-redis-'),socket=dir+'/redis.sock';let child,client;
 const stop=async()=>{client?.disconnect();if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}child=undefined;};
 t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
 const start=async()=>{
  child=spawn(process.env.WECOM_TEST_REDIS_SERVER,['--port','0','--unixsocket',socket,'--unixsocketperm','700','--dir',dir,'--appendonly','yes','--appendfsync','always','--save',''],{stdio:'ignore'});
  for(let attempt=0;;attempt++){try{await access(socket);break;}catch{if(attempt>=100)throw Error('test Redis socket unavailable');await new Promise(resolve=>setTimeout(resolve,20));}}
  client=new Redis({path:socket,lazyConnect:true,retryStrategy:()=>20,maxRetriesPerRequest:2});client.on('error',()=>{});
  await Promise.race([client.connect(),new Promise((_,reject)=>setTimeout(()=>reject(Error('test Redis startup timed out')),5000).unref())]);
  return new MirrorStore({key:k=>'diagnostic-fixture:'+k,client});
 };
 const f=fixture();f.svc.store=await start();await f.svc.store.verifyDurability();const first=await f.run();assert.equal(first.state,'rejected');
 await stop();f.svc.store=await start();f.input.action='verify';const replay=await f.run();assert.deepEqual(replay.diagnostics,first.diagnostics);
 f.input.action='apply';await f.run();assert.equal(f.writes(),1);
});

test('real transport treats owner denial as operation-scoped, never disabling add or rename or impersonating owner',async()=>{
 let privileged=false,name='old',members=['WA','WB','fwfixture'];const writes=[],data=new Map(),binding={serverId:'s',generation:'g',humanKey:'h'};
 const transport=createWeComChannelTransport({corpId:'wxfixture',serviceId:'fwfixture',corpSecret:'private-secret',token:'fixturetoken',aesKey:Buffer.alloc(32,7).toString('base64').replace(/=$/u,''),relayIngress:true,
 fetcher:async(url,options)=>{
  if(url.pathname.endsWith('/gettoken'))return Response.json({errcode:0,access_token:'private-access',expires_in:7200});
  if(url.pathname.endsWith('/chat/update')){
   const change=JSON.parse(options.body);writes.push(change);
   if(change.del_user_list?.length&&!privileged)return Response.json({errcode:86101,errmsg:'operation require owner privilege'});
   if(change.name)name=change.name;
   members=[...new Set([...members,...(change.add_user_list??[])])].filter(id=>!change.del_user_list?.includes(id));
   return Response.json({errcode:0});
  }
  // This deployed API does not expose the group owner. Native roles cannot fill that gap.
  return Response.json({errcode:0,chat_info:{chatid:'room',name,userlist:members}});
 }});
 const svc={transport,authorizedSource:async()=>binding,store:{prefix:'permission:',command:async(cmd,key,value,...args)=>{if(cmd==='GET')return data.get(key);if(args.includes('NX')&&data.has(key))return null;data.set(key,value);return 'OK';}}};
 const input={action:'apply',source,binding,sourceEpoch:'epoch',writeDeadline:Date.now()+30000,ownerUserId:'WA'};
 const run=(id,change,base)=>groupSyncProvider(svc,'s',{...input,id:id.repeat(64),change,base},AbortSignal.timeout(1000));
 const denied=await run('a',{kind:'member',userId:'WB',present:false},true);
 assert.equal(denied.state,'rejected');assert.equal(denied.diagnostics.action,'remove');assert.equal(denied.diagnostics.write.errcode,86101);
 assert.equal((await run('a',{kind:'member',userId:'WB',present:false},true)).state,'rejected');assert.equal(writes.length,1);
 assert.equal((await run('b',{kind:'member',userId:'WC',present:true},false)).state,'confirmed');
 assert.equal((await run('c',{kind:'name',name:'888'},'old')).state,'confirmed');
 privileged=true;assert.equal((await run('d',{kind:'member',userId:'WB',present:false},true)).state,'confirmed');
 assert.equal(writes.length,4);for(const change of writes){assert.equal(Object.hasOwn(change,'owner'),false);assert.equal(Object.hasOwn(change,'operator'),false);}
 // Desired state already exists: verification is enough, not another kick.
 assert.equal((await run('e',{kind:'member',userId:'WB',present:false},true)).state,'confirmed');assert.equal(writes.length,4);
});
