import assert from 'node:assert/strict';
import test from 'node:test';
import {startSplitCoreFixture} from '../fixtures/split-codex-core';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {CodexEngineAdapter} from '../../apps/opencraft-daemon/src/codex-engine-adapter';
test('split Core: cold existing Thread defaults load before one settings mutation, observation stays read-only',{skip:!process.env.OPENCRAFT_TEST_NATIVE_CLI||!process.env.OPENCRAFT_TEST_APP_SERVER_BUNDLE,timeout:60000},async()=>{
const binary=process.env.OPENCRAFT_TEST_NATIVE_CLI!;
const bundle=process.env.OPENCRAFT_TEST_APP_SERVER_BUNDLE!;
const root=await mkdtemp('/tmp/oc-c2-split-'),data=join(root,'accounts'),gen=join(root,'generation'),home=join(gen,'runtime'),token='synthetic-split-only-'.repeat(3),endpoint=join(root,'core.sock');
await mkdir(data,{mode:0o700});await mkdir(home,{recursive:true,mode:0o700});await writeFile(join(root,'token'),token,{mode:0o600});
let core:any,engine:any,modelPosts=0;const evidence:any[]=[];
const requests:string[]=[];
const proto=CodexEngineAdapter.prototype as any,original=proto.requestPhysical;proto.requestPhysical=async function(method:string,...args:any[]){requests.push(method);try{return await original.call(this,method,...args);}catch(e:any){if(method==='thread/settings/update')evidence.push({stage:'safe-physical-error',code:e.code??null,status:e.status??null,keys:Object.keys(e).filter(k=>['code','status','data','rpcError'].includes(k)),unknown:e.data?.resultUnknown===true,notLoaded:/not.loaded|not loaded|not running/i.test(e.message),notFound:/not found|no.*thread|thread.*missing/i.test(e.message),permission:/permission/i.test(e.message)});throw e;}};
try{
 core=await startSplitCoreFixture({endpoint,authToken:token,executable:binary,runtimeDirectory:root,dataDirectory:data,nativeCodexHomeDirectory:home,fetch:async(input:any,init:any)=>{const url=new URL(input instanceof Request?input.url:String(input));if(init?.method==='POST'&&url.pathname.endsWith('/responses')){modelPosts++;const item={id:'synthetic-item',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic completed',annotations:[]}]};
 return new Response([{type:'response.created',response:{id:'synthetic-response',object:'response',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'Synthetic completed'},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'synthetic-response',object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}].map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});}return Response.json({plan_type:'pro'});}},bundle);
 const makeEngine=()=>new CodexEngineAdapter({executable:binary,runtimeDirectory:root,dataDirectory:join(root,'host'),coreEndpoint:endpoint,coreAuthToken:token,coreHostOverlays:true,fetch:async()=>Response.json({ok:true}),collaboration:{serverId:'server',started(){},continued(){},authorize(){},assertThreadDefaults(c:any){assert.equal(c.actorId,'synthetic');},async command(){return{};},async tool(){return null;}}});engine=makeEngine();
 let finished!:()=>void;const completed=new Promise<void>(r=>finished=r);
 const pending=new Map<string,any>();let n=0;engine.subscribeMessage((raw:string)=>{const m=JSON.parse(raw);if(m.method==='turn/completed'&&m.params?.turn?.status==='completed')finished();if(!m.method&&pending.has(String(m.id))){const p=pending.get(String(m.id));clearTimeout(p.timer);pending.delete(String(m.id));p.resolve(m);}});await engine.connect();
 const context={sender:null,actorContext:{actorId:'synthetic',generation:1,credentialId:null,expiresAt:Date.now()+60000},resourceOwner:{id:'fixture',assertCurrent(){}}};
 const rpc=async(method:string,params:any={})=>{const id=String(++n);const result=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('bounded fixture '+method)),15000);pending.set(id,{resolve,timer});});await engine.sendWithContext(JSON.stringify({id,method,params,__opencraftClient:'fixture'}),context);const resultValue=await result;return resultValue;};
 assert.ok((await rpc('initialize',{clientInfo:{name:'isolated-split',version:'1'},capabilities:{experimentalApi:true}})).result);evidence.push({stage:'initialized',topology:'accounts split + actual340 AppServer + actual source generation runtime/router + official Native'});
 const access=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+600,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url')}.synthetic`;
 await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:access,refresh_token:'synthetic',account_id:'synthetic'}}));assert.ok((await rpc('opencraft/codex/accounts/import')).result);
 const creation=await rpc('thread/start',{cwd:root,runtimeWorkspaceRoots:[root],model:'gpt-6.1-sol'});assert.ok(creation.result,JSON.stringify({code:creation.error?.code}));const t=creation.result.thread.id;
 const params={threadId:t,scope:'subsequent-native-turns-including-already-accepted',bundle:{permissionMode:'read-only',mode:'default',model:'gpt-6.1-sol',reasoningEffort:'medium'}};
 const write=await rpc('opencraft/thread-defaults/update',params);evidence.push({stage:'fresh-write',errorCode:write.error?.code??null,errorSafeCode:write.error?.data?.code??null,requestState:write.result?.requestState??null,source:write.result?.observation?.source??null});
 assert.equal(write.result?.requestState,'acknowledged');
 await rpc('thread/name/set',{threadId:t,name:'Synthetic completed fixture'});
 const first=await rpc('turn/start',{threadId:t,clientUserMessageId:'synthetic-original',input:[{type:'text',text:'Synthetic local stub only'}]});assert.ok(first.result?.turn?.id);
 let timer:NodeJS.Timeout;try{await Promise.race([completed,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('Local stub completion timeout')),10000);})]);}finally{clearTimeout(timer!);}
 assert.equal(modelPosts,1,'only the explicit original synthetic input invokes the local stub');
 evidence.push({stage:'original-completed',turnId:first.result.turn.id,modelPosts});
 await engine.close();engine=null;await core.restartPhysical();engine=makeEngine();engine.subscribeMessage((raw:string)=>{const m=JSON.parse(raw);if(m.method==='turn/completed'&&m.params?.turn?.status==='completed')finished();if(!m.method&&pending.has(String(m.id))){const p=pending.get(String(m.id));clearTimeout(p.timer);pending.delete(String(m.id));p.resolve(m);}});await engine.connect();await rpc('initialize',{clientInfo:{name:'cold-isolated-split',version:'1'},capabilities:{experimentalApi:true}});
 const cold=await rpc('thread/read',{threadId:t,includeTurns:false});evidence.push({stage:'cold-read',code:cold.error?.code??null,status:cold.result?.thread?.status??null});
 const observedOnly=await rpc('opencraft/thread-defaults/read',{threadId:t});assert.equal(observedOnly.result.source,'native/thread/read');const stillCold=await rpc('thread/read',{threadId:t,includeTurns:false});assert.equal(stillCold.result.thread.status.type,'notLoaded','observe-only must not load or mutate');
 const beforeSetters=requests.filter(m=>m==='thread/settings/update').length,beforeResumes=requests.filter(m=>m==='thread/resume').length;
 const coldWrite=await rpc('opencraft/thread-defaults/update',params);evidence.push({stage:'cold-write',errorCode:coldWrite.error?.code??null,errorSafeCode:coldWrite.error?.data?.code??null,requestState:coldWrite.result?.requestState??null,source:coldWrite.result?.observation?.source??null});
 assert.equal(coldWrite.result?.requestState,'acknowledged','cold C2 write must ACK without caller retry');
 assert.equal(requests.filter(m=>m==='thread/settings/update').length-beforeSetters,1,'single setter attempt');assert.equal(requests.filter(m=>m==='thread/resume').length-beforeResumes,1,'one pre-write load, never a retry');
 assert.equal(modelPosts,1,'cold preparation/setter must not execute another Turn');
 console.log(JSON.stringify({evidence,modelPosts},null,2));
}finally{proto.requestPhysical=original;if(process.env.OPENCRAFT_TEST_SPLIT_EVIDENCE)await writeFile(process.env.OPENCRAFT_TEST_SPLIT_EVIDENCE,JSON.stringify({evidence,modelPosts},null,2));await engine?.close();await core?.close();await rm(root,{recursive:true,force:true});}

});
