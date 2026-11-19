import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createWecomAssistantRuntime} from '../../plugins/wecom/assistant-runtime.mjs';
import {storeInboundFile,reserveInboundFileSource,inboundFileId,GROUP_FILE_READ} from '../../plugins/wecom/inbound-files.mjs';
import {LocalAttachmentStore} from '../../../../apps/personal-assistant/src/adapters/filesystem/attachment-store.mjs';
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']),scope='a'.repeat(64),scope2='b'.repeat(64);
async function until(predicate){for(let i=0;i<400;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition not reached');}
async function fixture(t,{scopes=()=>[{scope,channelId:'ch1'}],messages=()=>[],search=()=>({messages:[]}),history=()=>({messages:[]}),image=()=>null,providerQuery=()=>({}),activity=()=>({latestSequence:0,messages:[]}),dispatch=async()=>({}),edit,outcomes=()=>[],outcomeAck=()=>({acknowledged:true})}={}){
 const directory=fs.mkdtempSync(join(os.tmpdir(),'wecom-wire-'));const oldData=process.env.OPENCRAFT_DATA_DIR,oldWs=process.env.OPENCRAFT_WORKSPACE_DIR;
 process.env.OPENCRAFT_DATA_DIR=join(directory,'data');process.env.OPENCRAFT_WORKSPACE_DIR=join(directory,'ws');
 const ports=new Map(),transports=new Map(),profiles=new Map(),runners=new Map(),calls=[],errors=[],databases=[];
 const runtime=createWecomAssistantRuntime({directory,profileOptions:{},taskExportRoot:join(directory,'exports'),onError:e=>errors.push(e),
 request:async(method,p)=>{calls.push([method,p]);if(method.endsWith('/edit')&&edit)return edit(p);switch(method.split('/').at(-1)){case'edit-results':return outcomes();case'edit-result-ack':return outcomeAck(p);case'scopes':return scopes();case'messages':return messages(p);case'authorize':return{source};case'history':return history(p);case'image':return image(p);case'provider-query':return providerQuery(p);case'activity':return activity(p);case'search':return search(p);default:return{messageId:'sent:'+createHash('sha256').update(JSON.stringify([method,p])).digest('hex')};}},
 start:async options=>{const s=options.serverDirectory.split('/').at(-1),path=join(options.serverDirectory,'profile');fs.mkdirSync(path,{recursive:true});ports.set(s,options.port);transports.set(s,options.overrides.messageTransport);profiles.set(s,path);const db=new DatabaseSync(':memory:');databases.push(db);db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');const runner={profile:{path},uow:{db,transaction:f=>f()},dispatch:p=>dispatch(p,s),close:async()=>{}};runners.set(s,runner);return runner;}});
 t.after(async()=>{await runtime.close();for(const db of databases)db.close();fs.rmSync(directory,{recursive:true,force:true});if(oldData===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=oldData;if(oldWs===undefined)delete process.env.OPENCRAFT_WORKSPACE_DIR;else process.env.OPENCRAFT_WORKSPACE_DIR=oldWs;});
 return{directory,runtime,ports,transports,profiles,runners,calls,errors};
}
test('search-to-file read materializes authorized old originals, refreshes pending metadata, and rejects foreign sources',async t=>{
 const id=inboundFileId('fixture',source,'old-file'),f=await fixture(t,{search:()=>({messages:[{content:'[文件] old.pdf（资料编号 '+id+'）'}]})});
 await storeInboundFile(id,'old.pdf',async()=>Buffer.from('original'),{source});await f.runtime.poll();await f.runtime.settle();const port=f.ports.get(scope);
 assert.match(JSON.stringify(await port.request(null,'opencraft/personal-assistant/groups/search',{channelId:'ch1',query:'old.pdf'})),new RegExp(id));
 const read=await port.request(null,GROUP_FILE_READ,{channelId:'ch1',reference:id});assert.equal(fs.readFileSync(read.original,'utf8'),'original');
 const foreign=inboundFileId('fixture','foreign','file');await storeInboundFile(foreign,'secret.txt',async()=>Buffer.from('private'),{source:'foreign'});
 await assert.rejects(port.request(null,GROUP_FILE_READ,{channelId:'ch1',reference:foreign}),/不属于本群/u);
 const pending=inboundFileId('fixture',source,'pending');reserveInboundFileSource(pending,source);
 const waiting=port.request(null,GROUP_FILE_READ,{channelId:'ch1',reference:pending});await storeInboundFile(pending,'later.csv',async()=>Buffer.from('bytes'),{source});
 assert.equal((await waiting).status,'original_only');assert.deepEqual(f.errors,[]);
});
test('slow scope does not delay other intake, later ticks, or its own task-return poll; shutdown cancels admission',async t=>{
 const id=inboundFileId('fixture',source,'slow'),dispatched=[];let bSeq=1;
 const f=await fixture(t,{scopes:()=>[{scope,channelId:'ch1'},{scope:scope2,channelId:'ch2'}],messages:p=>p.scope===scope?[{id:'slow',seq:1,content:'资料编号 '+id}]:p.after<bSeq?[{id:'fast-'+bSeq,seq:bSeq,content:'hello'}]:[],dispatch:async(p,s)=>{if(p.op==='say')dispatched.push([s,p.id]);return{};}});
 reserveInboundFileSource(id,source);await f.runtime.poll();await until(()=>dispatched.some(([s])=>s===scope2)||f.errors.length);assert.deepEqual(f.errors,[]);assert.equal(dispatched.some(([s])=>s===scope),false);
 let returns=0;f.runners.get(scope).taskReturns.poll=async()=>{returns++;};bSeq=2;await f.runtime.poll();await until(()=>dispatched.some(([,id])=>id==='wecom:fast-2'));await until(()=>returns>0);
 await f.runtime.close();assert.equal(dispatched.some(([s])=>s===scope),false);assert.deepEqual(f.errors,[]);
});
test('empty attachment has explicit receipt while other attachments and text are preserved',async t=>{
 const f=await fixture(t);await f.runtime.poll();await f.runtime.settle();const store=new LocalAttachmentStore(join(f.profiles.get(scope),'attachments'));
 const empty=store.importBytes('empty.txt',Buffer.alloc(0)),valid=store.importBytes('valid.txt',Buffer.from('data')),transport=f.transports.get(scope);
 const receipt=await transport.deliver({id:'mixed',body:{type:'message',channel:'group',content:'正文',files:[empty,valid]}});
 assert.equal(receipt.level,'accepted');assert.equal(f.calls.filter(([m])=>m.endsWith('/file')).length,1);
 const text=f.calls.find(([m])=>m.endsWith('/reply'))[1].text;assert.match(text,/正文/u);assert.match(text,/0 字节/u);
 assert.equal((await transport.deliver({id:'empty',body:{type:'message',channel:'group',files:[empty]}})).level,'accepted');
});

test('group tool argv routes to the same scoped CLI owner and rejects another group before forwarding',async t=>{
 const f=await fixture(t);await f.runtime.poll();await f.runtime.settle();const port=f.ports.get(scope);
 await port.request(null,'opencraft/personal-assistant/threads/command',{argv:['wecom','capabilities']});
 const call=f.calls.find(([m])=>m.endsWith('/cli'));assert.equal(call[1].scope,scope);assert.ok(call[1].argv.includes('ch1'));assert.ok(!JSON.stringify(call[1]).includes('token'));
 await assert.rejects(port.request(null,'opencraft/personal-assistant/threads/command',{argv:['wecom','history','--group','foreign']}),/denied/);
});

test('daily pause freezes its target set before mutation, so uncertain retries cannot pause newly created routines',async t=>{
 let targets=[{id:'original',revision:1,status:'active',text:'群日报'}];const calls=[];
 const f=await fixture(t,{dispatch:async p=>{if(p.op==='status')return {routines:targets};if(p.op==='routine.pause')calls.push(p);return{};}});
 await f.runtime.poll();await f.runtime.settle();const port=f.ports.get(scope),params={argv:['wecom','daily','pause','--idempotency-key','one-event']};
 assert.equal((await port.request(null,'opencraft/personal-assistant/threads/command',params)).paused,1);
 targets=[{id:'new-routine',revision:1,status:'active',text:'新建群日报'}];
 assert.equal((await port.request(null,'opencraft/personal-assistant/threads/command',params)).paused,1);
 assert.deepEqual(calls.map(c=>c.params.routineId),['original','original']);assert.equal(calls[0].id,calls[1].id);assert.equal(calls[0].params.expectedRevision,calls[1].params.expectedRevision);
});

test('actual group intake attaches a preceding native screenshot when the owner sends a bare mention',async t=>{
 const {createHash}=await import('node:crypto'),bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),say=[];
 const f=await fixture(t,{messages:p=>p.after<2?[{id:'mention',seq:2,content:'@助理'}]:[],history:()=>({messages:[{messageId:'screenshot',sequence:1,image:{state:'ready'},text:''}]}),image:p=>({type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64'),nextOffset:bytes.length}),dispatch:async p=>{if(p.op==='say')say.push(p);return{};}});
 await f.runtime.poll();await f.runtime.settle();assert.deepEqual(f.errors,[]);assert.equal(say.length,1);assert.equal(say[0].params.attachments.length,1);assert.match(say[0].params.text,/真正的图片附件/u);const id=say[0].params.attachments[0];assert.deepEqual(fs.readFileSync(join(f.profiles.get(scope),'attachments',id+'.blob')),bytes);assert.ok(f.calls.some(([op,p])=>op.endsWith('/image')&&p.scope===scope&&p.messageId==='screenshot'));
});

test('real group CLI persists subscriptions and reply/CLI collections in the same owner profile',async t=>{
 const f=await fixture(t,{providerQuery:()=>({memberIds:['wbci']}),activity:()=>({latestSequence:42,messages:[]})});
 await f.runtime.poll();await f.runtime.settle();const port=f.ports.get(scope),command=argv=>port.request(null,'opencraft/personal-assistant/threads/command',{argv:['wecom',...argv]});
 await command(['watch','add','ci',JSON.stringify({sender:'wbci',instruction:'只分析'}),'--idempotency-key','watch']);
 assert.equal((await command(['watch','list'])).subscriptions[0].sender,'wbci');
 await f.transports.get(scope).deliver({id:'form-reply',body:{type:'message',channel:'group',content:'/投票 '+JSON.stringify({title:'时间',options:['一','二'],onClose:'安排时间'})}});
 const db=f.runners.get(scope).uow.db;assert.ok(db.prepare('SELECT value FROM meta WHERE value LIKE ?').all('%安排时间%').length);
 const q=f.calls.find(([m])=>m.endsWith('/provider-query'));assert.equal(q[1].scope,scope);assert.ok(!JSON.stringify(q[1]).includes('owner'));
 await assert.rejects(command(['watch','list','--group','foreign']),/denied/);
});

test('collection slots are checked before either native reply or CLI admission, and host presentation does not eat agent replies',async t=>{
 const f=await fixture(t);await f.runtime.poll();await f.runtime.settle();const transport=f.transports.get(scope),port=f.ports.get(scope),command=argv=>port.request(null,'opencraft/personal-assistant/threads/command',{argv:['wecom',...argv]});
 await assert.rejects(command(['card','vote',JSON.stringify({title:'缺少键',options:['一','二'],onClose:'汇总'})]),/idempotency/);
 assert.equal((await command(['collection','list'])).collections.length,0);
 for(let i=0;i<16;i++)await transport.deliver({id:'collection-'+i,body:{type:'message',channel:'group',content:'/投票 '+JSON.stringify({title:'投票'+i,options:['一','二'],onClose:'汇总'})}});
 const before=f.calls.length;
 await assert.rejects(transport.deliver({id:'over',body:{type:'message',channel:'group',content:'/投票 '+JSON.stringify({title:'超额',options:['一','二'],onClose:'汇总'})}}),/too_many/);
 assert.equal(f.calls.length,before,'Capacity failure must precede native admission');
 const beforeCli=f.calls.filter(([op])=>op.endsWith('/cli')).length;
 await assert.rejects(command(['card','vote',JSON.stringify({title:'超额',options:['一','二'],onClose:'汇总'}),'--idempotency-key','over-cli']),/too_many/);
 assert.equal(f.calls.filter(([op])=>op.endsWith('/cli')).length,beforeCli);
 const list=await command(['collection','list']);assert.equal(list.collections.length,16);const id=list.collections[0].taskId;
 await command(['collection','cancel',id,'--idempotency-key','cancel']);
 await transport.deliver({id:'after-cancel',body:{type:'message',channel:'group',content:'/投票 '+JSON.stringify({title:'新投票',options:['一','二'],onClose:'汇总'})}});
 await transport.deliver({id:'agent-normal',body:{type:'message',channel:'group',content:'收到，继续。'}});assert.ok(f.calls.some(([op,p])=>op.endsWith('/reply')&&p.id==='agent-normal'&&p.text==='收到，继续。'));
 const count=f.calls.length;await transport.deliver({id:'host-progress',body:{type:'message',channel:'group',content:'收到，继续。'},presentation:{origin:'reception',text:''}});assert.equal(f.calls.length,count);
 await assert.rejects(command(['collection','list','--group','foreign']),/denied/);
});

test('old image get bypasses initial history but not group authority; task list/get use the local task tracker',async t=>{
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
 const f=await fixture(t,{image:p=>{if(p.messageId!=='old')throw Error('image not in scope');return {type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64'),nextOffset:bytes.length};}});
 await f.runtime.poll();await f.runtime.settle();const port=f.ports.get(scope),command=argv=>port.request(null,'opencraft/personal-assistant/threads/command',{argv:['wecom',...argv]});
 const image=await command(['image','get','old']);assert.deepEqual(fs.readFileSync(image.original),bytes);assert.ok(f.calls.some(([m,p])=>m.endsWith('/image')&&p.scope===scope&&p.messageId==='old'));
 const before=f.calls.filter(([m])=>m.endsWith('/image')).length;await assert.rejects(command(['image','get','old','--group','foreign']),/denied/u);assert.equal(f.calls.filter(([m])=>m.endsWith('/image')).length,before);
 await assert.rejects(command(['image','get','private']),/not in scope/u);await assert.rejects(command(['image','get','old','extra']),/image/u);
 assert.deepEqual(await command(['task','list']),{tasks:[],nextOffset:null});await assert.rejects(command(['task','get','foreign']),/does not belong/u);assert.deepEqual(f.errors,[]);
});

test('legacy edit text accepts a native business receipt without emitting another acknowledgement',async t=>{
 const receiptId='group-edit:'+'c'.repeat(64),f=await fixture(t,{edit:()=>({receiptId,local:{state:'applied'},wecom:{state:'pending'}})});
 await f.runtime.poll();await f.runtime.settle();const result=await f.transports.get(scope).deliver({id:'legacy-edit',body:{type:'message',channel:'group',content:'/改群名 新群名'}});
 assert.equal(result.remoteId,receiptId);assert.equal(result.level,'accepted');assert.equal(f.calls.filter(([m])=>m.endsWith('/edit')).length,1);assert.equal(f.calls.filter(([m])=>m.endsWith('/reply')).length,0);
});

test('actual assistant context directs normal group tools and distinguishes local success from provider confirmation',async()=>{
 const {groupMentionInput}=await import('../../plugins/wecom/assistant-context.mjs');const input=groupMentionInput('room',{content:'改名',author_id:'alice'},{messages:[]});
 assert.match(input,/"wecom","chat","rename"/);assert.match(input,/wecom.confirmed/);assert.match(input,/不要在最终回复里写操作指令/);assert.doesNotMatch(input,/sync request/);
});

test('terminal group outcomes reach the agent with stable IDs; failed acknowledgment retries without canned group replies',async t=>{
 let acknowledged=false,acks=0;const dispatched=[],outcome={receiptId:'group-edit:'+'c'.repeat(64),revision:'d'.repeat(64),local:{state:'applied'},wecom:{state:'needs_attention'},changes:[]};
 const f=await fixture(t,{outcomes:()=>acknowledged?[]:[outcome],outcomeAck:()=>{if(++acks===1)throw Error('lost acknowledgment');acknowledged=true;return{acknowledged:true};},dispatch:async p=>{if(p.op==='say')dispatched.push(p);return{ok:true};}});
 await f.runtime.poll();await f.runtime.settle();assert.equal(dispatched.length,1);assert.equal(acknowledged,false);
 // The normal runtime backoff must elapse before the failed scope restarts.
 await new Promise(r=>setTimeout(r,2100));await f.runtime.poll();await f.runtime.settle();
 assert.ok(dispatched.length>=2);assert.equal(dispatched[0].id,dispatched[1].id);assert.match(dispatched[0].params.text,/不要重新执行/);assert.equal(acknowledged,true);assert.equal(f.calls.filter(([m])=>m.endsWith('/reply')).length,0);
});
