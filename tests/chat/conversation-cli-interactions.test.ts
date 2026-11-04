import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {ThreadAccessStore} from '../../packages/access-control/src/thread-access';
import {openServerDatabase} from '../../packages/storage-node/src/server/index';
import {HostInteractions} from '../../packages/app-host-server/src/interactions';
import {CollaborationClient} from '../../packages/appserver-client/src/collaboration';
import {MemoryTransport} from '@opencraft/appserver-transport-memory';
const ref={serverId:'server:fixture:codex',threadId:'thread'};
async function fixture(t:any) {
 const root=await mkdtemp(join(tmpdir(),'interaction-hub-')),db=await openServerDatabase(root),actors=new ActorStore(db);
 const human=actors.resolveHuman({provider:'fixture',subject:'one',displayName:'One',expiresAt:Date.now()+60000})!;
 const peer=actors.resolveHuman({provider:'fixture',subject:'two',displayName:'Two',expiresAt:Date.now()+60000})!;
 const access=new ThreadAccessStore(join(root,'access.sqlite'),actors),owner=new HostInteractions();let allowed=true,writes=0,fail=false,before=()=>{};
 const port:any={hostId:'local-codex',serverId:ref.serverId,directory:()=>({instanceId:'fixture',servers:[{...ref,label:'fixture',engine:'codex',connectionState:'ready',capabilities:{interactions:true,interactionRespond:true}}]}),
  interactions:async()=>{before();return owner.snapshot(ref.threadId,true);},
  respondInteraction:async(r:any,s:any,c:any)=>{before();return {disposition:await owner.respondStructured(r.threadId,s,async()=>{c.resourceOwner.assertCurrent();writes++;if(fail)throw Error('lost response');},()=>c.resourceOwner.assertCurrent()),snapshot:owner.snapshot(r.threadId,true)};}};
 const hub=new Collaboration(db,actors,port,Date.now,()=>allowed,(c,r)=>access.allows(r.serverId,r.threadId,c));
 const id=owner.capture({id:'native',method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',command:'synthetic'}}),snapshot=owner.snapshot('thread',true);
 const answer={action:'respondInteraction',reference:ref,interactionId:id,submissionId:'one',expectedEpoch:snapshot.epoch,expectedRevision:snapshot.revision,response:{decision:'accept'}};
 t.after(async()=>{await hub.close();access.close();actors.close();await db.close();await rm(root,{recursive:true,force:true});});
 return {hub,human,peer,actors,access,owner,answer,set before(v:()=>void){before=v;},set allowed(v:boolean){allowed=v;},set fail(v:boolean){fail=v;},get writes(){return writes;}};
}
test('Hub current human/ACL fences reads and owner admission without acquiring execution ownership',async t=>{
 const f=await fixture(t);f.access.created(ref.serverId,ref.threadId,f.human);f.access.set(ref.serverId,ref.threadId,'private',1,f.human);
 await assert.rejects(f.hub.command(f.peer,{action:'interactions',reference:ref}),{status:403});
 await assert.rejects(f.hub.command(f.peer,f.answer),{status:403});
 assert.equal((await f.hub.command(f.human,{action:'interactions',reference:ref}) as any).interactions.length,1);
 f.before=()=>{f.allowed=false;};await assert.rejects(f.hub.command(f.human,{action:'interactions',reference:ref}),{status:403});
 f.allowed=true;await assert.rejects(f.hub.command(f.human,f.answer),{status:403});assert.equal(f.writes,0);
 assert.equal(f.owner.snapshot('thread',true).requests[0]!.state,'pending');
});
test('unknown write outcome keeps the shared unconfirmed ledger, does not resend on retry or claim Native completion',async t=>{
 const f=await fixture(t);f.fail=true;
 const unknown=await f.hub.command(f.human,f.answer) as any;assert.equal(unknown.disposition,'unknown');assert.equal(unknown.executionState,'unknown');assert.equal(f.writes,1);
 assert.equal(f.owner.snapshot('thread',true).requests[0]!.state,'unconfirmed');
 assert.equal((await f.hub.command(f.human,f.answer) as any).disposition,'already-submitted');assert.equal(f.writes,1);
 f.actors.setEnabled(f.human.actorId,false,'test');await assert.rejects(f.hub.command(f.human,f.answer),{status:403});
});
test('old services negotiate each interaction capability before sending a command',async()=>{
 const requests:any[]=[];
 const client=new CollaborationClient(new MemoryTransport({server:{receive(raw,peer){const p=JSON.parse(raw);requests.push(p);peer.send(JSON.stringify({id:p.id,result:{capabilities:{extensions:{'opencraft/collaboration':{version:1,servers:true}}}}}));}}}));
 try {await client.connect();await assert.rejects(client.interactions(ref),{code:'UNSUPPORTED_CAPABILITY'});await assert.rejects(client.respondInteraction(ref,{} as any),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(requests.length,1);} finally {await client.close();}
});

test('bounded list cursors bind ref, epoch and revision, and unknown prompts never leak raw fields',async t=>{
 const f=await fixture(t);
 for(let i=0;i<35;i++)f.owner.capture({id:'native-'+i,method:'item/permissions/requestApproval',params:{threadId:'thread',extra:'synthetic hidden'}});
 const first=await f.hub.command(f.human,{action:'interactions',reference:ref}) as any;
 assert.equal(first.interactions.length,30);assert.ok(first.nextCursor);assert.equal(JSON.stringify(first).includes('synthetic hidden'),false);
 const tail=await f.hub.command(f.human,{action:'interactions',reference:ref,cursor:first.nextCursor}) as any;
 assert.equal(tail.interactions.length,6);assert.equal(tail.nextCursor,null);
 f.owner.capture({id:'last',method:'item/tool/requestUserInput',params:{threadId:'thread',questions:[]}});
 await assert.rejects(f.hub.command(f.human,{action:'interactions',reference:ref,cursor:first.nextCursor}),{status:409});
 await assert.rejects(f.hub.command(f.human,{...f.answer,result:{decision:'accept'}}),{status:400});
 await assert.rejects(f.hub.command(f.human,{...f.answer,interactionScope:{threadId:'thread',respond:true}}),{status:400});
});
