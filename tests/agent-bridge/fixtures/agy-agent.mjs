#!/usr/bin/env node
import { DatabaseSync as Database } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { createInterface } from 'node:readline';
const dir = process.env.AGENT_BRIDGE_AGY_CONVERSATIONS;
const scenario = process.env.AGY_FIXTURE ?? 'success';
if (process.argv[2] === 'plugin') {
  console.log(JSON.stringify(scenario === 'missing-plugin' ? [] : [{name:'agy-acp-steer',enabled:true,hooks:['agy-acp-steer'],path:resolve('packages/agent-bridge-acp/plugin/agy')}]));
  process.exit(0);
}
const bytes = (field,b) => Buffer.concat([Buffer.from([field*8+2,b.length]),b]);
function payload(text) { const inner=bytes(2,Buffer.from(text));return Buffer.concat([Buffer.from([154,1,inner.length]),inner]); }
function open(id) {
 const db=new Database(join(dir,id+'.db'));
 db.exec(scenario==='bad-schema' ? 'CREATE TABLE IF NOT EXISTS steps (idx TEXT, step_type INTEGER, step_payload BLOB)' : 'CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, step_payload BLOB)');
 return db;
}
if (process.argv[2] === '--seed') { const db=open('sample');db.prepare('INSERT INTO steps VALUES (0,14,?)').run(payload('seed'));db.close();process.exit(0); }
if (process.argv[2] === '--lock') {
 const db=open('sample'); db.exec('BEGIN EXCLUSIVE');
 console.log('locked');
 // Hold the exclusive lock until the test ends this process's stdin. The lock
 // window must not race Worker startup and the read timeout.
 process.stdin.resume();
 await new Promise(resolve => {
  process.stdin.once('end',resolve); process.stdin.once('close',resolve); process.once('SIGTERM',resolve);
 });
 db.exec('ROLLBACK');db.close();process.exit(0);
}
const send = v => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
let promptCount=0, db, timer;
function update(update) { send({method:'session/update',params:{sessionId:'native-session',update}}); }
async function hook(floor=2) {
 return new Promise((resolve,reject) => {
  const req=request({socketPath:process.env.AGY_ACP_STEER_IPC,path:'/claim?event=post',method:'POST',headers:{'x-agy-acp-owner':process.env.AGY_ACP_STEER_OWNER}},res=>{
   let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b).messages)}catch(e){reject(e)}});
  });req.on('error',reject);req.end(JSON.stringify({conversationId:'native-session',initialNumSteps:floor}));
 });
}
createInterface({input:process.stdin}).on('line',async line=>{
 const f=JSON.parse(line),p=f.params??{};
 if(f.method==='initialize')send({id:f.id,result:{protocolVersion:1,_meta:{midTurnSteering:true}}});
 else if(f.method==='session/new')send({id:f.id,result:{sessionId:'native-session'}});
 else if(f.method==='session/prompt'){
  promptCount++;db=open('native-session');db.prepare('INSERT OR REPLACE INTO steps VALUES (0,14,?)').run(payload(p.prompt[0].text));
  await hook(1).catch(()=>[]);
  update({sessionUpdate:'tool_call',toolCallId:'tool',title:'wait',kind:'execute',status:'in_progress'});
  let ticks=0;
  timer=setInterval(async()=>{
   ticks++; const messages=await hook(scenario==='wrong-floor'?99:2).catch(()=>[]);
   for(const m of messages){
    update({sessionUpdate:'user_message_chunk',messageId:'echo',content:{type:'text',text:m.text}});
    if(scenario==='same-rows'){ db.prepare('INSERT INTO steps VALUES (2,14,?),(3,14,?)').run(payload(m.text),payload(m.text)); }
    else if(!['no-row','exit','end-before-row'].includes(scenario)) db.prepare('INSERT INTO steps VALUES (2,14,?)').run(payload(m.text));
    if(scenario==='exit')process.exit(1);
    if(scenario==='end-before-row'){clearInterval(timer);send({id:f.id,result:{stopReason:'end_turn'}});setTimeout(()=>db.prepare('INSERT INTO steps VALUES (2,14,?)').run(payload(m.text)),20);return;}
   }
   if(ticks>=25){clearInterval(timer);update({sessionUpdate:'tool_call_update',toolCallId:'tool',status:'completed'});send({id:f.id,result:{stopReason:'end_turn'}});}
  },20);
 } else if(f.id!==undefined)send({id:f.id,result:{}});
});
