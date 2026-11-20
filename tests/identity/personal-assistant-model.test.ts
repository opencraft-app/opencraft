import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {createAssistantModelSource} from '../../apps/local-agent-host/src/model-config/assistant';
import {ModelConfigurationRepository,ModelCredentialRepository} from '../../apps/local-agent-host/src/model-config/repository';
import {ModelPolicyStore} from '@opencraft/model-usage-policy';
import {createPersonalAssistantHost} from '../../apps/personal-assistant/src/runtime/host-supervisor.mjs';
const model={providerId:'test',modelId:'synthetic'};
async function fixture(t:test.TestContext) {
 const directory=await mkdtemp(join(tmpdir(),'assistant-model-')),storage=await openServerDatabase(directory),actors=new ActorStore(storage),service=new Collaboration(storage,actors);
 const human=(subject:string)=>actors.resolveHuman({provider:'local',subject,displayName:subject,expiresAt:Date.now()+3600000})!;
 const alice=human('alice'),bob=human('bob');
 const repository=new ModelConfigurationRepository(join(directory,'models')),credentials=new ModelCredentialRepository(join(directory,'models'));
 await repository.initialize();await credentials.set('TEST','synthetic-secret');
 await repository.update(0,d=>{d.providers=[{id:'test',name:'Test connection',protocol:'openai-responses',baseUrl:'https://example.invalid/v1',enabled:true,credentialRef:'TEST',models:[{id:'synthetic',name:'Test model',enabled:true,reasoningEfforts:false},{id:'other',enabled:true}]}];});
 let host:any;
 t.after(async()=>{await host?.close();await service.close();actors.close();await storage.close();await rm(directory,{recursive:true,force:true});});
 return {directory,service,actors,alice,bob,repository,credentials,async start(options={}){return host=await (createPersonalAssistantHost as any)({directory,service,codexBinary:process.execPath,modelSource:createAssistantModelSource(join(directory,'models')),intervalMs:25,spawn:()=>({ready:Promise.resolve(),failed:()=>false,async close(){}}),...options});}};
}
async function until(f:()=>boolean|Promise<boolean>){const end=Date.now()+6000;while(Date.now()<end){if(await f())return;await new Promise(r=>setTimeout(r,25));}throw Error('State timed out');}
test('owner selection is CAS protected, survives Host restart and reclaim; models disclose no credentials',async t=>{
 const f=await fixture(t);let host=await f.start();
 const claim=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 await f.service.personalAssistant(f.bob,'opencraft/personal-assistant/claim');
 const catalog=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/models');
 assert.equal(catalog.models[0].label,'Test connection · Test model');assert.ok(!JSON.stringify(catalog).includes('secret'));assert.ok(!JSON.stringify(catalog).includes('baseUrl'));
 const save=()=>f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model,expectedRevision:0});
 const saves=await Promise.allSettled([save(),save()]);assert.equal(saves.filter(s=>s.status==='fulfilled').length,1);
 await until(()=>host.state(claim.assistant.binding.botId).phase==='running');
 assert.equal((await f.service.personalAssistant(f.bob,'opencraft/personal-assistant/get')).assistant.model,null);
 await host.close();host=await f.start();await until(()=>host.state(claim.assistant.binding.botId).phase==='running');
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/revoke');
 const again=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');assert.equal(again.assistant.binding.botId,claim.assistant.binding.botId);assert.deepEqual(again.assistant.model,model);
 await assert.rejects(f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model:{providerId:'test',modelId:'missing'},expectedRevision:1}));
 assert.deepEqual((await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/get')).assistant.model,model);
 const provision=await f.service.provisionPersonalAssistant(f.alice),bot=f.actors.authenticateSession(provision.credential.token)!;
 await assert.rejects(f.service.personalAssistant(bot,'opencraft/personal-assistant/models'),/denied/);
});
test('a model save held across revoke/reclaim cannot update the new delegation',async t=>{
 const f=await fixture(t),wait=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();
 await f.start({modelSource:{async resolve(){started.resolve();await wait.promise;return {};},async catalog(){return {models:[],available:true};}}});
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 const save=f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model,expectedRevision:0});void save.catch(()=>{});
 await started.promise;await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/revoke');await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');wait.resolve();
 await assert.rejects(save,/denied/);assert.equal((await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/get')).assistant.model,null);
});
test('disabling a model stops its worker, retains selection and restores after repair',async t=>{
 const f=await fixture(t);let started=0,closed=0;
 const host=await f.start({spawn:()=>{started++;return {ready:Promise.resolve(),failed:()=>false,async close(){closed++;}};}});
 const {assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model,expectedRevision:0});await until(()=>started===1);
 await f.repository.update(1,d=>{d.providers[0]!.enabled=false;});await until(()=>host.state(assistant.binding.botId).phase==='config_required');assert.equal(closed,1);
 assert.deepEqual((await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/get')).assistant.model,model);
 await f.repository.update(2,d=>{d.providers[0]!.enabled=true;});await until(()=>started===2);
});
test('shared model source filters incompatible/missing-key/denied routes and consumes current credentials',async t=>{
 const f=await fixture(t),policy=new ModelPolicyStore(join(f.directory,'policy.sqlite'));t.after(()=>policy.close());
 const sent:any[]=[];const source=createAssistantModelSource(join(f.directory,'models'),join(f.directory,'policy.sqlite'),{fetch:async(_url,init)=>{sent.push(new Headers(init?.headers).get('authorization'));return Response.json({ok:true});}});t.after(()=>source.close());
 const invoke=async(m=model)=>{const c=await source.resolve(m);assert.notEqual(c.apiKey,'synthetic-secret');assert.notEqual(c.apiKey,'rotated-synthetic');const r=await fetch(c.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+c.apiKey,'content-type':'application/json'},body:JSON.stringify({model:m.modelId,input:'synthetic'})});assert.equal(r.status,200);await r.text();};
 await invoke();assert.equal(sent.at(-1),'Bearer synthetic-secret');await f.credentials.set('TEST','rotated-synthetic');await invoke();assert.equal(sent.at(-1),'Bearer rotated-synthetic');
 policy.write(0,[{engine:'codex',model:'synthetic'}],'test');await assert.rejects(source.resolve(model));assert.equal((await source.catalog()).models.length,1);
 await f.repository.update(1,d=>{d.providers[0]!.protocol='openai-completions';});assert.equal((await source.catalog()).models.length,0);
 await f.repository.update(2,d=>{d.providers[0]!.protocol='openai-responses';d.providers[0]!.credentialRef=null;});assert.equal((await source.catalog()).models.length,0);
 await f.repository.update(3,d=>{d.providers[0]!.authentication='none';});assert.equal((await source.catalog()).models.length,1);await invoke({providerId:'test',modelId:'other'});assert.equal(sent.at(-1),null);
 assert.ok(!(await readFile(f.repository.path,'utf8')).includes('rotated-synthetic'));
});


