import {spawn} from 'node:child_process';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
/** Source artifact is built by the trusted deployment, never from a browser path. */
export async function packagePersonalMachine(root,output){
  await mkdir(output,{recursive:true,mode:0o700});
  const run=(args)=>new Promise((done,fail)=>{const p=spawn('git',args,{cwd:root,stdio:['ignore','pipe','pipe']});const rows=[];p.stdout.on('data',b=>rows.push(b));p.on('error',fail);p.on('exit',code=>code===0?done(Buffer.concat(rows).toString().trim()):fail(new Error('Machine source snapshot unavailable')));});
  const tree=await run(['write-tree']);
  const path=join(output,'source.tgz'),temp=path+'.tmp';
  await run(['archive','--format=tar.gz','--output='+temp,tree]);
  await rename(temp,path);const digest=createHash('sha256').update(await readFile(path)).digest('hex');await writeFile(join(output,'sha256'),digest,{mode:0o600});return {path,digest};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const r=await packagePersonalMachine(resolve(process.argv[2]??'.'),resolve(process.argv[3]??'.local/personal-machine-package'));console.log(JSON.stringify(r));}
