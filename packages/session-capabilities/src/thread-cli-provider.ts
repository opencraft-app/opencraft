import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapabilitySession } from './index.js';

import { threadCli } from './thread-cli.js';

/** Materialize one admitted execution's private CLI namespace. No MCP dependency. */
export async function issueThreadCli(root: string, session: CapabilitySession, config: {url:string;token:string}) {
    const id=createHash('sha256').update(JSON.stringify([session.serverId,session.threadId,session.execution])).digest('hex');
    const directory=join(root,id),entry=join(directory,'opencraft');
    await mkdir(directory,{recursive:true,mode:0o700});
    const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077)throw Error('Invalid CLI directory');
    try {
    for(const [name,body,mode] of [['connection.json',JSON.stringify(config),0o600],['opencraft',`#!${process.execPath}\n(${threadCli.toString()})(process.argv.slice(2)).catch(() => {process.stdout.write(JSON.stringify({error:'thread_cli_outcome_unknown'})+'\\n');process.exitCode=1;});\n`,0o700]] as const){
      const temporary=join(directory,name+'.'+randomUUID()+'.tmp');
      await writeFile(temporary,body,{mode,flag:'wx'});
      try{await rename(temporary,join(directory,name));}finally{await rm(temporary,{force:true});}
    }
    } catch(error) {await rm(directory,{recursive:true,force:true});throw error;}
    return {launcher:entry,connectionFile:join(directory,'connection.json'), environment:{OPENCRAFT_THREAD_CLI:entry,PATH:directory+':'+(process.env.PATH??'')},
      revoke:()=>rm(directory,{recursive:true,force:true})};
}
