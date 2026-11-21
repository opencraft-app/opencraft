#!/usr/bin/env node
import { mkdir, lstat, chown, realpath, readdir, open, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
const exec=promisify(execFile);
const directory=process.argv[2];
const dataGiB=process.argv[3]===undefined?1:Number(process.argv[3]);
if(process.getuid()!==0||!directory?.startsWith('/')||directory==='/'||resolve(directory)!==directory||![3,4].includes(process.argv.length)||!Number.isSafeInteger(dataGiB)||dataGiB<1||dataGiB>1024)throw Error('Usage (root): prepare-volumes.mjs /private/observation-directory [dataGiB default 1]');
await mkdir(directory,{recursive:true,mode:0o700});
const root=await lstat(directory);
if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==0||(root.mode&0o077)!==0||await realpath(directory)!==directory)throw Error('Observation directory must be a private root-owned physical directory');
async function growImage(image,source,target) {
  const before=(await lstat(image)).size,delta=target-before;
  if(delta<=0)return;
  const stats=await statfs(directory),free=Number(stats.bavail)*Number(stats.bsize);
  if(free<delta+67108864)throw Error(`Insufficient host space to grow ${image}: need ${delta+67108864} bytes, have ${free}`);
  const file=await open(image,'r+');try{await file.truncate(target);}finally{await file.close();}
  if(source){await exec('losetup',['-c',source]);await exec('resize2fs',[source]);}
}
for(const [name,size] of [['prometheus',10],['loki',5],['data',dataGiB]]) {
  const path=join(directory,name),image=join(directory,`${name}.ext4`),target=size*1073741824;
  await mkdir(path,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const pathInfo=await lstat(path);if(!pathInfo.isDirectory()||pathInfo.isSymbolicLink())throw Error('Mount target must be a physical directory');
  let exists=false,imageSize=0;
  try {
    const info=await lstat(image);
    if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o077)!==0)throw Error('Existing image does not match quota');
    if(info.size>target||(name!=='data'&&info.size!==target))throw Error('Existing image does not match quota');
    exists=true;imageSize=info.size;
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  const mounted=await exec('findmnt',['-rn','--mountpoint',path,'-o','SOURCE']).catch(error=>{if(error.code===1)return null;throw error;});
  if(mounted) {
    if(!exists)throw Error('Unexpected mounted filesystem');
    const source=mounted.stdout.trim();
    const mountInfo=(await exec('findmnt',['-rn','--mountpoint',path,'-o','SOURCE,FSTYPE'])).stdout.trim().split(/\s+/u);
    if(mountInfo[0]!==source||mountInfo[1]!=='ext4')throw Error('Mounted filesystem identity does not match the managed ext4 volume');
    const backing=await exec('losetup',['--noheadings','--output','BACK-FILE',source]);
    if(await realpath(backing.stdout.trim())!==image)throw Error('Mount belongs to another filesystem');
    if(imageSize<target)await growImage(image,source,target);
  } else {
    if(exists&&name==='data')throw Error('Existing data image is not mounted; refusing growth without a verified live volume');
    if((await readdir(path)).length)throw Error('Refusing to mount over existing files');
    if(!exists){const file=await open(image,'wx',0o600);try{await file.truncate(target);}finally{await file.close();}await exec('mkfs.ext4',['-q','-m','0',image]);}
    await exec('mount',['-o','loop,nosuid,nodev,noexec',image,path]);
  }
  await chown(path,name==='data'?0:name==='loki'?10001:65534,name==='data'?0:name==='loki'?10001:65534);
}
console.log(JSON.stringify({directory,dataGiB,filesystems:['prometheus','loki','data'],note:'Persist these own-image mounts with systemd mount units before enabling the container stack.'}));
