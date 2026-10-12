import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdirSync,writeFileSync,renameSync,rmSync,readFileSync,chmodSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
 VelaBotAPI,VelaError,IM_METHODS,PLATFORM_METHODS,defaultGroupPolicy,isPolicyNotice,normalizeGroupID,platformGroupId,
 policyFromGroup,readLineage,replyCustomData,type GroupReplyPolicy,type IMMessage,type MessageInput,
} from './index.ts';
import {VelaNodeClient,safeJSON} from './node.ts';
import {Inbox} from './inbox.ts';

export const WORKER_VERSION='0.3.0';
const RECORDED_EVENTS=(name:string)=>['SDK_READY','SDK_NOT_READY','NET_STATE_CHANGE','KICKED_OUT','ERROR','CONVERSATION_LIST_UPDATED','PROFILE_UPDATED','BLACKLIST_UPDATED','USER_STATUS_UPDATED'].includes(name)
 ||['MESSAGE_','GROUP_','FRIEND_','TOPIC_'].some(prefix=>name.startsWith(prefix));
const BACKFILL_INTERVAL=120000;
const POLICY_TTL=5*60000;
/** A new inbox also picks up what arrived during provisioning (e.g. a group created right before the gateway restarted). */
const FIRST_START_LOOKBACK_SECONDS=10*60;

export interface WorkerOptions {
 /** LightVela backend base URL for Bot runtime calls, e.g. https://api.example.com/v1/collaboration. */
 apiURL:string;
 /** File holding this Bot's credential (0600). Re-read on every session so a rotated credential takes effect. */
 credentialFile:string;
 /** Holds inbox.sqlite and worker.json. */
 dir:string;
 /** Unix socket the Agent (plugin, CLI) talks to; access is limited by file permissions. See defaultSocketPath. */
 socketPath?:string;
 fileRoot?:string;
 /** The Agent process that owns this worker; the worker exits when it is gone. */
 parentPID?:number;
 log?:(...args:unknown[])=>void;
 /** Replace the Tencent-backed client and the backend client (tests). */
 client?:VelaNodeClient;
 api?:VelaBotAPI;
}
export interface RunningWorker {socketPath:string;ready:Promise<void>;client:VelaNodeClient;api:VelaBotAPI;inbox:Inbox;close():Promise<void>}

class HttpError extends Error {constructor(public status:number,message:string,public code:string|number=status){super(message)}}

/**
 * Unix socket paths are limited to ~107 bytes, so the socket lives in a short per-user directory (0700);
 * worker.json in the Agent's own directory records where it is.
 */
export function defaultSocketPath(dir:string):string {
 const root=join(tmpdir(),`vela-im-${process.getuid?.()??'user'}`);
 mkdirSync(root,{recursive:true,mode:0o700});
 chmodSync(root,0o700);
 return join(root,`${createHash('sha256').update(dir).digest('hex').slice(0,16)}.sock`);
}

