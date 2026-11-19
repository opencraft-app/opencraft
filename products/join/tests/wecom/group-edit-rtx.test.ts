import '../../plugins/wecom/assistant-install.mjs';
import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{openServerDatabase}from'@opencraft/storage-node/server';import{ActorStore}from'../../../../packages/access-control/src/actors';import{Collaboration}from'../../../../packages/access-control/src/collaboration';
import{syncHash,syncConfig,syncSnapshot}from'../../plugins/wecom/group-sync.mjs';
import{createGroupSyncPump}from'../../plugins/wecom/mirror/group-sync-target.mjs';
import{groupSyncProvider}from'../../plugins/wecom/mirror/group-sync-provider.mjs';
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'wecom-sync-')),old=process.env.OPENCRAFT_DATA_DIR,oldWs=process.env.OPENCRAFT_WORKSPACE_DIR;process.env.OPENCRAFT_DATA_DIR=dir;process.env.OPENCRAFT_WORKSPACE_DIR=dir+'-ws';
 const storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors),db=storage.database;
 t.after(async()=>{await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});if(old===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=old;if(oldWs===undefined)delete process.env.OPENCRAFT_WORKSPACE_DIR;else process.env.OPENCRAFT_WORKSPACE_DIR=oldWs;});
 const human=(id:string)=>actors.resolveHuman({provider:'tencentoa',subject:id,displayName:id,expiresAt:Date.now()+3600000})!;
 const alice=human('alice'),bob=human('bob'),carol=human('carol');for(const[c,id]of[[alice,'WA'],[bob,'WB'],[carol,'WC']]as const)actors.bindHuman(c,{provider:'wecom.wxfixture',subject:id,displayName:id,expiresAt:Date.now()+3600000});
 const channel=(c:any,op:string,p:any={})=>service.communicate(c,'opencraft/channels/'+op,p),group=await channel(alice,'group/create',{title:'Native',memberActorIds:[bob.actorId],clientRequestId:'group'});
 await service.personalAssistant(alice,'opencraft/personal-assistant/claim');
 const provision=await service.provisionPersonalAssistant(alice),bot=actors.authenticateSession(provision.credential.token)!;
 const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']),incarnation='sync-fixture';
 const native=(method:string,params:any={})=>service.synchronizeChannels({method,params:{...params,incarnation}});await native('configure',{bindings:[{source,channelId:group.id}]});
 await native('ingest',{source,arrival:{source,id:'mention',author:'WA',text:'@助理 hi',mentioned:true,at:1000}});
 const[scope]=await service.communicate(bot,'join/wecom-assistant/scopes',{});
 const cli=(...args:string[])=>service.communicate(bot,'join/wecom-assistant/cli',{scope:scope.scope,argv:[...args,'--group',group.id]});
 const cmd=(verb:string,p:any={})=>native('join/wecom-sync/'+verb,{source,...p});
 const binding={serverId:'one',humanKey:syncHash(['wecom','wxfixture','WA']),generation:'provider-epoch'};
 const read=()=>cmd('read',{sourceEpoch:epoch()});const epoch=()=>String(db.prepare('SELECT epoch FROM actor_channel_sources WHERE source=?').get(source)!.epoch);
 const snapshot=(name='Provider',memberIds=['WA','WB'])=>({externalId:'room',name,memberIds});
 const configure=(raw:any)=>cli('sync','configure',JSON.stringify(raw),'--idempotency-key','config-'+syncHash(raw));
 const observe=async(s=snapshot())=>{const ticket=await cmd('observe',{sourceEpoch:epoch()});return cmd('snapshot',{sourceEpoch:epoch(),...ticket,snapshot:s,binding});};

 return{service,storage,actors,db,alice,bob,carol,group,source,channel,cli,cmd,binding,epoch,read,snapshot,configure,observe};
}
import{createNativeMemberOwnerDirectory}from'../../plugins/tencentoa/src/native-member-owner-directory.mjs';
function verified(subject:string,rtx:string){const directory=createNativeMemberOwnerDirectory(process.env.OPENCRAFT_DATA_DIR!);try{directory.observe({provider:'tencentoa',subject,attributes:{loginName:rtx},aliases:['login:'+rtx],expiresAt:Date.now()+60000});}finally{directory.close();}}
function person(f:any,subject:string,displayName:string){const actor=f.actors.resolveHuman({provider:'tencentoa',subject,displayName,expiresAt:Date.now()+60000});f.actors.bindHuman(actor,{provider:'wecom.wxfixture',subject:'U'+subject,displayName,expiresAt:Date.now()+60000});return actor;}
test('ordinary assistant RTX add/remove resolves verified numeric OA subjects, never display names',async t=>{
 const f=await fixture(t),actor=person(f,'206880','misleading-name');verified('206880','walkercao');await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe();
 const add=await f.cli('chat','add','walkercao','--idempotency-key','numeric-add');assert.equal(add.wecom.state,'pending');assert.equal(f.service.channels.isMember(f.group.id,actor.actorId),true);
 const remove=await f.cli('chat','remove','walkercao','--idempotency-key','numeric-remove');assert.equal(remove.wecom.state,'pending');assert.equal(f.service.channels.isMember(f.group.id,actor.actorId),false);
 assert.deepEqual((await f.read()).operations.map((o:any)=>[o.userId,o.present]),[['U206880',true],['U206880',false]]);
});
test('RTX lookup reads a new verified association after the Worker has started',async t=>{
 const f=await fixture(t),actor=person(f,'206880','a');await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe();
 await assert.rejects(f.cli('chat','add','walkercao','--idempotency-key','same-key'),/identity_required/);verified('206880','walkercao');
 await f.cli('chat','add','walkercao','--idempotency-key','same-key');assert.equal(f.service.channels.isMember(f.group.id,actor.actorId),true);
});
test('display labels and unverified principal aliases do not authorize an RTX target',async t=>{
 const f=await fixture(t),actor=person(f,'206880','walkercao');await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe();
 await assert.rejects(f.cli('chat','add','walkercao','--idempotency-key','spoof'),/identity_required/);assert.equal(f.service.channels.isMember(f.group.id,actor.actorId),false);assert.equal((await f.read()).operations.length,0);
});
test('conflicting verified numeric identities cannot silently choose a legacy RTX Actor',async t=>{
 const f=await fixture(t);person(f,'206880','one');person(f,'999','two');verified('206880','carol');verified('999','carol');await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe();
 await assert.rejects(f.cli('chat','add','carol','--idempotency-key','conflict'),/identity_required/);assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),false);assert.equal((await f.read()).operations.length,0);
});
test('an RTX alias matching distinct legacy and numeric Actors is ambiguous, not a merge',async t=>{
 const f=await fixture(t),other=person(f,'206880','one');verified('206880','carol');await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe();
 await assert.rejects(f.cli('chat','add','carol','--idempotency-key','ambiguous'),/identity_required/);assert.equal(f.service.channels.isMember(f.group.id,other.actorId),false);assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),false);
});
