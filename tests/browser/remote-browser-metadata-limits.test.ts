import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserMetadataValueLimit, browserMetadataWireLimit } from '@opencraft/browser-core/metadata-limits';
import { RemoteBrowserStorage } from '../../apps/workbench-web/src/browser/remote-browser-storage';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';

test('catalog quota round-trips 1200 bindings and local quota rejection preserves the live owner',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'browser-metadata-budget-'));
 const service=new RemoteBrowserService({root:directory,dataDirectory:directory,ownerConnector:null});
 const storage:any=new RemoteBrowserStorage();
 try{
  const initial=await service.metadata('fixture',undefined,()=>{});
  storage.initialized=true;storage.scope=initial.scope;storage.connect=async()=>{};
  storage.call=async(input:any)=>service.metadata('fixture',input,()=>{});
  const value=JSON.stringify(Array.from({length:1200},(_,i)=>({scopeId:`scope-${i}`,hostId:'host',threadId:'t'+i+'访'.repeat(40)})));
  assert(value.length>64*1024);
  storage.setItem('opencraft.conversation-bindings.v1',value);await storage.flush();
  assert.equal((await service.metadata('fixture',undefined,()=>{})).values.bindings,value);
  const restored:any=new RemoteBrowserStorage();restored.connect=async()=>{};restored.call=async()=>service.metadata('fixture',undefined,()=>{});
  await restored.initialize();assert.equal(restored.getItem('opencraft.conversation-bindings.v1'),value);restored.dispose();
  assert.throws(()=>storage.setItem('opencraft.conversation-bindings.v1','x'.repeat(browserMetadataValueLimit('bindings')+1)),{code:'STATE_TOO_LARGE'});
  assert.equal(storage.getItem('opencraft.conversation-bindings.v1'),value);assert.equal(storage.failure,null);
  storage.setItem('opencraft.browser-pages.v1','[]');await storage.flush();
  assert.equal(service.server.options.maxPayload,browserMetadataWireLimit);
 }finally{storage.dispose();service.close();await service.persistence;await rm(directory,{recursive:true,force:true})}
});

test('wire budget includes worst-case JSON escaping of every allowed field',()=>{
 const values=Object.fromEntries(['bindings','pages','tabs','storage'].map(key=>[key,'\0'.repeat(browserMetadataValueLimit(key))]));
 assert(new TextEncoder().encode(JSON.stringify({values})).byteLength<browserMetadataWireLimit);
});
