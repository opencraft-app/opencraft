import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapabilitySession, SessionCapabilityProvider } from './index.js';

import { threadCli } from './thread-cli.js';

export function threadCliProvider(options: {directory:string;config(session:CapabilitySession):{url:string;token:string};
  context(session:CapabilitySession):Promise<unknown>}): SessionCapabilityProvider {
  const tool = {name:'thread_cli',description:'Open the execution-bound OpenCraft CLI for discovering child conversations, delegating independent work, reading results, sending follow-ups and waiting. Ordinary conversations may execute directly or coordinate children. Follow the user’s delegation preferences; never resume stopped work without their instruction. Returns a private launcher path, not credentials.',
    inputSchema:{type:'object',properties:{},additionalProperties:false}};
  return {id:'opencraft.thread-cli',tools:session=>session.execution?[tool]:[],async call(session,_name,args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw Error('thread_cli takes no arguments');
    const context=await options.context(session),config=options.config(session);
    const id=createHash('sha256').update(JSON.stringify([session.serverId,session.threadId,session.execution])).digest('hex');
    const directory=join(options.directory,id),entry=join(directory,'opencraft');
    await mkdir(directory,{recursive:true,mode:0o700});
    const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077)throw Error('Invalid CLI directory');
    for(const [name,body,mode] of [['connection.json',JSON.stringify(config),0o600],['opencraft',`#!${process.execPath}\n(${threadCli.toString()})(process.argv.slice(2)).catch(() => {process.stderr.write('Thread CLI failed; inspect state before retrying an uncertain write\\n');process.exitCode=1;});\n`,0o700]] as const){
      const temporary=join(directory,name+'.'+randomUUID()+'.tmp');
      await writeFile(temporary,body,{mode,flag:'wx'});
      try{await rename(temporary,join(directory,name));}finally{await rm(temporary,{force:true});}
    }
    return {context,launcher:entry,connectionFile:join(directory,'connection.json'),help:`Run ${JSON.stringify(entry)} --help. Use the same launcher followed by thread list --children to rediscover work after context compression. Child outcomes notify the parent automatically; inspect results before acting. Return relevant summaries to the user, not internal acknowledgments.`};
  }};
}
