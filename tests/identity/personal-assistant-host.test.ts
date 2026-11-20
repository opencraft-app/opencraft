import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
// Test-only explicit fixture injection; production entry never chooses this configuration.
const {createPersonalAssistantHost}=await import(process.env.OPENCRAFT_ASSISTANT_HOST_MODULE??'../../apps/personal-assistant/src/runtime/host-supervisor.mjs');

async function waitFor(predicate:()=>Promise<boolean>|boolean,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,30));}throw Error('Expected state not reached');}
async function fixture(t:test.TestContext){
 const directory=await mkdtemp(join(tmpdir(),'personal-host-')),storage=await openServerDatabase(directory),actors=new ActorStore(storage),service=new Collaboration(storage,actors);
 const human=(name:string)=>actors.resolveHuman({provider:'local',subject:name,displayName:name,expiresAt:Date.now()+60000})!;
 const alice=human('Alice'),bob=human('Bob');let host:any;
 t.after(async()=>{await host?.close();await service.close();actors.close();await storage.close();await rm(directory,{recursive:true,force:true});});
 return {directory,storage,actors,service,alice,bob,async start(options={}){return host=await (createPersonalAssistantHost as any)({directory,service,intervalMs:30,...options});}};
}
test('Host never claims on startup; missing model is truthful; own DM authority revokes immediately',async t=>{
 const f=await fixture(t);await f.start();
 assert.equal((await f.service.personalAssistantAssignments()).items.length,0);
 const {assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 await waitFor(async()=>(await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/get')).runtime.phase==='config_required');
 const {channel}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/open');assert.equal(channel.canSend,true);
 assert.equal((await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/get')).channelId,channel.id);
 assert.equal((await f.service.personalAssistant(f.bob,'opencraft/personal-assistant/get')).channelId,null);
 const provision=await f.service.provisionPersonalAssistant(f.alice),bot=f.actors.authenticateSession(provision.credential.token)!;
 await f.service.communicate(bot,'personal-assistant/reply',{id:'hello',text:'Hello Alice'});
 await assert.rejects(f.service.communicate(bot,'send',{targetActorId:f.bob.actorId,idempotencyKey:'bad',content:'no'}),/denied/);
 await assert.rejects(f.service.communicate(f.bob,'opencraft/channels/direct/open',{actorId:assistant.actorId}),/denied/);
 const changes:any[]=[];const unwatch=f.service.channels.onChange(change=>changes.push(change));
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/revoke');
 assert.ok(changes.some(change=>change.channelId===channel.id&&change.directory));
 await assert.rejects(f.service.communicate(bot,'personal-assistant/reply',{id:'late',text:'no'}),/denied/);
 assert.equal((await f.service.communicate(f.alice,'opencraft/channels/list')).groups[0].canSend,false);
 changes.length=0;await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 assert.ok(changes.some(change=>change.channelId===channel.id&&change.directory));
 assert.equal((await f.service.communicate(f.alice,'opencraft/channels/list')).groups[0].canSend,true);unwatch();
 await assert.rejects(f.service.personalAssistant(f.alice,'personal-assistant/provision'),/method_not_found/);
});
test('real isolated process consumes owner DM, sends native reply once, restores after Host restart and retains profile on revoke',async t=>{
 const f=await fixture(t),{assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 const config={readConfig:async()=>({maxRuntimes:2,profileOptions:{mode:'fixture',telemetry:{enabled:false}}})};
 let host=await f.start(config);await waitFor(()=>host.state(assistant.binding.botId).phase==='running');
 const {channel}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/open');
 await f.service.communicate(f.alice,'opencraft/channels/messages/send',{channelId:channel.id,clientMessageId:'hello',parts:[{type:'text',text:'你好'}]});
 const messages=()=>f.service.communicate(f.alice,'opencraft/channels/messages/list',{channelId:channel.id});
 await waitFor(async()=>(await messages()).messages.length===2);
 assert.deepEqual(host.state(assistant.binding.botId).reception,{queued:0,running:0},"reply publication must refresh reception before the heartbeat");
 const before=(await messages()).messages;
 await waitFor(()=>host.state(assistant.binding.botId).reception?.queued===0 && host.state(assistant.binding.botId).reception?.running===0);
 await host.close();host=await f.start(config);await waitFor(()=>host.state(assistant.binding.botId).phase==='running');
 await new Promise(r=>setTimeout(r,1250));assert.deepEqual((await messages()).messages,before);
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/revoke');
 await waitFor(()=>host.state(assistant.binding.botId).phase!=='running');
 assert.ok(JSON.parse(await readFile(join(f.directory,'bots',assistant.binding.botId,'profile.json'),'utf8')).botBinding);
 const again=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');assert.equal(again.assistant.binding.botId,assistant.binding.botId);
 await waitFor(()=>host.state(assistant.binding.botId).phase==='running');
});
test('late startup is stopped after revocation without a second handle',async t=>{
 const f=await fixture(t),{assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 const started=Promise.withResolvers<void>(),ready=Promise.withResolvers<void>();let closed=0,spawns=0;
 const host=await f.start({readConfig:async()=>({maxRuntimes:1,profileOptions:{}}),spawn:()=>{spawns++;started.resolve();return {ready:ready.promise,failed:()=>false,async close(){closed++;}};}});
 await started.promise;await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/revoke');ready.resolve();
 await waitFor(()=>closed===1);assert.equal(spawns,1);assert.notEqual(host.state(assistant.binding.botId).phase,'running');
});
test('people directory lists Humans and only the current Human personal assistant',async t=>{
 const f=await fixture(t);const {assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 const people=(await f.service.communicate(f.bob,'opencraft/channels/people/list')).people;
 assert.ok(people.some((p:any)=>p.actorId===f.alice.actorId&&p.kind==='human'));
 assert.equal(people.some((p:any)=>p.actorId===assistant.actorId),false);
 const mine=(await f.service.communicate(f.alice,'opencraft/channels/people/list')).people;
 assert.equal(mine.find((p:any)=>p.actorId===assistant.actorId)?.canMessage,true);
 const candidates=(await f.service.communicate(f.bob,'opencraft/channels/group/candidates/search',{query:'Personal assistant'})).candidates;
 assert.equal(candidates.some((p:any)=>p.actorId===assistant.actorId),false);
 const again=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 assert.equal(again.assistant.binding.botId,assistant.binding.botId);
 assert.equal((await f.service.personalAssistant(f.bob,'opencraft/personal-assistant/get')).assistant,null);
 assert.equal((await f.service.communicate(f.bob,'opencraft/channels/people/list',{query:'Personal assistant'})).people.some((p:any)=>p.actorId===assistant.actorId),false);
 await assert.rejects(f.service.communicate(f.bob,'opencraft/channels/people/list',{owner:f.alice.actorId}),/invalid_input/);
 f.actors.setEnabled(f.alice.actorId,false,'test');
 assert.equal((await f.service.communicate(f.bob,'opencraft/channels/people/list')).people.some((p:any)=>p.actorId===assistant.actorId),false);
});
test('a failed worker backs off; explicit retry only restarts its own handle',async t=>{
 const f=await fixture(t),{assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 let clock=Date.now(),starts=0,closed=0,failed=false;
 const host=await f.start({now:()=>clock,readConfig:async()=>({maxRuntimes:1,profileOptions:{}}),spawn:()=>{starts++;failed=false;return {ready:Promise.resolve(),failed:()=>failed,async close(){closed++;}};}});
 await waitFor(()=>host.state(assistant.binding.botId).phase==='running');failed=true;
 await waitFor(()=>host.state(assistant.binding.botId).phase==='retrying');
 await new Promise(r=>setTimeout(r,100));assert.equal(starts,1);assert.equal(closed,1);
 clock=host.state(assistant.binding.botId).retryAt+1;
 await waitFor(()=>starts===2&&host.state(assistant.binding.botId).phase==='running');
});
test('one installation lease permits only one Host to provision, then standby takes over',async t=>{
 const f=await fixture(t),{assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 let starts=0;const config={intervalMs:30,readConfig:async()=>({maxRuntimes:1,profileOptions:{}}),spawn:()=>{starts++;return {ready:Promise.resolve(),failed:()=>false,async close(){}};}};
 const first=await f.start(config);await waitFor(()=>first.state(assistant.binding.botId).phase==='running');
 const secondService=new Collaboration(f.storage,f.actors),second=await createPersonalAssistantHost({directory:f.directory,service:secondService,...config});
 try {await new Promise(r=>setTimeout(r,100));assert.equal(starts,1);assert.equal(second.state(assistant.binding.botId).phase,'unavailable');
   await first.close();await waitFor(()=>second.state(assistant.binding.botId).phase==='running');assert.equal(starts,2);
 }finally{await second.close();await secondService.close();}
});

test('task observation follows the owner grant and disappears when its runtime fails',async t=>{
 const f=await fixture(t),{assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 let failed=false;
 const works=[{id:'private-work',title:'Alice task',status:'running',updatedAt:Date.now()}];
 const host=await f.start({readConfig:async()=>({maxRuntimes:1,profileOptions:{}}),spawn:()=>({ready:Promise.resolve(),failed:()=>failed,works:()=>works,activity:()=>({running:0,queued:0}),async close(){}})});
 await waitFor(()=>host.state(assistant.binding.botId).phase==='running');
 assert.deepEqual((await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/get')).runtime.works,works);
 assert.equal((await f.service.personalAssistant(f.bob,'opencraft/personal-assistant/get')).runtime.works,undefined);
 failed=true;
 assert.equal(host.state(assistant.binding.botId).works,undefined);
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/revoke');
 await waitFor(()=>host.state(assistant.binding.botId).phase!=='running');
 assert.equal((await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/get')).runtime.works,undefined);
});

test('temporary inbox read failure retains the authorized process and cursor; revoke still retires it',async t=>{
 const f=await fixture(t),{assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 const {spawnAssistant}=await import('../../apps/personal-assistant/src/runtime/host-supervisor.mjs');
 let starts=0,failReads=false,failedReads=0;
 const communicate=f.service.communicate.bind(f.service);
 f.service.communicate=(async (context:any,method:string,params:any)=>{
   if(method==='personal-assistant/own-messages'&&failReads){failedReads++;throw Error('Temporary storage read failure');}
   return communicate(context,method,params);
 }) as typeof f.service.communicate;
 const host=await f.start({readConfig:async()=>({maxRuntimes:2,profileOptions:{mode:'fixture',telemetry:{enabled:false}}}),spawn:(options:any)=>{starts++;return spawnAssistant(options);}});
 await waitFor(()=>host.state(assistant.binding.botId).reception?.running===0);
 failReads=true;await waitFor(()=>failedReads>0);
 await waitFor(()=>host.state(assistant.binding.botId).reception===undefined);
 assert.equal(host.state(assistant.binding.botId).phase,'running');assert.equal(starts,1);
 const {channel}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/open');
 await communicate(f.alice,'opencraft/channels/messages/send',{channelId:channel.id,clientMessageId:'after-read-failure',parts:[{type:'text',text:'你好'}]});
 failReads=false;
 await waitFor(async()=>(await communicate(f.alice,'opencraft/channels/messages/list',{channelId:channel.id})).messages.length===2);
 assert.equal(starts,1);
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/revoke');
 await waitFor(()=>host.state(assistant.binding.botId).phase!=='running');
});
