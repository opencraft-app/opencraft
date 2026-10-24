#!/usr/bin/env node
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { socketRequest } from '../../packages/observability-contract/node.mjs';
import { fault, schemaVersion } from '../../packages/observability-contract/index.mjs';
import { compare, issues } from '../../packages/observability-query/index.mjs';
export async function run(argv,env=process.env) {
  const command=argv.shift();const options={};
  for(let i=0;i<argv.length;i++){const key=argv[i];if(key==='--json'){options.json=true;continue;}if(!['--target','--window','--from','--to','--out','--ref','--snapshot','--finding','--before','--after','--operation','--cache','--engine'].includes(key)||options[key.slice(2)]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))throw fault('invalid_arguments');options[key.slice(2)]=argv[++i];}
  if(!['capabilities','status','snapshot','incident','issues','explain','compare'].includes(command))throw fault('invalid_command');
  const offline=async path=>{if(!path)throw fault('missing_file_argument');const info=await lstat(path);if(!info.isFile()||info.size>1048576)throw fault('invalid_snapshot');const value=JSON.parse(await readFile(path,'utf8'));if(value.schemaVersion!==schemaVersion)throw fault('incompatible_schema',409);return value;};
  let result;
  if(command==='issues')result={schemaVersion,findings:issues(await offline(options.snapshot))};
  else if(command==='explain'){const snapshot=await offline(options.snapshot);const finding=issues(snapshot).find(f=>f.id===options.finding);if(!finding)throw fault('unknown_finding');result={schemaVersion,snapshotId:snapshot.snapshotId,window:snapshot.window,finding,unchanged:true,evidenceExpiresAt:snapshot.evidenceExpiresAt,evidenceAvailability:Date.parse(snapshot.evidenceExpiresAt)<Date.now()?"expired":snapshot.captureStatus,evidenceRefs:snapshot.events?.filter(e=>e.incidentRef).map(e=>e.incidentRef)??[]};}
  else if(command==='compare')result=compare(await offline(options.before),await offline(options.after),{...(options.operation?{operationType:options.operation}:{}),...(options.cache?{cache:options.cache}:{}),...(options.engine?{engine:options.engine}:{})});
  else {
    const target=options.target??env.OPENCRAFT_OBSERVE_TARGET;
    if(!target?.startsWith('unix:///'))throw fault('target_required');
    const targetUrl=new URL(target);if(targetUrl.search||targetUrl.hash||targetUrl.hostname)throw fault('invalid_target');
    const socketPath=decodeURIComponent(targetUrl.pathname);
    if(command==='capabilities')result=await socketRequest(socketPath,'/capabilities');
    else {
      let from=options.from,to=options.to;
      if(options.window){const match=/^(\d+)(m|h)$/u.exec(options.window);if(!match||from||to)throw fault('invalid_window');const ms=Number(match[1])*(match[2]==='h'?3600000:60000);if(ms<=0||ms>86400000)throw fault('invalid_window');to=new Date().toISOString();from=new Date(Date.parse(to)-ms).toISOString();}
      result=await socketRequest(socketPath,command==='status'?'/query':`/${command}`,{...(command==='status'?{name:'platform.status'}:{}),...(from?{from}:{}),...(to?{to}:{}),...(options.ref?{ref:options.ref}:{})});
    }
    if(result.schemaVersion!==schemaVersion)throw fault('incompatible_schema',409);
  }
  result={...result,clientIdentity:{component:'cli',sourceRevision:process.env.OPENCRAFT_OBSERVE_SOURCE_REVISION??null,buildId:process.env.OPENCRAFT_OBSERVE_BUILD_ID??null}};
  if(options.out)await writeFile(resolve(options.out),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  try{console.log(JSON.stringify(await run(process.argv.slice(2))));}catch(error){const code=error.code??'invalid_arguments';console.log(JSON.stringify({schemaVersion,error:{code}}));process.exitCode=error.status===401?3:error.status===403||code==='EACCES'?4:error.status===409?6:error.status>=500?5:2;}
}
