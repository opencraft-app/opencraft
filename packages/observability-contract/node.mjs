import { request } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createEventQueue } from './queue.mjs';
import { limits, fault } from './index.mjs';
/** An operator-owned Grafana path; browser input never selects this upstream. */
export function observationGrafanaBasePath(value = '/__opencraft_observe/grafana') {
  if (typeof value !== 'string' || value.length > 512
    || !/^(?:\/[A-Za-z0-9._~-]+)*\/__opencraft_observe\/grafana$/u.test(value)
    || new URL(value, 'http://localhost').pathname !== value) throw Error('Invalid observation Grafana base path');
  return value;
}
export function socketRequest(socketPath,path,body,method=body===undefined?'GET':'POST') {
  return new Promise((resolve,reject)=>{
    const encoded=body===undefined?undefined:JSON.stringify(body);
    const req=request({socketPath,path,method,headers:encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{}},res=>{
      const chunks=[];let bytes=0;res.on('data',chunk=>{bytes+=chunk.length;if(bytes>limits.responseBytes)req.destroy(fault('result_too_large',413));else chunks.push(chunk);});
      res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode>=400)reject(fault(value.error?.code??'backend_failure',res.statusCode));else resolve(value);}catch{reject(fault('invalid_backend_response',502));}});res.on('error',()=>reject(fault('backend_unreachable',503)));
    });req.setTimeout(4500,()=>req.destroy());req.on('error',error=>reject(fault(error.code==='EACCES'?'forbidden':'backend_unreachable',error.code==='EACCES'?403:503)));req.end(encoded);
  });
}
const instances=new Map();
export function nodeObserver(component,{socketPath=process.env.OPENCRAFT_OBSERVE_SOCKET,sourceRevision=process.env.OPENCRAFT_OBSERVE_SOURCE_REVISION??null,buildId=process.env.OPENCRAFT_OBSERVE_BUILD_ID??null,processResources=true}={}) {
  if(!socketPath?.startsWith('/'))return {emit:()=>false,close:()=>{},execution:()=>{},queue:()=>{}};
  const key=component+':'+socketPath;if(instances.has(key))return instances.get(key);
  const queue=createEventQueue(),producerId=randomUUID();let timer,busy=false,closed=false,failures=0,transportDropped=0,healthTimer;
  async function flush(){timer=undefined;if(busy||closed)return;const events=queue.take();if(!events.length)return;busy=true;try{await socketRequest(socketPath,'/events',{events});failures=0;}catch{failures++;transportDropped+=events.length;}finally{busy=false;if(queue.stats().pending&&!closed){timer=setTimeout(flush,Math.min(60000,10000*2**Math.min(3,failures)));timer.unref();}}}
  function emit(fields){try{if(closed)return false;const accepted=queue.emit({schemaVersion:1,component,producerId,eventId:randomUUID(),at:Date.now(),...(fields.outcome==='failed'||fields.outcome==='timeout'?{incidentRef:randomUUID()}:{}),...fields});if(accepted&&!timer&&!busy){timer=setTimeout(flush,10000);timer.unref();}return accepted;}catch{return false;}}
  if(processResources){
    const heartbeat=()=>{emit({kind:'resource',sourceRevision,buildId,rssBytes:process.memoryUsage().rss,heapBytes:process.memoryUsage().heapUsed,cpuSeconds:(process.cpuUsage().system+process.cpuUsage().user)/1e6,observedBy:'self',identitySource:'self',producerMode:'native',dropped:queue.stats().dropped+transportDropped,rejected:queue.stats().rejected,originClass:'operator'});};
    heartbeat();healthTimer=setInterval(heartbeat,30000);healthTimer.unref();
  }
  const observer={emit,stats:queue.stats,close(){closed=true;clearTimeout(timer);if(healthTimer)clearInterval(healthTimer);instances.delete(key);},
    queue(engine,threadId,count){try{
      if(typeof threadId!=='string'||!Number.isSafeInteger(count)||count<0)return;
      const executionId=createHash('sha256').update(JSON.stringify([engine,threadId])).digest('hex');
      emit({kind:'queue',engine,executionId,count,stage:'queued',measurementScope:'domain',originClass:'unknown'});
    }catch{}},
    execution(engine,method,params){try{
      const waitingHuman=['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput','item/permissions/requestApproval'].includes(method);
      if(!waitingHuman&&!['turn/started','turn/completed','item/started','item/completed','turn/plan/updated'].includes(method))return;
      const turn=params?.turn,turnId=turn?.id??params?.turnId,threadId=params?.threadId??params?.thread?.id;
      if(typeof turnId!=='string'||typeof threadId!=='string')return;
      const executionId=createHash('sha256').update(JSON.stringify([engine,threadId,turnId])).digest('hex');
      const outcome=method==='turn/started'?'started':method==='turn/completed'?turn?.status==='completed'?'ok':turn?.status==='interrupted'?'aborted':turn?.status==='failed'?'failed':'unknown':'progress';
      const type=params?.item?.type;
      const stage=waitingHuman?'human':method==='turn/started'?'running':method==='turn/completed'?outcome==='ok'?'completed':outcome==='failed'?'failed':'other':type==='agentMessage'?'model':['commandExecution','mcpToolCall','dynamicToolCall','fileChange'].includes(type)?'tool':'other';
      emit({kind:'execution',executionId,engine,outcome,stage,measurementScope:'domain',originClass:'unknown'});
      }catch{/* Telemetry must never affect the native notification owner. */}
    }};instances.set(key,observer);return observer;
}
