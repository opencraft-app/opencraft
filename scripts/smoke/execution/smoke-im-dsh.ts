import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { AppHostServer } from "../../../packages/app-host-server/src/index.js";
import { WebSocketTransport } from "../../../packages/appserver-transport-websocket/src/index.js";
import { SessionCapabilities } from "../../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp, capabilitySigningKey } from "../../../packages/session-capabilities/src/mcp.js";
import { ActorStore } from "../../../packages/access-control/src/actors.js";
import { Collaboration } from "../../../packages/access-control/src/collaboration.js";
import { ImPlugin } from "../../../plugins/im/src/server.js";
import { SwitchboardStore } from "../../../plugins/im/src/store.js";
import { stewardRoute } from "../../../plugins/im/src/templates.js";
import { IM_REPLY_TOOL } from "../../../plugins/im/src/reply-tool.js";
import { encodeConversationRef } from "../../../packages/appserver-protocol/src/collaboration.js";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../../apps/local-agent-host/src/model-config/repository.js";
import { createRoutedConversationExecution, callConversationHost } from "../../conversation-execution.mjs";
import { createImExecution } from "../../im-plugins.mjs";
import { startIndependentDshHost } from "../../server-deployment/dsh-host.mjs";
import { attachDshHost } from "../../server-deployment/dsh-host-client.mjs";

