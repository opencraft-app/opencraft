import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir,platform,arch} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
for(const cachedNode of [false,true])test('official installer updates an existing offline installation without a new pairing key'+(cachedNode?' using cached private Node':' using PATH Node'),{timeout:30000,skip:process.versions.node!=='26.7.0'},async t=>{
 const home=await mkdtemp(join(tmpdir(),'oc-update-entry-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const credential=randomBytes(32).toString('base64url'),id=randomUUID(),hubId=randomUUID();let origin='',authenticated=0;
 const module=await readFile(join(root,'scripts/personal-machine/update.mjs'));
 const server=createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer '+credential);authenticated++;
  if(req.url==='/__opencraft_machines/install.sh?module=update&id='+id){res.end(module);return;}
  if(req.url==='/__opencraft_machines/bootstrap?update=1&id='+id){res.end(JSON.stringify({schemaVersion:1,id,hubId,origin,digest:'a'.repeat(64)}));return;}
  res.writeHead(404);res.end();
 });await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())));origin='http://127.0.0.1:'+(server.address() as any).port;
 const state=join(home,'.opencraft/machines',id);await mkdir(state,{recursive:true,mode:0o700});const configuration=JSON.stringify({schemaVersion:1,id,hubId,origin,credential,phase:'enrolled'});await writeFile(join(state,'connection.json'),configuration,{mode:0o600});
 let path=dirname(process.execPath)+':'+process.env.PATH;
 if(cachedNode){
  const bin=join(home,'bin'),cache=join(home,'.opencraft','machine-node-26.7.0-'+platform()+'-'+arch(),'bin');
  await mkdir(bin,{recursive:true});await mkdir(cache,{recursive:true});await symlink(process.execPath,join(cache,'node'));
  await writeFile(join(bin,'node'),'#!/bin/sh\nexit 1\n',{mode:0o700});
  await writeFile(join(bin,'curl'),'#!/bin/sh\necho Unexpected runtime download >&2\nexit 99\n',{mode:0o700});
  path=bin+':/usr/bin:/bin';
 }
 const script='export OPENCRAFT_MACHINE_ORIGIN='+JSON.stringify(origin)+'\n'+await readFile(join(root,'scripts/personal-machine/install.sh'),'utf8');
 const output=await new Promise<string>((done,fail)=>{
  const child=spawn('bash',['-s','--','--check-update'],{env:{...process.env,HOME:home,PATH:path,OPENCRAFT_MACHINE_BOOTSTRAP:''},stdio:['pipe','pipe','pipe']});let text='';child.stdout.on('data',c=>text+=c);child.stderr.on('data',c=>text+=c);child.on('error',fail);child.on('exit',code=>code===0?done(text):fail(new Error(text.replaceAll(credential,'[redacted]'))));child.stdin.end(script);
 });
 assert.match(output,/update is available/);assert.equal(authenticated,2);assert.equal(await readFile(join(state,'connection.json'),'utf8'),configuration);
});
