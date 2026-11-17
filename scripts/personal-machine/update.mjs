#!/usr/bin/env node
/** User-invoked updater; never changes identity, pairing credentials or session data. */
import {readFile,writeFile,mkdir,rename,rm,symlink,lstat,realpath,open,copyFile,chmod} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,delimiter} from 'node:path';
import {homedir} from 'node:os';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
const MAX=256*1024*1024;
export function verifyArchive(bytes,digest){
 if(!/^[a-f0-9]{64}$/.test(digest)||createHash('sha256').update(bytes).digest('hex')!==digest)throw new Error('Update archive checksum mismatch');
 const tar=gunzipSync(bytes,{maxOutputLength:512*1024*1024});
 let offset=0,paxPath=null;
 const safe=name=>{if(!name||name.includes('\\')||isAbsolute(name)||name.split('/').includes('..'))throw new Error('Unsafe update archive path');};
 while(offset+512<=tar.length){
  const header=tar.subarray(offset,offset+512);if(header.every(b=>b===0))break;
  const text=(a,b)=>header.subarray(a,b).toString().replace(/\0.*$/s,'');
  const sum=parseInt(text(148,156).trim(),8),actual=header.reduce((n,b,i)=>n+(i>=148&&i<156?32:b),0);
  const size=parseInt(text(124,136).trim()||'0',8),type=text(156,157);
  if(sum!==actual||!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length)throw new Error('Invalid update archive header');
  let name=text(0,100);const prefix=text(345,500);if(prefix)name=prefix+'/'+name;safe(name);
  if(type==='x'||type==='g'){
   const metadata=tar.subarray(offset+512,offset+512+size);let position=0;
   while(position<metadata.length){const space=metadata.indexOf(32,position);if(space<position)throw new Error('Invalid archive metadata');const length=Number(metadata.subarray(position,space).toString());if(!Number.isSafeInteger(length)||length<=space-position+1||position+length>metadata.length)throw new Error('Invalid archive metadata');const item=metadata.subarray(space+1,position+length-1).toString();if(item.startsWith('path=')){paxPath=item.slice(5);safe(paxPath);}if(item.startsWith('linkpath='))throw new Error('Archive links are not supported');position+=length;}
  }else{if(!['','0','5'].includes(type))throw new Error('Archive links or special files are not supported');if(paxPath){safe(paxPath);paxPath=null;}}
  offset+=512+Math.ceil(size/512)*512;
 }
 if(offset===0)throw new Error('Empty update archive');
}
export function validateConnection(config){
 if(!config||config.schemaVersion!==1||!/^[-a-f0-9]{36}$/.test(config.id)||!/^[-a-f0-9]{36}$/.test(config.hubId)||!/^[A-Za-z0-9_-]{43}$/.test(config.credential)||config.phase!=='enrolled')throw new Error('An enrolled machine is required');
 const url=new URL(config.origin),parts=url.hostname.split('.').map(Number),privateIp=parts.length===4&&parts.every(x=>Number.isInteger(x)&&x>=0&&x<=255)&&(parts[0]===10||parts[0]===127||parts[0]===192&&parts[1]===168||parts[0]===172&&parts[1]>=16&&parts[1]<=31);
 if(url.origin!==config.origin||url.username||url.password||url.protocol!=='https:'&&!(url.protocol==='http:'&&privateIp))throw new Error('Invalid update origin');
}
export function download(config,path,limit=MAX){
 return new Promise((done,fail)=>{const req=(config.origin.startsWith('https:')?httpsRequest:httpRequest)(config.origin+path,{ca:config.ca,headers:{authorization:'Bearer '+config.credential},timeout:120000},res=>{
  if(res.statusCode!==200){res.resume();fail(new Error('Machine update unavailable ('+res.statusCode+'); check enrollment or retry later'));return;}
  const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>limit){res.destroy(new Error('Update response too large'));return;}chunks.push(chunk);});res.on('error',fail);res.on('aborted',()=>fail(new Error('Update download interrupted')));res.on('end',()=>done(Buffer.concat(chunks)));
 });req.on('error',()=>fail(new Error('Cannot reach the machine update server')));req.on('timeout',()=>req.destroy(new Error('Update request timed out')));req.end();});
}
const run=(command,args,cwd)=>new Promise((done,fail)=>{const child=spawn(command,args,{cwd,stdio:'inherit',env:{...process.env,PATH:dirname(process.execPath)+delimiter+(process.env.PATH??''),OPENCRAFT_MACHINE_BOOTSTRAP:'',OPENCRAFT_MACHINE_KEY:''}});child.on('error',fail);child.on('exit',code=>code===0?done():fail(new Error('Update preparation or startup failed')));});
async function atomicJson(path,value){const temp=path+'.new';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,path);}
async function optional(path){try{return await readFile(path);}catch(e){if(e.code!=='ENOENT')throw e;return null;}}
const socketControl=(state,method)=>new Promise((done,fail)=>{const req=httpRequest({socketPath:join(state,'control.sock'),path:'/status',method,timeout:60000},res=>{res.resume();res.on('end',done);});req.on('error',fail);req.on('timeout',()=>req.destroy(new Error('Machine shutdown timed out')));req.end();});
const capture=(command,args)=>new Promise((done,fail)=>{const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',c=>out+=c);child.stderr.resume();child.on('error',fail);child.on('exit',()=>done(out));});
export async function stop(state,unit,commands={run,capture}){
 if(await optional(unit)){
  const name='opencraft-machine-'+JSON.parse(await readFile(join(state,'connection.json'),'utf8')).id+'.service';
  const query=async()=>{const out=await commands.capture('systemctl',['--user','show',name,'--property=LoadState','--property=ActiveState']);return Object.fromEntries(out.trim().split('\n').map(line=>line.split('=')));};
  const status=await query();
  // A rejected/unloaded unit with an inactive process has nothing left to stop.
  if(['inactive','failed'].includes(status.ActiveState))return;
  if(!['active','activating','deactivating','reloading'].includes(status.ActiveState))throw new Error('Machine service state is unknown; update was not replayed');
  await commands.run('systemctl',['--user','stop',name],state);
  if(!['inactive','failed'].includes((await query()).ActiveState))throw new Error('Machine service did not stop');
  return;
 }
 try{await socketControl(state,'DELETE');}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
}
async function linkRuntime(state,target){const runtime=join(state,'runtime'),temp=runtime+'.next';await rm(temp,{force:true});await symlink(target,temp);await rename(temp,runtime);}
async function start(state){await run(process.execPath,['--import',join(state,'runtime/node_modules/tsx/dist/loader.mjs'),join(state,'runtime/scripts/personal-machine/daemon.ts'),'--state',state,'--install'],join(state,'runtime'));}
async function restoreFile(path,encoded){if(encoded===null)await rm(path,{force:true});else{await mkdir(dirname(path),{recursive:true});await writeFile(path,Buffer.from(encoded,'base64'),{mode:0o600});}}
export async function activate(state,candidate,version,operations={stop,start}){
 state=await realpath(state);candidate=await realpath(candidate);
 const config=JSON.parse(await readFile(join(state,'connection.json'),'utf8'));
 const unit=join(homedir(),'.config/systemd/user/opencraft-machine-'+config.id+'.service'),runtime=join(state,'runtime');
 const current=await realpath(runtime),stat=await lstat(runtime);
 const inside=path=>{const p=relative(state,path);if(!p||p.startsWith('..')||isAbsolute(p))throw new Error('Update path is outside this machine');};inside(current);inside(candidate);if(current===candidate)throw new Error('No different runtime is available');
 const record={schemaVersion:1,previous:stat.isSymbolicLink()?current:join(state,'releases/legacy-'+randomUUID()),candidate,version,unit,unitBytes:(await optional(unit))?.toString('base64')??null,wrapperBytes:(await optional(join(state,'opencraft-machine')))?.toString('base64')??null,launcherBytes:(await optional(join(state,'launcher.mjs')))?.toString('base64')??null};
 await atomicJson(join(state,'update-pending.json'),record);
 await operations.stop(state,unit);
 if(!stat.isSymbolicLink())await rename(runtime,record.previous);
 await linkRuntime(state,candidate);
 try{
  await operations.start(state);
  await atomicJson(join(state,'update-version.json'),{schemaVersion:1,version,previous:record.previous});
  await rm(join(state,'update-pending.json'));
 }catch(error){
  await operations.stop(state,unit);
  await linkRuntime(state,record.previous);
  await restoreFile(unit,record.unitBytes);await restoreFile(join(state,'opencraft-machine'),record.wrapperBytes);await restoreFile(join(state,'launcher.mjs'),record.launcherBytes);
  if(record.wrapperBytes)await chmod(join(state,'opencraft-machine'),0o700);
  let recovered=false;try{await operations.start(state);recovered=true;}catch{}
  await rm(join(state,'update-pending.json'));
  throw new Error(recovered?'New runtime failed; previous runtime restored and restarted.':'New runtime failed; previous files restored, but the previous runtime also requires attention.');
 }
}
export async function recover(state,operations={stop,start},restart=true){
 state=await realpath(state);
 const record=JSON.parse(await readFile(join(state,'update-pending.json'),'utf8'));
 const config=JSON.parse(await readFile(join(state,'connection.json'),'utf8'));
 const unit=join(homedir(),'.config/systemd/user/opencraft-machine-'+config.id+'.service');
 if(record.schemaVersion!==1||record.unit!==unit)throw new Error('Invalid recovery record');
 for(const path of [record.previous,record.candidate]){const name=relative(state,path);if(!name||name.startsWith('..')||isAbsolute(name))throw new Error('Invalid recovery runtime');}
 await operations.stop(state,unit);
 try{await lstat(record.previous);await linkRuntime(state,record.previous);}catch(error){if(error.code!=='ENOENT')throw error;if((await lstat(join(state,'runtime'))).isSymbolicLink())throw new Error('Previous runtime is unavailable');}
 await restoreFile(unit,record.unitBytes);await restoreFile(join(state,'opencraft-machine'),record.wrapperBytes);await restoreFile(join(state,'launcher.mjs'),record.launcherBytes);
 if(record.wrapperBytes)await chmod(join(state,'opencraft-machine'),0o700);
 if(restart)await operations.start(state);await rm(join(state,'update-pending.json'));console.log(restart?'Interrupted update recovered; previous machine runtime started.':'Interrupted update restored; preparing the new runtime.');
}
export async function acquireUpdateLock(state,recovery=false){
 const lock=join(state,'update.lock'),staging=join(state,'.update-lock-'+process.pid+'-'+randomUUID());
 await mkdir(staging,{mode:0o700});await writeFile(join(staging,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});
 try{
  try{await rename(staging,lock);}catch(error){
   if(!['EEXIST','ENOTEMPTY'].includes(error.code)||!recovery)throw new Error('Another update holds the lock; use --recover only after an interrupted update.');
   const owner=JSON.parse(await readFile(join(lock,'owner.json'),'utf8'));
   if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw new Error('Invalid update lock owner');
   try{process.kill(owner.pid,0);throw new Error('The update process is still running; recovery did not change it.');}catch(e){if(e.code!=='ESRCH')throw e;}
   // Only explicit recovery may reclaim a lock whose recorded process has exited.
   await rm(lock,{recursive:true});await rename(staging,lock);
  }
  return lock;
 }finally{await rm(staging,{recursive:true,force:true});}
}
export async function runUpdate(state,action='--update'){
 state=await realpath(resolve(state));const config=JSON.parse(await readFile(join(state,'connection.json'),'utf8'));validateConnection(config);
 const lock=await acquireUpdateLock(state,action==='--recover');
 try{
  if(action==='--recover'){await recover(state);return;}
  if(await optional(join(state,'update-pending.json'))){if(action==='--update')await recover(state,{stop,start},false);else throw new Error('An interrupted update needs recovery; run --recover before another update.');}
  if(action==='--rollback'){
   const previous=JSON.parse(await readFile(join(state,'update-version.json'),'utf8')).previous;
   const version=(await readFile(join(previous,'.machine-version'),'utf8').catch(()=> 'legacy')).trim();
   await activate(state,previous,version);console.log('Previous machine runtime activated.');return;
  }
  const metadata=JSON.parse((await download(config,'/__opencraft_machines/bootstrap?update=1&id='+config.id,16384)).toString());
  if(metadata.schemaVersion!==1||metadata.id!==config.id||metadata.hubId!==config.hubId||metadata.origin!==config.origin||!/^[a-f0-9]{64}$/.test(metadata.digest))throw new Error('Update identity mismatch');
  const version=(await optional(join(state,'runtime/.machine-version')))?.toString().trim();
  if(version===metadata.digest){console.log('Machine runtime is up to date.');return;}
  if(action==='--check-update'){console.log('A machine runtime update is available: '+metadata.digest.slice(0,12));return;}
  if(process.versions.node!=='26.7.0')throw new Error('This update requires the installed private Node 26.7.0 runtime');
  await mkdir(join(state,'releases'),{recursive:true,mode:0o700});const candidate=join(state,'releases',metadata.digest);
  if(!await optional(join(candidate,'.machine-version'))){
   const bytes=await download(config,'/__opencraft_machines/source.tgz?update=1&id='+config.id);verifyArchive(bytes,metadata.digest);
   const staging=join(state,'releases','.candidate-'+randomUUID());await mkdir(staging,{mode:0o700});
   try{
    await writeFile(join(staging,'source.tgz'),bytes,{mode:0o600});await run('tar',['-xzf','source.tgz'],staging);await rm(join(staging,'source.tgz'));
    console.log('Preparing machine runtime; the current runtime remains active.');
    await run(process.platform==='win32'?'npm.cmd':'npm',['ci','--no-audit','--no-fund'],staging);
    await run('npm',['run','prepare:dsh-runtime'],staging);await run('npm',['run','build:preview-bridge'],staging);
    await writeFile(join(staging,'.machine-version'),metadata.digest+'\n',{mode:0o600});await rename(staging,candidate);
   }finally{await rm(staging,{recursive:true,force:true});}
  }
  await activate(state,candidate,metadata.digest);console.log('Machine runtime updated and connected. Previous runtime retained for rollback.');
 }finally{await rm(lock,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href){const args=process.argv.slice(2),i=args.indexOf('--state');if(i<0||!args[i+1])throw new Error('--state is required');await runUpdate(args[i+1],args.includes('--check-update')?'--check-update':args.includes('--rollback')?'--rollback':args.includes('--recover')?'--recover':'--update');}
