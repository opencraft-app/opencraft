// An IM identity for acceptance scripts: its own worker process (the same runtime an Agent uses), driven over loopback.
import {spawn} from 'node:child_process';
import {readFileSync,rmSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const WORKER=fileURLToPath(new URL('../../sdk/dist/vela-im-worker.mjs',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export async function startPeer(apiURL,token,dir,{fresh=true}={}) {
 if(fresh)rmSync(dir,{recursive:true,force:true});
 mkdirSync(dir,{recursive:true});
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',WORKER],{stdio:['ignore','ignore','pipe'],
  env:{...process.env,VELA_API_URL:apiURL,VELA_IDENTITY_TOKEN:token,VELA_WORKER_DIR:dir,VELA_WORKER_PARENT_PID:String(process.pid)}});
 let log='';child.stderr.on('data',d=>{log=(log+d).slice(-4000)});
 let runtime;
 for(let i=0;i<300;i++){
  if(child.exitCode!==null)throw new Error(`worker exited ${child.exitCode}: ${log}`);
  try{runtime=JSON.parse(readFileSync(join(dir,'worker.json'),'utf8'))}catch{}
  if(runtime?.ready&&runtime.pid===child.pid)break;
  await sleep(100);
 }
 if(!runtime?.ready)throw new Error('worker did not come online: '+log);
 const request=async(path,body)=>{
  const r=await fetch(`http://127.0.0.1:${runtime.port}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${runtime.secret}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();
  if(!r.ok)throw Object.assign(new Error(`${path}: ${data.error}`),{status:r.status,code:data.code});
  return data;
 };
 let cursor=(await request('/events?after=0&wait=0')).cursor;
 const peer={
  id:runtime.userID,pid:child.pid,dir,
  request,
  invoke:(method,...args)=>request('/invoke',{method,args}),
  send:input=>request('/send',input),
  text:(to,text,conversationType='C2C',extra={})=>request('/send',{to,conversationType,type:'text',payload:{text},...extra}),
  capabilities:()=>request('/capabilities'),
  prepareGroupReply:(messageID,maxAgentHops=6)=>request('/group-reply',{messageID,maxAgentHops}),
  /** Wait for an inbox event matching predicate, consuming from this peer's cursor. */
  async waitEvent(predicate,timeout=20000,event='MESSAGE_RECEIVED') {
   const deadline=Date.now()+timeout;
   while(Date.now()<deadline){
    const batch=await request(`/events?after=${cursor}&wait=${Math.min(10000,Math.max(0,deadline-Date.now()))}`);
    cursor=batch.cursor;
    const hit=batch.events.find(e=>e.event===event&&predicate(e.data));
    if(hit)return hit.data;
   }
   throw new Error(`${peer.id}: no ${event} within ${timeout}ms`);
  },
  async until(fn,timeout=15000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await fn();if(last)return last;await sleep(400)}throw new Error('condition not met')},
  stop:()=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',()=>resolve());child.kill('SIGTERM')}),
 };
 return peer;
}
