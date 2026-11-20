import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {createPersonalAssistantHost} from '../../apps/personal-assistant/src/runtime/host-supervisor.mjs';
const prefix='opencraft/personal-assistant/';
async function fixture(t:test.TestContext){
 const directory=await mkdtemp(join(tmpdir(),'multi-bot-')),storage=await openServerDatabase(directory),actors=new ActorStore(storage),service=new Collaboration(storage,actors);
 const human=(id:string)=>actors.resolveHuman({provider:'local',subject:id,displayName:id,expiresAt:Date.now()+3600000})!;
 const alice=human('alice'),bob=human('bob');let host:any;
 const call=(method:string,params:Record<string,unknown>={},actor=alice)=>service.personalAssistant(actor,prefix+method,params);
 const create=(name:string,key=name,environment:Record<string,string>={kind:'local'})=>call('bots/create',{name,duties:'Role '+name,environment,clientRequestId:key});
 t.after(async()=>{await host?.close();await service.close();actors.close();await storage.close();await rm(directory,{force:true,recursive:true});});
 return {directory,storage,actors,service,alice,bob,call,create,setHost(h:any){host=h;}};
}
async function until(fn:()=>boolean|Promise<boolean>){for(let i=0;i<400;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('timed out');}
test('one owner creates distinct Bots; old default identity and history survive; creation retry is idempotent',async t=>{
 const f=await fixture(t),original=await f.call('claim');
 const dm=await f.call('open'),before=await f.service.send(f.alice,{targetActorId:original.assistant.actorId,content:'keep original history',idempotencyKey:'original-message'});
 const a=await f.create('Engineer'),b=await f.create('Designer');
 assert.notEqual(a.assistant.actorId,b.assistant.actorId);assert.notEqual(a.assistant.binding.botId,b.assistant.binding.botId);
 assert.equal((await f.create('Engineer')).assistant.binding.botId,a.assistant.binding.botId);
 await assert.rejects(f.create('Changed','Engineer'),/idempotency_key_reused/);
 const current=await f.call('get');assert.equal(current.assistant.binding.botId,original.assistant.binding.botId);assert.equal((await f.call('open')).channel.id,dm.channel.id);
 assert.equal((await f.call('get',{botId:b.assistant.binding.botId})).assistant.name,'Designer');
 const list=await f.call('bots/list');assert.equal(list.bots.length,3);assert.equal(list.bots.filter((b:any)=>b.assistant.isDefault).length,1);
 assert.ok((await f.service.messages(f.alice,original.assistant.actorId,0,50)).some((m:any)=>m.id===before.messageId));
 await assert.rejects(f.call('get',{botId:a.assistant.binding.botId},f.bob),/personal_assistant_denied/);
 assert.deepEqual((await f.call('bots/list',{},f.bob)).bots,[]);
});
test('explicit Bot model and memory selectors do not fall back to the default or another owner',async t=>{
 const f=await fixture(t);await f.call('claim');const a=(await f.create('Engineer')).assistant,b=(await f.create('Designer')).assistant;
 let memoryTarget='';const detach=f.service.attachPersonalAssistantHost({state:()=>({phase:'running'}),wake(){},models:async()=>({models:[],available:true}),validateModel:async()=>{},memory:async(id,_epoch,_request,binding)=>{memoryTarget=id;assert.equal(binding.botId,a.binding.botId);return {action:'status',version:'v',writable:true,total:0};}});t.after(detach);
 await f.call('model/set',{botId:a.binding.botId,model:{providerId:'test',modelId:'modelA'},expectedRevision:0});
 assert.equal((await f.call('get',{botId:a.binding.botId})).assistant.model.modelId,'modelA');assert.equal((await f.call('get',{botId:b.binding.botId})).assistant.model,null);assert.equal((await f.call('get')).assistant.model,null);
 await f.call('memory',{botId:a.binding.botId,assignmentId:a.binding.assignmentId,action:'status'});assert.equal(memoryTarget,a.binding.botId);
 await assert.rejects(f.call('memory',{botId:a.binding.botId,assignmentId:a.binding.assignmentId,action:'status'},f.bob));
});
test('configuration uses CAS, preserves actor identity, and pause fences only the selected Bot',async t=>{
 const f=await fixture(t),a=(await f.create('Engineer')).assistant,b=(await f.create('Designer')).assistant;
 const ca=await f.service.provisionPersonalAssistant(f.alice,a.binding.botId),cb=await f.service.provisionPersonalAssistant(f.alice,b.binding.botId);
 const ac=f.actors.authenticateSession(ca.credential.token)!;
 const update={botId:a.binding.botId,name:'Engineer Two',duties:'Build carefully',environment:{kind:'local'},expectedRevision:0};
 const results=await Promise.allSettled([f.call('bots/update',update),f.call('bots/update',update)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const changed=(await f.call('get',{botId:a.binding.botId})).assistant;assert.equal(changed.actorId,a.actorId);assert.equal(changed.name,'Engineer Two');assert.equal(f.actors.get(a.actorId)!.displayName,'Engineer Two');
 assert.equal(f.actors.authenticateSession(ca.credential.token),null);
 await assert.rejects(f.service.personalAssistant(ac,prefix+'authorize',{}));
 await f.call('bots/pause',{botId:a.binding.botId,paused:true,expectedRevision:1});
 assert.equal((await f.call('get',{botId:a.binding.botId})).runtime.phase,'stopped');
 assert.ok(f.actors.authenticateSession(cb.credential.token));
 await assert.rejects(f.service.provisionPersonalAssistant(f.alice,a.binding.botId));
 const inventory=await f.service.personalAssistantAssignments();assert.ok(inventory.items.some((x:any)=>x.assistant.binding.botId===b.binding.botId));assert.ok(!inventory.items.some((x:any)=>x.assistant.binding.botId===a.binding.botId));
 await f.call('bots/pause',{botId:a.binding.botId,paused:false,expectedRevision:2});assert.equal((await f.call('get',{botId:a.binding.botId})).assistant.actorId,a.actorId);
});
test('unsupported E2B selection cannot be saved or silently execute on local',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.call('environments'),{local:true,templates:[]});
 await assert.rejects(f.create('Remote','remote',{kind:'sandbox',backendId:'e2b',templateId:'template-one'}),/assistant_environment_unavailable/);
 assert.equal((await f.call('bots/list')).bots.length,0);
 const a=(await f.create('Local')).assistant;
 await assert.rejects(f.call('bots/update',{botId:a.binding.botId,name:'Remote',duties:'x',environment:{kind:'sandbox',backendId:'e2b',templateId:'unknown'},expectedRevision:0}),/assistant_environment_unavailable/);
 assert.deepEqual((await f.call('get',{botId:a.binding.botId})).assistant.environment,{kind:'local'});
});
test('Host uses each explicit Bot credential and selects registered environment provider without local fallback',async t=>{
 const f=await fixture(t);let locals=0,remotes=0;const requests:Array<()=>Promise<unknown>>=[];
 const handle=()=>({ready:Promise.resolve(),failed:()=>false,async close(){}});
 const host=await (createPersonalAssistantHost as any)({directory:f.directory,service:f.service,intervalMs:15,codexBinary:process.execPath,
  readConfig:async()=>({maxRuntimes:4,profileOptions:{mode:'fixture'}}),spawn:(o:any)=>{locals++;requests.push(()=>o.request(prefix+'authorize',{}));return handle();},
  environmentProviders:{e2b:{templates:async()=>[{id:'approved',name:'Approved template'}],spawn:async(e:any,o:any)=>{assert.equal(e.templateId,'approved');remotes++;requests.push(()=>o.request(prefix+'authorize',{}));return handle();}}}});f.setHost(host);
 const a=(await f.create('Local')).assistant,b=(await f.create('Remote','remote',{kind:'sandbox',backendId:'e2b',templateId:'approved'})).assistant;
 await until(()=>locals===1&&remotes===1);const authorities=await Promise.all(requests.map(r=>r())) as any[];
 assert.deepEqual(authorities.map(x=>x.binding.botId).sort(),[a.binding.botId,b.binding.botId].sort());
 assert.deepEqual((await f.call('environments')).templates,[{backendId:'e2b',id:'approved',name:'Approved template'}]);
});
test('incremental migration preserves old Bot identity, credential, model and delegated profile',async t=>{
 const {openManagedDatabase}=await import('@opencraft/sqlite-node');
 const {SERVER_MIGRATIONS}=await import('../../packages/storage-node/src/server/migrations.generated');
 const root=await mkdtemp(join(tmpdir(),'multi-bot-migration-')),path=join(root,'server.sqlite');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const old=openManagedDatabase({path,migrations:SERVER_MIGRATIONS.slice(0,-1),legacyPolicy:'reject'});
 old.database.prepare('INSERT INTO actors VALUES(?,?,?,?,?,?,?)').run('human://test/owner','human','Owner',1,1,1,null);
 old.database.prepare('INSERT INTO actors VALUES(?,?,?,?,?,?,?)').run('session://test/bot','session','Existing',1,1,1,'human://test/owner');
 old.database.prepare("INSERT INTO personal_assistants(bot_id,actor_id,owner_human_id,owner_generation,assignment_id,epoch,state,created_at,credential_id,model_selection,model_revision) VALUES(?,?,?,?,?,?,'claimed',?,?,?,?)").run('existing-bot','session://test/bot','human://test/owner',1,'existing-assignment','existing-epoch',1,'existing-credential','{"providerId":"p","modelId":"m"}',5);
 old.database.prepare('INSERT INTO assistant_thread_profiles VALUES(?,?,?,?,?,?,?)').run('existing-bot','default','existing-epoch',4,'source','{}',1);
 old.database.close();
 const current=openManagedDatabase({path,migrations:SERVER_MIGRATIONS,legacyPolicy:'reject'});
 const r=current.database.prepare('SELECT * FROM personal_assistants').get()!;
 assert.equal(r.bot_id,'existing-bot');assert.equal(r.actor_id,'session://test/bot');assert.equal(r.assignment_id,'existing-assignment');assert.equal(r.epoch,'existing-epoch');assert.equal(r.credential_id,'existing-credential');assert.equal(r.model_revision,5);assert.equal(r.is_default,1);assert.equal(r.paused,0);assert.equal(r.environment_json,'{"kind":"local"}');assert.equal(current.database.prepare('SELECT revision FROM assistant_thread_profiles').get()!.revision,4);assert.deepEqual(current.database.prepare('PRAGMA foreign_key_check').all(),[]);
 current.database.close();
 const again=openManagedDatabase({path,migrations:SERVER_MIGRATIONS,legacyPolicy:'reject'});assert.equal(again.database.prepare('SELECT count(*) AS n FROM personal_assistants').get()!.n,1);again.database.close();
});
test('two Bots of one Human use real isolated Codex processes, independent models and native DM timelines',{timeout:45000},async t=>{
 const {existsSync}=await import('node:fs'),{readFile}=await import('node:fs/promises'),{createServer}=await import('node:http');
 const binary='/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
 if(!existsSync(binary)){t.skip('Pinned native Codex binary unavailable');return;}
 const f=await fixture(t),seen:string[]=[],errors:unknown[]=[];
 const server=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const b=JSON.parse(Buffer.concat(chunks).toString());seen.push(b.model);const answer=JSON.stringify(b.text?.format?.schema?.properties?.operations?{operations:['reply']}:{proposal:{kind:'reply',text:'Reply from '+b.model}});res.writeHead(200,{'content-type':'text/event-stream'});res.end([{type:'response.created',response:{id:'r'+seen.length}},{type:'response.output_item.done',item:{id:'m'+seen.length,type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:answer}]}},{type:'response.completed',response:{id:'r'+seen.length,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));}catch(e){errors.push(e);res.writeHead(500).end();}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const modelSource={catalog:async()=>({available:true,models:[]}),resolve:async()=>({baseUrl:'http://127.0.0.1:'+(server.address() as any).port+'/v1',apiKey:'synthetic-only-key'}),close:async()=>{}};
 const host=await (createPersonalAssistantHost as any)({directory:f.directory,service:f.service,codexBinary:binary,modelSource,readConfig:async()=>null,intervalMs:25});f.setHost(host);
 const a=(await f.create('Engineer')).assistant,b=(await f.create('Designer')).assistant;
 await f.call('model/set',{botId:a.binding.botId,model:{providerId:'fixture',modelId:'alpha'},expectedRevision:0});await f.call('model/set',{botId:b.binding.botId,model:{providerId:'fixture',modelId:'beta'},expectedRevision:0});
 await until(()=>host.state(a.binding.botId).phase==='running'&&host.state(b.binding.botId).phase==='running');
 const ca=(await f.call('open',{botId:a.binding.botId})).channel.id,cb=(await f.call('open',{botId:b.binding.botId})).channel.id;assert.notEqual(ca,cb);
 for(const id of [ca,cb])await f.service.communicate(f.alice,'opencraft/channels/messages/send',{channelId:id,clientMessageId:'hello-'+id,parts:[{type:'text',text:'hello'}]});
 const history=(id:string)=>f.service.communicate(f.alice,'opencraft/channels/messages/list',{channelId:id});
 await until(async()=>JSON.stringify(await history(ca)).includes('Reply from alpha')&&JSON.stringify(await history(cb)).includes('Reply from beta'));
 assert.ok(!JSON.stringify(await history(ca)).includes('Reply from beta'));assert.ok(!JSON.stringify(await history(cb)).includes('Reply from alpha'));
 for(const bot of [a,b])assert.ok(!(await readFile(join(f.directory,'bots',bot.binding.botId,'profile.json'),'utf8')).includes('synthetic-only-key'));
 assert.ok(seen.includes('alpha')&&seen.includes('beta'));assert.deepEqual(errors,[]);
});
test('owned Bots remain listed after authority generation changes and require an explicit current-owner resume',async t=>{
 const f=await fixture(t),a=(await f.create('Engineer')).assistant;
 f.actors.setEnabled(f.alice.actorId,false,'operator');f.actors.setEnabled(f.alice.actorId,true,'operator');
 const current=f.actors.resolveHuman({provider:'local',subject:'alice',displayName:'alice',expiresAt:Date.now()+60000})!;
 const listed=(await f.call('bots/list',{},current)).bots;assert.equal(listed.length,1);assert.equal(listed[0].assistant.paused,true);assert.equal(listed[0].runtime.phase,'stopped');
 await assert.rejects(f.service.provisionPersonalAssistant(current,a.binding.botId));
 const resumed=await f.call('bots/pause',{botId:a.binding.botId,paused:false,expectedRevision:0},current);assert.equal(resumed.assistant.binding.botId,a.binding.botId);assert.equal(resumed.assistant.paused,false);
 const credential=await f.service.provisionPersonalAssistant(current,a.binding.botId);assert.ok(f.actors.authenticateSession(credential.credential.token));
});
