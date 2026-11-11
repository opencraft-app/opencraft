import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapabilitySession } from './index.js';
import { threadCli } from './thread-cli.js';

type Connection = {url:string;token:string};
async function namespace(root:string,id:string) {
  const directory=join(root,id),entry=join(directory,'opencraft');
  await mkdir(directory,{recursive:true,mode:0o700});
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077)throw Error('Invalid CLI directory');
  const write=async(name:string,body:string,mode:number)=>{
    const temporary=join(directory,name+'.'+randomUUID()+'.tmp');
    try{await writeFile(temporary,body,{mode,flag:'wx'});await rename(temporary,join(directory,name));}
    finally{await rm(temporary,{force:true});}
  };
  try {
    await write('opencraft',`#!${process.execPath}\n(${threadCli.toString()})(process.argv.slice(2)).catch(() => {process.stdout.write(JSON.stringify({error:'thread_cli_outcome_unknown'})+'\\n');process.exitCode=1;});\n`,0o700);
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  return {launcher:entry,connectionFile:join(directory,'connection.json'),
    environment:{OPENCRAFT_THREAD_CLI:entry,PATH:directory+':'+(process.env.PATH??'')},
    publish:(config:Connection)=>write('connection.json',JSON.stringify(config),0o600),
    revoke:()=>rm(directory,{recursive:true,force:true})};
}

/** Reserve a one-shot first-execution namespace, without a descriptor or authority. */
export async function reserveThreadCli(root:string) {
  const slot=await namespace(root,'initial-'+randomUUID());
  let published=false,closed=false;
  return {...slot,async publish(config:Connection){
    if(published||closed)throw Error('CLI reservation already consumed');
    published=true;
    await slot.publish(config);
    if(closed){await slot.revoke();throw Error('CLI reservation revoked');}
  },async rejectBeforeStart(){
    if(closed)throw Error('CLI reservation revoked');
    await rm(slot.connectionFile,{force:true});
    if(closed)throw Error('CLI reservation revoked');
    published=false;
  },async revoke(){closed=true;await slot.revoke();}};
}

/** Materialize one admitted execution's private CLI namespace. No MCP dependency. */
export async function issueThreadCli(root:string,session:CapabilitySession,config:Connection) {
  const id=createHash('sha256').update(JSON.stringify([session.serverId,session.threadId,session.execution])).digest('hex');
  const slot=await namespace(root,id);
  try{await slot.publish(config);}catch(error){await slot.revoke();throw error;}
  return {launcher:slot.launcher,connectionFile:slot.connectionFile,environment:slot.environment,revoke:slot.revoke};
}
