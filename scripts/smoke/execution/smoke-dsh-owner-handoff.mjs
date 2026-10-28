import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const entry=resolve(process.env.OPENCRAFT_DSH_HOST_ENTRY);
const {startIndependentDshHost}=await import(pathToFileURL(entry));
const unknown=process.env.OPENCRAFT_DSH_DRILL_MODE === "unknown";
const root=await mkdtemp('/tmp/dsh-owner-drill-');
const trace=join(root,'effect');let calls=0,host,consumer,socket,rpcId=0;const eventKinds=[];let effectRequests=0;
const model=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw),agent=Array.isArray(body.tools)&&body.tools.length>0;
 if(agent)calls++;
 const invoke=agent&&calls===1;
 const message=invoke?{role:'assistant',tool_calls:[{index:0,id:'one-effect',type:'function',function:{name:unknown?'fixture_effect':'bash',arguments:unknown?'{}':JSON.stringify({description:'Isolated owner handoff fixture',command:`printf 'start\n' >> '${trace}'; sleep 2; printf 'done\n' >> '${trace}'`})}}]}:{role:'assistant',content:agent?'done':'Fixture'};
 const base={id:'fixture',created:1,model:'fixture'};
 if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify({...base,choices:[{message,finish_reason:'stop'}]}));return;}
 res.setHeader('content-type','text/event-stream');
 const frame=(delta,finish_reason=null)=>`data: ${JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`;
 res.write(frame(message));res.write(frame({},invoke?'tool_calls':'stop'));res.end('data: [DONE]\n\n');
});
const until=async(check,label)=>{for(let i=0;i<400;i++){if(await check())return;await delay(50);}throw Error('Timeout: '+label);};
const effectServer=createServer(async(req,res)=>{for await(const chunk of req){}effectRequests++;await writeFile(trace,'start\ndone\n');res.destroy();});
const expected=()=>({expectedOwner:host.handoff.authority.owner,expectedEpoch:host.handoff.authority.snapshot().epoch,operationId:'drill',fence:'drill'});
const rpc=(method,params={})=>new Promise((accept,reject)=>{
 const id=++rpcId,timer=setTimeout(()=>{socket.removeEventListener('message',receive);reject(Error('RPC timeout: '+method));},15000);
 const receive=event=>{const frame=JSON.parse(event.data);if(frame.id!==id)return;if(frame.opencraftDshReceipt)socket.send(JSON.stringify({jsonrpc:"2.0",method:"opencraft/owner/receipt",params:frame.opencraftDshReceipt}));clearTimeout(timer);socket.removeEventListener('message',receive);frame.error?reject(Error(frame.error.message)):accept(frame.result);};
 socket.addEventListener('message',receive);socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));
});
try {
 await new Promise(done=>effectServer.listen(0,'127.0.0.1',done));
 await new Promise(done=>model.listen(0,'127.0.0.1',done));
 const models=join(root,'models'),skills=join(root,'skills');await mkdir(models);await mkdir(skills);
 await writeFile(join(models,'credentials.json'),JSON.stringify({schemaVersion:1,entries:{FIXTURE:'synthetic'}}),{mode:0o600});
 await writeFile(join(models,'models.json'),JSON.stringify({schemaVersion:1,revision:0,providers:[{id:'fixture',name:'Fixture',protocol:'openai-completions',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,credentialRef:'FIXTURE',enabled:true,models:[{id:'fixture',enabled:true,input:['text']}]}],defaultModel:{providerId:'fixture',modelId:'fixture'}}),{mode:0o600});
 const options={dataDirectory:join(root,'agent'),descriptorPath:join(root,'connection.json'),runtimeDirectory:root,skillsDirectory:skills,modelStorageDirectory:models,projectlessWorkspaceDirectory:join(root,'workspaces'),
   dshExecutable:resolve(process.env.OPENCRAFT_DSH_EXECUTABLE),dshCapabilityPlugin:resolve(process.env.OPENCRAFT_DSH_CAPABILITY_PLUGIN),
   ...(process.env.OPENCRAFT_DSH_COLD_DEPENDENCIES?{coldDependencyRoots:JSON.parse(process.env.OPENCRAFT_DSH_COLD_DEPENDENCIES)}:{})};
 host=await startIndependentDshHost(options);
 if(process.env.OPENCRAFT_ENGINE_HOST_ENTRY){
   const {startIndependentEngineHost}=await import(pathToFileURL(resolve(process.env.OPENCRAFT_ENGINE_HOST_ENTRY)));
   consumer=await startIndependentEngineHost({dataDirectory:root,descriptorPath:join(root,'aggregate.json'),runtimeDirectory:root,dshDescriptorPath:options.descriptorPath,engines:['dsh','pi'],defaultEngine:'dsh'});
 }
 socket=new WebSocket(consumer?.websocketUrl ?? host.websocketUrl);await new Promise((done,fail)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',fail,{once:true});});
 socket.addEventListener('message',event=>{const packet=JSON.parse(event.data);
   if(packet.id!==undefined&&packet.method==='item/tool/call'){
     void fetch(`http://127.0.0.1:${effectServer.address().port}`,{method:'POST',body:'synthetic'}).then(()=>{throw Error('Expected lost response');},()=>{
       socket.send(JSON.stringify({id:packet.id,error:{code:-32000,message:'Fixture response unknown'}}));
     });
   }
   if(packet.method)eventKinds.push({method:packet.method,turn:packet.params?.turn?.id,status:packet.params?.turn?.status});});
 await rpc('initialize');
 const {thread}=await rpc('thread/start',{dynamicTools:unknown?[{type:'function',name:'fixture_effect',description:'Synthetic private effect',inputSchema:{type:'object',properties:{}}}]:[],runtimeWorkspaceRoots:[],permissions:'danger-full-access'});
 await rpc('turn/start',{threadId:thread.id,clientUserMessageId:'exact-once',input:[{type:'text',text:'Run the fixture.'}]});
 await until(async()=>(await readFile(trace,'utf8').catch(()=>'')).startsWith('start\n'),'shell started');
 const fenced=await host.handoff.control('fence',expected());assert.equal(fenced.occupancy.coverage,'complete');assert.ok(fenced.occupancy.activeCount>0);if(!unknown)assert.ok(fenced.occupancy.os.activeCount>0);
 await assert.rejects(rpc('turn/start',{threadId:thread.id,input:[{type:'text',text:'forbidden'}]}),/fenced/);
 await assert.rejects(host.handoff.control('release',expected()),/drained/);
 await until(async()=>await readFile(trace,'utf8').catch(()=>'')==='start\ndone\n','one effect finished');
 if(unknown){
   await rpc('turn/interrupt',{threadId:thread.id});
   await until(async()=>{const native=await host.nativeOwner('inspect');return native.records.every(row=>!row.running&&!row.openTurn);},'cancel acknowledged and turn ended');
   const retained=await host.handoff.inspect();assert.ok(retained.native.custody.some(row=>row.state==='unknown'));
   assert.equal(effectRequests,1);await assert.rejects(host.handoff.control('release',expected()),/drained/);
   console.log(JSON.stringify({passed:true,mode:'unknown',profile:consumer?'aggregate':'direct',effectRequests,cancellationAcknowledged:true,retained}));
   process.exitCode=0;
 }else{
 let drained;
 await until(async()=>{drained=await host.handoff.inspect();return drained.coverage==='complete'&&drained.activeCount===0;},'native and OS drain');
 const orphan=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await new Promise((done,fail)=>{orphan.once('spawn',done);orphan.once('error',fail);});
 const extraOs=await host.handoff.inspect();assert.equal(extraOs.native.activeCount,0);assert.ok(extraOs.os.activeCount>0);
 await assert.rejects(host.handoff.control('release',expected()),/drained/);
 orphan.kill();await new Promise(done=>orphan.once('exit',done));
 await until(async()=>{drained=await host.handoff.inspect();return drained.activeCount===0;},'extra OS child exited');
 assert.equal(calls,2);
 if(consumer)await until(async()=>consumer.handoff.host.consumerObservation().activeCount===0,"consumer lease settled");
 const consumerLease=consumer?.handoff.host.consumerObservation();if(consumerLease){assert.equal(consumerLease.coverage,"complete");assert.equal(consumerLease.activeCount,0);}
 const history=(await host.nativeOwner('inspect')).records;
 const released=await host.handoff.control('release',expected());assert.equal(released.released,true);
 socket.close();await host.close();
 host=await startIndependentDshHost(options);
 const ready=await host.handoff.control('cold-ready',expected());assert.deepEqual((await host.nativeOwner('inspect')).records,history);
 await host.handoff.control('resume',{...expected(),identity:ready.handoff.ready.identity});
 console.log(JSON.stringify({passed:true,profile:consumer?"aggregate":"direct",consumerLease,calls,effects:1,extraOs,fenced,drained,successor:host.handoff.authority.snapshot(),history}));
}
}catch(error){console.error(JSON.stringify({failed:true,error:error.message,eventKinds,consumer:consumer?.handoff.host.consumerObservation(),native:await host?.handoff.inspect()}));throw error;}finally{socket?.close();await consumer?.close();await host?.close();effectServer.closeAllConnections();await new Promise(done=>effectServer.close(done));model.closeAllConnections();await new Promise(done=>model.close(done));await rm(root,{recursive:true,force:true});}