test('an unrelated effort restriction keeps declared assistant models selectable and carries the resolved effort to requests',async t=>{
 const f=await fixture(t),policyPath=join(f.directory,'policy.sqlite'),policy=new ModelPolicyStore(policyPath);t.after(()=>policy.close());
 const sent:any[]=[];
 await f.repository.update(1,d=>{for(const m of d.providers[0]!.models)m.reasoningEfforts={low:'low',medium:'medium',high:'high'};});
 policy.write(0,[{engine:'codex',effort:'ultra'}],'test');
 const source=createAssistantModelSource(join(f.directory,'models'),policyPath,{fetch:async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({ok:true});}});t.after(()=>source.close());
 const host=await f.start({modelSource:source});
 const {assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 const catalog=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/models');
 assert.deepEqual(catalog.models.map((m:any)=>m.modelId),['synthetic','other']);
 assert.equal(sent.length,0,'listing models must not send a model request');
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model,expectedRevision:0});
 await until(()=>host.state(assistant.binding.botId).phase==='running');
 for(const selection of [model,{providerId:'test',modelId:'other'}]){
  const connection=await source.resolve(selection);assert.equal(connection.reasoningEffort,'medium');
  const reply=await fetch(connection.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+connection.apiKey,'content-type':'application/json'},body:JSON.stringify({model:selection.modelId,input:'synthetic fixture',reasoning:{effort:connection.reasoningEffort}})});
  assert.equal(reply.status,200);await reply.text();
 }
 assert.deepEqual(sent.map(p=>p.reasoning.effort),['medium','medium']);
 assert.deepEqual(policy.read().rules,[{engine:'codex',effort:'ultra'}]);
 assert.equal((await f.repository.read()).defaultModel,null,'assistant resolution must not rewrite the installation default');
});

