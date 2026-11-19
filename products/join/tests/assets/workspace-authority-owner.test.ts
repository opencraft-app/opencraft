import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,lstat,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {createOwnedWorkspaceAuthority} from '../../assets/workspace-authority-owner';
const token='test-owner-authority-token-'.repeat(3);
if(process.env.WORKSPACE_OWNER_CHILD){
 const socketPath=process.env.WORKSPACE_OWNER_SOCKET!;
 if(process.env.WORKSPACE_OWNER_CHILD==='owned')await createOwnedWorkspaceAuthority({socketPath,token});
 else{const server=createServer();server.listen(socketPath);await once(server,'listening');await chmod(socketPath,0o600)}
 process.send?.('ready');setInterval(()=>{},1000);
}else{
 async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'workspace-owner-')),socketPath=join(root,'authority.sock');
  t.after(()=>rm(root,{recursive:true,force:true}));return {root,socketPath};
 }
 async function child(t:test.TestContext,socketPath:string,kind:string){
  const processChild=fork(fileURLToPath(import.meta.url),[],{env:{PATH:process.env.PATH,WORKSPACE_OWNER_CHILD:kind,WORKSPACE_OWNER_SOCKET:socketPath},
   stdio:['ignore','ignore','pipe','ipc']});
  processChild.stderr?.resume();
  t.after(async()=>{if(processChild.exitCode===null&&processChild.signalCode===null){const done=once(processChild,'exit');processChild.kill('SIGKILL');await done}});
  await Promise.race([once(processChild,'message').then(([message])=>assert.equal(message,'ready')),
   once(processChild,'exit').then(()=>{throw Error('fixture child exited before readiness')})]);
  return processChild;
 }
 test('live owners cannot be displaced and graceful close permits reopen',async t=>{
  const {socketPath}=await fixture(t),first=await createOwnedWorkspaceAuthority({socketPath,token});
  try{
   const inode=(await lstat(socketPath)).ino;
   await assert.rejects(createOwnedWorkspaceAuthority({socketPath,token}));
   assert.equal((await lstat(socketPath)).ino,inode);
  }finally{await first.close()}
  const next=await createOwnedWorkspaceAuthority({socketPath,token});await next.close();
 });
 test('SIGKILL leaves a recorded socket which a new proven owner safely reclaims',async t=>{
  const {socketPath}=await fixture(t),processChild=await child(t,socketPath,'owned');
  const done=once(processChild,'exit');processChild.kill('SIGKILL');await done;
  assert.equal((await lstat(socketPath)).isSocket(),true);
  const next=await createOwnedWorkspaceAuthority({socketPath,token});
  try{assert.equal((await lstat(socketPath)).isSocket(),true)}
  finally{await next.close()}
  await assert.rejects(lstat(socketPath),{code:'ENOENT'});
 });
 test('an unrecorded abandoned socket is not deleted merely because it refuses connections',async t=>{
  const {socketPath}=await fixture(t),processChild=await child(t,socketPath,'legacy');
  const done=once(processChild,'exit');processChild.kill('SIGKILL');await done;
  const inode=(await lstat(socketPath)).ino;
  await assert.rejects(createOwnedWorkspaceAuthority({socketPath,token}));
  assert.equal((await lstat(socketPath)).ino,inode);
 });
 test('a listening legacy socket cannot be displaced even with a matching recorded inode',async t=>{
  const {socketPath}=await fixture(t),server=createServer();server.listen(socketPath);await once(server,'listening');
  try{
   await chmod(socketPath,0o600);const info=await lstat(socketPath);
   await writeFile(socketPath+'.receipt.json',JSON.stringify({version:1,dev:info.dev,ino:info.ino}),{mode:0o600});
   await assert.rejects(createOwnedWorkspaceAuthority({socketPath,token}));
   assert.equal((await lstat(socketPath)).ino,info.ino);assert.equal(server.listening,true);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
 });

}
