import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile,symlink,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SandboxEnvironment} from '@opencraft/sandbox';
import {SandboxWorkspaceFiles} from '../../apps/local-agent-host/src/sandbox-workspace-files';
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'bound-files-'));let allowed=true,spawns=0;const children:any[]=[],commands:any[]=[];
 const sandbox: Pick<SandboxEnvironment,'spawn'>={async spawn(command,output){
  spawns++;commands.push(command);const p=spawn(command.command[0]!,command.command.slice(1),{cwd:command.cwd,env:command.env,stdio:['pipe','pipe','pipe']});
  children.push(p);const exited=new Promise<{code:number}>(resolve=>p.on('close',code=>resolve({code:code??1})));
  p.stdout.on('data',data=>output?.({stream:'stdout',data}));p.stderr.resume();
  return {kind:'process',id:String(p.pid),exited,async writeStdin(d){await new Promise<void>((res,rej)=>p.stdin.write(d,e=>e?rej(e):res()));},async closeStdin(){p.stdin.end();},async terminate(){if(p.exitCode===null)p.kill();await exited;}};
 }};
 const options={sandbox,root,python:'/usr/bin/python3',writable:true,async authorize(){if(!allowed)throw Error('revoked');},onCleanupUnconfirmed(){throw Error('cleanup');}};
 const port=new SandboxWorkspaceFiles(options);
 return {root,options,port,children,commands,deny(){allowed=false;},get spawns(){return spawns;},async close(){await port.close();await rm(root,{recursive:true,force:true});}};
}
test('bound file operations read and write same selected filesystem',async()=>{
 const f=await fixture();try{
  const file=join(f.root,'中文.txt'),dataBase64=Buffer.from('same workspace').toString('base64');
  assert.deepEqual(await f.port.request('fs/writeFile',{path:file,dataBase64}),{});
  assert.equal(await readFile(file,'utf8'),'same workspace');
  assert.deepEqual(await f.port.request('fs/readFile',{path:file}),{dataBase64});
  assert.deepEqual(await f.port.request('fs/readDirectory',{path:f.root}),{entries:[{fileName:'中文.txt',isDirectory:false,isFile:true}]});
  assert.equal((await f.port.request('fs/getMetadata',{path:file}) as any).isFile,true);
 }finally{await f.close();}
});
test('unsupported, escaped and readonly requests never spawn',async()=>{
 const f=await fixture();try{
  for(const p of ['/etc/passwd',f.root+'/../outside',f.root+'-other/x'])await assert.rejects(f.port.request('fs/readFile',{path:p}));
  await assert.rejects(f.port.request('fs/remove',{path:f.root}));
  await assert.rejects(new SandboxWorkspaceFiles({...f.options,writable:false}).request('fs/writeFile',{path:f.root+'/x',dataBase64:''}));
  assert.equal(f.spawns,0);
 }finally{await f.close();}
});
test('file and directory symlinks cannot escape the bound port',async()=>{
 const f=await fixture();try{
  await symlink('/etc/passwd',f.root+'/link');await symlink('/etc',f.root+'/directory');
  await assert.rejects(f.port.request('fs/readFile',{path:f.root+'/link'}));
  await assert.rejects(f.port.request('fs/writeFile',{path:f.root+'/link',dataBase64:''}));
  await assert.rejects(f.port.request('fs/readDirectory',{path:f.root+'/directory'}));
  await assert.rejects(f.port.request('fs/readFile',{path:f.root+'/directory/passwd'}));
 }finally{await f.close();}
});
test('authorization revocation and file limits fail explicitly',async()=>{
 const f=await fixture();try{
  await writeFile(f.root+'/large',Buffer.alloc(1024*1024+1));await assert.rejects(f.port.request('fs/readFile',{path:f.root+'/large'}));
  f.deny();await assert.rejects(f.port.request('fs/readDirectory',{path:f.root}),/revoked/);
 }finally{await f.close();}
});
test('directory creation supports nested folders without following links or granting readonly writes',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.port.request('fs/createDirectory',{path:f.root+'/one/two'}),{});
  assert.equal((await f.port.request('fs/getMetadata',{path:f.root+'/one/two'}) as any).isDirectory,true);
  await assert.rejects(f.port.request('fs/createDirectory',{path:f.root+'/one',recursive:false}));
  await symlink('/tmp',f.root+'/external');await assert.rejects(f.port.request('fs/createDirectory',{path:f.root+'/external/never-create',recursive:true}));
  await assert.rejects(new SandboxWorkspaceFiles({...f.options,writable:false}).request('fs/createDirectory',{path:f.root+'/denied'}));
 }finally{await f.close();}
});
test('aborted file request never spawns; cancellation answers at once and a late resident spawn is reclaimed on close',async()=>{
 const f=await fixture();try{
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(f.port.request('fs/readDirectory',{path:f.root},cancelled.signal));assert.equal(f.spawns,0);
  let resolve!: (value:any)=>void,began!:()=>void,closed=0;
  const started=new Promise<void>(r=>began=r),controller=new AbortController();
  const port=new SandboxWorkspaceFiles({...f.options,sandbox:{async spawn(){began();return new Promise(r=>resolve=r)}}});
  const pending=assert.rejects(port.request('fs/readDirectory',{path:f.root},controller.signal),/cancelled/);await started;controller.abort();await pending;
  const closing=port.close();
  resolve({kind:'process',id:'late',exited:new Promise(()=>{}),async terminate(){closed++},async closeStdin(){},async writeStdin(){throw Error('must not write')}});
  await closing;assert.equal(closed,1);
  await assert.rejects(port.request('fs/readDirectory',{path:f.root}),/closed/);
 }finally{await f.close();}
});
test('one attached resident process serves sequential and concurrent operations',async()=>{
 const f=await fixture();try{
  for(let i=0;i<20;i++)await f.port.request('fs/writeFile',{path:`${f.root}/file-${i}`,dataBase64:Buffer.from('v'+i).toString('base64')});
  const reads=await Promise.all(Array.from({length:40},(_,i)=>f.port.request('fs/readFile',{path:`${f.root}/file-${i%20}`})));
  reads.forEach((value:any,i)=>assert.equal(Buffer.from(value.dataBase64,'base64').toString(),'v'+(i%20)));
  // Large concurrent responses do not interleave: each answer arrives whole under its own id.
  await writeFile(f.root+'/big',Buffer.alloc(1024*1024,7));
  const big=await Promise.all([1,2,3].map(()=>f.port.request('fs/readFile',{path:f.root+'/big'})));
  for(const value of big as any[])assert.equal(Buffer.from(value.dataBase64,'base64').length,1024*1024);
  const mixed=await Promise.allSettled([f.port.request('fs/readFile',{path:f.root+'/missing'}),f.port.request('fs/getMetadata',{path:f.root+'/big'})]);
  assert.equal(mixed[0].status,'rejected');assert.equal((mixed[1] as any).value.isFile,true);
  assert.equal(f.spawns,1,'file operations reuse one resident process');
  assert.equal(f.commands[0].attached,true,'the resident process is attached: its failure never retires the environment');
 }finally{await f.close();}
});
test('resident process loss fails in-flight requests without replay; the next request starts a new process',async()=>{
 const f=await fixture();try{
  await f.port.request('fs/writeFile',{path:f.root+'/a',dataBase64:Buffer.from('a').toString('base64')});
  await mkdir(f.root+'/fifo-dir');execFileSync('mkfifo',[f.root+'/fifo-dir/pipe']);
  // A FIFO is refused without blocking (O_NONBLOCK + regular-file check).
  await assert.rejects(f.port.request('fs/readFile',{path:f.root+'/fifo-dir/pipe'}),/rejected/);
  const inflight=Array.from({length:4},()=>f.port.request('fs/readFile',{path:f.root+'/a'}));
  f.children[0].kill('SIGKILL');
  const settled=await Promise.allSettled(inflight);
  for(const result of settled)if(result.status==='rejected')assert.match(String(result.reason),/File process ended|input failed/);
  assert.deepEqual(await f.port.request('fs/readFile',{path:f.root+'/a'}),{dataBase64:Buffer.from('a').toString('base64')});
  assert.equal(f.spawns,2);
 }finally{await f.close();}
});
