import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { openServerDatabase } from '../../../../packages/storage-node/src/server/index.ts';
import { ActorStore } from '../../../../packages/access-control/src/actors.ts';
import { avatarProfiles } from '../../plugins/tencentoa/src/avatar-profiles.mjs';

// Bundle this fixture, then run it against the actual candidate Worker/extension.
// It creates only a private temporary database. No provider calls or real messages.
const runtime=process.env.OPENCRAFT_AVATAR_RUNTIME_DIRECTORY??'/opt/opencraft/runtime';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'channel-avatar-bundle-'));
process.env.OPENCRAFT_DATA_DIR=directory;process.env.OPENCRAFT_WORKSPACE_DIR=directory+'-workspace';
let storage,actors,worker;
try {
 storage=await openServerDatabase(directory);actors=new ActorStore(storage);
 const principal=(provider,subject,displayName)=>({provider,subject,displayName,expiresAt:Date.now()+3600000});
 const alice=actors.resolveHuman(principal('tencentoa','10001','Owner display'));
 const bob=actors.resolveHuman(principal('tencentoa','10002','Member display'));
 const candidate=actors.resolveHuman(principal('tencentoa','10003','Candidate display'));
 const oldCandidate=actors.resolveHuman(principal('tencentoa','10004','Old display'));
 const legacy=new DatabaseSync(directory+'/employee-admission.sqlite');legacy.exec("CREATE TABLE employee_policy_identities(subject TEXT PRIMARY KEY,login_name TEXT NOT NULL); INSERT INTO employee_policy_identities VALUES('10004','verified-old-candidate');");legacy.close();
 const outsider=actors.resolveHuman(principal('local','impostor','verified-owner'));
 for(const[subject,loginName]of [['10001','verified-owner'],['10002','verified-member'],['10003','verified-candidate']])
  avatarProfiles(directory).observePrincipal({...principal('tencentoa',subject,loginName),attributes:{loginName}});
 worker=new Worker(pathToFileURL(path.join(runtime,'orchestration-runtime-worker.mjs')),{workerData:{path:directory+'/opencraft-server.sqlite',extensionModule:pathToFileURL(path.join(runtime,'assistant-extension.mjs')).href}});
 assert.equal((await once(worker,'message'))[0].type,'ready');let serial=0;
 async function call(method,payload){const id=++serial,pending=once(worker,'message');worker.postMessage({id,method,payload});const[reply]=await pending;assert.equal(reply.id,id);if(reply.error)throw Error(JSON.stringify(reply.error));return reply.result;}
 const command=(context,method,params={})=>call('communication',{context,method:'opencraft/channels/'+method,params}).then(packet=>packet.result);
 const group=await command(alice,'group/create',{title:'Avatar fixture',memberActorIds:[bob.actorId],clientRequestId:'group'});
 assert.equal((await command(alice,'messages/list',{channelId:group.id})).messages.length,0);
 const photo=(p,name)=>assert.deepEqual(p?.avatar,{kind:'employee',name});
 photo(group.participants.find(p=>p.actorId===bob.actorId),'verified-member');
 photo((await command(alice,'group/members/list',{channelId:group.id})).members.find(p=>p.actorId===alice.actorId),'verified-owner');
 const candidates=(await command(alice,'group/candidates/search',{channelId:group.id,query:''})).candidates;
 photo(candidates.find(p=>p.actorId===candidate.actorId),'verified-candidate');
 photo(candidates.find(p=>p.actorId===oldCandidate.actorId),'verified-old-candidate');
 assert.equal(candidates.find(p=>p.actorId===outsider.actorId).avatar,undefined);
 await assert.rejects(command(outsider,'group/members/list',{channelId:group.id}),/channel_denied/);
 actors.setGrant(alice.actorId,bob.actorId,'message.send',true,alice.actorId);
 const dm=await command(alice,'direct/open',{actorId:bob.actorId});photo(dm.participants[0],'verified-member');
 const reserved=(await call('channelSync',{method:'reserveHuman',params:{reservation:{binding:{provider:'wecom.wxfixture',subject:'T-reserved'},loginProvider:'tencentoa',alias:'verified-reservation'}}})).result;
 storage.database.prepare('INSERT INTO actor_channel_members VALUES(?,?,?)').run(group.id,reserved.id,'reserved-fixture');
 photo((await command(alice,'group/members/list',{channelId:group.id})).members.find(p=>p.actorId===reserved.id),'verified-reservation');
 assert.equal(storage.database.prepare('SELECT enabled FROM actors WHERE id=?').get(reserved.id).enabled,0);
 assert.equal(storage.database.prepare('SELECT count(*) AS n FROM actor_bindings WHERE actor_id=?').get(reserved.id).n,0);
 assert.ok(!(await command(alice,'group/candidates/search',{channelId:group.id,query:''})).candidates.some(p=>p.actorId===reserved.id));
 actors.bindHuman(bob,principal('local','bob-backup','Member display'));
 actors.unbindHuman(bob,{provider:'tencentoa',subject:'10002'});
 assert.equal((await command(alice,'group/members/list',{channelId:group.id})).members.find(p=>p.actorId===bob.actorId).avatar,undefined);
 const listed=(await command(alice,'list')).groups.find(g=>g.id===group.id);
 assert.equal(listed.participants.find(p=>p.actorId===bob.actorId).avatar,undefined);
 await call('close',{});
 console.log(JSON.stringify({ok:true,compiledWorker:true,compiledProductExtension:true,members:true,candidates:true,coldDirectHeader:true,boundedGroupPreview:true,unverifiedNameFallback:true,readAuthorization:true,revocationObserved:true,reservedRosterOnly:true,legacyVerifiedMetadata:true,externalRequests:0}));
} finally {
 if(worker)await worker.terminate();actors?.close();await storage?.close();
 await fs.rm(directory,{recursive:true,force:true});await fs.rm(directory+'-workspace',{recursive:true,force:true});
}
