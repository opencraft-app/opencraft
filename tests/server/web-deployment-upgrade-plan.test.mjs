import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, readdir, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { inspectStore, collectInventory, fingerprint } from '../../scripts/full-upgrade/inventory.mjs';
import { createPlan, checkPlanExpectations } from '../../scripts/full-upgrade/plan.mjs';
import { signBytes, sha256, fileListDigest, HARD_LIMITS, LEGACY_LIMITS } from '../../scripts/full-release/contract.mjs';
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const keyId='test-key', now=Date.now(), source='a'.repeat(40);
const trust={product:'test',channel:'test',registry:'https://registry.example/',packageName:'@example/app',keys:{[keyId]:publicKey.export({type:'spki',format:'pem'})}};
function fixture() {
  const files = [['LICENSE',sha256('license'),7,'0644']];
  return { schemaVersion:1, kind:'opencraft.full-release', release:{releaseId:'test-release',releaseSequence:1,createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),product:'test',channel:'test',source:{revision:source,upstreamRevision:source,patchSetSha256:'a'.repeat(64)}},
    transport:{kind:'npm',registry:trust.registry,packageName:trust.packageName,exactVersion:'1.0.0'},
    targets:[{profile:'headless',platform:process.platform,arch:process.arch,nodeAbi:Number(process.versions.modules)}],
    updater:{minBootstrap:1,minAgent:1,helperProtocol:1,bridge:true,legacy:{...LEGACY_LIMITS}},
    revocations:{sequence:1,keyIds:[],releaseIds:[]},
    components:[{componentId:'runtime',role:'web-bootstrap',version:'1.0.0',buildId:'fixture',sourceRevision:source,required:true,enabledPolicy:'preserve',content:{kind:'tree',root:'.',fileListSha256:fileListDigest(files),unpackedBytes:7,entries:1},fileList:files,provides:[],requires:[],activation:{strategy:'helper',unitRole:'bootstrap',authority:'unsupported',retainedHistory:true},licenses:['LICENSE']}],
    stores:[],rollback:{policy:'compatible-retained-only',automaticSnapshotRestore:false,proof:'fixture'},
    budgets:{npmJsonBytes:HARD_LIMITS.npmJsonBytes,metadataBytes:HARD_LIMITS.metadataBytes,manifestBytes:HARD_LIMITS.manifestBytes,outer:{...LEGACY_LIMITS},recursive:{unpackedBytes:LEGACY_LIMITS.unpackedBytes,entries:LEGACY_LIMITS.entries,depth:1,diskBytes:8*1024**3,memoryBytes:HARD_LIMITS.memoryBytes}},proofs:[{name:'test',status:'verified',evidence:'fixture'}] };
}

