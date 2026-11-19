import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,installRuntimePlugin,parseManifest} from '../runtime-plugins/store.mjs';
import {startPluginExecutor} from '../runtime-plugins/executor.mjs';
import {startReviewHandsOwner} from '../plugins/support-review/src/hands-owner';
import {HandsReviewExecutor} from '../plugins/support-review/src/hands-client';

test('Hands environment bootstrap contains no plugin lifecycle or install mode',async()=>{
 const entry=await readFile(new URL('../hands.mjs',import.meta.url),'utf8');
 assert.ok(entry.includes('await startContainerHands();'));assert.doesNotMatch(entry,/loadRuntimePlugins|runtime-plugins|startServices|--runtime-plugin/);
});
test('explicit execution role is distinct from Gateway and accepts legacy role only as a compatibility alias',async()=>{
 const root=await mkdtemp(join(tmpdir(),'plugin-execution-'));
 try{
  const output=join(root,'package'),store=join(root,'store'),marker=join(root,'marker');await mkdir(output);
  const code=`import {writeFile} from 'node:fs/promises';export async function activate(context){await writeFile(${JSON.stringify(marker)},context.role);return {close(){}};}`;
  const manifest={schemaVersion:1,id:'fixture.executor',version:'1.0.0',hostApi:1,nodeMajor:26,sourceRevision:'a'.repeat(40),roles:{execution:{entry:'entry.mjs'}},files:[{path:'entry.mjs',size:Buffer.byteLength(code),sha256:hash(code)}]};
  await writeFile(join(output,'entry.mjs'),code);await writeFile(join(output,'manifest.json'),JSON.stringify(manifest));await installRuntimePlugin(output,store,{enable:true});
  await assert.rejects(access(marker));let host=await startPluginExecutor({directory:store});assert.equal(await readFile(marker,'utf8'),'execution');assert.equal(host.selected.length,1);await host.close();
  assert.throws(()=>parseManifest({...manifest,roles:{...manifest.roles,hands:{entry:'entry.mjs'}}}));
  await writeFile(join(output,'manifest.json'),JSON.stringify({...manifest,version:'1.0.1',roles:{hands:{entry:'entry.mjs'}}}));await installRuntimePlugin(output,store,{enable:true});
  host=await startPluginExecutor({directory:store});assert.equal(await readFile(marker,'utf8'),'hands');await host.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test('execution-side graceful close drains an accepted operation rather than aborting it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'plugin-review-drain-'));let owner:any;
 try{
  const tokenFile=join(root,'token'),socketPath=join(root,'owner.sock');await writeFile(tokenFile,'drain-fixture-'.repeat(4),{mode:0o600});
  await writeFile(join(root,'support-review.py'),'import sys,json,time,pathlib\nr=json.load(sys.stdin)\npathlib.Path("started").write_text("yes")\ntime.sleep(0.25)\npathlib.Path("completed").write_text("yes")\nprint(json.dumps({"ok":True,"result":{"completed":True}}))\n');
  owner=await startReviewHandsOwner({socketPath,tokenFile,workerRoot:root,pythonExecutable:'/usr/bin/python3'},{drainOnClose:true});
  const client=new HandsReviewExecutor(async()=>({socketPath,tokenFile}));const work=client.execute({action:'list',actor:'fixture'},()=>true);
  let started=false;for(let i=0;i<100;i++){try{await access(join(root,'started'));started=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,5));}}assert.ok(started);
  const close=owner.close();assert.deepEqual(await work,{ok:true,result:{completed:true}});await close;
  assert.equal(await readFile(join(root,'completed'),'utf8'),'yes');await assert.rejects(access(socketPath));
 }finally{await owner?.close();await rm(root,{recursive:true,force:true});}
});
