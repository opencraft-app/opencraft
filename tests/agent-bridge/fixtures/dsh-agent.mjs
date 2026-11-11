import { createInterface } from 'node:readline';
import { Duplex } from 'node:stream';
import { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
const hooks = {}, inbox = new Map();
const send = frame => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n');
const agent = { status:'idle', session:{id:'s',header:{origin:'acp'}}, inbox:{remove(id){return inbox.delete(id);}}, steer(message){inbox.set(message.id,message);}, cancel(){} };
if (!process.env.DSH_FIXTURE_ABSENT) {
 const patch = JSON.parse(await readFile(process.argv.at(-1),'utf8'));
 const plugin = await import(patch[0].insert[0].name);
 const socket = new Socket({fd:3,readable:true,writable:true});
 const channel = new Duplex({read(){},write(chunk,_enc,done){
  const frame=JSON.parse(String(chunk));
  if(process.env.DSH_FIXTURE_BAD_BARRIER && frame.result?.settled) frame.result.settled=false;
  if(process.env.DSH_FIXTURE_UNKNOWN_WITHDRAW && frame.result && 'withdrawn' in frame.result) {delete frame.result;frame.error={code:-32000,message:'lost withdrawal result'};}
  socket.write(JSON.stringify(frame)+'\n',done);
 }});
 socket.on('data',chunk=>channel.push(chunk));
 socket.on('error',()=>channel.destroy());
 plugin.attach({agents:{get:()=>agent},on(name,fn){hooks[name]=fn;},effect(){}},channel);
}
createInterface({input:process.stdin}).on('line', async line=>{
 const f=JSON.parse(line);
 const reply=result=>send({id:f.id,result});
 if(f.method==='initialize') reply({protocolVersion:1,agentInfo:{name:'dsh-fixture'},agentCapabilities:{_meta:{midTurnSteering:true}}});
 else if(f.method==='session/new') reply({sessionId:'s'});
 else if(f.method==='session/prompt') {
  agent.status='running';
  if (process.env.DSH_FIXTURE_EXIT_AFTER_ADMISSION) setTimeout(() => process.exit(1), 80);
  setTimeout(()=>{
   if (!process.env.DSH_FIXTURE_UNCLAIMED) for(const message of inbox.values()) {inbox.delete(message.id);hooks['agent/inbox/claimed']?.({agent,message});}
   agent.status='idle';reply({stopReason:'end_turn'});
  },process.env.DSH_FIXTURE_UNKNOWN_WITHDRAW?500:150);
 } else if(f.id) reply({});
});
