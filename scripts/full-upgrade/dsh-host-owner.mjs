import {readPrivateJson,invariant} from './durable.mjs';
/** DSH keeps its existing consumer descriptor; handoff adds a separate private
 * control listener so releasing native/Host resources cannot wait on itself. */
export function dshHostOwner(descriptorPath) {
  const rpc=async(action,input={})=>{
    const descriptor=await readPrivateJson(descriptorPath),control=descriptor.ownerHandoff;
    invariant(descriptor.schemaVersion===1 && control?.protocol===1 && typeof control.token==='string','dsh-owner-protocol-required');
    const url=new URL(control.url);
    invariant(url.protocol==='http:' && url.hostname==='127.0.0.1' && url.pathname==='/owner-handoff' && !url.username && !url.password && !url.search && !url.hash,'invalid-dsh-owner-descriptor');
    const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+control.token,'content-type':'application/json'},
      body:JSON.stringify({action,...input}),signal:AbortSignal.timeout(120000)});
    invariant(response.ok,'dsh-owner-control-rejected');
    const bytes=await response.text();invariant(bytes.length<=16*1024*1024,'dsh-owner-response-limit');
    const value=JSON.parse(bytes);
    invariant(value.pid===descriptor.pid && typeof value.bootId==='string' && typeof value.handoff?.owner==='string','dsh-owner-identity-unavailable');
    return value;
  };
  return {snapshot:()=>rpc('inspect'),acquireFence:input=>rpc('fence',input),inspectDrain:input=>rpc('inspect',input),
    releaseWriter:input=>rpc('release',input),coldReady:input=>rpc('cold-ready',input),
    releaseFence:(input,ready)=>rpc('resume',{...input,identity:ready.handoff.ready.identity})};
}
