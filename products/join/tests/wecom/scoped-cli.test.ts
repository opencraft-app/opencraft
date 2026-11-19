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

async function fixture(t:test.TestContext,{images=false}={}){
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
 await sync('configure',{bindings:[{source,channelId:group.id}],images});
 const ingest=(id:string,author:string,text='请总结本群',mentioned=true)=>sync('ingest',{source,arrival:{source,id,author,text,at:1000,mentioned}});
 const call=(n:number,op:string,p:any={})=>service.communicate(bots[n]!.context,'join/wecom-assistant/'+op,p);
 t.after(async()=>{for(const close of beforeClose)await close();await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});for(const [key,value]of [['OPENCRAFT_DATA_DIR',priorEnv.data],['OPENCRAFT_WORKSPACE_DIR',priorEnv.workspace]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 return {beforeClose,directory:dir,service,storage,actors,alice,bob,unlinked,bots,group,source,channels,sync,ingest,call};
}
async function cliFixture(t:any){const f=await fixture(t);await f.ingest('cli-a','WA');await f.ingest('cli-b','WB');const [a]=await f.call(0,'scopes'),[b]=await f.call(1,'scopes');return {...f,scope:a.scope,otherScope:b.scope,cli:(argv:string[],n=0,scope=n===0?a.scope:b.scope)=>f.call(n,'cli',{scope,argv})};}
test('scoped CLI uses own Bot membership, idempotency and revocation; cannot select another owner or scope',async t=>{
 const f=await cliFixture(t),g=f.group.id,argv=['send','md','CLI reply','--group',g,'--idempotency-key','reply'];
 assert.equal((await f.cli(['groups'])).groups[0].id,g);assert.ok((await f.cli(['capabilities'])).commands.includes('chat create'));
 const a=await f.cli(argv),b=await f.cli(argv);assert.equal(a.messageId,b.messageId);
 await assert.rejects(f.cli(['send','md','changed','--group',g,'--idempotency-key','reply']),/idempotency_conflict/);
 await assert.rejects(f.cli(argv,0,f.otherScope),/denied/);await assert.rejects(f.service.communicate(f.alice,'join/wecom-cli/command',{argv}));
 assert.equal((await f.cli(['status',a.messageId,'--group',g])).deliveries[0].state,'queued');
 await f.cli(['send','md','bob','--group',g,'--idempotency-key','bob'],1);
 await f.channels(f.alice,'group/member/set',{channelId:g,actorId:f.bob.actorId,present:false,clientRequestId:'remove-cli'});
 await assert.rejects(f.cli(['history','--group',g],1),/denied/);
});
test('CLI actions retain requester provider identity, managed callbacks, source-isolated originals and immutable operation keys',async t=>{
 const {stagedGroupAction}=await import('../../plugins/wecom/outbound-files.mjs'),{storeInboundFile,inboundFileId}=await import('../../plugins/wecom/inbound-files.mjs');
 const f=await cliFixture(t),run=(a:string[],key:string)=>f.cli([...a,'--group',f.group.id,'--idempotency-key',key]);
 const created=await run(['chat','create','事故讨论','bob'],'create');assert.equal(stagedGroupAction(created.messageId).owner,'WA');assert.equal(stagedGroupAction(created.messageId).kind,'create-chat');
 await assert.rejects(run(['chat','create','事故讨论','alice'],'create'),/idempotency_conflict/);
 for(const [sub,body]of [['vote',{title:'午饭',options:['面','饭']}],['buttons',{buttons:[{title:'检查',prompt:'检查当前状态'}]}],['notice',{title:'日报',summary:'完成',url:'https://example.com/report'}]] as const){const r=await run(['card',sub,JSON.stringify(body)],sub);assert.ok(stagedGroupAction(r.messageId));}
 await assert.rejects(run(['card','update','provider-response-code'],'raw'));
 const id=inboundFileId('secret',f.source,'file');await storeInboundFile(id,'原件.xlsx',async()=>Buffer.from('opaque'),{source:f.source});const meta=await run(['file','info',id],'read');assert.equal(meta.parts,0);assert.equal(meta.status,'original_only');
 const foreign=inboundFileId('secret','foreign','file');await storeInboundFile(foreign,'secret.pdf',async()=>Buffer.from('secret'),{source:'foreign'});await assert.rejects(run(['file','info',foreign],'foreign'),/denied/);
});
test('real private CLI reads JSON client-side, rejects wrong bearer, chunks files and retains exact replay without provider credentials',async t=>{
 const {writeFile,readFile}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{createConnection}=await import('node:net');
 const {openScopedWecomCli}=await import('../../plugins/wecom/scoped-cli-server.mjs');const f=await cliFixture(t),exec=promisify(execFile);
 const server=await openScopedWecomCli({directory:join(f.directory,'cli'),socketDirectory:join(f.directory,'run'),scope:f.scope,request:async argv=>{assert.ok(Buffer.byteLength(JSON.stringify(argv))<64000);return f.cli([...argv,'--group',f.group.id]);}});t.after(()=>server.close());
 const binding=JSON.parse(await readFile(join(f.directory,'cli','binding.json'),'utf8'));
 for(const invalidToken of ['x'.repeat(43),'中'.repeat(43)]){const refused=await new Promise<string>((resolve,reject)=>{const s=createConnection(binding.socket);let body='';s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify({token:invalidToken,argv:['groups']})+'\n'));s.on('data',c=>body+=c);s.on('end',()=>resolve(body));});assert.match(refused,/wecom_cli_denied/);}
 const run=async(...args:string[])=>JSON.parse((await exec(process.execPath,[server.launcher,...args],{env:{...process.env,WECOM_CONFIG:'/missing-provider-credentials'}})).stdout);
 assert.equal((await run('groups')).groups[0].id,f.group.id);
 await f.cli(['sync','configure','{"name":"both"}','--group',f.group.id,'--idempotency-key','connect']);
 const changed=await run('chat','rename','From private CLI','--idempotency-key','wire-rename');
 assert.equal(changed.local.state,'applied');assert.equal(changed.wecom.state,'pending');
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'From private CLI');
 assert.deepEqual(await run('status',changed.receiptId),changed);
 assert.equal((await run('chat','rename','From private CLI','--idempotency-key','wire-rename')).receiptId,changed.receiptId);
 const help=(await exec(process.execPath,[server.launcher,'--help'])).stdout;assert.doesNotMatch(help,/sync request|sync status/);
 const json=join(f.directory,'card.json');await writeFile(json,JSON.stringify({title:'投票',options:['A','B']}));assert.ok((await run('card','vote',json,'--idempotency-key','wire-card')).messageId);
 const file=join(f.directory,'report.pdf');await writeFile(file,Buffer.alloc(90000,97));const sent=await run('send','file',file,'--idempotency-key','wire-file');assert.ok(sent.messageId);
 const {stagedGroupFile}=await import('../../plugins/wecom/outbound-files.mjs');assert.deepEqual(stagedGroupFile(sent.messageId).bytes,await readFile(file));assert.equal(stagedGroupFile(sent.messageId).mode,'file');await assert.rejects(run('send','image',file,'--idempotency-key','wire-file'));assert.equal((await run('send','file',file,'--idempotency-key','wire-file')).messageId,sent.messageId);
 await server.close();await assert.rejects(run('groups'));
});
test('operator raw card JSON files are read rather than parsed as path strings',async t=>{
 const {writeFile}=await import('node:fs/promises'),{main}=await import('../../tools/wecom-cli/wecom.mjs');const f=await fixture(t),file=join(f.directory,'raw-card.json');await writeFile(file,JSON.stringify({card_type:'text_notice'}));let output='';
 assert.equal(await main(['send','card','g:fixture',file,'--dry-run'],{stdout:{write:(s:string)=>{output+=s;}}}),0);assert.equal(JSON.parse(output).body.template_card.card_type,'text_notice');
 output='';assert.equal(await main(['card','update','fixture-response-code',file,'--dry-run'],{stdout:{write:(s:string)=>{output+=s;}}}),0);assert.equal(JSON.parse(output).body.template_card.card_type,'text_notice');
});

