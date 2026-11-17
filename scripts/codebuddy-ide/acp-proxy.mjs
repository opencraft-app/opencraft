import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
const config=JSON.parse(await readFile(process.env.OPENCRAFT_CODEBUDDY_IDE_DESCRIPTOR,'utf8'));
const endpoint=new URL(config.url);if(endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1')throw new Error('Invalid IDE bridge address');endpoint.pathname='/proxy';
const socket=new WebSocket(endpoint,{headers:{authorization:'Bearer '+config.proxyToken},maxPayload:2*1024*1024});
await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
const pending=new Map(),sessions=new Map();
socket.on('message',bytes=>{try{const packet=JSON.parse(String(bytes)),task=pending.get(packet.id);if(!task)return;pending.delete(packet.id);packet.error?task.reject(new Error('IDE operation was not confirmed')):task.resolve(packet.result);}catch{socket.close();}});
socket.on('close',()=>{for(const task of pending.values())task.reject(new Error('IDE bridge disconnected'));pending.clear();process.exitCode=1;process.stdin.destroy();});
const call=(method,params)=>new Promise((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const send=packet=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...packet})+'\n');
const catalog={currentModelId:'current',availableModels:[{modelId:'current',name:'CodeBuddy IDE'}]};
async function request(method,params){
 if(method==='initialize'){await call('describe',{});return {protocolVersion:1,agentInfo:{name:'CodeBuddy IDE'},agentCapabilities:{loadSession:true,promptCapabilities:{}}};}
 if(method==='session/new'||method==='session/load'||method==='session/resume'){
  const result=await call(method==='session/new'?'new':'resume',params);sessions.set(result.sessionId,{cwd:params.cwd});return {...result,models:catalog};
 }
 if(method==='session/set_model'){if(params.modelId!=='current')throw new Error('Select the model in CodeBuddy IDE');return {};}
 if(method==='session/set_mode')throw new Error('Set permissions in CodeBuddy IDE');
 if(method==='session/prompt'){
  const session=sessions.get(params.sessionId);if(!session)throw new Error('IDE session not loaded');
  if(!Array.isArray(params.prompt)||params.prompt.some(part=>part.type!=='text'||typeof part.text!=='string'))throw new Error('This IDE bridge accepts text messages only');
  const result=await call('prompt',{sessionId:params.sessionId,cwd:session.cwd,text:params.prompt.map(part=>part.text).join('\n')});
  for(const message of result.messages)send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:message.text}}}});
  return {stopReason:'end_turn'};
 }
 throw new Error('Unsupported IDE method');
}
let lineBytes=0;process.stdin.on('data',chunk=>{for(const byte of chunk){lineBytes=byte===10?0:lineBytes+1;if(lineBytes>2*1024*1024){process.exitCode=1;process.stdin.destroy();socket.close();break;}}});
const lines=createInterface({input:process.stdin});lines.on('line',line=>{void(async()=>{let packet;try{packet=JSON.parse(line);if(packet.id===undefined)return;const result=await request(packet.method,packet.params??{});send({id:packet.id,result});}catch{if(packet?.id!==undefined)send({id:packet.id,error:{code:-32000,message:'CodeBuddy IDE could not confirm this operation. Check the IDE conversation and connection.'}});}})();});
lines.on('close',()=>socket.close());
