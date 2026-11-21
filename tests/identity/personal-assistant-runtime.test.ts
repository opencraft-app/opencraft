import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '../../packages/storage-node/src/server/index';
import {ActorStore} from '../../packages/access-control/src/actors';
import {ActorAccess} from '../../packages/access-control/src/actor-access';
import {Collaboration,CollaborationHttpApi} from '../../packages/access-control/src/collaboration';
import {createWorkbenchWebServer} from '../../apps/headless-server/src/serve-workbench-web.mjs';
import {startPersonalAssistant} from '@opencraft/personal-assistant';
import {httpPlatformAssistantPort} from '@opencraft/personal-assistant/platform-port';

test('claimed Bot runtime reads native history and survives revoke/reclaim without membership or identity duplication',async()=>{
const root=await mkdtemp(join(tmpdir(),'personal-host-smoke-')),storage=await openServerDatabase(join(root,'server'));
const actors=new ActorStore(storage),principal={provider:'local',subject:'test',displayName:'Test',expiresAt:Date.now()+60000};
const human=actors.resolveHuman(principal)!,service=new Collaboration(storage,actors);
const access=new ActorAccess(actors,{authenticateHuman:r=>r.headers.cookie==='synthetic'?principal:null,admitted:()=>true,administrator:()=>false});
const gateway=await createWorkbenchWebServer({root,appServerTarget:null,actorService:access,actorCollaborationService:new CollaborationHttpApi(service,access),loopbackOnly:true});
const {port}=await gateway.listen({host:'127.0.0.1',port:0}),origin='http://127.0.0.1:'+port;
let runner:any;
try{
 const claim=await fetch(origin+'/__opencraft_actors/collaboration/personal-assistant/claim',{method:'POST',headers:{cookie:'synthetic',origin,'content-type':'application/json'},body:'{}'});
 assert.equal(claim.status,200);const {assistant}=await claim.json();
 const group=await service.communicate(human,'opencraft/channels/group/create',{title:'真实管道合成群',memberActorIds:[],clientRequestId:'one'});
 await service.communicate(human,'opencraft/channels/messages/send',{channelId:group.id,clientMessageId:'fact',parts:[{type:'text',text:'合成验收事实 123'}]});
 const activate=async()=>{const {credential}=await service.provisionPersonalAssistant(human);return startPersonalAssistant({serverDirectory:join(root,'server'),port:httpPlatformAssistantPort({origin,token:credential.token}),profileOptions:{telemetry:{enabled:false}}});};
 runner=await activate();
 const groups=await runner.dispatch({op:'platform.groups.list',params:{}});assert.equal(groups.groups[0].id,group.id);
 const history=await runner.dispatch({op:'platform.groups.history',params:{channelId:group.id}});assert.equal(history.messages[0].text,'合成验收事实 123');
 assert.equal(service.channels.isMember(group.id,assistant.actorId),false);
 await service.personalAssistant(human,'opencraft/personal-assistant/revoke');
 await assert.rejects(runner.dispatch({op:'platform.groups.list',params:{}}));
 await runner.close();runner=null;
 const again=await service.personalAssistant(human,'opencraft/personal-assistant/claim');assert.equal(again.assistant.binding.botId,assistant.binding.botId);
 runner=await activate();assert.equal((await runner.dispatch({op:'platform.groups.list',params:{}})).groups.length,1);
 console.log('PASS: HTTP claim → trusted Host provisioning → standalone Bot runner → real Core group history → revoke → reclaim/reopen same Bot');
}finally{await runner?.close();await gateway.close();await service.close();actors.close();await storage.close();await rm(root,{recursive:true,force:true});}

});