test('assistant effort resolution preserves explicit defaults and fails closed on denied, unknown or unprojectable levels',async t=>{
 const f=await fixture(t),policyPath=join(f.directory,'policy.sqlite'),policy=new ModelPolicyStore(policyPath);t.after(()=>policy.close());
 const source=createAssistantModelSource(join(f.directory,'models'),policyPath);t.after(()=>source.close());
 await f.repository.update(1,d=>{d.providers[0]!.models=[
  {id:'synthetic',enabled:true,reasoningEfforts:{low:'low',medium:'medium'}},
  {id:'low-only',enabled:true,reasoningEfforts:{low:'custom-low'}},
  {id:'no-thinking',enabled:true,reasoningEfforts:false},
  {id:'unknown',enabled:true},
  {id:'max-only',enabled:true,reasoningEfforts:{max:'max'}},
 ];d.defaultModel={providerId:'test',modelId:'synthetic',reasoningEffort:'low'};});
 policy.write(0,[{engine:'codex',effort:'ultra'}],'test');
 const ref=(modelId:string)=>({providerId:'test',modelId});
 assert.equal((await source.resolve(model)).reasoningEffort,'low');
 assert.equal((await source.resolve(ref('low-only'))).reasoningEffort,'low');
 assert.equal((await source.resolve(ref('no-thinking'))).reasoningEffort,'none');
 assert.deepEqual((await source.catalog()).models.map(m=>m.modelId),['synthetic','low-only','no-thinking']);
 await assert.rejects(source.resolve(ref('unknown')));await assert.rejects(source.resolve(ref('max-only')));
 // A real restriction remains enforced; do not silently pick a different allowed level.
 policy.write(1,[{engine:'codex',effort:'low'},{engine:'codex',effort:'none'}],'test');
 assert.equal((await source.catalog()).models.length,0);await assert.rejects(source.resolve(model));
 policy.write(2,[{engine:'codex',model:'configured/test/synthetic'}],'test');
 await assert.rejects(source.resolve(model));
 await f.repository.update(2,d=>{d.defaultModel={providerId:'test',modelId:'synthetic',reasoningEffort:'high'};});
 policy.write(3,[],'test');await assert.rejects(source.resolve(model),'a configured level absent from the model declaration must not be invented');
 assert.equal((await source.resolve(ref('unknown'))).reasoningEffort,undefined,'unknown legacy metadata remains omitted without effort restrictions');
});

test('with the proxy service, assistant requests reach the provider route with the caller token only',async t=>{
 const f=await fixture(t),sent:any[]=[];
 await f.repository.update(1,d=>{d.providers.push({id:'hub',name:'Hub',protocol:'anthropic-messages',baseUrl:'https://hub.invalid/v1',enabled:true,credentialRef:'TEST',models:[{id:'claude',enabled:true,reasoningEfforts:false}]} as any);});
 const caller={caller:'caller:assistant',baseUrl:'http://127.0.0.1:45071',token:'c'.repeat(43)};
 const source=createAssistantModelSource(join(f.directory,'models'),undefined,{proxyCaller:()=>caller,fetch:async(url,init)=>{const h=new Headers(init?.headers);sent.push({url:String(url),auth:h.get('authorization')??h.get('x-api-key')});return Response.json({ok:true});}});t.after(()=>source.close());
 for(const m of [model,{providerId:'hub',modelId:'claude'}]){const c=await source.resolve(m);const r=await fetch(c.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+c.apiKey,'content-type':'application/json'},body:JSON.stringify({model:m.modelId,input:'synthetic'})});await r.text(); /* Anthropic output translation is covered elsewhere; only the outbound route matters here. */}
 assert.deepEqual(sent,[{url:'http://127.0.0.1:45071/providers/test/v1/responses',auth:'Bearer '+caller.token},{url:'http://127.0.0.1:45071/providers/hub/messages',auth:caller.token}]);
 await f.repository.update(2,d=>{d.providers[0]!.authentication='none';d.providers[0]!.credentialRef=null;});
 const c=await source.resolve(model);await (await fetch(c.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+c.apiKey,'content-type':'application/json'},body:JSON.stringify({model:'synthetic',input:'x'})})).text();
 assert.equal(sent.at(-1).url,'https://example.invalid/v1/responses');assert.equal(sent.at(-1).auth,null);
});

