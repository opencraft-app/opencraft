import { supportsTerminalMethod, OPENCRAFT_METHOD_ACCESS_EXTENSION } from '@opencraft/appserver-protocol';
import { composeHostTerminalSelector, HostTerminalSession } from '../../../../scripts/host-terminal-transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ordinaryWorkspaceTerminalSelector } from '../../assets/ordinary-workspace-terminal';
import type { HostTerminalService } from '../../../../scripts/host-terminal-transport';
import type { OrdinaryRuntimeAdmission } from '../../assets/ordinary-conversation-runtime';
import type { OrdinaryExecutionBinding } from '../../../../apps/local-agent-host/src/ordinary-conversation-owner';
const context={sender:null},scope={account:'tencentoa:alice',hostId:'host',threadId:'remote',projectId:null};
function fixture(){
 let allowed=true,live=true,localCalls=0,remoteCalls=0,principal='alice';
 const listeners=new Set<(method:string,params:unknown)=>void>();
 const port:HostTerminalService={async probe(){},subscribe(fn){listeners.add(fn);return()=>{listeners.delete(fn)}},
  async dispatch(_method,_params,_scope,current,accepted){current?.();remoteCalls++;accepted?.();return {ok:true}}};
 const admission:OrdinaryRuntimeAdmission={authority:{principalId:'alice',hostId:'host'},catalog:{scope:'tencentoa:alice',current:()=>allowed},async authorize(){if(!allowed)throw Error('revoked')}};
 const original:OrdinaryExecutionBinding={isCurrent:()=>live,processes:port as any,async executionFields(){throw Error('unused')},async close(){}};
 let binding=original;
 const select=ordinaryWorkspaceTerminalSelector({runtime:{
  hasPlacement(_host,thread){return ['remote','foreign','missing'].includes(thread)},
  async bindingFor(a,thread){if(a.authority.principalId!=='alice'||thread!=='remote')throw Error('missing or denied');return binding}},
  admit(){return {...admission,authority:{...admission.authority,principalId:principal}}},
  local:async()=>{localCalls++;return port}});
 return {select,port,admission,emit(){for(const fn of listeners)fn('process/outputDelta',{processHandle:'same'})},
  revoke(){allowed=false},retire(){live=false},replace(){binding={...original}},other(){principal='bob'},
  counts:()=>({localCalls,remoteCalls,subscriptions:listeners.size})};
}
test('remote classification never falls back for missing or another principal workspace',async()=>{
 const f=fixture();
 for(const threadId of ['foreign','missing'])await assert.rejects(f.select({...scope,threadId},context));
 f.other();await assert.rejects(f.select(scope,context));
 assert.equal(f.counts().localCalls,0);
});
test('unbound local threads preserve explicit local policy, remote service is stable per binding',async()=>{
 const f=fixture();
 await f.select({...scope,threadId:'local'},context);
 const a=await f.select(scope,context),b=await f.select(scope,context);assert.strictEqual(a,b);
 await a.dispatch('process/list',{},scope,()=>{});assert.deepEqual(f.counts(),{localCalls:1,remoteCalls:1,subscriptions:0});
});
test('durable authority and incarnation retirement stop output without leaking into successor',async()=>{
 for(const change of ['revoke','retire'] as const){
  const f=fixture(),service=await f.select(scope,context),output:unknown[]=[];
  const remove=service.subscribe((method,params)=>output.push({method,params}));f.emit();assert.equal(output.length,1);
  f[change]();f.emit();assert.equal(output.length,1);
  await assert.rejects(service.dispatch('process/writeStdin',{},scope,()=>{}));assert.equal(f.counts().remoteCalls,0);
  remove();assert.equal(f.counts().subscriptions,0);
 }
});
test('replaced binding and mismatched dispatch scope are rejected before process calls',async()=>{
 const f=fixture(),service=await f.select(scope,context);
 await assert.rejects(service.dispatch('process/list',{}, {...scope,threadId:'foreign'},()=>{}));
 f.replace();await assert.rejects(service.dispatch('process/list',{},scope,()=>{}));assert.equal(f.counts().remoteCalls,0);
});
test('scope snapshot is not redirected by mutation after selection',async()=>{
 const f=fixture(),input={...scope},service=await f.select(input,context);input.threadId='foreign';
 await service.dispatch('process/list',{},scope,()=>{});assert.equal(f.counts().remoteCalls,1);
});

test('Host terminal session keeps remote routing and gates pushed output after durable revocation',async()=>{
 const f=fixture(),messages:any[]=[];
 const session=new HostTerminalSession(f.port,()=>({...scope}),f.select);
 session.subscribeMessage(frame=>messages.push(JSON.parse(frame)));
 const frame=(id:string,method:string,params:unknown={})=>JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'viewer'});
 await session.connect();await session.receive(frame('init','initialize'),context);
 session.project(JSON.stringify({id:'init',result:{capabilities:{}},[LOGICAL_CLIENT_FIELD]:'viewer'}));
 await session.receive(frame('attach','process/attach',{processHandle:'same',threadId:'remote',afterSequence:0}),context);
 assert.ok(messages.at(-1).result);messages.length=0;f.emit();assert.equal(messages.length,1);
 f.revoke();f.emit();assert.equal(messages.length,1);
 assert.equal(f.counts().localCalls,0);
 session.close();assert.equal(f.counts().subscriptions,0);
});

