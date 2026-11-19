import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {SandboxEnvironment} from '@opencraft/sandbox';
import type {Artifact} from '../../../../apps/local-agent-host/src/artifacts/catalog';
import {transferWorkspaceArtifact} from '../../assets/workspace-artifact-transfer';
async function fixture(t:test.TestContext) {
 const root=await mkdtemp(join(tmpdir(),'artifact583-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bytes=Buffer.alloc(200000,73),path=join(root,'input.pdf');await writeFile(path,bytes);
 const artifact:Artifact={id:'test',name:'input.pdf',mimeType:'application/pdf',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),path,origin:'upload'};
 let spawns=0;
 const sandbox={async spawn(input,output){spawns++;
  const command=[...input.command];command[2]=command[2]!.replace('os.open("/workspace",',`os.open(${JSON.stringify(root)},`);
  const child=spawn(command[0]!,command.slice(1),{cwd:root,stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',data=>output?.({stream:'stdout',data}));child.stderr.on('data',()=>{});
  const exited=new Promise<{code:number|null}>(resolve=>child.on('close',code=>resolve({code})));void exited.catch(()=>{});
  return {kind:'process',exited,writeStdin:(data:Uint8Array)=>new Promise<void>((resolve,reject)=>child.stdin.write(data,e=>e?reject(e):resolve())),
   closeStdin:()=>new Promise<void>(resolve=>child.stdin.end(resolve)),async terminate(){child.kill('SIGTERM');await exited;}};
 }} as Pick<SandboxEnvironment,'spawn'>;
 return {root,artifact,bytes,sandbox,get spawns(){return spawns}};
}
test('streams bytes into private volume, checks digest and publishes atomic locator',async t=>{
 const f=await fixture(t);const result=await transferWorkspaceArtifact({sandbox:f.sandbox,artifact:f.artifact,authorize:async()=>{},onCleanupUnconfirmed(){assert.fail('cleanup')}});
 assert.equal(result.origin,'execution-copy');assert.match(result.path,/^\/workspace\/\.opencraft\/attachments\/[a-f0-9]{64}\.pdf$/);
 assert.deepEqual(await readFile(join(f.root,'.opencraft/attachments',basename(result.path))),f.bytes);
 assert.deepEqual(await readFile(f.artifact.path),f.bytes);
});
test('mismatched source metadata cannot publish a partial attachment',async t=>{
 const f=await fixture(t);await assert.rejects(transferWorkspaceArtifact({sandbox:f.sandbox,artifact:{...f.artifact,sha256:'0'.repeat(64)},authorize:async()=>{},onCleanupUnconfirmed(){}}),/transfer failed/);
 assert.deepEqual(await readdir(join(f.root,'.opencraft/attachments')),[]);
});
test('cancelled authority does not spawn a process',async t=>{
 const f=await fixture(t);const signal=AbortSignal.abort();
 await assert.rejects(transferWorkspaceArtifact({sandbox:f.sandbox,artifact:f.artifact,signal,authorize:async()=>{},onCleanupUnconfirmed(){}}));assert.equal(f.spawns,0);
});

test('revoked upload authority terminates receiver before publishing a locator',async t=>{
 const f=await fixture(t);let checks=0;
 await assert.rejects(transferWorkspaceArtifact({sandbox:f.sandbox,artifact:f.artifact,
  authorize:async()=>{if(++checks>=4)throw Error('revoked');},onCleanupUnconfirmed(){assert.fail('cleanup')}}),/revoked/);
 const files=await readdir(join(f.root,'.opencraft/attachments')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 assert.deepEqual(files,[]);
});

import {ordinaryNativeRouting} from '../../assets/ordinary-native-routing';
test('physical workspace attachment hook keeps local fallback explicit and remote authority mandatory',async t=>{
 const f=await fixture(t);let remote=false,copies=0;const context={sender:null};
 const admission={authority:{principalId:'owner',hostId:'host'},catalog:{scope:'scope',current:()=>true},authorize:async()=>{}};
 const runtime={hasPlacement:()=>remote,async prepareArtifactFor(a:unknown,id:string,artifact:Artifact){assert.equal(a,admission);assert.equal(id,'thread');copies++;return {...artifact,path:'/workspace/private.pdf'};}};
 const hooks=ordinaryNativeRouting({hostId:'host',runtime:runtime as unknown as Parameters<typeof ordinaryNativeRouting>[0]['runtime'],
 authority:{} as Parameters<typeof ordinaryNativeRouting>[0]['authority'],admit:c=>{assert.equal(c,context);return admission},restoreProvisional:async()=>{},onCleanupUnconfirmed(){}});
 assert.equal(await hooks.prepareWorkspaceArtifact!(f.artifact,'thread',context),null);assert.equal(copies,0);
 remote=true;await assert.rejects(hooks.prepareWorkspaceArtifact!(f.artifact,'thread'),/authority unavailable/);assert.equal(copies,0);
 assert.equal((await hooks.prepareWorkspaceArtifact!(f.artifact,'thread',context))!.path,'/workspace/private.pdf');assert.equal(copies,1);
});

import {CodexEngineAdapter} from '../../../../apps/opencraft-daemon/src/codex-engine-adapter';
import {LocalAttachmentStagingService} from '../../../../apps/local-agent-host/src/attachments/local-attachment-staging';
test('actual attachment projection uses workspace locator and does not invoke Host transfer',async t=>{
 const f=await fixture(t);const staging=new LocalAttachmentStagingService(join(f.root,'stage'));
 t.after(()=>staging.close());
 const {ref}=await staging.stage({clientAttachmentId:'input',name:'input.txt',mimeType:'text/plain',size:3,source:{kind:'client-bytes',dataBase64:'YWJj'}});
 assert.equal(ref.location.kind,'host-file');if(ref.location.kind!=='host-file')throw Error('fixture');
 const context={sender:null};let local=0,remote=0;
 const adapter=Object.assign(Object.create(CodexEngineAdapter.prototype),{artifactReaders:new Map(),artifactLifetime:new AbortController(),attachmentStaging:staging,
 options:{async prepareWorkspaceArtifact(artifact:Artifact,threadId:string,c:unknown){assert.equal(threadId,'thread');assert.equal(c,context);remote++;return {...artifact,path:'/workspace/attachment.txt'};},
 async prepareArtifact(artifact:Artifact){local++;return artifact;}}});
 const input=[{type:'mention',name:ref.name,path:ref.location.path}];
 const result=await adapter.modelVisibleAttachmentInput(input,'thread',undefined,context);
 assert.match(result.input[0].text,/\/workspace\/attachment.txt/);assert.equal(remote,1);assert.equal(local,0);
 adapter.options.prepareWorkspaceArtifact=async()=>{throw Error('revoked')};
 await assert.rejects(adapter.modelVisibleAttachmentInput(input,'thread',undefined,context),/revoked/);assert.equal(local,0);
});

test('actual internal request registration retains its own context and retires with the request',async()=>{
 let guard: (()=>unknown)|undefined;let alive=true;
 const context={sender:null,resourceOwner:{id:'owned',assertCurrent(){if(!alive)throw Error('revoked')}}};
 const adapter=Object.assign(Object.create(CodexEngineAdapter.prototype),{
  statusValue:{state:'open'},child:{},physicalInitialized:true,sequence:0,sessionMcpGeneration:1,
  options:{},internalRequests:new Map(),environmentCreations:new Map(),checkModelPolicy:async()=>{},
  async writePhysical(message:{id:string}){const request=this.internalRequests.get(message.id);guard=request.nativeAdmission.context;
   assert.equal(guard!(),context);clearTimeout(request.timer);this.internalRequests.delete(message.id);request.resolve({ok:true});},
 });
 assert.deepEqual(await adapter.requestPhysical('thread/read',{threadId:'thread'},1000,undefined,undefined,undefined,context),{ok:true});
 assert.throws(()=>guard!(),/retired/);
 adapter.writePhysical=async(message:{id:string})=>{alive=false;adapter.internalRequests.get(message.id).nativeAdmission.context();};
 await assert.rejects(adapter.requestPhysical('thread/read',{threadId:'thread'},1000,undefined,undefined,undefined,context),/revoked/);
 assert.equal(adapter.internalRequests.size,0);
});

import {restoreWorkspaceQueuedContext} from '../../../../apps/opencraft-daemon/src/workspace-queued-context';
test('queued workspace context restores only original delegation and captured provider identity',async()=>{
 const expiresAt=Date.now()+60000;
 const actor={actorId:'original',generation:2,credentialId:'credential',expiresAt};
 let subject='original-subject',authorityId='grant',current=true;
 const dependencies={actors:{isCurrent:()=>current,bindings:()=>[{provider:'tencentoa',subject}]},
  executionContext:async(thread:string,input:{inputId:string})=>{assert.equal(thread,'thread');assert.equal(input.inputId,'input');return {context:actor,authorityId:'grant'};},
  authority:()=>({authorizer:'original',expiresAt,authorityId})};
 const submission={ownership:'human' as const,principal:{provider:'tencentoa',subject:'original-subject'}};
 const context=await restoreWorkspaceQueuedContext('thread','input',submission,dependencies as Parameters<typeof restoreWorkspaceQueuedContext>[3]);
 assert.equal(context.validUntil,expiresAt);assert.deepEqual(context.actorContext,actor);assert.equal(context.sender,null);
 context.resourceOwner!.assertCurrent();authorityId='replacement';assert.throws(()=>context.resourceOwner!.assertCurrent(),/authority changed/);
 authorityId='grant';subject='other-user';assert.throws(()=>context.resourceOwner!.assertCurrent(),/authority changed/);
 subject='original-subject';current=false;assert.throws(()=>context.resourceOwner!.assertCurrent(),/authority changed/);
 await assert.rejects(restoreWorkspaceQueuedContext('thread','input',undefined,dependencies as Parameters<typeof restoreWorkspaceQueuedContext>[3]),/identity unavailable/);
});

test('actual queued start restores workspace authority before preparing attachments and never restores local work',async()=>{
 const context={sender:null};let restored=0,projected=0,remote=true;
 const submission={ownership:'human',principal:{provider:'tencentoa',subject:'owner'}};
 const queued={clientUserMessageId:'input',input:[],executionSubmission:submission};
 const adapter=Object.assign(Object.create(CodexEngineAdapter.prototype),{
  queueStore:()=>({firstAwaitingAdmission:()=>null,find:()=>queued}),
  async modelVisibleAttachmentInput(input:unknown[],thread:string,client:unknown,c:unknown){assert.equal(thread,'thread');assert.equal(c,remote?context:undefined);projected++;return {input,attachments:[]};},
  options:{requiresWorkspaceResume:()=>remote,collaboration:{
   async restoreWorkspaceSubmission(thread:string,input:string,s:unknown){assert.equal(thread,'thread');assert.equal(input,'input');assert.equal(s,submission);restored++;return context},
   async queuedContext(){throw Error('STOP_AFTER_ATTACHMENT_PROJECTION')},
  }},
 });
 await assert.rejects(adapter.dispatchQueuedStart('thread','queue-id'),/STOP_AFTER_ATTACHMENT_PROJECTION/);
 assert.equal(restored,1);assert.equal(projected,1);
 remote=false;await assert.rejects(adapter.dispatchQueuedStart('thread','queue-id'),/STOP_AFTER_ATTACHMENT_PROJECTION/);
 assert.equal(restored,1);assert.equal(projected,2);
 remote=true;adapter.options.collaboration.restoreWorkspaceSubmission=async()=>{throw Error('revoked')};
 await assert.rejects(adapter.dispatchQueuedStart('thread','queue-id'),/revoked/);assert.equal(projected,2);
});

import {workspaceArtifactReader} from '../../assets/workspace-artifact-reader';
test('workspace generated output streams exact bytes with bounded credit and verified receipt',async t=>{
 const f=await fixture(t);
 const reader=workspaceArtifactReader({sandbox:f.sandbox,authorize:async()=>{},onCleanupUnconfirmed(){assert.fail('cleanup')}});
 const file=await reader('/workspace/input.pdf');const chunks:Buffer[]=[];
 for await(const chunk of file.body){assert.ok(chunk.length<=65536);chunks.push(chunk);}
 assert.deepEqual(Buffer.concat(chunks),f.bytes);await file.dispose();
});
test('workspace generated output rejects traversal before spawn and stops on revoked authority',async t=>{
 const f=await fixture(t);let allowed=true;
 const reader=workspaceArtifactReader({sandbox:f.sandbox,authorize:async()=>{if(!allowed)throw Error('revoked')},onCleanupUnconfirmed(){assert.fail('cleanup')}});
 await assert.rejects(reader('/workspace/../secret'),/Invalid workspace output path/);assert.equal(f.spawns,0);
 const file=await reader('/workspace/input.pdf');allowed=false;
 await assert.rejects(async()=>{for await(const chunk of file.body){void chunk;}},/revoked/);await file.dispose();
});

test('workspace output refuses changed files rather than committing mixed bytes',async t=>{
 const f=await fixture(t);
 const file=await workspaceArtifactReader({sandbox:f.sandbox,authorize:async()=>{},onCleanupUnconfirmed(){assert.fail('cleanup')}})('/workspace/input.pdf');
 await assert.rejects(async()=>{
  let changed=false;
  for await(const chunk of file.body){if(!changed){changed=true;await writeFile(f.artifact.path,Buffer.alloc(f.bytes.length,74));}void chunk;}
 },/ended before receipt|output failed/);
 await file.dispose();
});

test('actual adapter captures workspace output through remote reader, never same-path Host fallback',async t=>{
 const f=await fixture(t);const staging=new LocalAttachmentStagingService(join(f.root,'output-stage'));t.after(()=>staging.close());
 let local=0,remote=0,failures=0,allowed=true;
 const context={sender:null,resourceOwner:{id:'owner',assertCurrent(){if(!allowed)throw Error('revoked')}}};
 const reader=workspaceArtifactReader({sandbox:f.sandbox,authorize:async()=>context.resourceOwner.assertCurrent(),onCleanupUnconfirmed(){assert.fail('cleanup')}});
 const adapter=Object.assign(Object.create(CodexEngineAdapter.prototype),{attachmentStaging:staging,artifactLifetime:new AbortController(),artifactOutputs:new Set(),
  diagnostic(){failures++},options:{requiresWorkspaceResume:()=>true,
   readGeneratedFile(){local++;throw Error('HOST_FALLBACK')},
   collaboration:{async workspaceTurnContext(thread:string,turn:string){assert.equal(thread,'thread');assert.equal(turn,'turn');return context}},
   async readWorkspaceArtifact(thread:string,path:string,c:unknown,signal:AbortSignal){assert.equal(c,context);remote++;return reader(path,signal)},
  }});
 const item=(id:string)=>({id,type:'mcpToolCall',status:'completed',result:{structuredContent:{artifacts:[{id:'pdf',name:'input.pdf',mimeType:'application/pdf',savedPath:'/workspace/input.pdf'}]}}});
 const artifact=(id:string)=>staging.catalog.get(staging.catalog.id({scope:'codex-generated',key:JSON.stringify(['generation','thread',id,'artifact:pdf'])}));
 adapter.captureArtifactOutput('thread',item('success'),'turn');await Promise.all([...adapter.artifactOutputs]);
 const captured=artifact('success');assert.ok(captured);assert.deepEqual(await readFile(captured.path),f.bytes);assert.equal(local,0);assert.equal(remote,1);assert.equal(failures,0);
 allowed=false;adapter.captureArtifactOutput('thread',item('denied'),'turn');await Promise.all([...adapter.artifactOutputs]);
 assert.equal(artifact('denied'),null);assert.equal(failures,1);assert.equal(local,0);assert.equal(remote,1);
 adapter.captureArtifactOutput('thread',item('missing-turn'));await Promise.all([...adapter.artifactOutputs]);assert.equal(artifact('missing-turn'),null);assert.equal(local,0);
});

test('internal workspace resume retains a durable finalizer with exact context and parameter snapshot',async()=>{
 const context={sender:null};let finalized=0;
 const params={threadId:'thread',excludeTurns:true};
 const adapter=Object.assign(Object.create(CodexEngineAdapter.prototype),{
  statusValue:{state:'open'},child:{},physicalInitialized:true,sequence:0,sessionMcpGeneration:1,
  options:{async finalizeNativeResume(input:{context:unknown;params:unknown;requestId:string;result:unknown}){
   assert.equal(input.context,context);assert.deepEqual(input.params,{threadId:'thread',excludeTurns:true});
   assert.equal(input.requestId,'opencraft:host:1');assert.deepEqual(input.result,{thread:{id:'thread'}});finalized++;
  }},internalRequests:new Map(),environmentCreations:new Map(),checkModelPolicy:async()=>{},
  async writePhysical(message:{id:string}){
   const request=this.internalRequests.get(message.id);assert.equal(typeof request.finalizeWorkspaceReceipt,'function');
   params.excludeTurns=false;await request.finalizeWorkspaceReceipt({result:{thread:{id:'thread'}}});
   clearTimeout(request.timer);this.internalRequests.delete(message.id);request.resolve({ok:true});
  },
 });
 assert.deepEqual(await adapter.requestPhysical('thread/resume',params,1000,undefined,undefined,undefined,context),{ok:true});assert.equal(finalized,1);
});

test('actual queue idle probe restores original queued authority before remote resume',async()=>{
 const context={sender:null};let restored=0,resumed=0,status='notLoaded',remote=true;
 const queued={clientUserMessageId:'original-input',executionSubmission:{ownership:'human',principal:{provider:'tencentoa',subject:'original'}}};
 const adapter=Object.assign(Object.create(CodexEngineAdapter.prototype),{nativeCore:null,
  queue:{firstAwaitingAdmission:()=>queued},threadStatus:async()=>status,
  options:{requiresWorkspaceResume:()=>remote,collaboration:{async restoreWorkspaceSubmission(thread:string,input:string,submission:unknown){
   assert.equal(thread,'thread');assert.equal(input,'original-input');assert.equal(submission,queued.executionSubmission);restored++;return context;
  }}},
  async requestPhysical(method:string,params:unknown,timeout:unknown,signal:unknown,usage:unknown,admit:unknown,c:unknown){
   assert.equal(method,'thread/resume');assert.equal(c,remote?context:undefined);resumed++;status='idle';return {};
  },
 });
 assert.equal(await adapter.queueThreadIsIdle('thread'),true);assert.equal(restored,1);assert.equal(resumed,1);
 status='notLoaded';remote=false;assert.equal(await adapter.queueThreadIsIdle('thread'),true);assert.equal(restored,1);
 status='notLoaded';remote=true;adapter.options.collaboration.restoreWorkspaceSubmission=async()=>{throw Error('revoked')};
 await assert.rejects(adapter.queueThreadIsIdle('thread'),/revoked/);assert.equal(resumed,2);
});
test('recovery resolves the specific previous Turn delegation, never another queued user',async()=>{
 const context={sender:null};let called=0;
 const adapter=Object.assign(Object.create(CodexEngineAdapter.prototype),{
  options:{requiresWorkspaceResume:()=>true,collaboration:{async workspaceTurnContext(thread:string,turn:string){assert.equal(thread,'thread');assert.equal(turn,'previous-turn');called++;return context}}},
  queue:{firstAwaitingAdmission(){assert.fail('must not borrow a queued input')}},
  requestPhysical(){assert.fail('must not infer another Turn')},
 });
 assert.equal(await adapter.workspaceResumeContext('thread',undefined,'previous-turn'),context);assert.equal(called,1);
});

test('actual physical reply gate waits once for an internal workspace receipt before publication',async t=>{
 const f=await fixture(t);
 const adapter=new CodexEngineAdapter({dataDirectory:f.root,coreEndpoint:'/tmp/not-connected-workspace-fixture',coreAuthToken:'x'.repeat(64)} as ConstructorParameters<typeof CodexEngineAdapter>[0]);
 t.after(()=>adapter.close());
 const internal=adapter as unknown as {receivePhysicalLine(line:string):void;internalRequests:Map<string,unknown>};
 const receive=internal.receivePhysicalLine;const delivered:unknown[]=[];
 internal.receivePhysicalLine=line=>delivered.push(JSON.parse(line));
 let release!:()=>void,finalized=0;
 const wait=new Promise<void>(resolve=>{release=resolve});
 const request={method:'thread/resume',async finalizeWorkspaceReceipt(){finalized++;await wait;}};
 internal.internalRequests.set('internal-resume',request);
 const frame=JSON.stringify({id:'internal-resume',result:{thread:{id:'thread'}}});
 receive(frame);receive(frame);await Promise.resolve();
 assert.equal(finalized,1);assert.equal(delivered.length,0);assert.equal(internal.internalRequests.get('internal-resume'),request);
 release();await new Promise(resolve=>setImmediate(resolve));assert.equal(delivered.length,1);
 internal.internalRequests.delete('internal-resume');
});

// Image content is read by the model engine, not by the execution sandbox.
// Only ordinary file mentions receive a private-workspace execution locator.
test('mixed image inputs retain native readers and order while file mentions use workspace delivery',async t=>{
 const f=await fixture(t);const staging=new LocalAttachmentStagingService(join(f.root,'mixed-stage'));t.after(()=>staging.close());
 const {ref}=await staging.stage({clientAttachmentId:'mixed',name:'notes.txt',mimeType:'text/plain',size:3,source:{kind:'client-bytes',dataBase64:'YWJj'}});
 assert.equal(ref.location.kind,'host-file');if(ref.location.kind!=='host-file')throw Error('fixture');
 const context={sender:null};let deliveries=0;
 const adapter=Object.assign(Object.create(CodexEngineAdapter.prototype),{artifactReaders:new Map(),artifactLifetime:new AbortController(),attachmentStaging:staging,
 options:{async prepareWorkspaceArtifact(artifact:Artifact,thread:string,c:unknown){assert.equal(c,context);deliveries++;return {...artifact,path:'/workspace/notes.txt'};},
 async prepareArtifact(){assert.fail('HOST_FALLBACK')}}});
 const images=[{type:'localImage',path:'/engine/staged/photo.png',detail:'original'},
  {type:'image',url:'data:image/png;base64,aW1hZ2U=',detail:'high'},
  {type:'image',fileId:'file-model-owned',detail:'low'}];
 const mention={type:'mention',name:ref.name,path:ref.location.path};
 const input=[images[0],mention,images[1],images[2]];
 const result=await adapter.modelVisibleAttachmentInput(input,'thread','client',context);
 assert.equal(result.input[0],images[0]);assert.match(result.input[1].text,/\/workspace\/notes.txt/);
 assert.equal(result.input[2],mention);assert.equal(result.input[3],images[1]);assert.equal(result.input[4],images[2]);
 assert.equal(deliveries,1);assert.equal(result.attachments.length,1);assert.equal(adapter.artifactReaders.size,0);
 assert.deepEqual(input,[images[0],mention,images[1],images[2]]);
 // Image-only input must not require an execution transfer or create a sandbox.
 adapter.options.prepareWorkspaceArtifact=async()=>{assert.fail('IMAGE_EXECUTION_TRANSFER')};
 const imageOnly=await adapter.modelVisibleAttachmentInput(images,'thread','client',context);
 assert.deepEqual(imageOnly.input,images);assert.deepEqual(imageOnly.attachments,[]);assert.equal(deliveries,1);
});

test('generated PNG uses workspace reader and survives catalog capture byte-for-byte',async t=>{
 const f=await fixture(t);const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
 await writeFile(join(f.root,'result.png'),png);
 const staging=new LocalAttachmentStagingService(join(f.root,'image-output'));t.after(()=>staging.close());
 const context={sender:null};let reads=0;
 const reader=workspaceArtifactReader({sandbox:f.sandbox,authorize:async()=>{},onCleanupUnconfirmed(){assert.fail('cleanup')}});
 const adapter=Object.assign(Object.create(CodexEngineAdapter.prototype),{attachmentStaging:staging,artifactLifetime:new AbortController(),artifactOutputs:new Set(),
 diagnostic(){assert.fail('IMAGE_CAPTURE_FAILED')},options:{requiresWorkspaceResume:()=>true,
 readGeneratedFile(){assert.fail('HOST_IMAGE_FALLBACK')},
 collaboration:{async workspaceTurnContext(thread:string,turn:string){assert.equal(thread,'thread');assert.equal(turn,'turn');return context}},
 async readWorkspaceArtifact(thread:string,path:string,c:unknown,signal:AbortSignal){assert.equal(c,context);assert.equal(path,'/workspace/result.png');reads++;return reader(path,signal)}}});
 adapter.captureArtifactOutput('thread',{id:'image-output',type:'mcpToolCall',status:'completed',result:{structuredContent:{artifacts:[{id:'png',name:'result.png',mimeType:'image/png',savedPath:'/workspace/result.png'}]}}},'turn');
 await Promise.all([...adapter.artifactOutputs]);
 const saved=staging.catalog.get(staging.catalog.id({scope:'codex-generated',key:JSON.stringify(['generation','thread','image-output','artifact:png'])}));
 assert.ok(saved);assert.equal(saved.mimeType,'image/png');assert.deepEqual(await readFile(saved.path),png);assert.equal(reads,1);
});
