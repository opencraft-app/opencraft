import '../../products/join/plugins/wecom/assistant-install.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {avatarProfiles} from '../../products/join/plugins/tencentoa/src/avatar-profiles.mjs';
import {joinIdentityComposition} from '../../products/join/identity.mjs';

test('authenticated product identity reaches native channel projections inside the real storage worker',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'avatar-worker-')),storage=await openServerDatabase(dir),actors=new ActorStore(storage);
 const principal={provider:'tencentoa',subject:'12345',displayName:'Unrelated Display',attributes:{loginName:'verified-account'},expiresAt:Date.now()+60000};
 const human=actors.resolveHuman(principal)!;
 const identity=await joinIdentityComposition().createIdentity({hubAuthority:{providers:['tencentoa']},resolveIdentity:()=>principal,dataDirectory:dir});
 // This is the same trusted authentication wrapper used by the Gateway.
 assert.equal(identity.service.connectionContext({})?.sender?.loginName,'verified-account');
 const service=new Collaboration(storage,actors);
 t.after(async()=>{await service.close();identity.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
 const call=(method:string,params={})=>service.communicate(human,'opencraft/channels/'+method,params);
 const group=await call('group/create',{title:'Worker proof',memberActorIds:[],clientRequestId:'group'});
 assert.deepEqual(group.participants[0].avatar,{kind:'employee',name:'verified-account'});
 assert.deepEqual((await call('group/members/list',{channelId:group.id})).members[0].avatar,{kind:'employee',name:'verified-account'});
 assert.deepEqual((await call('list')).groups[0].participants[0].avatar,{kind:'employee',name:'verified-account'});
 const sent=await call('messages/send',{channelId:group.id,clientMessageId:'message',parts:[{type:'text',text:'own'}]});
 assert.deepEqual(sent.receipt.sender.avatar,{kind:'employee',name:'verified-account'});
 const source=JSON.stringify(['wecom-customer-service','wxcorp','fwservice','wrgroup']),incarnation='fixture';
 await service.synchronizeChannels({method:'configure',params:{incarnation,bindings:[{source,channelId:group.id}],images:false}});
 avatarProfiles(dir).observeDirectory(source,'T123A','directory-account');
 await service.synchronizeChannels({method:'ingest',params:{incarnation,source,arrival:{source,id:'external-message',author:'T123A',sender:{id:'T123A',displayName:'Not an account'},text:'external',at:Date.now()}}});
 const page=await call('messages/list',{channelId:group.id});
 assert.deepEqual(page.messages[1].sender.avatar,{kind:'employee',name:'directory-account'});
 assert.equal(page.messages[1].sender.kind,'external');assert.equal(page.messages[1].sender.isSelf,false);
});
