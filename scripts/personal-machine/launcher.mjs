#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
const args=process.argv.slice(2),index=args.indexOf('--state');
if(index<0||!args[index+1])throw new Error('--state is required');
const state=resolve(args[index+1]),runtime=join(state,'runtime');
const command=args.includes('--update')?'--update':args.includes('--check-update')?'--check-update':args.includes('--rollback')?'--rollback':args.includes('--recover')?'--recover':null;
if(command){const {runUpdate}=await import(pathToFileURL(join(runtime,'scripts/personal-machine/update.mjs')));await runUpdate(state,command);}
else{
 const child=spawn(process.execPath,['--import',join(runtime,'node_modules/tsx/dist/loader.mjs'),join(runtime,'scripts/personal-machine/daemon.ts'),...args],{cwd:runtime,stdio:'inherit',env:process.env});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
 child.on('error',()=>{console.error('Machine runtime could not start.');process.exitCode=1;});
 child.on('exit',code=>process.exit(code??1));
}
