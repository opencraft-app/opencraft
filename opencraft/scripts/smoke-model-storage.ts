import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import WebSocket from 'ws';
import {startLocalAgentHost} from '../apps/local-agent-host/src/main';
const root=await mkdtemp(join(tmpdir(),'opencraft-model-persistence-'));
let host:Awaited<ReturnType<typeof startLocalAgentHost>>|undefined;
let socket:WebSocket|undefined;
delete process.env.OPENCRAFT_DSH_URL;
try{
 for(let boot=0;boot<2;boot++){
  host=await startLocalAgentHost({dataDirectory:join(root,`runtime-${boot}`),modelStorageDirectory:join(root,'product'),dshExecutable:resolve('runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')});
  socket=new WebSocket(host.websocketUrl);await new Promise<void>((r,j)=>{socket!.once('open',r);socket!.once('error',j)});let id=0;
  const request=(method:string,params:any={})=>new Promise<any>((r,j)=>{const current=++id;const handler=(data:WebSocket.RawData)=>{const frame=JSON.parse(data.toString());if(frame.id!==current)return;socket!.off('message',handler);frame.error?j(new Error(frame.error.message)):r(frame.result)};socket!.on('message',handler);socket!.send(JSON.stringify({jsonrpc:'2.0',id:current,method,params}))});
  if(boot===0){const before=await request('runtime/providers/list');await request('runtime/providers/apply',{target:{kind:'create',id:'persisted-demo'},expectedRevision:before.creation.revision,displayName:'Persistent model',baseURL:'http://127.0.0.1:1/v1',api:'openai-completions',enabled:true,models:[{id:'persisted-model'}],credential:{kind:'replace',value:'synthetic-persisted-key'}});}
  if(boot===0){const state=await request('runtime/settings/describe');const revision=state.namespaces.find((n:any)=>n.ns==='agent-default-model').revision;await request('runtime/settings/mutate',{ns:'agent-default-model',expectedRevision:revision,ops:[{op:'set',path:['provider'],value:'persisted-demo'},{op:'set',path:['model'],value:'persisted-model'}]});}
  const directory=await request('runtime/providers/list');assert.equal(directory.application.state,'applied',directory.application.error);assert.equal(directory.providers.find((p:any)=>p.provider==='persisted-demo')?.active,true);
  const models=await request('model/list',{limit:100});assert.ok(models.data.some((m:any)=>m.displayName==='persisted-model'));
  const text=await readFile(join(root,'product','models.json'),'utf8');assert.doesNotMatch(text,/llm-pi-ai|settingsNs|apiKeyEnv|synthetic-persisted-key/);assert.equal(JSON.parse(text).providers[0].models[0].id,'persisted-model');assert.deepEqual(JSON.parse(text).defaultModel,{providerId:'persisted-demo',modelId:'persisted-model'});
  socket.close();socket=undefined;await host.close();host=undefined;
 }
 console.log('OpenCraft models.json: first write -> engine apply -> new runtime/profile -> same provider and model restored; no inference call.');
}finally{socket?.terminate();await host?.close();await rm(root,{recursive:true,force:true})}
