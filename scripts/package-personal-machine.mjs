import {spawn} from 'node:child_process';
import {copyFile,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
/** Source artifact is built by the trusted deployment, never from a browser path. */
export async function packagePersonalMachine(root,output){
  await mkdir(output,{recursive:true,mode:0o700});
  const run=(args,env=process.env)=>new Promise((done,fail)=>{const p=spawn('git',args,{cwd:root,env,stdio:['ignore','pipe','pipe']});const rows=[];p.stdout.on('data',b=>rows.push(b));p.on('error',fail);p.on('exit',code=>code===0?done(Buffer.concat(rows).toString().trim()):fail(new Error('Machine source snapshot unavailable')));});
  const tempIndex=join(tmpdir(),'opencraft-machine-index-'+randomUUID());
  try {
    const rawIndex=process.env.GIT_INDEX_FILE||await run(['rev-parse','--git-path','index']);
    const sourceIndex=isAbsolute(rawIndex)?rawIndex:resolve(root,rawIndex);
    try { await copyFile(sourceIndex,tempIndex); } catch(error) { if(error?.code!=='ENOENT')throw error; }
    const env={...process.env,GIT_INDEX_FILE:tempIndex};
    // Stage modified/deleted tracked files into the disposable index only; untracked files remain excluded.
    await run(['add','-u'],env);
    const tree=await run(['write-tree'],env);
    const path=join(output,'source.tgz'),temp=path+'.tmp';
    await run(['archive','--format=tar.gz','--output='+temp,tree],env);
    await rename(temp,path);const digest=createHash('sha256').update(await readFile(path)).digest('hex');await writeFile(join(output,'sha256'),digest,{mode:0o600});return {path,digest};
  } finally {
    await rm(tempIndex,{force:true});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const r=await packagePersonalMachine(resolve(process.argv[2]??'.'),resolve(process.argv[3]??'.local/personal-machine-package'));console.log(JSON.stringify(r));}
