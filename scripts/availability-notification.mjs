import { createServer } from 'node:http';
import { readFile, mkdir, chmod, lstat, unlink, open } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readPrivateJson } from '../packages/identity-core/src/node.ts';

/** Separate private Unix socket; never registered with HTTP ingress/relay routes. */
export async function startAvailabilityNotification(configFile, getService) {
  if(!configFile)return null;
  const config=await readPrivateJson(configFile);
  if(!config.socketPath?.startsWith('/')||!config.tokenFile?.startsWith('/')||!config.receiptsFile?.startsWith('/')
    ||!config.channelId||!config.senderId||!config.actorId)throw Error('invalid_notification_configuration');
  const token=(await readFile(config.tokenFile,'utf8')).trim();
  if(token.length<32)throw Error('invalid_notification_token');
  const hash=value=>createHash('sha256').update(value).digest();
  await mkdir(dirname(config.socketPath),{recursive:true,mode:0o700});
  // Reclaim only an owned, refused Unix socket left by a dead process.
  try{
    const info=await lstat(config.socketPath);
    if(!info.isSocket()||info.uid!==process.getuid())throw Error('notification_socket_exists');
    const stale=await new Promise(resolve=>{const socket=createConnection(config.socketPath);socket.on('connect',()=>{socket.destroy();resolve(false);});socket.on('error',e=>resolve(e.code==='ECONNREFUSED'));socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});});
    if(!stale)throw Error('notification_socket_in_use');await unlink(config.socketPath);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  let active=0;const claims=new Set();
  const receipts=new Map();
  try{for(const line of (await readFile(config.receiptsFile,'utf8')).trim().split('\n').filter(Boolean)){const row=JSON.parse(line);receipts.set(row.receiptId,row);}}catch(error){if(error.code!=='ENOENT')throw error;}
  async function record(row){const fd=await open(config.receiptsFile,'a',0o600);try{await fd.writeFile(JSON.stringify(row)+'\n');await fd.sync();}finally{await fd.close();}receipts.set(row.receiptId,row);}
  const server=createServer(async(req,res)=>{
    const reply=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    if(req.method!=='POST'||req.url!=='/notify'){reply(404,{});return;}
    if(!timingSafeEqual(hash(req.headers.authorization??''),hash('Bearer '+token))){reply(401,{});return;}
    if(active>=16){reply(429,{});return;}active++;let claimedId;
    try{
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096)throw Error();}
      const input=JSON.parse(body);
      if(Object.keys(input).some(key=>!['incidentId','kind','site','hostId','engine','errorCode'].includes(key))
        ||!['alert','recovery'].includes(input.kind)||![input.incidentId,input.site,input.hostId,input.engine,input.errorCode].every(v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,80}$/.test(v)))throw Error();
      const receiptId=input.incidentId+':'+input.kind;
      const prior=receipts.get(receiptId);
      if(prior&&prior.status!=='retryable'){reply(prior.delivered?200:409,prior);return;}
      if(claims.has(receiptId)){reply(409,{error:'notification_in_flight'});return;}
      const service=getService();if(!service) {reply(503,{});return;}
      let deliver;try{deliver=service.prepareOperatorNotification(config.channelId,config.senderId,config.actorId);}catch{reply(503,{error:'notification_unavailable'});return;}
      const text=`${input.kind==='alert'?'连接失败':'连接恢复'} · ${input.site}\n${input.hostId} · ${input.engine}${input.kind==='alert'?'\n'+input.errorCode:''}`;
      claims.add(receiptId);claimedId=receiptId;
      await record({receiptId,delivered:false,status:'sending',at:Date.now()});
      try{
        const receipt=await deliver(text,receiptId);
        const row={...receipt,status:'delivered',at:Date.now()};await record(row);reply(200,row);
      }catch(error){const retryable=['not_sent','rejected'].includes(error?.deliveryState);await record({receiptId,delivered:false,status:retryable?'retryable':'unknown',at:Date.now()});reply(retryable?503:502,{error:retryable?'notification_retryable':'notification_delivery_unknown'});}
    }catch{reply(400,{error:'invalid_notification'});}finally{active--;if(claimedId)claims.delete(claimedId);}
  });
  await new Promise((yes,no)=>{server.once('error',no);server.listen(config.socketPath,yes);});await chmod(config.socketPath,0o600);
  return {close:async()=>{await new Promise(done=>server.close(done));await unlink(config.socketPath).catch(error=>{if(error.code!=='ENOENT')throw error;});}};
}
