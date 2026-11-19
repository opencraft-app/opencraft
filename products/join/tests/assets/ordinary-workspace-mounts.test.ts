import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ordinaryMountProbe, validateOrdinaryMountReceipt, verifyOrdinaryWorkspaceMounts } from '../../assets/ordinary-workspace-mounts';
const privateId='11111111-1111-1111-1111-111111111111',sharedId='22222222-2222-2222-2222-222222222222';
const expected={privateName:'private-volume',sharedName:'shared-volume',relativePath:'folder'};
const receipt=()=>({mounts:[{mount:'/workspace',root:'/',fs:'nfs',source:'192.0.2.1:/private-volume'},
 {mount:'/shared',root:'/',fs:'nfs4',source:'192.0.2.1:/shared-volume'}],
 workspace:'/workspace',library:'/shared/folder',directory:true});
test('exact private/shared NFS exports and selected directory are verified',()=>{
 assert.deepEqual(validateOrdinaryMountReceipt(receipt(),expected),{cwd:'/workspace',libraryPath:'/shared/folder'});
});
test('wrong export, local filesystem, bind subtree and nested mount are rejected',()=>{
 for(const alter of [
  (v:ReturnType<typeof receipt>)=>{v.mounts[0]!.source='host:/foreign';},
  (v:ReturnType<typeof receipt>)=>{v.mounts[1]!.source='host:/foreign';},
  (v:ReturnType<typeof receipt>)=>{v.mounts[1]!.fs='ext4';},
  (v:ReturnType<typeof receipt>)=>{v.mounts[1]!.root='/subdir';},
  (v:ReturnType<typeof receipt>)=>{v.mounts.push({...v.mounts[1]!,mount:'/shared/folder'});},
  (v:ReturnType<typeof receipt>)=>{v.mounts.push({...v.mounts[1]!});},
  (v:ReturnType<typeof receipt>)=>{v.library='/etc';},
  (v:ReturnType<typeof receipt>)=>{v.directory=false;},
 ]){
  const v=receipt();alter(v);assert.throws(()=>validateOrdinaryMountReceipt(v,expected),/unavailable/);
 }
});
test('actual Python probe parses mountinfo without exposing unrelated mounts',()=>{
 const mountinfo='1 0 0:1 / /workspace rw - nfs 192.0.2.1:/private-volume rw\n2 0 0:2 / /shared rw - nfs4 192.0.2.1:/shared-volume rw\n3 0 0:3 / /unrelated rw - ext4 /dev/x rw\n';
 const prefix='import builtins,io,os\noriginal=builtins.open\nbuiltins.open=lambda p,*a,**k:io.StringIO('+JSON.stringify(mountinfo)+') if p=="/proc/self/mountinfo" else original(p,*a,**k)\nos.path.realpath=lambda p:p\nos.path.isdir=lambda p:True\n';
 const run=spawnSync('/usr/bin/python3',['-c',prefix+ordinaryMountProbe,'/shared/folder'],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);assert.deepEqual(validateOrdinaryMountReceipt(JSON.parse(run.stdout),expected),{cwd:'/workspace',libraryPath:'/shared/folder'});
});
function fixture(){
 let spawned=0,terminated=0,allowed=true;
 const metadata:any={schemaVersion:2,workspaceID:'ws-test',privateVolumeID:privateId,privateVolumeName:'private-volume',sharedVolumeID:sharedId,members:[{sandboxID:'sandbox'}]};
 const volume:any={volumeID:sharedId,name:'shared-volume',token:'synthetic-volume-secret'};
 const requests:string[]=[];
 const input:Parameters<typeof verifyOrdinaryWorkspaceMounts>[0]={
  sandbox:{async spawn(_options,output){spawned++;output?.({stream:'stdout',data:Buffer.from(JSON.stringify(receipt()))});
   return {kind:'process',async closeStdin(){},exited:Promise.resolve({code:0}),async terminate(){terminated++;}} as any;}},
  workspaceId:'ws-test',instanceId:'sandbox',privateVolumeId:privateId,library:{volumeId:sharedId,relativePath:'folder'},
  apiUrl:'https://api.example.test',readApiKey:async()=>{assert.ok(allowed);return 'synthetic-api-key';},
  async authorize(){if(!allowed)throw Error('revoked');},onCleanupUnconfirmed(){throw Error('unexpected cleanup uncertainty');},
  request:(async(url:any)=>{requests.push(String(url));return Response.json(String(url).includes('/workspaces/')?metadata:volume);}) as typeof fetch,
 };
 return {input,metadata,volume,requests,get spawned(){return spawned;},get terminated(){return terminated;},revoke(){allowed=false;}};
}
test('provider volume identity and actual sandbox mount proof are both required',async()=>{
 const f=fixture();const result=await verifyOrdinaryWorkspaceMounts(f.input);
 assert.deepEqual(result,{cwd:'/workspace',libraryPath:'/shared/folder'});assert.equal(f.spawned,1);
 assert.deepEqual(f.requests,['https://api.example.test/workspaces/ws-test','https://api.example.test/volumes/'+sharedId]);
 assert.ok(!JSON.stringify(result).includes('synthetic-volume-secret'));
});
test('foreign member, private/shared volume mismatch reject before sandbox work',async()=>{
 for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.metadata.members[0].sandboxID='foreign';},
  (f:ReturnType<typeof fixture>)=>{f.metadata.privateVolumeID=sharedId;},
  (f:ReturnType<typeof fixture>)=>{f.metadata.sharedVolumeID=privateId;},
  (f:ReturnType<typeof fixture>)=>{f.volume.volumeID=privateId;} ]){
  const f=fixture();mutate(f);await assert.rejects(verifyOrdinaryWorkspaceMounts(f.input),/unavailable/);assert.equal(f.spawned,0);
 }
});
test('revocation during volume lookup prevents probe',async()=>{
 const f=fixture(),request=f.input.request!;f.input.request=async(...args)=>{const result=await request(...args);f.revoke();return result;};
 await assert.rejects(verifyOrdinaryWorkspaceMounts(f.input),/revoked/);assert.equal(f.spawned,0);
});
test('unsafe relative path and endpoint credentials fail before API requests',async()=>{
 for(const alter of [(f:ReturnType<typeof fixture>)=>{f.input.library!.relativePath='../escape';},
  (f:ReturnType<typeof fixture>)=>{f.input.apiUrl='https://user:password@api.example.test';}]){
  const f=fixture();alter(f);await assert.rejects(verifyOrdinaryWorkspaceMounts(f.input),/unavailable/);assert.equal(f.requests.length,0);
 }
});
