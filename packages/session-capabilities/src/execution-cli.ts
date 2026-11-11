import { randomBytes } from 'node:crypto';
import { executionCliSourceSession } from './credentials.js';
import { issueThreadCli } from './thread-cli-provider.js';

/** Server→Host admission port: signed source + live Server authority recheck. */
export function hostExecutionCli(options:{directory:string;endpoint:string;key:Buffer;launcherEndpoint?:()=>string}) {
  const endpoint=new URL(options.endpoint);
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/thread-cli'
    ||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||options.key.length!==32)throw Error('cliUnavailable');
  const active=new Map<string,string>();
  return {async forward(token:string,body:unknown) {
    const credential=active.get(token);
    if(!credential)throw Error('cliUnavailable');
    try {
      const response=await fetch(options.endpoint,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},
        body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30_000)});
      const result=await response.json();
      if(!active.has(token))return {status:503,body:{error:'thread_cli_outcome_unknown'}};
      return {status:response.status,body:result};
    }catch {
      // After forwarding begins a network/parse failure is not a definitive refusal.
      return {status:503,body:{error:'thread_cli_outcome_unknown'}};
    }
  },async issue(source:{serverId:string;threadId:string;credential:string}) {
    const session=executionCliSourceSession(options.key,source.credential);
    if(session.serverId!==source.serverId||session.threadId!==source.threadId)throw Error('cliUnavailable');
    const authorize=async()=>{
      const response=await fetch(new URL('/execution-admission',options.endpoint),{method:'POST',
        headers:{authorization:'Bearer '+source.credential,'content-type':'application/json'},body:'{}',
        redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error('cliUnavailable');
    };
    // Authorize before publication; only this live Host lease forwards the bearer.
    await authorize();
    if(!options.launcherEndpoint)throw Error('cliUnavailable');
    const token=randomBytes(32).toString('base64url');
    const lease=await issueThreadCli(options.directory,session,{url:options.launcherEndpoint(),token});
    active.set(token,source.credential);
    return {...lease,revoke:async()=>{active.delete(token);await lease.revoke();}};
  }};
}

/** Wait for the durable native Turn binding without granting pre-Turn CLI writes. */
export async function waitForExecutionCliBinding(check:()=>Promise<{turnId:string|null}>,timeoutMs=5000):Promise<void> {
  const deadline=Date.now()+timeoutMs;
  for(;;) {
    if((await check()).turnId)return;
    if(Date.now()>=deadline)throw Error('cliUnavailable');
    await new Promise(resolve=>setTimeout(resolve,Math.min(25,Math.max(0,deadline-Date.now()))));
  }
}
