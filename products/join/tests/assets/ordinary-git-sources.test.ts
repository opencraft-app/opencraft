import { EmployeeGitVaultStore } from '../../../../scripts/employee-git-vault-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PublishedOrdinaryGitSources, InstalledOrdinaryWorkspaceSources, describeOrdinaryGitPublication } from '../../assets/ordinary-git-sources';
import type { InstalledOrdinaryEnvironmentCatalog } from '../../assets/ordinary-environment-catalog';
import type { OrdinaryRuntimeAdmission } from '../../assets/ordinary-conversation-runtime';
function fixture(){
 const values=new Map<string,{revision:number;document:unknown}>();
 const vault={readDocument(scope:string,ns:string){return structuredClone(values.get(scope+'/'+ns)??{revision:0,document:null});},
  writeDocument(scope:string,ns:string,revision:number,document:unknown){assert.equal(values.get(scope+'/'+ns)?.revision??0,revision);values.set(scope+'/'+ns,{revision:revision+1,document:structuredClone(document)});}};
 const registry=new PublishedOrdinaryGitSources(vault);
 const publication={repositoryId:'repo',remote:'https://github.com/example/repo.git',libraryId:'shared',generation:'g1',commit:'a'.repeat(40),ref:'main'};
 const logical={version:1,kind:'git',repositoryId:'repo',ref:'main',relativePath:'src'};
 return {registry,vault,publication,logical};
}
test('published source is scoped to its owner, with stable hashed authorization domain',()=>{
 const f=fixture();f.registry.publish('alice',0,f.publication);
 const a=f.registry.resolve('alice',f.logical);assert.equal(a.commit,'a'.repeat(40));assert.equal(a.generation,'g1');
 assert.throws(()=>f.registry.resolve('bob',f.logical),/unavailable/);
 f.registry.publish('bob',0,f.publication);const b=f.registry.resolve('bob',f.logical);
 assert.notEqual(a.authorizationDomain,b.authorizationDomain);assert.throws(()=>f.registry.pinned('bob',a),/unavailable/);
});
test('moving a ref never changes a persisted baseline or reclaims its generation',()=>{
 const f=fixture();f.registry.publish('alice',0,f.publication);const old=f.registry.resolve('alice',f.logical);
 f.registry.publish('alice',1,{...f.publication,generation:'g2',commit:'b'.repeat(40)});
 assert.equal(f.registry.resolve('alice',f.logical).commit,'b'.repeat(40));
 assert.deepEqual(f.registry.pinned('alice',old),{remote:f.publication.remote});
});
test('immutable generation, repository remote and library identities cannot be rebound',()=>{
 for(const change of [{commit:'b'.repeat(40)},{remote:'https://github.com/example/other.git'},{libraryId:'other'}]){
  const f=fixture();f.registry.publish('alice',0,f.publication);
  assert.throws(()=>f.registry.publish('alice',1,{...f.publication,...change}),/unavailable/);
  assert.equal(f.registry.resolve('alice',f.logical).commit,f.publication.commit);
 }
});
test('publication CAS and explicit disabling fence both latest and pinned access',()=>{
 const f=fixture();f.registry.publish('alice',0,f.publication);const pinned=f.registry.resolve('alice',f.logical);
 assert.throws(()=>f.registry.publish('alice',0,{...f.publication,generation:'g2'}),/conflict/);
 f.registry.disable('alice',1,'repo');
 assert.throws(()=>f.registry.resolve('alice',f.logical),/unavailable/);
 assert.throws(()=>f.registry.pinned('alice',pinned),/unavailable/);
 assert.throws(()=>f.registry.publish('alice',2,f.publication),/unavailable/);
});
test('credential-bearing remote URLs and arbitrary caller remote/path changes are rejected',()=>{
 for(const remote of ['https://token@github.com/a/b.git','https://github.com/a/b.git?token=x','file:///tmp/repo']){
  const f=fixture();assert.throws(()=>f.registry.publish('alice',0,{...f.publication,remote}),/unavailable/);
 }
 const f=fixture();f.registry.publish('alice',0,f.publication);
 for(const logical of [{...f.logical,remote:f.publication.remote},{...f.logical,relativePath:'../escape'},{...f.logical,libraryId:'foreign'}])
  assert.throws(()=>f.registry.resolve('alice',logical),/unavailable/);
});
test('concrete source resolver uses published pin and verifies selected environment/library admission',async()=>{
 const f=fixture();f.registry.publish('alice',0,f.publication);
 let allowed=true,libraryChecks=0;
 const catalog={
  resolveLibrary(_context:unknown,_environment:unknown,input:any){if(!allowed||input.libraryId!=='shared')throw Error('library unavailable');libraryChecks++;return {kind:'library-reference',libraryId:'shared',relativePath:input.relativePath,authorizationDomain:'lib-domain',generation:'lib-gen'};},
  libraryBinding(){if(!allowed)throw Error('library unavailable');},
  runtime(){return {authorize:async()=>{if(!allowed)throw Error('environment unavailable');}};},
 } as unknown as InstalledOrdinaryEnvironmentCatalog;
 const owner=new InstalledOrdinaryWorkspaceSources(catalog,f.registry);
 const admission:OrdinaryRuntimeAdmission={authority:{principalId:'actor',hostId:'host'},catalog:{scope:'alice',current:()=>allowed},authorize:async()=>{if(!allowed)throw Error('revoked');}};
 const environment={configurationId:'e',configurationRevision:'a'.repeat(64),templateId:'base',cpuMillis:1,memoryBytes:1};
 const source=await owner.resolve(admission,environment,f.logical);
 assert.equal(source.kind,'git');assert.ok(libraryChecks>0);
 await owner.authorize(admission,{version:1,environment,source});
 f.registry.publish('alice',1,{...f.publication,generation:'g2',commit:'b'.repeat(40)});
 await owner.authorize(admission,{version:1,environment,source});
 assert.deepEqual(await owner.resolve(admission,environment,undefined),{kind:'empty'});
 allowed=false;await assert.rejects(owner.authorize(admission,{version:1,environment,source}),/revoked/);
});


test('publication manifest identity is available before upload without granting source access',()=>{
 const f=fixture(),descriptor=describeOrdinaryGitPublication('alice',f.publication);
 assert.throws(()=>f.registry.resolve('alice',f.logical),/unavailable/);
 f.registry.publish('alice',0,f.publication);
 assert.deepEqual(f.registry.resolve('alice',{...f.logical,relativePath:''}),descriptor.source);
});
test('pinned baseline survives actual encrypted vault close and reopen',()=>{
 const root=mkdtempSync(join(tmpdir(),'ordinary-git-bases-'));
 let vault:EmployeeGitVaultStore|undefined;
 try{
  const f=fixture();vault=new EmployeeGitVaultStore(root);
  const first=new PublishedOrdinaryGitSources(vault);first.publish('alice',0,f.publication);
  const pinned=first.resolve('alice',f.logical);vault.close();vault=undefined;
  vault=new EmployeeGitVaultStore(root);const restored=new PublishedOrdinaryGitSources(vault);
  assert.deepEqual(restored.resolve('alice',f.logical),pinned);
  restored.publish('alice',1,{...f.publication,generation:'g2',commit:'b'.repeat(40)});
  assert.deepEqual(restored.pinned('alice',pinned),{remote:f.publication.remote});
 }finally{vault?.close();rmSync(root,{recursive:true,force:true});}
});
