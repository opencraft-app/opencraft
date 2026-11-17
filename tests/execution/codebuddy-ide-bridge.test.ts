import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {NativeCodeBuddyAdapter} from '../../extensions/codebuddy-ide/native-adapter.mjs';
import {CodeBuddyIdeBridge} from '../../apps/local-agent-host/src/codebuddy-ide-bridge';
import {AcpEngine} from '../../plugins/acp-engine/src/index';
import {fileURLToPath} from 'node:url';
const required=['getContext','chat.sendMessage','isAgentBusy','ide.getRuntimeProductConfig'].map(name=>'tencentcloud.codingcopilot.'+name);
function native(trusted=()=>true){const calls:any[]=[];let resolve:any;let hold=false,busy=false,account='account-a';const adapter=new NativeCodeBuddyAdapter({getCommands:async()=>required,executeCommand:async(command:string,payload:any)=>{
 calls.push({command,payload});if(command.endsWith('getContext'))return {authenticated:true,userId:account,conversationId:'native-current'};
 if(command.endsWith('isAgentBusy'))return {busy};
 if(command.endsWith('chat.sendMessage')){if(hold)await new Promise(done=>{resolve=done});return {id:payload.options.conversationId,completion:{success:true,conversationId:payload.options.conversationId,messages:[{role:'assistant',content:'Native IDE response'}]}};}
 throw new Error('Unexpected command');
}},()=>'/workspace',trusted);return {adapter,calls,setAccount:(value:string)=>account=value,setBusy:(value:boolean)=>busy=value,hold(){hold=true;},release(){resolve?.();}};}
test('a Host-verified native import keeps its identity and cannot be resumed or sent under another IDE account',async()=>{
 const f=native(),id='11111111-2222-4333-8444-555555555555';
 await assert.rejects(f.adapter.call('resume',{sessionId:id,cwd:'/workspace'}),/Open this conversation/);
 await f.adapter.call('resume',{sessionId:id,cwd:'/workspace',_meta:{'opencraft/nativeHistoryVerified':true}});
 assert.equal(f.calls.some(call=>call.command.endsWith('chat.sendMessage')),false);
 f.setAccount('account-b');
 await assert.rejects(f.adapter.call('prompt',{sessionId:id,cwd:'/workspace',text:'hello'}),/not been admitted/);
 await assert.rejects(f.adapter.call('resume',{sessionId:id,cwd:'/workspace',_meta:{'opencraft/nativeHistoryVerified':true}}),/account or project changed/);
});
test('native IDE adapter calls only IDE commands, preserves native identity and refuses cross-project/busy sends',async()=>{
 const f=native();const session=await f.adapter.call('new',{cwd:'/workspace'});
 await assert.rejects(f.adapter.call('prompt',{sessionId:session.sessionId,cwd:'/other',text:'hello'}),/project changed/);
 f.setBusy(true);await assert.rejects(f.adapter.call('prompt',{sessionId:session.sessionId,cwd:'/workspace',text:'hello'}),/busy/);f.setBusy(false);
 const result=await f.adapter.call('prompt',{sessionId:session.sessionId,cwd:'/workspace',text:'hello'});
 assert.equal(result.messages[0].text,'Native IDE response');
 const command=f.calls.find(call=>call.command.endsWith('chat.sendMessage'));assert.equal(command.payload.options.conversationId,session.sessionId);assert.equal(command.payload.options.withSummary,false);
 assert.equal(f.calls.filter(call=>call.command.endsWith('chat.sendMessage')).length,1);
 await assert.rejects(f.adapter.call('resume',{sessionId:'missing',cwd:'/workspace'}),/Open this conversation/);
 await f.adapter.call('resume',{sessionId:'native-current',cwd:'/workspace'});
});
test('IDE proxy uses authenticated loopback transport and native completion without a CLI agent',async t=>{
 const root=await mkdtemp(join(tmpdir(),'oc-ide-test-'));let engine:AcpEngine|undefined;let bridge:CodeBuddyIdeBridge|undefined;
 t.after(async()=>{await engine?.close();await bridge?.close();await rm(root,{recursive:true,force:true});});
 bridge=new CodeBuddyIdeBridge(root,{} as never);await bridge.start();
 const config=JSON.parse(await readFile(bridge.descriptor,'utf8'));
 const rejected=new WebSocket(config.url,{headers:{authorization:'Bearer invalid'}});await new Promise<void>(resolve=>rejected.once('error',()=>resolve()));
 for(const headers of [{authorization:'Bearer '+config.ideToken,origin:'http://untrusted.invalid'},{authorization:'Bearer '+'é'.repeat(64)}]){const denied=new WebSocket(config.url,{headers});await new Promise<void>(resolve=>denied.once('error',()=>resolve()));}
 const ide=new WebSocket(config.url,{headers:{authorization:'Bearer '+config.ideToken}});await new Promise<void>((resolve,reject)=>{ide.once('open',resolve);ide.once('error',reject);});t.after(()=>ide.close());
 const f=native();ide.send(JSON.stringify({kind:'hello',version:1,status:{authenticated:true,cwd:'/workspace'}}));
 ide.on('message',async bytes=>{const request=JSON.parse(String(bytes));try{const result=await f.adapter.call(request.method,request.params);ide.send(JSON.stringify({kind:'response',id:request.id,result}));}catch{ide.send(JSON.stringify({kind:'response',id:request.id,error:'Refused'}));}});
 engine=new AcpEngine({id:'codebuddy-ide',command:process.execPath,args:[fileURLToPath(new URL('../../scripts/codebuddy-ide/acp-proxy.mjs',import.meta.url))],cwd:root,dataDirectory:join(root,'ledger'),env:{OPENCRAFT_CODEBUDDY_IDE_DESCRIPTOR:bridge.descriptor}});
 const client={notify(){},async request(){throw new Error('No external tools');}};
 const {thread}=await engine.request('thread/start',{cwd:'/workspace'},client);assert.match(thread.id,/^codebuddy_ide_/);
 const completed=new Promise<void>(resolve=>engine.subscribe(method=>{if(method==='turn/completed')resolve();}));
 await engine.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'hello'}]},client);await completed;
 assert.equal(f.calls.filter(call=>call.command.endsWith('chat.sendMessage')).length,1);
 const history=await engine.request('thread/read',{threadId:thread.id,includeTurns:true},client);assert.equal(history.thread.id,thread.id);
 await assert.rejects(engine.request('turn/interrupt',{threadId:thread.id},client),/Stop this task in CodeBuddy IDE/);
});

test('untrusted IDE projects expose status but cannot create or execute a conversation',async()=>{
 const f=native(()=>false);assert.equal((await f.adapter.describe()).authenticated,true);assert.equal((await f.adapter.describe()).workspaceTrusted,false);
 await assert.rejects(f.adapter.call('new',{cwd:'/workspace'}),/Trust the project/);
 assert.equal(f.calls.some(call=>call.command.endsWith('chat.sendMessage')),false);
});
test('parallel requests cannot send twice while the native completion is pending',async()=>{
 const f=native();const {sessionId}=await f.adapter.call('new',{cwd:'/workspace'});f.hold();
 const params={sessionId,cwd:'/workspace',text:'hello'};const first=f.adapter.call('prompt',params);
 await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(f.adapter.call('prompt',params),/already running/);f.release();await first;
 assert.equal(f.calls.filter(call=>call.command.endsWith('chat.sendMessage')).length,1);
});
