import fs from'node:fs';import{join}from'node:path';import{deploymentPaths}from'../../../../../scripts/container-deployment/paths.mjs';
/** Installation-private transport diagnostics; never request payloads or tokens. */
export function mirrorFailureReporter({credential,file}={}){
 let last='',at=0;
 return (error,{stage='unknown'}={})=>{
  let reason=String(error?.message??error).replaceAll(credential??'\u0000','[redacted]').replace(/https?:\/\/\S+/giu,'[url]').replace(/Bearer\s+\S+/giu,'Bearer [redacted]').replace(/\s+/gu,' ').slice(0,200);
  const key=stage+':'+reason;if(key===last&&Date.now()-at<60000)return;last=key;at=Date.now();
  try{const p=file??join(deploymentPaths().dataDirectory,'join-wecom-mirror-failures.log');if((fs.statSync(p,{throwIfNoEntry:false})?.size??0)>1048576)fs.renameSync(p,p+'.1');fs.appendFileSync(p,JSON.stringify({at:new Date().toISOString(),event:'wecom-mirror-target-failure',stage,error:reason})+'\n',{mode:0o600});}catch{}
 };
}