/** One Agent ⇄ one worker ⇄ one Tencent IM login. Serves the Agent over a local Unix socket. */
export async function startWorker(o:WorkerOptions):Promise<RunningWorker> {
 const log=o.log??((...args:unknown[])=>console.error(new Date().toISOString(),'[vela-worker]',...args));
 mkdirSync(o.dir,{recursive:true,mode:0o700});
 const runtimePath=join(o.dir,'worker.json');
 const socketPath=o.socketPath??defaultSocketPath(o.dir);
 const inbox=new Inbox(join(o.dir,'inbox.sqlite'));inbox.prune();
 const client=o.client??new VelaNodeClient({fileRoot:o.fileRoot});
 const api=o.api??new VelaBotAPI(o.apiURL,()=>readFileSync(o.credentialFile,'utf8'));
 let online=false;let closing=false;
 let backfilling:Promise<boolean>|undefined;let backfillTimer:ReturnType<typeof setInterval>|undefined;let parentTimer:ReturnType<typeof setInterval>|undefined;

 const policies=new Map<string,{policy:GroupReplyPolicy;at:number}>();
 /** Reply rules come from the platform; groups it did not create keep the mention-only default. */
 const groupPolicy=async(conversationID:string):Promise<GroupReplyPolicy>=>{
  const groupID=normalizeGroupID(conversationID.replace(/^GROUP/,''));
  const cached=policies.get(groupID);
  if(cached&&Date.now()-cached.at<POLICY_TTL)return cached.policy;
  const id=platformGroupId(groupID);
  let policy=defaultGroupPolicy(groupID);
  if(id) {
   try {policy=policyFromGroup(await api.group(id))}
   catch(e:any) {
    if(e?.status!==404)throw e;
   }
  }
  policies.set(groupID,{policy,at:Date.now()});
  return policy;
 };

 /** Resolves true once Tencent's conversation sync allowed a complete pass, false if it should be retried. */
 const backfill=()=>backfilling??=(async()=>{
  const since=inbox.syncTime(Math.floor(Date.now()/1000)-FIRST_START_LOOKBACK_SECONDS);const started=Math.floor(Date.now()/1000);
  const conversations=(await client.call('getConversationList')).data;
  if(conversations?.isSyncCompleted===false)return false; // SDK 正在同步，不提前推进补拉水位。
  for(const c of conversations?.conversationList??[]) {
   if(c.type!=='C2C'&&c.type!=='GROUP')continue;
   if(c.lastMessage?.lastTime&&c.lastMessage.lastTime<since)continue;
   let next:string|undefined;let complete=false;
   for(let page=0;page<100;page++) {
    const r=await client.getMessages(c.conversationID,{count:15,...(next?{nextReqMessageID:next}:{})});
    const list=r.messageList??[];
    for(const m of list)if(m.time>=since&&m.from!==client.userID)inbox.save('MESSAGE_RECEIVED',[safeJSON(m)]);
    if(r.isCompleted||!list.length||list.some((m:any)=>m.time<since)){complete=true;break}
    next=r.nextReqMessageID;
   }
   // 达到分页上限时显式记录事件并保持水位，避免静默丢失。
   if(!complete){inbox.save('SYNC_INCOMPLETE',{conversationID:c.conversationID});return true}
  }
  inbox.synced(started-5);
  return true;
 })().catch(e=>{log('backfill failed:',e?.message??e);return false}).finally(()=>{backfilling=undefined});

 let markReady:()=>void;const ready=new Promise<void>(resolve=>{markReady=resolve});
 const connect=async()=>{
  for(let attempt=0;!closing;attempt++) {
   try {
    await client.connect(()=>api.credentials());
    for(const name of Object.keys(client.TencentCloudChat.EVENT))if(RECORDED_EVENTS(name))client.on(name,(event:any)=>{
     try{inbox.save(name,safeJSON(event.data))}catch(e:any){log('inbox write failed:',e?.message)}
     if(name==='SDK_READY')void backfill();
     if(name==='MESSAGE_RECEIVED')for(const m of event.data??[])if(isPolicyNotice(m))policies.delete(normalizeGroupID(String(m.conversationID??'').replace(/^GROUP/,'')));
    });
    // Messages that arrived while no worker was online are in the inbox before the Agent is told we are ready.
    for(let i=0;i<30&&!closing&&!await backfill();i++)await new Promise(r=>setTimeout(r,1000));
    backfillTimer=setInterval(()=>void backfill(),BACKFILL_INTERVAL);backfillTimer.unref();
    online=true;writeRuntime();markReady();
    log(`IM identity ${client.userID} online`);
    return;
   } catch(e:any) {
    if(e?.status===401||e?.status===403){log('bot credential rejected:',e.message);await shutdown(2);return}
    const delay=Math.min(60000,2000*2**attempt);
    log(`connect failed (${e?.code??''} ${e?.message??e}); retry in ${delay/1000}s`);
    await client.disconnect().catch(()=>{});
    await new Promise(r=>setTimeout(r,delay));
   }
  }
 };

 const body=async(req:IncomingMessage):Promise<any>=>{
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>150*1024*1024)throw new HttpError(413,'请求体过大');chunks.push(chunk)}
  if(!size)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new HttpError(400,'JSON 无效')}
 };
 const whenOnline=async()=>{
  await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new HttpError(503,'IM 连接尚未就绪','NOT_READY')),30000))]);
 };
 const identity=()=>{const bot=api.identity;return bot?{id:bot.userId,kind:'bot' as const,name:bot.displayName}:{id:client.userID}};
 const routes:Record<string,(req:IncomingMessage,url:URL)=>Promise<unknown>>={
  'GET /health':async()=>({ok:true,ready:online,userID:client.userID||null,pid:process.pid,version:WORKER_VERSION}),
  'GET /capabilities':async()=>{await whenOnline();return {...client.capabilities(),identity:identity()}},
  /** Who controls this Bot: its command policy and every identity of its owner. Refreshed from the platform. */
  'GET /control':async()=>{await whenOnline();const me=await api.me();return {identity:identity(),commandPolicy:me.commandPolicy,owner:{userIds:me.ownerUserIds}}},
  'POST /call':async req=>{
   await whenOnline();const b=await body(req);
   if(typeof b.method!=='string'||(b.args!==undefined&&!Array.isArray(b.args)))throw new HttpError(400,'需要 method 和 args 数组');
   return client.call(b.method,b.args??[]);
  },
  'POST /invoke':async req=>{
   await whenOnline();const b=await body(req);
   if(!(IM_METHODS as readonly string[]).includes(b.method))throw new HttpError(400,`未知的 IM 操作 ${b.method}`,'UNKNOWN_OPERATION');
   if(b.args!==undefined&&!Array.isArray(b.args))throw new HttpError(400,'args 必须是数组');
   return (client as any)[b.method](...(b.args??[]));
  },
  /** Platform group operations, performed as this Bot under the same permissions as a human member. */
  'POST /platform':async req=>{
   const b=await body(req);
   if(!(PLATFORM_METHODS as readonly string[]).includes(b.method))throw new HttpError(400,`未知的平台操作 ${b.method}`,'UNKNOWN_OPERATION');
   if(b.args!==undefined&&!Array.isArray(b.args))throw new HttpError(400,'args 必须是数组');
   const result=await (api as any)[b.method](...(b.args??[]));
   if(b.method!=='me')policies.clear();
   return result??{ok:true};
  },
  'POST /send':async req=>{
   await whenOnline();const input=await body(req) as MessageInput;
   if(input.replyToMessageID&&!input.cloudCustomData) {
    const parent=inbox.message(input.replyToMessageID);
    if(parent)input.cloudCustomData=replyCustomData(readLineage(parent));
   }
   delete input.replyToMessageID;
   return client.send(input);
  },
  'POST /group-reply':async req=>{
   await whenOnline();const b=await body(req);
   const message:IMMessage|undefined=typeof b.messageID==='string'?inbox.message(b.messageID):undefined;
   if(!message)throw new HttpError(404,'当前身份的 inbox 中没有这条消息','MESSAGE_NOT_FOUND');
   if(!message.conversationID?.startsWith('GROUP'))throw new HttpError(400,'需要群消息','NOT_GROUP_MESSAGE');
   return client.prepareGroupReply(message,await groupPolicy(message.conversationID),{maxAgentHops:b.maxAgentHops??6});
  },
  'GET /events':async(req,url)=>{
   const after=Number(url.searchParams.get('after')??0),wait=Number(url.searchParams.get('wait')??25000);
   if(!Number.isSafeInteger(after)||after<0||!Number.isFinite(wait)||wait<0||wait>30000)throw new HttpError(400,'事件游标或等待时间无效');
   let events=inbox.events(after);
   if(!events.length&&wait) {
    await new Promise<void>(resolve=>{
     const finish=()=>{clearTimeout(timer);inbox.signals.off('event',finish);req.off('close',finish);resolve()};
     const timer=setTimeout(finish,wait);inbox.signals.once('event',finish);req.once('close',finish);
     if(inbox.lastSeq()>after)finish();
    });
    events=inbox.events(after);
   }
   return {events,cursor:events.at(-1)?.seq??after};
  },
 };
 const server=createServer((req,res:ServerResponse)=>{
  const reply=(status:number,value:unknown)=>{
   const text=JSON.stringify(value)??'null';
   if(!res.headersSent)res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
   res.end(text);
  };
  const url=new URL(req.url??'/','http://worker.local');
  const route=routes[`${req.method} ${url.pathname}`];
  if(!route)return reply(404,{error:'路径不存在',code:404});
  route(req,url).then(v=>reply(200,safeJSON(v)??null),(e:any)=>{
   const status=e instanceof HttpError?e.status:e instanceof VelaError?(e.status||400):typeof e?.code==='number'?400:500;
   if(status===500)log('request failed:',req.method,url.pathname,e?.stack??e);
   reply(status,{error:String(e?.message??'IM 操作失败').split('\n')[0],code:e?.code??status});
  });
 });
 server.requestTimeout=0;
 if(existsSync(socketPath))rmSync(socketPath,{force:true});
 const previousMask=process.umask(0o177);
 try {await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>resolve())})}
 finally {process.umask(previousMask)}
 chmodSync(socketPath,0o600);
 const writeRuntime=()=>{
  const temp=`${runtimePath}.${process.pid}.tmp`;
  writeFileSync(temp,JSON.stringify({pid:process.pid,socket:socketPath,ready:online,userID:client.userID||null,startedAt:Date.now(),version:WORKER_VERSION}),{mode:0o600});
  chmodSync(temp,0o600);renameSync(temp,runtimePath);
 };
 writeRuntime();

 const shutdown=async(code?:number)=>{
  if(closing)return;closing=true;
  clearInterval(backfillTimer);clearInterval(parentTimer);
  server.closeAllConnections?.();server.close();
  await client.disconnect().catch(()=>{});
  try{if(JSON.parse(readFileSync(runtimePath,'utf8')).pid===process.pid){rmSync(runtimePath,{force:true});rmSync(socketPath,{force:true})}}catch{}
  inbox.close();
  if(code!==undefined)process.exit(code);
 };
 if(o.parentPID) {
  parentTimer=setInterval(()=>{try{process.kill(o.parentPID!,0)}catch{log('owning Agent process exited; stopping');void shutdown(0)}},3000);
  parentTimer.unref();
 }
 void connect();
 return {socketPath,ready,client,api,inbox,close:()=>shutdown()};
}