test('native image chunks are current-scope reads, bounded for Host IPC and fenced on revoke',async t=>{
 const f=await fixture(t,{images:true});const bytes=Buffer.alloc(140000);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
 const image=await f.sync('ingest',{source:f.source,arrival:{source:f.source,id:'original-image',author:'WA',text:'',mediaId:'fixture-image',at:1000,mentioned:false}});
 await f.sync('imageReady',{source:f.source,messageId:image.messageId,bytes});await f.ingest('vision-alice','WA');await f.ingest('vision-bob','WB');
 const[a]=await f.call(0,'scopes'),[b]=await f.call(1,'scopes');const read=(offset:number,n=0,scope=n?b.scope:a.scope,messageId=image.messageId)=>f.call(n,'image',{scope,messageId,offset});
 const p=await read(0);assert.equal(Buffer.from(p.base64,'base64').length,65536);assert.equal(p.nextOffset,65536);assert.equal(p.size,bytes.length);assert.ok(Buffer.byteLength(JSON.stringify(p))<100000);
 const q=await read(p.nextOffset);assert.equal(q.sha256,p.sha256);assert.equal(q.nextOffset,131072);assert.equal((await read(q.nextOffset)).nextOffset,bytes.length);
 await assert.rejects(read(-1));await assert.rejects(read(bytes.length));await assert.rejects(read(0,0,b.scope));await assert.rejects(f.service.communicate(f.alice,'join/wecom-assistant/image',{scope:a.scope,messageId:image.messageId,offset:0}));
 const other=await f.channels(f.alice,'group/create',{title:'other',memberActorIds:[],clientRequestId:'other-images'}),source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','other']);await f.sync('addSource',{binding:{source,channelId:other.id},images:true});const foreign=await f.sync('ingest',{source,arrival:{source,id:'foreign',author:'WA',text:'',mediaId:'foreign-image',at:1000}});await f.sync('imageReady',{source,messageId:foreign.messageId,bytes});await assert.rejects(read(0,0,a.scope,foreign.messageId));
 await read(0,1);await f.channels(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove-image-reader'});await assert.rejects(read(0,1));
});

test('provider reads and native activity keep actual Worker scope and recheck membership after I/O',async t=>{
 const {scopedProviderQuery}=await import('../../plugins/wecom/provider-query.mjs');const f=await cliFixture(t);
 const descriptor=await f.cli(['chat','live','--group',f.group.id]);assert.deepEqual(descriptor,{providerQuery:{scope:f.scope,query:{kind:'chat'}}});
 const grant=await f.call(0,'provider-grant',{scope:f.scope});assert.equal(grant.owner,'WA');assert.equal(grant.source,f.source);
 const live=await scopedProviderQuery(f.service,f.bots[0]!.context,f.scope,{kind:'chat'},async p=>{assert.equal(p.owner,'WA');return{membershipSource:'provider',members:[{id:'WA',kind:'human'}]};});assert.equal(live.membershipSource,'provider');
 const activity=await f.call(0,'activity',{scope:f.scope,after:0});assert.ok(activity.messages.length);assert.ok(activity.latestSequence>=activity.messages.at(-1).seq);assert.deepEqual((await f.call(0,'activity',{scope:f.scope,after:0,latest:true})).messages,[]);
 await assert.rejects(f.call(0,'activity',{scope:f.otherScope,after:0}));await assert.rejects(f.call(0,'activity',{scope:f.scope,after:-1}));
 await assert.rejects(scopedProviderQuery(f.service,f.bots[1]!.context,f.otherScope,{kind:'chat'},async()=>{await f.channels(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present:false,clientRequestId:'revoke-provider-read'});return{members:['secret']};}),/denied/);
});

