import assert from 'node:assert/strict';
import test from 'node:test';
import {HostInteractions} from '../../packages/app-host-server/src/interactions';
import {projectStructuredInteraction, structuredInteractionResult, type StructuredInteractionSubmission} from '@opencraft/appserver-protocol';

function fixture(method='item/commandExecution/requestApproval',params:Record<string,unknown>={}) {
 const owner=new HostInteractions();
 const source={id:1,method,params:{threadId:'thread',turnId:'turn',itemId:'item',...params},__opencraftInteractionKey:'lifetime'};
 const id=owner.capture(source),snapshot=owner.snapshot('thread',true);
 const submission:StructuredInteractionSubmission={interactionId:id,submissionId:'human:a',expectedEpoch:snapshot.epoch,expectedRevision:snapshot.revision,response:{decision:'accept'}};
 return {owner,source,id,submission,request:snapshot.requests[0]!};
}
const fault=(code:string)=>(e:unknown)=>(e as {domainData?:{code:string}}).domainData?.code===code;
test('structured admission is fenced by source, revision, Thread and current authority',async()=>{
 const f=fixture();let writes=0;const write=async()=>{writes++;};
 await assert.rejects(f.owner.respondStructured('thread',{...f.submission,expectedEpoch:'old'},write),fault('SOURCE_CHANGED'));
 await assert.rejects(f.owner.respondStructured('thread',{...f.submission,expectedRevision:0},write),fault('SOURCE_CHANGED'));
 await assert.rejects(f.owner.respondStructured('peer',f.submission,write),fault('SCOPE'));
 await assert.rejects(f.owner.respondStructured('thread',f.submission,write,()=>{throw Error('revoked');}),/revoked/);
 assert.equal(writes,0);assert.equal(f.owner.snapshot('thread',true).requests[0]!.state,'pending');
});
test('two answers and same submission conflict use the shared owner without duplicate writes',async()=>{
 const f=fixture();let writes=0,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const first=f.owner.respondStructured('thread',f.submission,async()=>{writes++;await gate;});
 assert.equal(await f.owner.respondStructured('thread',{...f.submission,submissionId:'human:b',response:{decision:'decline'}},async()=>{writes++;}),'already-submitted');
 await assert.rejects(f.owner.respondStructured('thread',{...f.submission,response:{decision:'decline'}},async()=>{writes++;}),fault('RESPONSE_CONFLICT'));
 release();assert.equal(await first,'submitted');assert.equal(writes,1);
 assert.equal(f.owner.snapshot('thread',true).requests[0]!.state,'responding','submitted is not completion');
});
test('failed delivery remains unconfirmed until producer replay; stale snapshot never replays it',async()=>{
 const f=fixture();let writes=0;
 await assert.rejects(f.owner.respondStructured('thread',f.submission,async()=>{writes++;throw Error('disconnect');}),/disconnect/);
 assert.equal(f.owner.snapshot('thread',true).requests[0]!.state,'unconfirmed');
 assert.equal(await f.owner.respondStructured('thread',f.submission,async()=>{writes++;}),'already-submitted');
 f.owner.markSourceUnavailable();await assert.rejects(f.owner.respondStructured('thread',f.submission,async()=>{writes++;}),fault('SOURCE_UNAVAILABLE'));
 f.owner.capture({...f.source,id:2,__opencraftInteractionState:'pending'});
 await assert.rejects(f.owner.respondStructured('thread',f.submission,async()=>{writes++;}),fault('SOURCE_CHANGED'));
 const current=f.owner.snapshot('thread',true);
 assert.equal(await f.owner.respondStructured('thread',{...f.submission,expectedRevision:current.revision},async source=>{assert.equal(source.id,2);writes++;}),'submitted');
 assert.equal(writes,2);
 f.owner.resolveNative(2,'thread');assert.equal(await f.owner.respondStructured('thread',f.submission,async()=>assert.fail()),'resolved');
 const restarted=fixture();await assert.rejects(restarted.owner.respondStructured('thread',f.submission,async()=>assert.fail()),fault('SOURCE_CHANGED'));
});
test('approval scopes follow the actual method and explicit source decisions',()=>{
 const normal=fixture();assert.deepEqual(projectStructuredInteraction(normal.request).actions.map(a=>a.scope),['once','deny','cancel']);
 assert.throws(()=>structuredInteractionResult(normal.request,{decision:'acceptForSession'}));
 const session=fixture(undefined,{availableDecisions:['accept','acceptForSession','decline']});
 assert.equal(projectStructuredInteraction(session.request).actions.find(a=>a.decision==='acceptForSession')!.scope,'session');
 assert.deepEqual(structuredInteractionResult(session.request,{decision:'acceptForSession'}),{decision:'acceptForSession'});
 for(const response of [{decision:'accept',result:{}},{decision:{acceptWithExecpolicyAmendment:{}}},{result:{}}]) assert.throws(()=>structuredInteractionResult(normal.request,response));
 const file=fixture('item/fileChange/requestApproval',{grantRoot:'/unconfirmed'});assert.throws(()=>structuredInteractionResult(file.request,{decision:'acceptForSession'}));
 assert.equal(projectStructuredInteraction(fixture('item/permissions/requestApproval').request).supported,false);
});
test('question answers bind question ids, offered options and bounded schema',()=>{
 const f=fixture('item/tool/requestUserInput',{questions:[{id:'q',header:'Choose',question:'Which?',isOther:false,isSecret:false,options:[{label:'A',description:'A'}]}]});
 assert.deepEqual(structuredInteractionResult(f.request,{answers:{q:{answers:['A']}}}),{answers:{q:{answers:['A']}}});
 for(const response of [{answers:{}},{answers:{other:{answers:['A']}}},{answers:{q:{answers:['B']}}},{answers:{q:{answers:['A'],anything:true}}},{answers:{q:{answers:['A']}},result:{}}]) assert.throws(()=>structuredInteractionResult(f.request,response));
});

test('source replay during current-authority validation fences the old answer before write',async()=>{
 const f=fixture();let validations=0,writes=0;
 await assert.rejects(f.owner.respondStructured('thread',f.submission,async()=>{writes++;},()=>{
   if(++validations===2) f.owner.capture({...f.source,id:2,__opencraftInteractionState:'pending'});
 }),fault('SOURCE_CHANGED'));
 assert.equal(writes,0);assert.equal(f.owner.snapshot('thread',true).requests[0]!.state,'pending');
 f.owner.clear();f.owner.capture(f.source);
 await assert.rejects(f.owner.respondStructured('thread',f.submission,async()=>assert.fail()),fault('SOURCE_CHANGED'));
});
