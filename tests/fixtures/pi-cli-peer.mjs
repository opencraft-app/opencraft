import {createInterface} from 'node:readline';
import {mkdir,readFile,appendFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
const directory=arg('--session-dir'),id=args.includes('--session')?arg('--session').split('_').at(-1).replace(/\.jsonl$/u,''):args.includes('--session-id')?arg('--session-id'):randomUUID();
await mkdir(directory,{recursive:true});
const path=join(directory,`fixture_${id}.jsonl`),provider='fixture';
const models=[{provider,id:'vision',name:'Pi Vision',input:['text','image'],reasoning:true,contextWindow:8192,maxTokens:1024},{provider,id:'text',name:'Pi Text',input:['text'],reasoning:false,contextWindow:4096,maxTokens:512}];
let model=models[0],thinking='high',parent=null,active;
try{const rows=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);for(const row of rows.slice(1)){parent=row.id;if(row.type==='model_change')model=models.find(m=>m.id===row.modelId)||model;if(row.type==='thinking_level_change')thinking=row.thinkingLevel;}}catch(e){if(e.code!=='ENOENT')throw e;}
const send=frame=>process.stdout.write(JSON.stringify(frame)+'\n');
const result=(frame,data={})=>send({id:frame.id,type:'response',command:frame.type,success:true,data});
const state=()=>({sessionId:id,sessionFile:path,model,thinkingLevel:thinking,isStreaming:!!active});
async function header(){try{await readFile(path);}catch(e){if(e.code!=='ENOENT')throw e;await appendFile(path,JSON.stringify({type:'session',version:3,id,cwd:process.cwd(),timestamp:new Date().toISOString()})+'\n');}}
async function entry(type,data){await header();const record={type,id:randomUUID(),parentId:parent,timestamp:new Date().toISOString(),...data};parent=record.id;await appendFile(path,JSON.stringify(record)+'\n');}
createInterface({input:process.stdin}).on('line',line=>{void(async()=>{
 const f=JSON.parse(line);
 if(process.env.PI_TEST_TRACE)await appendFile(process.env.PI_TEST_TRACE,JSON.stringify({type:f.type,pid:process.pid,cwd:process.cwd(),...(['set_model','set_thinking_level'].includes(f.type)?{modelId:f.modelId,level:f.level}:{}),...(f.type==='prompt'?{message:f.message,images:f.images}: {})})+'\n');
 if(f.type==='get_state')return result(f,state());
 if(f.type==='get_available_models')return result(f,{models});
 if(f.type==='get_available_thinking_levels')return result(f,{levels:model.reasoning?['off','low','medium','high']:['off']});
 if(f.type==='set_model'){const next=models.find(m=>m.provider===f.provider&&m.id===f.modelId);if(!next)return send({id:f.id,type:'response',command:f.type,success:false,error:'Unknown model'});model=next;if(!model.reasoning)thinking='off';await entry('model_change',{provider,modelId:model.id});return result(f,model);}
 if(f.type==='set_thinking_level'){if(!(model.reasoning?['off','low','medium','high']:['off']).includes(f.level))return send({id:f.id,type:'response',command:f.type,success:false,error:'Invalid thinking level'});thinking=f.level;await entry('thinking_level_change',{thinkingLevel:thinking});return result(f);}
 if(f.type==='abort'){if(active){clearTimeout(active.timer);active=undefined;send({type:'agent_settled',aborted:true});}return result(f);}
 if(f.type==='prompt'){
  if(active)return send({id:f.id,type:'response',command:f.type,success:false,error:'Already streaming'});
  if(f.message==='/handled'){await header();return result(f,{disposition:'handled'});}
  await entry('message',{message:{role:'user',timestamp:Date.now(),content:[...(f.message?[{type:'text',text:f.message}]:[]),...(f.images||[])]}});
  if(f.message==='disconnect'){result(f,{disposition:'started'});process.exit(3);}
  const finish=async()=>{
   if(f.message==='retry')send({type:'message_end',message:{role:'assistant',stopReason:'error'}});
   if(f.message==='tool'){
    send({type:'tool_execution_start',toolCallId:'call',toolName:'read',args:{path:'fixture'}});
    await entry('message',{message:{role:'assistant',timestamp:Date.now(),stopReason:'toolUse',content:[{type:'toolCall',id:'call',name:'read',arguments:{path:'fixture'}}]}});
    await entry('message',{message:{role:'toolResult',timestamp:Date.now(),toolCallId:'call',toolName:'read',content:[{type:'text',text:'full tool output'}],isError:false}});
    send({type:'tool_execution_end',toolCallId:'call',toolName:'read',result:{content:[{type:'text',text:'full tool output'}]},isError:false});
   }
   const text='PI_OK:'+f.message;
   send({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'Checking'}});
   send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});
   const message={role:'assistant',timestamp:Date.now(),stopReason:'stop',content:[{type:'thinking',thinking:'Checking'},{type:'text',text}],usage:{input:10,output:3,cacheRead:2,cacheWrite:0}};
   await entry('message',{message});send({type:'message_end',message});send({type:'agent_end',willRetry:false,messages:[message]});send({type:'agent_settled',aborted:false});active=undefined;
   if(process.env.PI_TEST_ACK_LAST==='1')result(f,{disposition:'started'});
  };
  if(process.env.PI_TEST_ACK_LAST!=='1')result(f,{disposition:'started'});
  active={timer:setTimeout(()=>void finish(),f.message==='wait'?10000:10)};return;
 }
 send({id:f.id,type:'response',command:f.type,success:false,error:'Unsupported command'});
})().catch(()=>process.exit(4));});
