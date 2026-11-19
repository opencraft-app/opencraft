import { constants } from 'node:fs';
import { open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { acquireProcessWriter } from '../../../packages/sqlite-node/src/writer-lock';
import { createWorkspaceExecutionAuthority } from '@opencraft/sandbox-node/workspace-execution-channel';
const unavailable=()=>Error('Workspace authority unavailable: ownership cannot be verified');
/** Product process owner around the shared one-shot authority. Only a recorded
 * socket of a proven dead/released writer can be reclaimed; age is no proof. */
export async function createOwnedWorkspaceAuthority(options: Parameters<typeof createWorkspaceExecutionAuthority>[0]) {
 const path=options.socketPath,parent=dirname(path),receipt=path+'.receipt.json';
 if(!isAbsolute(path)||Buffer.byteLength(path)>103||path.includes('\0'))throw unavailable();
 const directory=await lstat(parent);
 if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o077)
   ||directory.uid!==process.getuid?.()||await realpath(parent)!==parent)throw unavailable();
 const release=acquireProcessWriter(path+'.writer.lock');
 let authority:Awaited<ReturnType<typeof createWorkspaceExecutionAuthority>>|undefined;
 try{
  let socket;
  try{socket=await lstat(path)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  if(socket){
   if(!socket.isSocket()||socket.uid!==process.getuid?.()||(socket.mode&0o077))throw unavailable();
   const file=await open(receipt,constants.O_RDONLY|constants.O_NOFOLLOW);
   let proof;
   try{
    const stat=await file.stat();
    if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)||stat.size>1024)throw unavailable();
    proof=JSON.parse(await file.readFile('utf8'));
   }finally{await file.close()}
   if(proof.version!==1||proof.dev!==socket.dev||proof.ino!==socket.ino)throw unavailable();
   // A listener without our lock may be an older/live implementation. Never
   // displace it even when a previous receipt happens to match.
   await new Promise<void>((resolve,reject)=>{
    const probe=createConnection(path);
    const fail=()=>{probe.destroy();reject(unavailable())};
    probe.setTimeout(1000,fail);probe.once('connect',fail);
    probe.once('error',error=>{probe.destroy();if((error as NodeJS.ErrnoException).code==='ECONNREFUSED')resolve();else reject(unavailable())});
   });
   const current=await lstat(path);
   if(!current.isSocket()||current.ino!==socket.ino||current.dev!==socket.dev)throw unavailable();
   await unlink(path);
  }
  authority=await createWorkspaceExecutionAuthority(options);
  const current=await lstat(path),temporary=receipt+'.'+randomUUID()+'.tmp';
  try{
   const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
   try{await file.writeFile(JSON.stringify({version:1,dev:current.dev,ino:current.ino}));await file.sync()}finally{await file.close()}
   await rename(temporary,receipt);
   const directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY);
   try{await directory.sync()}finally{await directory.close()}
  }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
  const owned=authority;let closing:Promise<void>|undefined;
  return {...owned,close(){return closing??=(async()=>{await owned.close();release()})()}};
 }catch(error){
  // Failed deletion keeps the writer fenced until process death.
  if(authority)await authority.close();
  release();throw error;
 }
}
