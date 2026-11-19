import '../../plugins/wecom/assistant-install.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../../../packages/access-control/src/actors';
import {Collaboration} from '../../../../packages/access-control/src/collaboration';
import {wecomMention} from '../../plugins/wecom/assistant-mentions.mjs';

async function fixture(t:test.TestContext){
 const beforeClose:Array<()=>unknown>=[];
 const dir=await mkdtemp(join(tmpdir(),'wecom-assistant-'));
 const priorEnv={data:process.env.OPENCRAFT_DATA_DIR,workspace:process.env.OPENCRAFT_WORKSPACE_DIR};
 process.env.OPENCRAFT_DATA_DIR=dir;process.env.OPENCRAFT_WORKSPACE_DIR=join(dir,'workspace');
 const storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors);
 const human=(id:string)=>actors.resolveHuman({provider:'tencentoa',subject:id,displayName:id,expiresAt:Date.now()+3600000})!;
 const alice=human('alice'),bob=human('bob'),unlinked=human('unlinked');
 for(const [c,id] of [[alice,'WA'],[bob,'WB']] as const)actors.bindHuman(c,{provider:'wecom.wxfixture',subject:id,displayName:id,expiresAt:Date.now()+60000});
 const channels=(c:any,op:string,p:any={})=>service.communicate(c,'opencraft/channels/'+op,p);
 const group=await channels(alice,'group/create',{title:'team',memberActorIds:[bob.actorId],clientRequestId:'team'});
 const bots=[];for(const c of [alice,bob]){const a=await service.personalAssistant(c,'opencraft/personal-assistant/claim');const p=await service.provisionPersonalAssistant(c);bots.push({assistant:a.assistant,context:actors.authenticateSession(p.credential.token)!});}
 const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']),incarnation='fixture';
 const sync=(method:string,params:any={})=>service.synchronizeChannels({method,params:{...params,incarnation}});
 await sync('configure',{bindings:[{source,channelId:group.id}],images:false});
 const ingest=(id:string,author:string,text='请总结本群',mentioned=true)=>sync('ingest',{source,arrival:{source,id,author,text,at:1000,mentioned}});
 const call=(n:number,op:string,p:any={})=>service.communicate(bots[n]!.context,'join/wecom-assistant/'+op,p);
 t.after(async()=>{for(const close of beforeClose)await close();await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});for(const [key,value]of [['OPENCRAFT_DATA_DIR',priorEnv.data],['OPENCRAFT_WORKSPACE_DIR',priorEnv.workspace]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 return {beforeClose,directory:dir,service,storage,actors,alice,bob,unlinked,bots,group,source,channels,sync,ingest,call};
}
test('ordinary questions and command keywords inside sentences remain assistant requests',()=>{
 assert.deepEqual(wecomMention({mentioned:true,text:'@机器人 帮我查一下服务器为什么慢'}),{kind:'assistant',text:'帮我查一下服务器为什么慢'});
 assert.equal(wecomMention({mentioned:true,text:'服务器'})?.kind,'command');
 assert.equal(wecomMention({mentioned:false,text:'请总结'}) ,null);
});
test('two senders in one room route to their own assistants, deduplicate and reply as distinct assistants',async t=>{
 const f=await fixture(t);
 const [a,b]=await Promise.all([f.ingest('a','WA'),f.ingest('b','WB')]);
 assert.equal((await f.ingest('a','WA')).messageId,a.messageId);
 const [as,bs]=await Promise.all([f.call(0,'scopes'),f.call(1,'scopes')]);
 assert.equal(as.length,1);assert.equal(bs.length,1);assert.notEqual(as[0].scope,bs[0].scope);
 assert.deepEqual((await f.call(0,'messages',{scope:as[0].scope,after:0})).map((r:any)=>r.id),[a.messageId]);
 assert.deepEqual((await f.call(1,'messages',{scope:bs[0].scope,after:0})).map((r:any)=>r.id),[b.messageId]);
 await assert.rejects(f.call(0,'messages',{scope:bs[0].scope,after:0}),/denied/);
 const r=await f.call(0,'reply',{scope:as[0].scope,id:'reply',text:'Alice reply'});
 assert.equal((await f.call(0,'reply',{scope:as[0].scope,id:'reply',text:'Alice reply'})).messageId,r.messageId);
 await assert.rejects(f.call(0,'reply',{scope:as[0].scope,id:'reply',text:'changed'}),/idempotency_conflict/);
 const sent=await f.sync('claim');assert.equal(sent.messageId,r.messageId);assert.equal(sent.author,'alice的助理');assert.equal(sent.replyTo,'a');
 assert.equal(sent.source,f.source);
 assert.deepEqual(sent.presentation,{version:1,sender:{id:f.bots[0]!.context.actorId,role:'assistant',displayName:'alice的助理'},format:'markdown'});
 await f.sync('settle',{source:f.source,messageId:sent.messageId,attemptId:sent.attemptId,status:'delivered'});
 assert.equal(await f.sync('claim'),null);
 await f.ingest('a2','WA');await f.call(0,'reply',{scope:as[0].scope,id:'reply2',text:'Second answer'});
 const second=await f.sync('claim');assert.equal(second.text,'Second answer');assert.equal(second.replyTo,'a2','a later mention in the same scope is the reply target');
});
test('unlinked identity never falls back to the binder; normal messages and control commands never invoke a model',async t=>{
 const f=await fixture(t);await f.ingest('unknown','unlinked');await f.ingest('ordinary','WA','hello',false);await f.ingest('control','WA','帮助');
 assert.deepEqual(await f.call(0,'scopes'),[]);assert.deepEqual(await f.call(1,'scopes'),[]);
 const notice=await f.sync('claim');assert.match(notice.text,/关联你自己的/);assert.equal(notice.replyTo,'unknown');
});
test('membership removal fences pending replies and old requests even after rejoin',async t=>{
 const f=await fixture(t);await f.ingest('b','WB');const [{scope}]=await f.call(1,'scopes');
 await f.call(1,'reply',{scope,id:'reply',text:'pending'});
 await f.channels(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove'});
 assert.equal(await f.sync('claim'),null);
 await assert.rejects(f.call(1,'history',{scope}),/denied/);
 await f.channels(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present:true,clientRequestId:'rejoin'});
 assert.deepEqual(await f.call(1,'scopes'),[]);
 await f.ingest('new','WB');const [next]=await f.call(1,'scopes');assert.notEqual(next.scope,scope);
});
test('revoke fences an in-flight delivery, and callback retry cannot change mention ownership',async t=>{
 const f=await fixture(t);await f.ingest('a','WA');const [{scope}]=await f.call(0,'scopes');
 await f.call(0,'reply',{scope,id:'r',text:'answer'});const sent=await f.sync('claim');
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/revoke');
 await assert.rejects(f.sync('check',{source:f.source,messageId:sent.messageId,attemptId:sent.attemptId}),/denied/);
 await assert.rejects(f.ingest('a','WB'),/idempotency_conflict/);
});
test('native @助理 in an IOA linked group resolves the current sender; unlinked groups retain core behavior',async t=>{
 const f=await fixture(t);
 await f.channels(f.alice,'messages/send',{channelId:f.group.id,clientMessageId:'native-a',parts:[{type:'text',text:'@助理 总结一下'}]});
 await f.channels(f.alice,'messages/send',{channelId:f.group.id,clientMessageId:'native-bare',parts:[{type:'text',text:'@助理'}]});
 await f.channels(f.bob,'messages/send',{channelId:f.group.id,clientMessageId:'native-b',parts:[{type:'text',text:'告诉我进展'}],wakeActorIds:[f.bots[1].assistant.actorId]});
 const [a]=await f.call(0,'scopes'),[b]=await f.call(1,'scopes');assert.notEqual(a.scope,b.scope);
 assert.equal((await f.call(0,'messages',{scope:a.scope,after:0})).length,2);
 assert.equal((await f.call(1,'messages',{scope:b.scope,after:0})).length,1);
 const other=await f.channels(f.alice,'group/create',{title:'unlinked',memberActorIds:[],clientRequestId:'unlinked'});
 await f.channels(f.alice,'messages/send',{channelId:other.id,clientMessageId:'plain',parts:[{type:'text',text:'@助理 hello'}]});
 assert.equal((await f.call(0,'scopes')).length,1);
});
test('actual group runner consumes durable intake and reopens the same isolated profile',async t=>{
 const {createWecomAssistantRuntime}=await import('../../plugins/wecom/assistant-runtime.mjs');
 const {startPersonalAssistant}=await import('../../../../apps/personal-assistant/src/runtime/personal-assistant.mjs');
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'wecom-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await f.ingest('context','WA','老歌在吗',false);
 const trigger=await f.ingest('one','WA','@Join 支持 (Join 支持)');const [{scope}]=await f.call(0,'scopes');
 await f.ingest('later','WA','之后的消息不属于这次触发的前文',false);
 let opened:any;const request=(method:string,p:any)=>f.service.communicate(f.bots[0].context,method,p);
 const inputs:any[]=[];
 const start=async(options:any)=>{
   opened=await startPersonalAssistant(options);
   const dispatch=opened.dispatch.bind(opened);
   opened.dispatch=(request:any)=>{if(request.op==='say')inputs.push(request);return dispatch(request);};
   return opened;
 };
 let runtime=createWecomAssistantRuntime({directory,profileOptions:{telemetry:{enabled:false}},request,start,onError:(e:unknown)=>console.error(e)});
 t.after(()=>runtime.close());
 await runtime.poll();await runtime.settle();assert.ok(opened);const original=opened.profile.path??opened.profile.directory;
 const context=JSON.parse(inputs[0].params.text.split('\n').slice(1).join('\n'));
 assert.equal(context.channelId,f.group.id);assert.equal(context.trigger.messageId,trigger.messageId);
 assert.ok(context.trigger.authorId);assert.equal(context.request.mentionOnly,true);
 assert.ok(context.history.messages.some((m:any)=>m.text==='老歌在吗'));
 assert.ok(context.history.messages.every((m:any)=>m.sequence<context.trigger.seq));
 assert.equal(context.history.nextBefore,context.history.messages[0].sequence);
 assert.ok(!context.history.messages.some((m:any)=>m.text.includes('之后的消息')));
 assert.equal((await opened.dispatch({op:'platform.groups.list',params:{}})).groups[0].id,f.group.id);
 await assert.rejects(opened.dispatch({op:'platform.conversations.list',params:{}}));
 const sent=await opened.dispatch({op:'message.send',id:'group-reply',params:{message:{type:'text',content:'群助理实际回复'}}});
 const until=Date.now()+5000;while(Date.now()<until){const m=await opened.dispatch({op:'message.get',params:{messageId:sent.messageId}});if(m.state==='accepted')break;await new Promise(r=>setTimeout(r,25));}
 assert.equal((await opened.dispatch({op:'message.get',params:{messageId:sent.messageId}})).state,'accepted');
 const delivered=await f.sync('claim');assert.equal(delivered.text,'群助理实际回复');assert.equal(delivered.source,f.source);
 await f.sync('settle',{source:f.source,messageId:delivered.messageId,attemptId:delivered.attemptId,status:'delivered'});
 const cursor=opened.uow.db.prepare("SELECT value FROM meta WHERE key='join:wecom:inbox-sequence'").get();assert.ok(Number(cursor.value)>0);
 await runtime.close();runtime=createWecomAssistantRuntime({directory,profileOptions:{telemetry:{enabled:false}},request,start});
 await runtime.poll();await runtime.settle();assert.equal(opened.profile.path??opened.profile.directory,original);
 assert.equal(opened.uow.db.prepare("SELECT value FROM meta WHERE key='join:wecom:inbox-sequence'").get().value,cursor.value);
 assert.ok(original?.includes(scope));
 assert.equal(inputs.length,1);
});
test('real isolated Host processes two people in one group and restarts without duplicate replies',{timeout:45000},async t=>{
 const {createPersonalAssistantHost}=await import('../../../../apps/personal-assistant/src/runtime/host-supervisor.mjs');
 const f=await fixture(t);let host:any;
 f.beforeClose.push(()=>host?.close());
 const wait=async(check:()=>Promise<boolean>)=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('Group Host timed out');};
 const start=()=>createPersonalAssistantHost({directory:f.directory,service:f.service,intervalMs:50,readConfig:async()=>({maxRuntimes:2,profileOptions:{mode:'fixture',telemetry:{enabled:false}}})});
 await Promise.all([f.ingest('host-a','WA','你好'),f.ingest('host-b','WB','你好')]);host=await start();
 const messages=async()=>(await f.channels(f.alice,'messages/list',{channelId:f.group.id})).messages;
 await wait(async()=>{const rows=await messages();return f.bots.every(b=>rows.some((r:any)=>r.sender?.id===b.assistant.actorId));});
 const before=await messages();await host.close();host=await start();
 await wait(async()=>f.bots.every(b=>host.state(b.assistant.binding.botId).phase==='running'));
 await new Promise(r=>setTimeout(r,1500));assert.deepEqual(await messages(),before);
});
test('long replies split atomically, retain payload identity, and cannot be retargeted',async t=>{
 const f=await fixture(t);await f.ingest('a','WA');const [{scope}]=await f.call(0,'scopes');
 const text='中😀'.repeat(3000);const receipt=await f.call(0,'reply',{scope,id:'long',text});
 assert.equal((await f.call(0,'reply',{scope,id:'long',text})).messageId,receipt.messageId);
 await assert.rejects(f.call(0,'reply',{scope,id:'long',text:text.slice(0,-3)}),/idempotency_conflict/);
 await assert.rejects(f.call(0,'reply',{scope,id:'malformed',text:'\uD83D'}),/denied/);
 await assert.rejects(f.call(0,'reply',{scope,id:'new',text:'no',channelId:'other'}),/denied/);
 let combined='';for(;;){const row=await f.sync('claim');if(!row)break;assert.equal(row.source,f.source);assert.ok(row.text.length<=3500);combined+=row.text;
 await f.sync('settle',{source:f.source,messageId:row.messageId,attemptId:row.attemptId,status:'delivered'});}
 assert.equal(combined,text);
});
test('group assistant files become a readable timeline line plus staged bytes for the transport',async t=>{
 const data=await mkdtemp(join(tmpdir(),'wecom-files-'));
 const env={d:process.env.OPENCRAFT_DATA_DIR,w:process.env.OPENCRAFT_WORKSPACE_DIR};
 process.env.OPENCRAFT_DATA_DIR=data;process.env.OPENCRAFT_WORKSPACE_DIR=join(data,'ws');
 t.after(()=>{for(const [k,v] of [['OPENCRAFT_DATA_DIR',env.d],['OPENCRAFT_WORKSPACE_DIR',env.w]] as const){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const { stagedGroupFile, dropGroupFile }=await import('../../plugins/wecom/outbound-files.mjs');
 const f=await fixture(t);await f.ingest('a','WA');const [s]=await f.call(0,'scopes');
 const bytes=Buffer.from('%PDF-1.4 report');
 const r=await f.call(0,'file',{scope:s.scope,id:'m1:0',name:'周报.pdf',data:bytes.toString('base64')});
 assert.equal((await f.call(0,'file',{scope:s.scope,id:'m1:0',name:'周报.pdf',data:bytes.toString('base64')})).messageId,r.messageId);
 const sent=await f.sync('claim');assert.equal(sent.text,'[文件] 周报.pdf');assert.equal(sent.messageId,r.messageId);
 assert.deepEqual({...stagedGroupFile(sent.messageId),bytes:stagedGroupFile(sent.messageId).bytes.toString()},{name:'周报.pdf',mode:'auto',bytes:'%PDF-1.4 report'});
 dropGroupFile(sent.messageId);assert.equal(stagedGroupFile(sent.messageId),null);
 await assert.rejects(f.call(0,'file',{scope:s.scope,id:'m2',name:'../x',data:'eA=='}),/denied/);
});
test('group create-chat requests stage an action owned by the requester',async t=>{
 const data=await mkdtemp(join(tmpdir(),'wecom-chat-'));
 const env={d:process.env.OPENCRAFT_DATA_DIR,w:process.env.OPENCRAFT_WORKSPACE_DIR};
 process.env.OPENCRAFT_DATA_DIR=data;process.env.OPENCRAFT_WORKSPACE_DIR=join(data,'ws');
 t.after(()=>{for(const [k,v] of [['OPENCRAFT_DATA_DIR',env.d],['OPENCRAFT_WORKSPACE_DIR',env.w]] as const){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const { stagedGroupAction }=await import('../../plugins/wecom/outbound-files.mjs');
 const f=await fixture(t);await f.ingest('a','WA');const [s]=await f.call(0,'scopes');
 const r=await f.call(0,'chat',{scope:s.scope,id:'m1',title:'事故 #123',members:['zhangsan','lisi']});
 const sent=await f.sync('claim');assert.equal(sent.text,'[建群] 事故 #123');
 assert.deepEqual(stagedGroupAction(r.messageId),{kind:'create-chat',title:'事故 #123',members:['zhangsan','lisi'],owner:'WA'});
 await assert.rejects(f.call(0,'chat',{scope:s.scope,id:'m2',title:'x',members:['bad name']}),/denied/);
});
test('a reply threads under its open mention; later output with no open mention stands alone',async t=>{
 const f=await fixture(t);await f.ingest('a','WA');const [s]=await f.call(0,'scopes');
 await f.call(0,'reply',{scope:s.scope,id:'answer',text:'答案'});
 const first=await f.sync('claim');assert.equal(first.replyTo,'a');
 await f.sync('settle',{source:f.source,messageId:first.messageId,attemptId:first.attemptId,status:'delivered'});
 await f.call(0,'reply',{scope:s.scope,id:'report',text:'定时日报'});
 const later=await f.sync('claim');assert.equal(later.replyTo,undefined);
});

test('report replies stage cards in the native outbox with stable payload identity',async t=>{
 const data=await mkdtemp(join(tmpdir(),'wecom-report-'));
 const env={d:process.env.OPENCRAFT_DATA_DIR,w:process.env.OPENCRAFT_WORKSPACE_DIR};
 process.env.OPENCRAFT_DATA_DIR=data;process.env.OPENCRAFT_WORKSPACE_DIR=join(data,'ws');
 t.after(()=>{for(const [k,v] of [['OPENCRAFT_DATA_DIR',env.d],['OPENCRAFT_WORKSPACE_DIR',env.w]] as const){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const { stagedGroupAction }=await import('../../plugins/wecom/outbound-files.mjs');
 const f=await fixture(t);await f.ingest('a','WA');const [scope]=await f.call(0,'scopes');
 const report={title:'构建日报',summary:'全部通过',url:'https://example.com/build',metrics:[{label:'成功',value:'12'}]};
 const params={scope:scope.scope,id:'daily-1',text:'/图文 '+JSON.stringify(report)};
 const receipt=await f.call(0,'reply',params);
 assert.equal((await f.call(0,'reply',params)).messageId,receipt.messageId);
 assert.deepEqual(stagedGroupAction(receipt.messageId),{kind:'report',report,owner:'WA',requestId:receipt.messageId});
 const sent=await f.sync('claim');assert.match(sent.text,/成功：12/);assert.equal(sent.messageId,receipt.messageId);
 await assert.rejects(f.call(0,'reply',{...params,text:'/图文 '+JSON.stringify({...report,title:'changed'})}));
});

test('retiring a WeCom source preserves history and fences all pending deliveries',async t=>{
 const f=await fixture(t);await f.ingest('retire','WA');const [{scope}]=await f.call(0,'scopes');
 const receipt=await f.call(0,'reply',{scope,id:'pending',text:'待发'});
 await f.sync('retireSource',{source:f.source,messageId:receipt.messageId});
 const audit=new (await import('node:sqlite')).DatabaseSync(join(f.directory,'opencraft-server.sqlite'),{readOnly:true});
 try{assert.equal(audit.prepare('SELECT state FROM actor_channel_outbox WHERE message_id=?').get(receipt.messageId)?.state,'delivered');}finally{audit.close();}
 assert.deepEqual(await f.sync('mirrorSources',{corpId:'wxfixture'}),[]);
 assert.deepEqual(await f.call(0,'scopes'),[]);
 assert.equal(await f.sync('claim'),null);
 const history=await f.channels(f.alice,'messages/list',{channelId:f.group.id});assert.ok(history.messages.length>=2);
});

test('native and WeCom requests share a scope but every action resolves the current provider userid',async t=>{
 const f=await fixture(t);process.env.OPENCRAFT_DATA_DIR=f.directory;process.env.OPENCRAFT_WORKSPACE_DIR=f.directory+'-ws';
 const {stagedGroupAction}=await import('../../plugins/wecom/outbound-files.mjs');
 await f.ingest('wecom-first','WA');const [{scope}]=await f.call(0,'scopes');
 const before=await f.call(0,'chat',{scope,id:'before',title:'Before',members:[]});assert.equal(stagedGroupAction(before.messageId).owner,'WA');
 await f.channels(f.alice,'messages/send',{channelId:f.group.id,clientMessageId:'native-after-wecom',parts:[{type:'text',text:'@助理 再处理一下'}]});
 assert.equal((await f.call(0,'scopes'))[0].scope,scope);
 assert.equal((await f.call(0,'authorize',{scope})).source,f.source);
 for(const [op,params]of [['chat',{id:'after',title:'After',members:[]}],['edit',{id:'edit',add:[],remove:[],name:'New name'}],['reply',{id:'menu',text:'/快捷入口'}],['reply',{id:'report',text:'/图文 '+JSON.stringify({title:'日报',summary:'完成',url:'https://example.com/report'})}]] as const){
  const receipt=await f.call(0,op,{scope,...params});assert.equal(stagedGroupAction(receipt.messageId).owner,'WA');
 }
 // Native-first requests used to poison report ownership through the oldest row.
 await f.channels(f.bob,'messages/send',{channelId:f.group.id,clientMessageId:'native-first',parts:[{type:'text',text:'@助理 帮我处理'}]});
 const [bs]=await f.call(1,'scopes');const br=await f.call(1,'reply',{scope:bs.scope,id:'bob-report',text:'/图文 '+JSON.stringify({title:'日报',summary:'完成',url:'https://example.com/report'})});assert.equal(stagedGroupAction(br.messageId).owner,'WB');
});
test('lost ACK replays a frozen voice transcript through actual native SQLite ingress',async t=>{
 const f=await fixture(t);process.env.OPENCRAFT_DATA_DIR=f.directory;process.env.OPENCRAFT_WORKSPACE_DIR=f.directory+'-ws';
 const {createMirrorTarget}=await import('../../plugins/wecom/mirror/target.mjs');let pending=true,acks=0,transcripts=0;const seen:string[]=[];
 const event={source:f.source,id:'voice-ack-loss',author:'WA',text:'[语音]',at:1000,mentioned:true,assistantEligible:true,voice:{mediaId:'voice',format:'amr'}};
 const fetcher=async(url:any)=>{const action=String(url).split('/').pop();if(action==='link-poll')return Response.json({links:[]});if(action==='poll')return Response.json({deliveries:pending?[{binding:{serverId:'one',source:f.source},event,token:'t'}]:[]});if(action==='file')return new Response('audio');if(action==='ack'){if(++acks===1)throw Error('lost ACK');pending=false;}return Response.json({});};
 const config={relayOrigin:'https://relay.example/',serverId:'one',credential:'c'.repeat(43),corpId:'wxfixture'};
 const target=await createMirrorTarget(config,{collaboration:f.service},fetcher,{transcribe:async()=>++transcripts===1?'明天开会':'另一个转写'});
 target.subscribe(async(arrival:any)=>{seen.push(arrival.text);return f.sync('ingest',{source:f.source,arrival});});
 const deadline=Date.now()+6000;try{while(pending&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.equal(pending,false);assert.equal(acks,2);assert.equal(transcripts,1);assert.deepEqual(seen,['[语音] 明天开会','[语音] 明天开会']);}finally{await target.close();}
});
test('pre-journal voice retries recover accepted text but never bypass immutable author and time checks',async t=>{
 const f=await fixture(t);await f.ingest('legacy-voice','WA','[语音] 已接受的转写');
 const arrival={source:f.source,id:'legacy-voice',author:'WA',text:'[语音]',at:1000,mentioned:true};
 const prior=await f.sync('received',{source:f.source,arrival});assert.equal(prior.text,'[语音] 已接受的转写');
 await assert.rejects(f.sync('received',{source:f.source,arrival:{...arrival,author:'WB'}}),/idempotency_conflict/u);
 await assert.rejects(f.sync('received',{source:f.source,arrival:{...arrival,at:1001}}),/idempotency_conflict/u);
 await assert.rejects(f.sync('received',{source:f.source,arrival:{...arrival,mentioned:false}}),/idempotency_conflict/u);
 assert.equal(await f.sync('received',{source:f.source,arrival:{...arrival,id:'not-received'}}),null);
 assert.equal((await f.ingest('legacy-voice','WA',prior.text)).messageId,prior.messageId);
});
test('completed chunk receipt replays do not restage delivered bytes or create another outbox message',async t=>{
 const f=await fixture(t);process.env.OPENCRAFT_DATA_DIR=f.directory;process.env.OPENCRAFT_WORKSPACE_DIR=f.directory+'-ws';
 const {dropGroupFile,stagedGroupFile}=await import('../../plugins/wecom/outbound-files.mjs');
 await f.ingest('file-command','WA');const [{scope}]=await f.call(0,'scopes');const params={scope,id:'file-repeat',name:'report.txt',data:Buffer.from('contents').toString('base64'),offset:0,size:8};
 const original=await f.call(0,'file',params),sent=await f.sync('claim');assert.equal(sent.messageId,original.messageId);dropGroupFile(sent.messageId);
 // Provider delivery is known but native settle may still be pending when the producer retries.
 assert.equal((await f.call(0,'file',params)).messageId,original.messageId);assert.equal(stagedGroupFile(original.messageId),null);
 await f.sync('settle',{source:f.source,messageId:sent.messageId,attemptId:sent.attemptId,status:'delivered'});
 assert.equal((await f.call(0,'file',params)).messageId,original.messageId);assert.equal(await f.sync('claim'),null);assert.equal(stagedGroupFile(original.messageId),null);
 await assert.rejects(f.call(0,'file',{...params,data:Buffer.from('changed!').toString('base64')}),/changed/u);
});
test('legacy provenance migration verifies the HMAC against native external IDs, never pasted foreign tokens',async t=>{
 const f=await fixture(t),fs=await import('node:fs');
 const {inboundFileId}=await import('../../plugins/wecom/inbound-files.mjs'),{createMirrorTarget}=await import('../../plugins/wecom/mirror/target.mjs');
 const credential='e'.repeat(43),id=inboundFileId(credential,f.source,'legacy-file'),foreign=inboundFileId(credential,f.source+'other','foreign-file');
 const root=join(f.directory,'join-wecom-inbound-files');
 for(const ref of [id,foreign]){fs.mkdirSync(join(root,ref),{recursive:true});fs.writeFileSync(join(root,ref,'meta.json'),JSON.stringify({name:'legacy.txt',status:'ready',parts:1,chars:6}));fs.writeFileSync(join(root,ref,'part1.txt'),'legacy');}
 await f.ingest('legacy-file','WA','[文件] legacy.txt（资料编号 '+id+'）',false);await f.ingest('pasted-foreign','WA','资料编号 '+foreign,false);
 const fetcher=async(url:any)=>Response.json(String(url).endsWith('/link-poll')?{links:[]}:String(url).endsWith('/poll')?{deliveries:[]}:{});
 const target=await createMirrorTarget({relayOrigin:'https://relay.example/',serverId:'one',credential,corpId:'wxfixture'},{collaboration:f.service},fetcher);target.subscribe(async()=>{throw Error('no delivery expected');});
 const deadline=Date.now()+4000;try{while(!fs.existsSync(join(root,id,'source.json'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.equal(JSON.parse(fs.readFileSync(join(root,id,'source.json'),'utf8')).source,f.source);assert.equal(fs.existsSync(join(root,foreign,'source.json')),false);}finally{await target.close();}
});


test('human names ending in 的助理 remain human text; native message owner supplies identity and format',async t=>{
 const f=await fixture(t);
 const alice=f.actors.resolveHuman({provider:'tencentoa',subject:'alice',displayName:'alice的助理',expiresAt:Date.now()+60000})!;
 await f.channels(alice,'messages/send',{channelId:f.group.id,clientMessageId:'human-markdown-looking',parts:[{type:'text',text:'**不是助理**'}]});
 const row=await f.sync('claim');
 assert.equal(row.author,'alice的助理');assert.equal(row.text,'**不是助理**');
 assert.deepEqual(row.presentation,{version:1,sender:{id:alice.actorId,role:'human',displayName:'alice的助理'},format:'text'});
 await f.sync('settle',{source:f.source,messageId:row.messageId,attemptId:row.attemptId,status:'delivered'});
});

test('legacy WeCom assistant routing never falls back to an additional Bot when the default is revoked',async t=>{
 const f=await fixture(t),prefix='opencraft/personal-assistant/';
 const extra=await f.service.personalAssistant(f.alice,prefix+'bots/create',{name:'Additional worker',duties:'Private work only',environment:{kind:'local'},clientRequestId:'wecom-additional-guard'});
 const provision=await f.service.provisionPersonalAssistant(f.alice,extra.assistant.binding.botId),context=f.actors.authenticateSession(provision.credential.token)!;
 await f.service.personalAssistant(f.alice,prefix+'revoke');
 const receipt=await f.ingest('missing-default','WA');
 const row=f.storage.database.prepare('SELECT assistant_id,reason FROM join_wecom_assistant_requests WHERE message_id=?').get(receipt.messageId);
 assert.equal(row?.reason,'assistant');assert.equal(row?.assistant_id,null);
 assert.deepEqual(await f.service.communicate(context,'join/wecom-assistant/scopes',{}),[]);
 const notice=await f.sync('claim');assert.match(notice.text,/开通你自己的助理/);
 await f.sync('settle',{source:f.source,messageId:notice.messageId,attemptId:notice.attemptId,status:'delivered'});
 await f.service.personalAssistant(f.alice,prefix+'claim');
 const defaultProvision=await f.service.provisionPersonalAssistant(f.alice);f.bots[0]!.context=f.actors.authenticateSession(defaultProvision.credential.token)!;
 await f.ingest('default-restored','WA');const scopes=await f.call(0,'scopes');assert.equal(scopes.length,1);
 assert.deepEqual(await f.service.communicate(context,'join/wecom-assistant/scopes',{}),[]);
});
