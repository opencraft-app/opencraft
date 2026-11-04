import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';
import {run} from '../../apps/opencraft-cli/src/main';import {CliSshTransport} from '../../apps/opencraft-cli/src/ssh';
import {COLLABORATION_CAPABILITIES} from '@opencraft/appserver-protocol/collaboration';
const serverId='server:synthetic:codex',ref={serverId,threadId:'thread'};
async function fixture(t:test.TestContext){const root=await mkdtemp('/tmp/cli-attachment-command-'),config=join(root,'connections.json'),old=process.env.OPENCRAFT_CONFIG;process.env.OPENCRAFT_CONFIG=config;await writeFile(config,JSON.stringify({schemaVersion:1,defaultConnection:'fixture',connections:{fixture:{sshAlias:'synthetic',instanceId:'instance'}}}));
 t.after(async()=>{if(old===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=old;await rm(root,{recursive:true,force:true});});
 let serverCap=true,hubCap=true,opens=0;const calls:any[]=[],listeners=new Set<(s:string)=>void>();
 t.mock.getter(CliSshTransport.prototype,'status',()=>({state:'open'}));t.mock.method(CliSshTransport.prototype,'connect',async()=>{opens++;});t.mock.method(CliSshTransport.prototype,'close',async()=>{});t.mock.method(CliSshTransport.prototype,'subscribeStatus',()=>()=>{});t.mock.method(CliSshTransport.prototype,'subscribeMessage',(f:any)=>{listeners.add(f);return()=>listeners.delete(f);});
 t.mock.method(CliSshTransport.prototype,'send',async(raw:string)=>{const packet=JSON.parse(raw);if(packet.id===undefined)return;let result:any={};if(packet.method==='initialize')result={capabilities:{extensions:{'opencraft/collaboration':{...COLLABORATION_CAPABILITIES,messageAttachments:hubCap}}}};
 else if(packet.params.action==='servers')result={instanceId:'instance',actor:{id:'human',kind:'human',generation:1},servers:[{serverId,capabilities:{messageAttachments:serverCap}}]};
 else{calls.push(packet.params);assert.equal(packet.params.action,'messageAttachments');result={ref,source:'opencraft-message-attachments',observedAt:Date.now(),consistency:'live-pages',entries:[{clientMessageId:packet.params.clientMessageId??'recorded-client-id',id:'file',name:'recorded name',mimeType:'text/plain',declaredSize:0,kind:'object-url',contentAvailable:'unknown',url:'SECRET_DOWNLOAD',path:'SECRET_PATH',payload:'SECRET_BODY'}],nextCursor:null,complete:true,body:'SECRET_BODY'};}
 for(const f of listeners)f(JSON.stringify({id:packet.id,result}));});
 return {calls,get opens(){return opens;},set serverCap(v:boolean){serverCap=v;},set hubCap(v:boolean){hubCap=v;}};
}
test('CLI defaults to recorded Thread listing, preserves clientMessageId selectors and drops arbitrary reply fields',async t=>{
 const f=await fixture(t);const first=await run(['thread','attachments','thread','--server',serverId]) as any;assert.equal(first.entries[0].clientMessageId,'recorded-client-id');assert.equal(JSON.stringify(first).includes('SECRET'),false);
 const second=await run(['thread','attachments','thread','--server',serverId,'--message','client-message','--cursor=opaqueCursor']) as any;assert.equal(second.entries[0].clientMessageId,'client-message');assert.equal(f.calls[1].clientMessageId,'client-message');assert.equal(f.calls[1].cursor,'opaqueCursor');
});
test('old service/Host are explicitly unsupported without a metadata query',async t=>{
 const f=await fixture(t);f.serverCap=false;await assert.rejects(run(['thread','attachments','thread','--server',serverId]),{code:'UNSUPPORTED_CAPABILITY'});f.serverCap=true;f.hubCap=false;await assert.rejects(run(['thread','attachments','thread','--server',serverId]),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(f.calls.length,0);
});
test('invalid selectors/options are rejected before any connection opens',async t=>{
 const f=await fixture(t);for(const suffix of [['--message','x'.repeat(513)],['--cursor='],['--limit','2'],['--actor','spoof'],['--turn','native-turn']])await assert.rejects(run(['thread','attachments','thread','--server',serverId,...suffix]),{code:'INVALID_ARGUMENTS'});assert.equal(f.opens,0);
});