function inventory(overrides={}) {
 const identity={product:'test',channel:'test',profile:'headless',bootId:'boot-1',adapterProfileSha256:'a'.repeat(64),platform:process.platform,arch:process.arch,
 owners:[],deployments:[],stores:[],storeDiscovery:{roots:[],maxDepth:5,maxStores:256,completeness:'unknown'},unmanagedUnits:[],unsupportedComponents:[],...overrides};
 return {schemaVersion:1,kind:'opencraft.upgrade-inventory',mode:'read-only',...identity,fingerprint:fingerprint(identity),resources:{probeNode:{abi:Number(process.versions.modules)},storage:[{path:'/state',availableBytes:32*1024**3}],availableMemoryBytes:2*1024**3},guarantees:{}};
}
function plan(i=inventory(),record=fixture(),keys=trust) {
 const manifestBytes=Buffer.from(JSON.stringify(record));
 return createPlan({inventory:i,manifestBytes,signature:signBytes(manifestBytes,privateKey,keyId),trust:keys,now});
}
test('signed payload stays advisory and unknown compatibility blocks every component',()=>{
 const p=plan(); assert.equal(p.executable,false);assert.equal(p.status,'blocked');assert.deepEqual(p.executionOrder,[]);
 assert.equal(p.components.length,1);assert.equal(p.components[0].proposedAction,'helper');
 assert.ok(p.components[0].blockedReasons.includes('target-activation-unsupported'));
 assert.ok(p.compatibilityMatrix.every(c=>c.status==='unknown'));
 assert.equal(p.automaticSnapshotRestore,false);
});
test('target digest and plan identity stay fixed and process/boot/schema drift invalidates CAS',()=>{
 const i=inventory(),m=Buffer.from(JSON.stringify(fixture())),p=plan(i);
 assert.equal(plan(i).planDigest,p.planDigest);assert.equal(checkPlanExpectations(p,i,m),true);
 assert.equal(checkPlanExpectations(p,inventory({bootId:'boot-2'}),m),false);
 assert.equal(checkPlanExpectations(p,inventory({stores:[{schemaSha256:'b'}]}),m),false);
 assert.equal(checkPlanExpectations(p,i,Buffer.from('changed')),false);
 const bad=structuredClone(i);bad.bootId='mutated-with-old-fingerprint';assert.throws(()=>plan(bad),/fingerprint/);assert.equal(checkPlanExpectations(p,bad,m),false);
});
test('signature, revocation, replay and same-sequence collision reject before producing a plan',()=>{
 const r=fixture(),bytes=Buffer.from(JSON.stringify(r)),sig=signBytes(bytes,privateKey,keyId);sig.signature='A'.repeat(86)+'==';
 assert.throws(()=>createPlan({inventory:inventory(),manifestBytes:bytes,signature:sig,trust,now}));
 assert.throws(()=>plan(inventory(),r,{...trust,revokedKeyIds:[keyId]}));
 assert.throws(()=>plan(inventory({deployments:[{replay:{highestSequence:2,manifestSha256:'b'.repeat(64)}}]})));
 assert.throws(()=>plan(inventory({deployments:[{replay:{highestSequence:1,manifestSha256:'b'.repeat(64)}}]})));
});
test('expired, wrong product/channel, incompatible platform and unknown inventory version reject',()=>{
 for(const change of [r=>r.release.expiresAt=new Date(now-1).toISOString(),r=>r.release.channel='other',r=>r.targets[0].nodeAbi=1]) {
  const r=fixture();change(r);assert.throws(()=>plan(inventory(),r));
 }
 const i=inventory();i.schemaVersion=2;assert.throws(()=>plan(i));
});
test('wrong profiles are blocked while budget ceilings do not invent resource demand',()=>{
 const i=inventory({profile:'daemon'});i.resources.storage[0].availableBytes=1;i.resources.availableMemoryBytes=1;
 const p=plan(i);assert.equal(p.checks.find(c=>c.id==='product-channel-profile').status,'blocked');
 for(const id of ['disk-peak','memory-peak']) {
  const c=p.checks.find(c=>c.id===id);assert.equal(c.status,'unknown');assert.equal(c.details.requiredAdditionalBytes,null);assert.ok(c.details.budgetCeilingBytes>1);
 }
 assert.equal(p.checks.find(c=>c.id==='disk-peak').details.targetPayloadBytes,7);
});
test('final dependency mismatch is separate from unknown mixed and reverse combinations',()=>{
 const r=fixture();r.components[0].requires=[{componentId:'runtime',name:'protocol',version:'2'}];
 const p=plan(inventory(),r);assert.equal(p.compatibilityMatrix[0].status,'blocked');
 assert.ok(p.compatibilityMatrix.some(c=>c.combination==='rollback'&&c.status==='unknown'));
});
test('missing read-only stores are unknown and never created',async t=>{
 const root=await mkdtemp(join(tmpdir(),'upgrade-ro-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const row=await inspectStore(join(root,'absent.sqlite'));assert.equal(row.status,'unknown');assert.deepEqual(await readdir(root),[]);
});
test('SQLite inspection reports real schema/ledger without rewriting user rows',async t=>{
 const root=await mkdtemp(join(tmpdir(),'upgrade-ro-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'store.sqlite'),db=new DatabaseSync(path);
 db.exec("CREATE TABLE schema_migrations(version INTEGER,name TEXT,checksum TEXT); INSERT INTO schema_migrations VALUES(3,'existing','digest'); CREATE TABLE data(value TEXT); INSERT INTO data VALUES('private-payload'); PRAGMA user_version=3;");db.close();
 const before=await readFile(path),row=await inspectStore(path);
 assert.equal(row.status,'observed');assert.equal(row.userVersion,3);assert.equal(row.migrationLedger.rows[0].version,3);
 assert.equal(JSON.stringify(row).includes('private-payload'),false);assert.deepEqual(await readFile(path),before);
});
test('real process sampling redacts credentials/config values and records unit incarnation',async t=>{
 const root=await mkdtemp(join(tmpdir(),'upgrade-process-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const entry=join(root,'owner.mjs'),config=join(root,'config.json');
 await writeFile(entry,'setInterval(()=>{},1000);');await writeFile(config,JSON.stringify({apiKey:'DO-NOT-LEAK-CONFIG',dataDirectory:root,dshCapabilityPlugin:join(root,'plugin.mjs')}));
 await writeFile(join(root,'deployment.json'),JSON.stringify({current:{version:'1.0.0',fullRelease:{releaseSequence:2,secret:'DO-NOT-LEAK-STATE'}}}));
 await writeFile(join(root,'full-release-state.json'),JSON.stringify({highestSequence:'bad',secret:'DO-NOT-LEAK-REPLAY'}));
 const child=spawn(process.execPath,[entry,'--secret','DO-NOT-LEAK-ARGV'],{env:{...process.env,API_TOKEN:'DO-NOT-LEAK-ENV',OPENCRAFT_WEB_STATE:root,OPENCRAFT_DSH_HOST_CONFIG:config},stdio:'ignore'});
 t.after(()=>child.kill());await new Promise(r=>setTimeout(r,100));
 const shim=join(root,'systemctl');
 await writeFile(shim, `#!${process.execPath}
console.log(process.argv[2] === 'list-units' ? '[{"unit":"fixture.service"}]' : ${JSON.stringify('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID='+child.pid+'\nFragmentPath=\nDropInPaths=\nControlGroup=\nUser=')});
`);await chmod(shim,0o755);
 const old=process.env.PATH;process.env.PATH=root+':'+old;t.after(()=>{process.env.PATH=old;});
 const result=await collectInventory({schemaVersion:1,product:'test',channel:'test',profile:'headless',owners:[{ownerId:'owner',role:'test',units:['fixture.service']}]});
 const p=result.owners[0].units[0].processes[0];assert.equal(p.pid,child.pid);assert.equal(p.entry,entry);assert.ok(p.startTicks);assert.equal(p.configs[0].paths.dataDirectory,root);
 const serialized=JSON.stringify(result);for(const secret of ['DO-NOT-LEAK-CONFIG','DO-NOT-LEAK-ARGV','DO-NOT-LEAK-ENV','DO-NOT-LEAK-STATE','DO-NOT-LEAK-REPLAY'])assert.equal(serialized.includes(secret),false);
 assert.equal(result.guarantees.executesUpgrade,false);assert.equal(result.deployments[0].replayObservation.status,'unknown');assert.equal(result.deployments[0].replay,null);
});
test('installed target pointer never claims old independent owners are already updated',()=>{
 const manifest=fixture(),manifestSha256=sha256(Buffer.from(JSON.stringify(manifest)));
 const p=plan(inventory({deployments:[{stateDirectory:'/state',current:{fullRelease:{manifestSha256}},replay:null}]}),manifest);
 assert.equal(p.components[0].comparison.installed,'target-pointer-present');
 assert.equal(p.components[0].comparison.running,'unknown');assert.equal(p.components[0].status,'blocked');
});
test('durable generations preserve active/retained states and report bindings rather than claiming idle',async t=>{
 const root=await mkdtemp(join(tmpdir(),'upgrade-generations-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'registry.sqlite'),db=new DatabaseSync(path);
 db.exec("CREATE TABLE generations(id TEXT,state TEXT,incarnation INTEGER,definition TEXT); CREATE TABLE admission(generation_id TEXT,epoch INTEGER); CREATE TABLE thread_routes(generation_id TEXT); CREATE TABLE creation_claims(generation_id TEXT,state TEXT);");
 for(const [id,state] of [['old','draining'],['new','active']])db.prepare('INSERT INTO generations VALUES(?,?,?,?)').run(id,state,2,JSON.stringify({bundle:'/fixed/'+id+'/app.cjs'}));
 db.exec("INSERT INTO admission VALUES('new',4);INSERT INTO thread_routes VALUES('old');INSERT INTO creation_claims VALUES('new','pending');");db.close();
 const before=await readFile(path),row=await inspectStore(path);
 assert.equal(row.generations.admission[0].epoch,4);assert.equal(row.generations.entries.find(g=>g.id==='old').threadBindings,1);
 assert.equal(row.generations.entries.find(g=>g.id==='old').state,'draining');assert.equal(row.generations.occupancy.status,'unknown');
 assert.deepEqual(await readFile(path),before);
});
test('missing or unreadable current replay state never verifies release authentication',()=>{
 for(const reason of ['replay-state-missing','replay-state-unreadable-or-invalid']) {
  const p=plan(inventory({deployments:[{current:{fullRelease:{releaseSequence:2}},replay:null,replayObservation:{status:'unknown',reason}}]}));
  assert.equal(p.checks.find(c=>c.id==='release-signature-policy').status,'verified');
  assert.equal(p.checks.find(c=>c.id==='release-authentication').status,'unknown');assert.ok(p.blockedReasons.includes('release-authentication'));
 }
});
test('unknown unit observations are not stable; explicit absent units and complete snapshots are distinct',()=>{
 const owner=units=>({ownerId:'owner',role:'core',units});
 const checkStatus=units=>plan(inventory({owners:[owner(units)]})).checks.find(c=>c.id==='inventory-stability').status;
 assert.equal(checkStatus([{unit:'test.service',status:'unknown',reason:'unit-unreadable',processes:[]}]),'unknown');
 assert.equal(checkStatus([{unit:'test.service',status:'observed',stable:false,processes:[]}]),'blocked');
 assert.equal(checkStatus([{unit:'test.service',status:'not-installed',processes:[]}]),'verified');
 assert.equal(checkStatus([{unit:'test.service',status:'observed',stable:true,processes:[]}]),'verified');
});
test('conflicting observed highest-sequence digests cannot certify one selected watermark',()=>{
 const r=fixture(),matching=sha256(Buffer.from(JSON.stringify(r)));
 assert.throws(()=>plan(inventory({deployments:[matching,'b'.repeat(64)].map(manifestSha256=>({replayObservation:{status:'observed'},replay:{highestSequence:1,manifestSha256}}))}),r),/Conflicting/);
});
test('distribution metadata does not acquire an invented backup or CI runtime owner',()=>{
 const r=fixture();r.components[0].role='distribution';
 const p=plan(inventory({owners:[{ownerId:'backup',role:'distribution',units:[]}]}),r);
 assert.deepEqual(p.components[0].ownerIds,[]);assert.ok(p.components[0].blockedReasons.includes('distribution-root-has-no-independent-runtime-owner'));
 assert.equal(p.owners[0].ownerId,'backup');
});

test('inventory never executes an observed owner binary to discover its Node version',async t=>{
 const root=await mkdtemp(join(tmpdir(),'upgrade-untrusted-node-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const marker=join(root,'owner-was-executed'),sourceFile=join(root,'fake.c'),fakeNode=join(root,'node');
 await writeFile(sourceFile, '#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc,char **argv){if(argc>1&&!strcmp(argv[1],"-p")){FILE *f=fopen('+JSON.stringify(marker)+',"w");if(f)fclose(f);puts("{\\\"version\\\":\\\"v999\\\",\\\"abi\\\":999}");return 0;}for(;;)sleep(1);}\n');
 execFileSync('cc',[sourceFile,'-o',fakeNode]);
 const child=spawn(fakeNode,[],{stdio:'ignore'});t.after(()=>child.kill());await new Promise(r=>setTimeout(r,100));
 const shim=join(root,'systemctl');
 await writeFile(shim, `#!${process.execPath}
console.log(process.argv[2] === 'list-units' ? '[{"unit":"fixture.service"}]' : ${JSON.stringify('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID='+child.pid+'\nFragmentPath=\nDropInPaths=\nControlGroup=\nUser=')});
`);await chmod(shim,0o755);
 const old=process.env.PATH;process.env.PATH=root+':'+old;t.after(()=>{process.env.PATH=old;});
 const result=await collectInventory({schemaVersion:1,product:'test',channel:'test',profile:'headless',owners:[{ownerId:'owner',role:'test',units:['fixture.service']}]});
 assert.equal((await readdir(root)).includes('owner-was-executed'),false);
 assert.equal(result.owners[0].units[0].processes[0].node,null);
});
