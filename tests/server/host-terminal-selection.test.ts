import test from 'node:test';
import assert from 'node:assert/strict';
import { HostTerminalSession, type HostTerminalService } from '../../apps/headless-server/src/host-terminal-transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
function service() {
 const listeners=new Set<(m:string,p:unknown)=>void>(), calls:string[]=[];
 const port:HostTerminalService={async probe(){},subscribe(fn){listeners.add(fn);return()=>{listeners.delete(fn)}},async dispatch(method,_p,_s,current,accepted){current?.();calls.push(method);accepted?.();return {processHandle:'same'}}};
 return {port,calls,emit:(text:string,method='process/outputDelta')=>{for(const fn of listeners)fn(method,{processHandle:'same',deltaBase64:Buffer.from(text).toString('base64')})},get subscriptions(){return listeners.size}};
}
const scope=(account:string,threadId:string)=>({account,hostId:'host',threadId,projectId:null});
const context=(actorId:string)=>({sender:null,actorContext:{actorId}} as any);
async function init(s:HostTerminalSession,client:string){await s.receive(JSON.stringify({id:1,method:'initialize',[LOGICAL_CLIENT_FIELD]:client}),context(client));s.project(JSON.stringify({id:1,result:{capabilities:{extensions:{}}},[LOGICAL_CLIENT_FIELD]:client}));}
const frame=(client:string,method:string,threadId:string)=>JSON.stringify({id:2,method,params:{processHandle:'same',threadId},[LOGICAL_CLIENT_FIELD]:client});
test('authenticated scope selects remote owner; same handles do not mix output with local or other binding',async()=>{
 const local=service(),a=service(),b=service(),messages:any[]=[];
 const session=new HostTerminalSession(local.port,(c,p)=>scope(c.actorContext!.actorId,p.threadId),async s=>s.threadId==='a'?a.port:b.port);
 session.subscribeMessage(f=>messages.push(JSON.parse(f)));await session.connect();await init(session,'alice');await init(session,'bob');
 await session.receive(frame('alice','process/spawn','a'),context('alice'));await session.receive(frame('bob','process/spawn','b'),context('bob'));
 assert.deepEqual(local.calls,[]);assert.deepEqual(a.calls,['process/spawn']);assert.deepEqual(b.calls,['process/spawn']);messages.length=0;
 local.emit('wrong');a.emit('A');b.emit('B');
 assert.deepEqual(messages.map(m=>[m[LOGICAL_CLIENT_FIELD],Buffer.from(m.params.deltaBase64,'base64').toString()]),[['alice','A'],['bob','B']]);
 a.emit('', 'process/exited');messages.length=0;b.emit('still-B');assert.equal(messages[0][LOGICAL_CLIENT_FIELD],'bob');
 session.close();assert.equal(local.subscriptions+a.subscriptions+b.subscriptions,0);
});
test('resolver failure never executes local and authority is rechecked after resolution',async()=>{
 const local=service(),remote=service();let valid=true,fail=true;const messages:any[]=[];
 const s=new HostTerminalSession(local.port,(_c,p)=>{if(!valid)throw Error('revoked');return scope('alice',p.threadId)},async()=>{if(fail)throw Error('binding missing');valid=false;return remote.port});
 s.subscribeMessage(f=>messages.push(JSON.parse(f)));await s.connect();await init(s,'alice');
 await s.receive(frame('alice','process/spawn','a'),context('alice'));assert.ok(messages.at(-1).error);fail=false;
 await s.receive(frame('alice','process/spawn','a'),context('alice'));assert.ok(messages.at(-1).error);assert.equal(local.calls.length+remote.calls.length,0);s.close();
});
test('revocation stops remote output and default route preserves existing local behavior',async()=>{
 const local=service();let valid=true;const messages:any[]=[];
 const s=new HostTerminalSession(local.port,(_c,p)=>{if(!valid)throw Error('revoked');return scope('alice',p.threadId)});
 s.subscribeMessage(f=>messages.push(JSON.parse(f)));await s.connect();await init(s,'alice');await s.receive(frame('alice','process/attach','a'),context('alice'));
 assert.deepEqual(local.calls,['process/attach']);valid=false;messages.length=0;local.emit('secret');assert.deepEqual(messages,[]);s.close();
});

test('selector receives the exact authenticated context, never forged process identity fields',async()=>{
 const local=service(),remote=service(),trusted=context('alice');let seen=0;
 const s=new HostTerminalSession(local.port,(c,p)=>scope(c.actorContext!.actorId,p.threadId),async(selected,c)=>{
  seen++;assert.strictEqual(c,trusted);assert.equal(selected.account,'alice');assert.equal(c.actorContext!.actorId,'alice');return remote.port;
 });
 await s.connect();await init(s,'client');
 await s.receive(JSON.stringify({id:2,method:'process/spawn',[LOGICAL_CLIENT_FIELD]:'client',
  params:{threadId:'a',processHandle:'same',actorContext:{actorId:'mallory'},account:'mallory',hostId:'forged'}}),trusted);
 assert.equal(seen,1);assert.deepEqual(remote.calls,['process/spawn']);assert.deepEqual(local.calls,[]);s.close();
});