test('activity pagination is byte-bounded before private IPC and never advances past returned messages',async t=>{const f=await cliFixture(t);for(let i=0;i<8;i++)await f.ingest('large-'+i,'WA','\u0001'.repeat(15000),false);const a=await f.call(0,'activity',{scope:f.scope,after:0});assert.ok(Buffer.byteLength(JSON.stringify(a))<400000);assert.ok(a.messages.at(-1).seq<a.latestSequence);const b=await f.call(0,'activity',{scope:f.scope,after:a.messages.at(-1).seq});assert.ok(b.messages[0].seq>a.messages.at(-1).seq);});

test('new native replies are byte-framed, originals retain explicit file intent, and collection controls are scoped/idempotent',async t=>{
 const {stagedGroupAction,stagedGroupFile}=await import('../../plugins/wecom/outbound-files.mjs');const f=await cliFixture(t),g=f.group.id;
 const body='中文🧪'.repeat(1800),reply=await f.call(0,'reply',{scope:f.scope,id:'byte-framing',text:body});
 const pieces=f.storage.database.prepare('SELECT m.content FROM actor_messages m JOIN join_wecom_assistant_replies r ON r.message_id=m.id WHERE r.payload_hash=(SELECT payload_hash FROM join_wecom_assistant_replies WHERE message_id=?) ORDER BY m.seq').all(reply.messageId) as any[];
 assert.equal(pieces.map(p=>p.content).join(''),body);assert.ok(pieces.every(p=>Buffer.byteLength(p.content)<=3000));assert.equal((await f.call(0,'reply',{scope:f.scope,id:'byte-framing',text:body})).messageId,reply.messageId);
 const taskId='oc-m-'+'a'.repeat(40),args=['collection','close',taskId,'--group',g,'--idempotency-key','close'];const close=await f.cli(args);assert.equal(stagedGroupAction(close.messageId).owner,'WA');assert.equal(stagedGroupAction(close.messageId).taskId,taskId);assert.equal((await f.cli(args)).messageId,close.messageId);
 await assert.rejects(f.cli(['collection','export',taskId,'--group',g,'--idempotency-key','close']),/conflict/);
 const bytes=Buffer.from('PNG original'),id='original-file';const sent=await f.call(0,'file',{scope:f.scope,id,name:'picture.png',data:bytes.toString('base64'),offset:0,size:bytes.length,mode:'file'});assert.equal(stagedGroupFile(sent.messageId).mode,'file');assert.deepEqual(stagedGroupFile(sent.messageId).bytes,bytes);
 await assert.rejects(f.call(0,'file',{scope:f.scope,id,name:'picture.png',data:bytes.toString('base64'),offset:0,size:bytes.length,mode:'image'}),/changed|conflict/);
});
