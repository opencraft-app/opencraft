#!/usr/bin/env node
/** Shared runtime preparation executed identically by fresh install and --update. */
import {spawn} from 'node:child_process';
import {dirname,resolve,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const npm=process.platform==='win32'?'npm.cmd':'npm';
const env={
  ...process.env,
  PATH:dirname(process.execPath)+delimiter+(process.env.PATH??''),
  OPENCRAFT_MACHINE_BOOTSTRAP:'',
  OPENCRAFT_MACHINE_KEY:'',
};

function run(command,args){
  return new Promise((done,fail)=>{
    const child=spawn(command,args,{cwd:root,stdio:'inherit',env});
    child.on('error',fail);
    child.on('exit',code=>code===0?done():fail(new Error(`Machine runtime preparation failed: ${command} ${args.join(' ')}`)));
  });
}

await run(npm,['ci','--no-audit','--no-fund']);
await run(npm,['run','prepare:dsh-runtime']);
await run(npm,['run','build:preview-bridge']);