test('Headless terminal composition supplies stable existing local service without crossing Hosts',async()=>{
 const f=fixture();let retained:unknown;
 const select=composeHostTerminalSelector('host',f.port,async(s,c,local)=>{
  assert.strictEqual(c,context);
  if(retained)assert.strictEqual(local,retained);retained=local;
  return local(s,c);
 })!;
 assert.strictEqual(await select(scope,context),f.port);
 assert.strictEqual(await select({...scope,threadId:'local'},context),f.port);
 await assert.rejects(select({...scope,hostId:'other'},context),/Host mismatch/);
});
test('Headless terminal composition preserves no-selector behavior and rejects failed remote selection',async()=>{
 const f=fixture();
 assert.equal(composeHostTerminalSelector('host',f.port,undefined),undefined);
 const select=composeHostTerminalSelector('host',f.port,async()=>{throw Error('remote unavailable')})!;
 await assert.rejects(select(scope,context),/remote unavailable/);
 assert.equal(f.counts().localCalls,0);
});

test('offline local owner does not block a healthy selected workspace terminal',async()=>{
 for(const remoteReady of [true,false]){
  let dispatched=0,probed=0,selected=0;
  const local:HostTerminalService={async probe(){throw Error('local offline')},subscribe(){return()=>{}},
   async dispatch(){throw Error('local fallback forbidden')}};
  const remote:HostTerminalService={async probe(){probed++;if(!remoteReady)throw Error('remote offline')},
   subscribe(){return()=>{}},async dispatch(){dispatched++;return {processes:[]}}};
  const session=new HostTerminalSession(local,()=>({...scope}),async()=>{selected++;return remote});
  const replies:any[]=[];session.subscribeMessage(v=>replies.push(JSON.parse(v)));
  const frame=(id:string,method:string)=>JSON.stringify({id,method,params:{},[LOGICAL_CLIENT_FIELD]:'viewer'});
  try {
   await session.connect();await session.receive(frame('init','initialize'),context);
   const projected=JSON.parse(session.project(JSON.stringify({id:'init',result:{capabilities:{extensions:{
    [OPENCRAFT_METHOD_ACCESS_EXTENSION]:{version:1,methods:[]}
   }}},[LOGICAL_CLIENT_FIELD]:'viewer'}))!);
   const extensions=projected.result.capabilities.extensions;
   assert.equal(extensions['opencraft/terminal'].available,false);
   assert.equal(extensions['opencraft/terminal'].selection,'per-request');
   assert.equal(supportsTerminalMethod(extensions,'process/list'),true);
   await session.receive(frame('list','process/list'),context);
   assert.equal(selected,1);assert.equal(probed,1);
   assert.equal(dispatched,remoteReady?1:0);
   assert.equal(Boolean(replies.at(-1).result),remoteReady);
   assert.equal(Boolean(replies.at(-1).error),!remoteReady);
  } finally {session.close()}
 }
});
test('terminal authority revoked during selected owner probe prevents dispatch',async()=>{
 let allowed=true,dispatched=false;
 const port:HostTerminalService={async probe(){},subscribe(){return()=>{}},async dispatch(){dispatched=true;return {}}};
 const selected={...port,async probe(){allowed=false}};
 const session=new HostTerminalSession(port,()=>{if(!allowed)throw Error('revoked');return {...scope}},async()=>selected);
 const replies:any[]=[];session.subscribeMessage(v=>replies.push(JSON.parse(v)));
 try {
  await session.connect();await session.receive(JSON.stringify({id:1,method:'initialize'}),context);
  session.project(JSON.stringify({id:1,result:{capabilities:{}}}));
  await session.receive(JSON.stringify({id:2,method:'process/list'}),context);
  assert.ok(replies.at(-1).error);assert.equal(dispatched,false);
 } finally {session.close()}
});
test('offline legacy local terminal retains unavailable capability without a selector',async()=>{
 let dispatched=false;
 const port:HostTerminalService={async probe(){throw Error('offline')},subscribe(){return()=>{}},
  async dispatch(){dispatched=true;return {}}};
 const session=new HostTerminalSession(port,()=>({...scope})),replies:any[]=[];
 session.subscribeMessage(v=>replies.push(JSON.parse(v)));
 try{
  await session.connect();await session.receive(JSON.stringify({id:1,method:'initialize'}),context);
  const projected=JSON.parse(session.project(JSON.stringify({id:1,result:{capabilities:{extensions:{
   [OPENCRAFT_METHOD_ACCESS_EXTENSION]:{version:1,methods:['process/list']}
  }}}}))!);
  const extensions=projected.result.capabilities.extensions;
  assert.deepEqual(extensions['opencraft/terminal'],{version:1,available:false,recovery:false});
  assert.equal(supportsTerminalMethod(extensions,'process/list'),false);
  await session.receive(JSON.stringify({id:2,method:'process/list'}),context);
  assert.ok(replies.at(-1).error);assert.equal(dispatched,false);
 }finally{session.close()}
});