// Real isolated DSH + production Host/MCP/IM adapters. The only external boundary
// is a local synthetic model and in-memory delivery; no real IM message is sent.
const directory=await mkdtemp(join(tmpdir(),'im-dsh-native-'));
let host:any,appHost:any,mcp:SessionCapabilityMcp|undefined,collaboration:Collaboration|undefined,im:ImPlugin|undefined,actors:ActorStore|undefined;
let modelCalls=0,toolCalls=0;
let store:SwitchboardStore;
const deliveries:string[]=[];
const endpoint=createServer(async(request,response)=>{
 try {
  let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);
  const agent=Array.isArray(body.tools)&&body.tools.length>0;
  if(agent)modelCalls++;
  const hasReply=body.tools?.some((tool:any)=>tool.function?.name==='im_reply');
  const invoke=agent&&toolCalls===0;
  if(invoke){assert.equal(hasReply,true,'DSH must see im_reply from the independent MCP owner');toolCalls++;}
  const message=invoke?{role:'assistant',tool_calls:[{index:0,id:'fixture-im-reply',type:'function',function:{name:'im_reply',arguments:JSON.stringify({replyRef:store.messages('bot')[0]!.reply_ref,text:'complete DSH answer'})}}]}
   :{role:'assistant',content:agent?'final remains in workbench':'Fixture title'};
  const base={id:'fixture',created:1,model:'fixture'};
  if(!body.stream){response.setHeader('content-type','application/json');response.end(JSON.stringify({...base,choices:[{message,finish_reason:'stop'}]}));return;}
  response.setHeader('content-type','text/event-stream');
  const chunk=(delta:unknown,finish_reason:string|null=null)=>`data: ${JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`;
  response.end(chunk(message)+chunk({},invoke?'tool_calls':'stop')+'data: [DONE]\n\n');
 }catch(error){response.writeHead(500);response.end(JSON.stringify({error:String(error)}));}
});
try{
 await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const models=join(directory,'models');await new ModelCredentialRepository(models).set('FIXTURE','synthetic-key');
 await new ModelConfigurationRepository(models).initialize({schemaVersion:1,revision:0,providers:[{id:'fixture',name:'Fixture',protocol:'openai-completions',baseUrl:`http://127.0.0.1:${(endpoint.address() as any).port}/v1`,credentialRef:'FIXTURE',enabled:true,models:[{id:'fixture',enabled:true,input:['text']}]}],defaultModel:{providerId:'fixture',modelId:'fixture'}});
 const machineIdentity={machineId:'fixture',machineName:'Fixture'};
 const options={descriptorPath:join(directory,'connection.json'),machineIdentity,dataDirectory:join(directory,'agent'),modelStorageDirectory:models,skillsDirectory:join(directory,'skills'),projectlessWorkspaceDirectory:join(directory,'workspaces'),runtimeDirectory:directory,dshExecutable:resolve('runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),dshCapabilityPlugin:resolve('apps/local-agent-host/src/dsh-capability-plugin.mjs')};
 const capabilities=new SessionCapabilities();actors=new ActorStore(join(directory,'actors.sqlite'));
 const human=actors.resolveHuman({provider:'local',subject:'fixture',displayName:'Human',expiresAt:Date.now()+60_000})!;
 host=await startIndependentDshHost(options);const attachment=await attachDshHost(options.descriptorPath,options.dataDirectory,'fixture');
 appHost=new AppHostServer({physicalHostLifetime:'server',logicalClientRouting:true,createTransport:()=>new WebSocketTransport({url:host.websocketUrl,createSocket:url=>new WebSocket(url)})});
 const execution=createRoutedConversationExecution(()=>appHost,{machineId:'fixture',engines:['dsh'],getInputs:async()=>attachment.inputs});
 collaboration=new Collaboration(join(directory,'collaboration.sqlite'),actors,execution);
 const key=capabilitySigningKey(join(directory,'session-capabilities.key'));
 const mcpOptions={descriptorPath:join(directory,'session-capabilities.json'),authorizeInput:(session:any,inputId:string)=>collaboration!.authorizeInput(session.threadId,inputId,'queue',undefined,session.serverId)};
 mcp=new SessionCapabilityMcp(capabilities,key,undefined,mcpOptions);await mcp.listen();
 const created=await callConversationHost(appHost,{hostId:'opencraft-server',threadId:''},'fixture','thread/start',{permissions:'danger-full-access'});
 const ref={serverId:'server:fixture:dsh',threadId:created.thread.id};
 store=new SwitchboardStore(join(directory,'im.sqlite'));store.saveChannel({id:'bot',provider:'wecom',ownerId:human.actorId,name:'Fixture',groupScope:'chat',botId:'synthetic'},true,null);
 store.route('bot',1,stewardRoute(encodeConversationRef(ref)),true);
 im=new ImPlugin(store,createImExecution({actors,collaboration,getAppHost:()=>appHost}),1024,true);
 im.register({id:'bot',ownerId:human.actorId,senders:{sender:human.actorId},groupScope:'chat'});
 capabilities.register({id:'im.reply',tools:session=>im!.replyAvailable(session)?[IM_REPLY_TOOL]:[],call:(session,name,args,signal)=>im!.reply(session,args,signal)});
 im.setDelivery(async(_channel,address,text)=>{assert.equal(address.chat,'original');deliveries.push(text);});
 const message={id:'external',source:{chatId:'original',chatType:'direct' as const,senderId:'sender'},text:'Reply once through im_reply',replyAddress:{chat:'original',expiresAt:Date.now()+60_000},async reply(){throw Error('automatic final forbidden');}};
 // Rotate just the gateway before admission; the independent Host stays alive.
 const enginePid=host.engineProcessId;await mcp.close();mcp=new SessionCapabilityMcp(capabilities,key,undefined,mcpOptions);await mcp.listen();
 await im.receive('bot',message);
 const deadline=Date.now()+30_000;let settled=false;
 while(Date.now()<deadline){await collaboration.pump();const result=await callConversationHost(appHost,{hostId:'opencraft-server',threadId:ref.threadId},'history','thread/read',{includeTurns:true});
  if(result.thread.turns.some((turn:any)=>turn.status==='completed')){assert.match(JSON.stringify(result),/final remains in workbench/);settled=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
 assert.equal(settled,true);await im.receive('bot',message);await collaboration.pump();
 assert.deepEqual(deliveries,['complete DSH answer']);assert.equal(toolCalls,1);assert.equal(modelCalls,2);assert.equal(host.engineProcessId,enginePid);
 const record=store.messages('bot')[0]!;const receipt=await attachment.inputs.receipt(ref.threadId,'actor-input:'+record.request_id);assert.equal(receipt.state,'delivered');
 await appHost.close();appHost=undefined;await host.close();host=await startIndependentDshHost(options);
 const reopened=await attachDshHost(options.descriptorPath,options.dataDirectory,'fixture');assert.deepEqual(await reopened.inputs.receipt(ref.threadId,'actor-input:'+record.request_id),receipt);
 console.log(JSON.stringify({ok:true,engine:'dsh',model:'local synthetic',externalTransport:'in-memory',deliveries:deliveries.length,modelCalls,nativeReceipt:true,gatewayRestart:true,hostRestart:true}));
}finally{
 await im?.close();await collaboration?.close();await appHost?.close();await host?.close();await mcp?.close();actors?.close();
 await new Promise<void>(resolve=>endpoint.close(()=>resolve()));await rm(directory,{recursive:true,force:true});
}
