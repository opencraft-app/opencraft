import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { composerCapabilitiesOptions, invalidateComposerCapabilities, changesComposerCapabilities, type CapabilitiesReader } from "../apps/workbench-web/src/runtime/composer-capabilities-query";

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return {promise,resolve}; };
const model = (id:string) => ({id,supportedReasoningEfforts:[],defaultReasoningEffort:null});
const reader = (ids: string[]): CapabilitiesReader => ({
  listModels: async () => ({data:ids.map(model),nextCursor:null}),
} as CapabilitiesReader);

test('every model page publishes together, including an empty replacement', async () => {
  const client=new QueryClient();
  const old= composerCapabilitiesOptions('local',null,reader(['old']));
  await client.fetchQuery(old);
  const pending=deferred<any>(); let calls=0;
  const source={...reader(['new']),listModels:async ({cursor}:any)=>{calls++;return cursor===null?{data:[model('new')],nextCursor:'page-2'}:pending.promise;}} as CapabilitiesReader;
  const next=composerCapabilitiesOptions('local',null,source);
  const refresh=client.fetchQuery({...next,staleTime:0});
  await new Promise(r=>setTimeout(r,0));
  assert.equal(calls,2); assert.equal(client.getQueryData(old.queryKey)?.models[0]?.id,'old');
  pending.resolve({data:[model('new-2')],nextCursor:null}); await refresh;
  assert.deepEqual(client.getQueryData(old.queryKey)?.models.map(m=>m.id),['new','new-2']);
  await client.fetchQuery({...composerCapabilitiesOptions('local',null,{listModels:async()=>({data:[]})}),staleTime:0});
  assert.deepEqual(client.getQueryData(old.queryKey),{models:[]});client.clear();
});

test('a failed refresh retains the previous complete result with an error', async () => {
  const client=new QueryClient();const options=composerCapabilitiesOptions('local',null,reader(['old']));await client.fetchQuery(options);
  await assert.rejects(client.fetchQuery({...composerCapabilitiesOptions('local',null,{listModels:async()=>{throw Error('unavailable')}}),staleTime:0}));
  assert.equal(client.getQueryData(options.queryKey)?.models[0]?.id,'old');
  assert.equal(client.getQueryState(options.queryKey)?.status,'error');client.clear();
});

test('invalidation cancels an initial pending load and rejects late publication', async () => {
  const client=new QueryClient();const pending=deferred<any>();
  const old=composerCapabilitiesOptions('local',null,{...reader(['old']),listModels:()=>pending.promise});
  const stale=client.fetchQuery(old).catch(()=>null);
  await invalidateComposerCapabilities(client,'local');
  await client.fetchQuery(composerCapabilitiesOptions('local',null,reader(['new'])));
  pending.resolve({data:[model('old')],nextCursor:null}); await stale;await new Promise(r=>setTimeout(r,0));
  assert.equal(client.getQueryData(old.queryKey)?.models[0]?.id,'new');client.clear();
});

test('host invalidation covers its thread scopes but not other hosts; fresh reads deduplicate', async () => {
  const client=new QueryClient();let calls=0;
  const source={listModels:async()=>{calls++;return {data:[model('x')],nextCursor:null}}} as CapabilitiesReader;
  const host=composerCapabilitiesOptions('a',null,source),thread=composerCapabilitiesOptions('a','thread',source),other=composerCapabilitiesOptions('b',null,source);
  await client.fetchQuery(host);await client.fetchQuery(host);assert.equal(calls,1);
  await client.fetchQuery(thread);await client.fetchQuery(other);
  await invalidateComposerCapabilities(client,'a');
  assert.equal(client.getQueryState(host.queryKey)?.isInvalidated,true);
  assert.equal(client.getQueryState(thread.queryKey)?.isInvalidated,true);
  assert.equal(client.getQueryState(other.queryKey)?.isInvalidated,false);
  await client.fetchQuery(host);assert.equal(calls,4);client.clear();
});

test('all provider/model writes share one invalidation contract; reads do not invalidate',()=>{
  for(const method of ['runtime/providers/apply','runtime/providers/setEnabled','runtime/providers/delete','runtime/models/setEnabled','runtime/models/delete','runtime/settings/mutate'])assert.equal(changesComposerCapabilities(method),true);
  assert.equal(changesComposerCapabilities('runtime/models/list'),false);
});
