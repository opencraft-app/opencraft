import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,writeFileSync,readFileSync,chmodSync,mkdirSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{spawnSync,spawn}from'node:child_process';
const image=x=>'sha256:'+x.repeat(64),runner=resolve('scripts/fast-release/publish.sh');
function fixture(t){const root=mkdtempSync(join(tmpdir(),'fast-publish-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(root+'/state');mkdirSync(root+'/bin');
const source=resolve('.'),revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
const state={images:{old:image('a'),candidate:image('b'),'hands-image':image('c')},containers:{gateway:{Id:'gateway',Image:image('a'),Config:{Labels:{'com.docker.compose.service':'gateway'}},State:{Running:true,StartedAt:'first',Health:{Status:'healthy'}}},hands:{Id:'hands',Image:image('c'),Config:{Labels:{'com.docker.compose.service':'hands'}},State:{Running:true,StartedAt:'untouched',Health:{Status:'healthy'}}}}};
writeFileSync(root+'/docker-state',JSON.stringify(state));writeFileSync(root+'/compose.yaml','{}');writeFileSync(root+'/override.yaml',JSON.stringify({services:{gateway:{image:'old'},hands:{image:'hands-image'}}}));writeFileSync(root+'/candidate.yaml',JSON.stringify({services:{gateway:{image:'candidate'},hands:{image:'hands-image'}}}));
const plan={schemaVersion:1,releaseId:'test',projectDirectory:root,composeFiles:[root+'/compose.yaml',root+'/override.yaml'],overrideFile:root+'/override.yaml',candidateOverride:root+'/candidate.yaml',stateDirectory:root+'/state',sourceRepository:source,sourceRevision:revision,service:'gateway',candidateImageId:image('b'),expectedImages:{gateway:image('a'),hands:image('c')},verify:[[process.execPath,'-e','console.log("behavior verified")']]};
writeFileSync(root+'/plan.json',JSON.stringify(plan));
writeFileSync(root+'/bin/docker',`#!${process.execPath}
const f=require('fs'),root=${JSON.stringify(root)},p=root+'/docker-state',s=JSON.parse(f.readFileSync(p)),a=process.argv.slice(2);function out(v){process.stdout.write(typeof v==='string'?v:JSON.stringify(v))}if(a[0]==='inspect'){let v=s.containers[a[1]];if(!v)v={Id:s.images[a[1]]??a[1]};out([v]);}else{const fs=a.flatMap((v,i)=>v==='-f'?[a[i+1]]:[]),cfg=JSON.parse(f.readFileSync(fs.at(-1)));if(a.includes('config'))out(cfg);else if(a.includes('ps'))out(a.at(-1)==='gateway'?'gateway':'gateway\\nhands');else if(a.includes('stop')){s.containers.gateway.State.Running=false;(s.events??=[]).push('stop');f.writeFileSync(p,JSON.stringify(s));}else if(a.includes('up')){s.containers.gateway.Image=s.images[cfg.services.gateway.image];s.containers.gateway.State.Running=true;s.containers.gateway.State.StartedAt='changed';(s.events??=[]).push('up');f.writeFileSync(p,JSON.stringify(s));}else process.exit(2);}`);chmodSync(root+'/bin/docker',0o755);
return{root,plan,state,run(){writeFileSync(root+'/plan.json',JSON.stringify(plan));return spawnSync('bash',[runner,root+'/plan.json',root+'/deploy.lock'],{encoding:'utf8',env:{...process.env,PATH:root+'/bin:'+process.env.PATH,OPENCRAFT_NODE:process.execPath}})},receipt(){return JSON.parse(readFileSync(root+'/state/test/receipt.json'))},live(){return JSON.parse(readFileSync(root+'/docker-state'))}};}
test('publishes a single image and retains other service identity',t=>{const f=fixture(t),r=f.run();assert.equal(r.status,0,JSON.stringify(f.receipt()));assert.equal(f.receipt().phase,'succeeded');assert.equal(f.live().containers.gateway.Image,image('b'));assert.deepEqual(f.live().containers.hands,f.state.containers.hands);});
test('rejects a stale live baseline before changing configuration',t=>{const f=fixture(t),previous=readFileSync(f.root+'/override.yaml','utf8');f.plan.expectedImages.gateway=image('d');const r=f.run();assert.equal(r.status,1);assert.equal(f.receipt().phase,'rejected');assert.equal(readFileSync(f.root+'/override.yaml','utf8'),previous);assert.equal(f.live().containers.gateway.Image,image('a'));});
test('rejects unrelated configuration changes',t=>{const f=fixture(t);writeFileSync(f.root+'/candidate.yaml',JSON.stringify({services:{gateway:{image:'candidate',privileged:true},hands:{image:'hands-image'}}}));assert.equal(f.run().status,1);assert.equal(f.receipt().phase,'rejected');assert.equal(f.live().containers.gateway.Image,image('a'));});
test('behavior failure restores exact previous configuration and image',t=>{const f=fixture(t),previous=readFileSync(f.root+'/override.yaml','utf8');f.plan.verify=[[process.execPath,'-e','process.exit(1)']];assert.equal(f.run().status,1);assert.equal(f.receipt().phase,'rolled_back',JSON.stringify(f.receipt()));assert.equal(readFileSync(f.root+'/override.yaml','utf8'),previous);assert.equal(f.live().containers.gateway.Image,image('a'));});
test('rejects a concurrent publisher without creating release state',async t=>{const f=fixture(t);const holder=spawn('flock',[f.root+'/deploy.lock','sh','-c','echo locked; read line'],{stdio:['pipe','pipe','pipe']});await new Promise(resolve=>holder.stdout.once('data',resolve));try{const r=f.run();assert.equal(r.status,75);assert.equal(f.live().containers.gateway.Image,image('a'));}finally{holder.stdin.end('\n');await new Promise(resolve=>holder.once('exit',resolve));}});
test('explicit rollback restores a successful release under the same lock',t=>{const f=fixture(t);assert.equal(f.run().status,0);const r=spawnSync('bash',[runner,f.root+'/plan.json',f.root+'/deploy.lock','--rollback'],{encoding:'utf8',env:{...process.env,PATH:f.root+'/bin:'+process.env.PATH,OPENCRAFT_NODE:process.execPath}});assert.equal(r.status,0,r.stderr);assert.equal(f.receipt().phase,'rolled_back');assert.equal(f.live().containers.gateway.Image,image('a'));});
test('a recorded release ID cannot be silently reused',t=>{const f=fixture(t);assert.equal(f.run().status,0);assert.notEqual(f.run().status,0);assert.equal(f.receipt().phase,'succeeded');assert.equal(f.live().containers.gateway.Image,image('b'));});

function cold(f) {
 f.plan.lifecycle={mode:'cold',afterStop:[[process.execPath,'-e',`const fs=require('fs'),p=${JSON.stringify(f.root+'/docker-state')},s=JSON.parse(fs.readFileSync(p));if(s.containers.gateway.State.Running)process.exit(2);(s.events??=[]).push('quiescent');fs.writeFileSync(p,JSON.stringify(s));`]]};
}
function rollback(f) { return spawnSync('bash',[runner,f.root+'/plan.json',f.root+'/deploy.lock','--rollback'],{encoding:'utf8',env:{...process.env,PATH:f.root+'/bin:'+process.env.PATH,OPENCRAFT_NODE:process.execPath}}); }
test('cold apply and explicit rollback share stop, ownership check, start ordering',t=>{
 const f=fixture(t);cold(f);assert.equal(f.run().status,0,JSON.stringify(f.receipt()));
 assert.deepEqual(f.live().events,['stop','quiescent','up']);
 assert.equal(rollback(f).status,0,JSON.stringify(f.receipt()));
 assert.deepEqual(f.live().events,['stop','quiescent','up','stop','quiescent','up']);
 assert.deepEqual(f.live().containers.hands,f.state.containers.hands);
});
test('cold automatic rollback repeats ownership checks and retains failed verification output',t=>{
 const f=fixture(t);cold(f);f.plan.verify=[[process.execPath,'-e','console.log("stdout evidence");console.error("stderr cause");process.exit(7)']];
 assert.equal(f.run().status,1);assert.equal(f.receipt().phase,'rolled_back');
 assert.deepEqual(f.live().events,['stop','quiescent','up','stop','quiescent','up']);
 assert.match(f.receipt().error,/status 7.*verify-0.log/);
 const log=readFileSync(f.root+'/state/test/verify-0.log','utf8');
 assert.match(log,/stdout evidence/);assert.match(log,/stderr cause/);
});
test('failed native ownership check never admits candidate or bypasses the check on recovery',t=>{
 const f=fixture(t);cold(f);f.plan.lifecycle.afterStop=[[process.execPath,'-e','console.error("owner still held");process.exit(1)']];
 assert.equal(f.run().status,1);assert.equal(f.receipt().phase,'rollback_failed');
 assert.deepEqual(f.live().events,['stop','stop']);
 assert.equal(f.live().containers.gateway.Image,image('a'));assert.equal(f.live().containers.gateway.State.Running,false);
 assert.match(readFileSync(f.root+'/state/test/apply-after-stop-0.log','utf8'),/owner still held/);
 assert.match(f.receipt().rollbackError,/rollback-after-stop-0.log/);
});
test('invalid lifecycle contracts fail before stopping a service',t=>{
 const f=fixture(t);f.plan.lifecycle={mode:'cold',afterStop:[]};assert.notEqual(f.run().status,0);
 assert.equal(f.live().containers.gateway.State.Running,true);assert.equal(f.live().events,undefined);
});

function compatibleRollback(f) {
 f.state.images.compatible=image('d');writeFileSync(f.root+'/docker-state',JSON.stringify(f.state));
 writeFileSync(f.root+'/compatible.yaml',JSON.stringify({services:{gateway:{image:'compatible'},hands:{image:'hands-image'}}}));
 f.plan.rollback={override:f.root+'/compatible.yaml',imageId:image('d')};
}
test('schema-compatible automatic rollback retains the selected storage reader',t=>{
 const f=fixture(t);compatibleRollback(f);cold(f);f.plan.verify=[[process.execPath,'-e','process.exit(1)']];
 assert.equal(f.run().status,1);assert.equal(f.receipt().phase,'rolled_back');assert.equal(f.live().containers.gateway.Image,image('d'));
 assert.equal(f.receipt().previousImageId,image('a'));assert.equal(f.receipt().rollbackImageId,image('d'));
 assert.equal(rollback(f).status,0);assert.deepEqual(f.live().containers.hands,f.state.containers.hands);
});
test('schema-compatible explicit rollback uses the sealed recovery image',t=>{
 const f=fixture(t);compatibleRollback(f);assert.equal(f.run().status,0);
 writeFileSync(f.root+'/compatible.yaml','invalid changed external input');
 assert.equal(rollback(f).status,0);assert.equal(f.live().containers.gateway.Image,image('d'));
});
test('compatible rollback rejects unrelated service changes before stopping',t=>{
 const f=fixture(t);compatibleRollback(f);cold(f);
 writeFileSync(f.root+'/compatible.yaml',JSON.stringify({services:{gateway:{image:'compatible'},hands:{image:'hands-image',privileged:true}}}));
 assert.equal(f.run().status,1);assert.equal(f.receipt().phase,'rejected');assert.equal(f.live().events,undefined);
});