test('real Host and Codex answer native DM through selected model, retain identity and resume after selection/restart',{timeout:45000},async t=>{
 const {createServer}=await import('node:http');
 const {existsSync}=await import('node:fs');
 const binary='/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
 if(!existsSync(binary)){t.skip('Native Codex unavailable');return;}
 const f=await fixture(t),requests:any[]=[],errors:unknown[]=[];
 const server=createServer(async(req,res)=>{
  try {
   assert.equal(req.headers.authorization,'Bearer synthetic-secret');
   const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
   const text=JSON.stringify(body.text?.format?.schema?.properties?.operations?{operations:['reply']}:{proposal:{kind:'reply',text:'Native selected '+body.model}});
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.end([{type:'response.created',response:{id:'r'+requests.length}},{type:'response.output_item.done',item:{id:'m'+requests.length,type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}},{type:'response.completed',response:{id:'r'+requests.length,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
  }catch(error){errors.push(error);res.writeHead(500).end();}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 await f.repository.update(1,d=>{d.providers[0]!.baseUrl=`http://127.0.0.1:${(server.address() as any).port}/v1`;});
 const options={spawn:undefined,codexBinary:binary};let host=await f.start(options);
 const {assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model,expectedRevision:0});
 await until(()=>host.state(assistant.binding.botId).phase==='running');
 const {channel}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/open');
 const messages=()=>f.service.communicate(f.alice,'opencraft/channels/messages/list',{channelId:channel.id});
 async function say(id:string){await f.service.communicate(f.alice,'opencraft/channels/messages/send',{channelId:channel.id,clientMessageId:id,parts:[{type:'text',text:'hello '+id}]});}
 await say('first');await until(async()=>(await messages()).messages.some((m:any)=>JSON.stringify(m).includes('Native selected synthetic')));
 const original=JSON.parse(await readFile(join(f.directory,'bots',assistant.binding.botId,'profile.json'),'utf8'));
 assert.ok(!JSON.stringify(original).includes('synthetic-secret'));
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model:{providerId:'test',modelId:'other'},expectedRevision:1});
 await host.close();host=await f.start(options);await until(()=>host.state(assistant.binding.botId).phase==='running');
 await say('second');await until(async()=>(await messages()).messages.some((m:any)=>JSON.stringify(m).includes('Native selected other')));
 assert.deepEqual((await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/get')).assistant.binding,assistant.binding);
 assert.equal((await messages()).messages.length,4);assert.deepEqual(errors,[]);
 assert.ok(requests.some(r=>r.model==='synthetic'));assert.ok(requests.some(r=>r.model==='other'));
});

test('missing native executable is unavailable; explicit non-thinking default is projected without another model',async t=>{
 const f=await fixture(t);await f.start({codexBinary:join(f.directory,'missing-native')});
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 assert.deepEqual(await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/models'),{models:[],available:false});
 await assert.rejects(f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model,expectedRevision:0}));
 await f.repository.update(1,d=>{d.defaultModel={providerId:'test',modelId:'other',reasoningEffort:'off'};});
 const source=createAssistantModelSource(join(f.directory,'models'));
 assert.equal((await source.resolve({providerId:'test',modelId:'other'})).reasoningEffort,'none');
});

test('real Host and Codex answer native DM through a configured Anthropic Messages model via the loopback gateway',{timeout:45000},async t=>{
 const {createServer}=await import('node:http');
 const {existsSync}=await import('node:fs');
 const binary='/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
 if(!existsSync(binary)){t.skip('Native Codex unavailable');return;}
 const f=await fixture(t),requests:any[]=[],errors:unknown[]=[];
 const server=createServer(async(req,res)=>{
  try {
   assert.equal(req.url,'/v1/messages');
   assert.equal(req.headers['x-api-key'],'anthropic-synthetic');
   assert.equal(req.headers.authorization,undefined);
   const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
   const schema=body.output_config?.format?.schema;
   const text=JSON.stringify(schema?.properties?.operations?{operations:['reply']}:{proposal:{kind:'reply',text:'Anthropic selected '+body.model}});
   const events=[{type:'message_start',message:{id:'msg'+requests.length,role:'assistant',content:[],usage:{input_tokens:1,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  }catch(error){errors.push(error);res.writeHead(500).end();}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 await f.credentials.set('ANTH','anthropic-synthetic');
 await f.repository.update(1,d=>{d.providers.push({id:'anth',name:'Anthropic connection',protocol:'anthropic-messages',baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,enabled:true,credentialRef:'ANTH',models:[{id:'claude-synthetic',enabled:true,maxTokens:1024}]});});
 const host=await f.start({spawn:undefined,codexBinary:binary});
 const {assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');
 const catalog:any=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/models');
 assert.ok(catalog.models.some((m:any)=>m.providerId==='anth'&&m.modelId==='claude-synthetic'));
 await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model:{providerId:'anth',modelId:'claude-synthetic'},expectedRevision:0});
 await until(()=>host.state(assistant.binding.botId).phase==='running');
 const {channel}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/open');
 const messages=()=>f.service.communicate(f.alice,'opencraft/channels/messages/list',{channelId:channel.id});
 await f.service.communicate(f.alice,'opencraft/channels/messages/send',{channelId:channel.id,clientMessageId:'anth-1',parts:[{type:'text',text:'hello anthropic'}]});
 await until(async()=>(await messages()).messages.some((m:any)=>JSON.stringify(m).includes('Anthropic selected claude-synthetic')));
 assert.deepEqual(errors,[]);
 assert.ok(requests.length>0 && requests.every(r=>r.model==='claude-synthetic'));
 const profile=await readFile(join(f.directory,'bots',assistant.binding.botId,'profile.json'),'utf8');
 assert.ok(!profile.includes('anthropic-synthetic'));
});

test('real Host exposes scoped cooldown, recovers429 once without acknowledgement spam',{timeout:30000},async t=>{
 const {existsSync}=await import('node:fs');const binary='/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';if(!existsSync(binary)){t.skip('Native Codex unavailable');return;}
 const f=await fixture(t);let calls=0;
 const source=createAssistantModelSource(join(f.directory,'models'),undefined,{fetch:async(_u,init)=>{
   calls++;if(calls===1)return Response.json({error:{message:'synthetic busy'}},{status:429,headers:{'retry-after':'0.4'}});
   const p=JSON.parse(init!.body as string),text=JSON.stringify(p.text?.format?.schema?.properties?.operations?{operations:['reply']}:{proposal:{kind:'reply',text:'Recovered once'}});
   return new Response([{type:'response.created',response:{id:'r'+calls}},{type:'response.output_item.done',item:{id:'m'+calls,type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}},{type:'response.completed',response:{id:'r'+calls,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 }});
 const host=await f.start({spawn:undefined,codexBinary:binary,modelSource:source});const {assistant}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/claim');await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/model/set',{model,expectedRevision:0});await until(()=>host.state(assistant.binding.botId).phase==='running');const {channel}=await f.service.personalAssistant(f.alice,'opencraft/personal-assistant/open');
 await f.service.communicate(f.alice,'opencraft/channels/messages/send',{channelId:channel.id,clientMessageId:'limited',parts:[{type:'text',text:'hello'}]});
 await until(()=>host.state(assistant.binding.botId).modelWait?.reason==='rate_limit');const wait=host.state(assistant.binding.botId).modelWait;assert.ok(wait.retryAt>Date.now());
 await until(async()=>JSON.stringify(await f.service.communicate(f.alice,'opencraft/channels/messages/list',{channelId:channel.id})).includes('Recovered once'));
 const page=await f.service.communicate(f.alice,'opencraft/channels/messages/list',{channelId:channel.id});assert.equal(page.messages.length,2);assert.ok(!JSON.stringify(page).includes('收到，正在处理'));assert.equal(calls,3);assert.equal(host.state(assistant.binding.botId).modelWait,undefined);
});
