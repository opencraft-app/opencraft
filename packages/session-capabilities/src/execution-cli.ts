import { randomBytes } from 'node:crypto';
import { executionCliSourceSession } from './credentials.js';
import { issueThreadCli,reserveThreadCli } from './thread-cli-provider.js';

/** Server→Host admission port: signed source + live Server authority recheck. */
export function hostExecutionCli(options:{directory:string;endpoint:string;key:Buffer;launcherEndpoint?:()=>string}) {
  const endpoint=new URL(options.endpoint);
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/thread-cli'
    ||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||options.key.length!==32)throw Error('cliUnavailable');
  const active=new Map<string,string>();
  const initial=new Map<string,{slot:Awaited<ReturnType<typeof reserveThreadCli>>;token?:string}>();
  const scopeKey=(scope:{serverId:string;threadId:string})=>JSON.stringify([scope.serverId,scope.threadId]);
  return {async reserve(scope:{serverId:string;threadId:string}) {
    const key=scopeKey(scope);
    if(initial.has(key))throw Error('CLI reservation already exists');
    const slot=await reserveThreadCli(options.directory);
    if(initial.has(key)){await slot.revoke();throw Error('CLI reservation already exists');}
    const reservation={slot,token:undefined as string|undefined};
    initial.set(key,reservation);
    return {environment:slot.environment,async revoke(){
      if(initial.get(key)===reservation)initial.delete(key);
      if(reservation.token)active.delete(reservation.token);
      await slot.revoke();
    }};
  },async forward(token:string,body:unknown) {
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
    const key=scopeKey(source),reserved=initial.get(key);
    // A reserved namespace binds exactly once, after both signature and live admission.
    const connection={url:options.launcherEndpoint(),token};
    const lease=reserved?.slot??await issueThreadCli(options.directory,session,connection);
    if(reserved){await reserved.slot.publish(connection);reserved.token=token;initial.delete(key);}
    active.set(token,source.credential);
    return {environment:lease.environment,launcher:lease.launcher,connectionFile:lease.connectionFile,...(reserved?{async rejectBeforeStart(){
      active.delete(token);
      await reserved.slot.rejectBeforeStart();
      if(initial.has(key))throw Error('CLI reservation conflict');
      reserved.token=undefined;initial.set(key,reserved);
      return {environment:reserved.slot.environment,async revoke(){
        if(initial.get(key)===reserved)initial.delete(key);
        if(reserved.token)active.delete(reserved.token);
        await reserved.slot.revoke();
      }};
    }}:{}),revoke:async()=>{active.delete(token);await lease.revoke();}};
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
