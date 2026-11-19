import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startReviewHandsOwner } from '../plugins/support-review/src/hands-owner';

test('root Hands executes a worker that UID994 Gateway cannot read; private per-UID tokens work', {skip: process.getuid?.() !== 0}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-cross-uid-'));await chmod(root,0o711);
 const socketDirectory=join(root,'ipc'),workerRoot=join(root,'worker'),gateway=join(root,'gateway');
 await mkdir(socketDirectory,{mode:0o750});await chown(socketDirectory,0,990);
 await mkdir(workerRoot,{mode:0o700});await mkdir(gateway,{mode:0o700});await chown(gateway,994,990);
 const token='synthetic-review-token-'.repeat(4),handsToken=join(workerRoot,'token'),gatewayToken=join(gateway,'token');
 await writeFile(handsToken,token,{mode:0o600});await writeFile(gatewayToken,token,{mode:0o600});await chown(gatewayToken,994,990);
 await writeFile(join(workerRoot,'support-review.py'),'import json,os,sys\nr=json.load(sys.stdin)\nprint(json.dumps({"ok":True,"result":{"uid":os.geteuid(),"actor":r["actor"]}}))\n',{mode:0o600});
 const socketPath=join(socketDirectory,'owner.sock');
 const owner=await startReviewHandsOwner({socketPath,tokenFile:handsToken,workerRoot,pythonExecutable:'/usr/bin/python3',socketGid:990});
 try {
  const entry=join(gateway,'client.mjs');
  await writeFile(entry,`import {access} from 'node:fs/promises';import {HandsReviewExecutor} from ${JSON.stringify(new URL('../plugins/support-review/src/hands-client.ts',import.meta.url).href)};let denial;try{await access(${JSON.stringify(join(workerRoot,'support-review.py'))});}catch(error){denial=error.code;}const executor=new HandsReviewExecutor(async()=>(${JSON.stringify({socketPath,tokenFile:gatewayToken})}));const result=await executor.execute({action:'list',actor:'verified-reviewer'},()=>true);console.log(JSON.stringify({uid:process.getuid(),denial,result}));`,{mode:0o600});
  await chown(entry,994,990);
  const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),entry],{uid:994,gid:990,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{err+=b;});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10_000);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
  assert.equal(code,0,err);assert.deepEqual(JSON.parse(out),{uid:994,denial:'EACCES',result:{ok:true,result:{uid:0,actor:'verified-reviewer'}}});
 }finally{await owner.close();await rm(root,{recursive:true,force:true});}
});
