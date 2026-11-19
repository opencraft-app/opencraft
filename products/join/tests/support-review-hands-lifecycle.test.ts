import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(failure: boolean) {
 const root=await mkdtemp(join(tmpdir(),'hands-product-life-'));
 try {
  await mkdir(join(root,'bin'));await mkdir(join(root,'runtime','browser'),{recursive:true});
  await mkdir(join(root,'browser'),{mode:0o700});
  await symlink(process.execPath,join(root,'bin','node'));
  await copyFile(fileURLToPath(new URL('../../../scripts/container-deployment/hands-application.mjs',import.meta.url)),join(root,'runtime','hands-application.mjs'));
  await writeFile(join(root,'runtime','paths.mjs'),`export const deploymentPaths=()=>({terminalEndpoint:process.env.TEST_ROOT+'/terminal.sock',fileSystemEndpoint:process.env.TEST_ROOT+'/files.sock'});`);
  const stub=`const {createServer}=require('node:net');const {basename}=require('node:path');const root=process.env.TEST_ROOT;const name=basename(process.argv[1]);const path=name==='owner.cjs'?root+'/browser/owner.sock':name.includes('execution')?root+'/exec.sock':name.includes('terminal')?root+'/terminal.sock':root+'/files.sock';const server=createServer();server.listen(path);process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
  for(const file of ['browser/owner.cjs','hands-execution-owner.mjs','hands-terminal-owner.mjs','hands-files-owner.mjs']) {
   // The owner names ending in mjs need ESM imports rather than require.
   await writeFile(join(root,'runtime',file),file.endsWith('.cjs')?stub:stub.replace("const {createServer}=require('node:net');const {basename}=require('node:path');","import {createServer} from 'node:net';import {basename} from 'node:path';"));
  }
  await writeFile(join(root,'entry.mjs'),`import {appendFile} from 'node:fs/promises';import {startContainerHands} from './runtime/hands-application.mjs';await startContainerHands({startServices:async fail=>{${failure?'setTimeout(fail,250);':''}return [{close:()=>appendFile(process.env.TEST_ROOT+'/closed','closed\\n')}];}});`);
  const child=spawn(process.execPath,[join(root,'entry.mjs')],{env:{...process.env,TEST_ROOT:root,OPENCRAFT_BROWSER_DATA_DIR:join(root,'browser'),OPENCRAFT_WORKSPACE_DIR:root,OPENCRAFT_HANDS_EXECUTION_SOCKET:join(root,'exec.sock')},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',data=>{output+=data;if(!failure&&output.includes('owners ready.')) child.kill('SIGTERM');});child.stderr.on('data',data=>{errors+=data;});
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
  assert.equal(code,failure?1:0,errors);assert.equal(await readFile(join(root,'closed'),'utf8'),'closed\n');
  if(!failure)assert.equal(output.match(/owners ready\./g)?.length,1,'owner loop starts only once');
 }finally{await rm(root,{recursive:true,force:true});}
}
test('Hands closes the product companion on normal stop without duplicate owner startup',async()=>fixture(false));
test('product companion failure stops Hands and closes the companion exactly once',async()=>fixture(true));
