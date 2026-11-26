import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonRpcAppServerClient } from '@opencraft/appserver-client';
import { createCordisThreadSessionRuntime, createV3ConversationNavigationSource } from '@opencraft/appserver-session';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from '@opencraft/appserver-protocol';
const flush = async () => { for(let i=0;i<12;i++) await new Promise<void>(r=>setImmediate(r)); };
type SnapshotPage = { data: readonly Record<string, unknown>[]; nextCursor: string | null };

async function fixture() {
 let reads=0,live=true,fail=false,held=false,late:(()=>void)|undefined,elapsed=0;
 let page: SnapshotPage | undefined;
 const older = new Map<string, (page?: SnapshotPage) => void>();
 const timers=new Map<number,()=>void>();let seq=0;
 const transport=new MemoryTransport({receive(frame,peer){
  const request=parseJsonRpcMessage(frame);if(!isJsonRpcRequest(request))return;
  const send=(result:unknown)=>peer.send(encodeJsonRpcMessage({id:request.id,result}));
  if(request.method==='initialize'){send({codexHome:'/fixture',platformFamily:'unix',platformOs:'linux',userAgent:'audit',capabilities:{extensions:{'opencraft/read-history':{version:1}}}});return;}
  if (request.method === 'thread/turns/list') {
    const { cursor } = request.params as { cursor: string };
    older.set(cursor, page => send(page ?? { data: [{ id: cursor, status: 'completed', itemsView: 'full', items: [] }], nextCursor: null }));
    return;
  }
  if(request.method!=='thread/read')return;
  reads++;elapsed+=600;
  if(live)peer.send(encodeJsonRpcMessage({method:'item/agentMessage/delta',params:{threadId:'a',turnId:'turn',itemId:'item',delta:'x'}}));
  const finish=()=>fail?peer.send(encodeJsonRpcMessage({id:request.id,error:{code:-32000,message:'temporary failure'}})):
   send({thread:{id:'a',sessionId:'a',cwd:'/fixture',historyMode:'paginated',status:{type:'active',activeFlags:[]},turns:[]},initialTurnsPage:page??{data:[{id:'turn',status:'inProgress',itemsView:'full',items:[{id:'item',type:'agentMessage',text:'x'.repeat(reads)}]}],nextCursor:null}});
  if(held)late=finish;else finish();
 }});
 const client=new JsonRpcAppServerClient({hostId:'continuous',transport});await client.connect({clientInfo:{name:'test',version:'1'}});
 const session=await createCordisThreadSessionRuntime({client,readClock:{now:()=>elapsed,setTimeout(run){const id=++seq;timers.set(id,run);return id;},clearTimeout(id){timers.delete(id as number);}}});
 return {session,client,timers,older,get reads(){return reads;},setPage(value:SnapshotPage){page=value;},get text(){return session.views.get('a')?.turns[0]?.items?.[0]?.text;},live(value:boolean){live=value;},fail(value:boolean){fail=value;},hold(value:boolean){held=value;},late(){late?.();},async tick(){const [id,run]=[...timers][0]??[];assert.ok(run);timers.delete(id);run();await flush();},async close(){await session.dispose();await client.close();}};
}
test('continuous output releases baseline after two reads and follows bounded snapshots without duplicated deltas',async()=>{
 const f=await fixture();try{
  await f.session.resume.read('a');await flush();assert.equal(f.reads,2);assert.equal(f.text,'xx');assert.equal(f.timers.size,1);
  for(let i=0;i<55;i++){await f.tick();assert.equal(f.text,'x'.repeat(f.reads));assert.equal(f.timers.size,1);}
  f.live(false);await f.tick();assert.equal(f.timers.size,0);assert.equal(f.text,'x'.repeat(f.reads));
 }finally{await f.close();}
});
test('snapshot following retries a failed read without replaying ambiguous deltas',async()=>{
 const f=await fixture();try{await f.session.resume.read('a');await flush();f.fail(true);await f.tick();assert.equal(f.text,'xx');assert.ok(f.session.views.get('a')?.historyError);f.fail(false);await f.tick();assert.equal(f.text,'xxxx');assert.equal(f.session.views.get('a')?.historyError,null);}finally{await f.close();}
});
for(const action of ['release','fresh-read','disconnect','dispose'] as const)test(`snapshot follower fences held response on ${action}`,async()=>{
 const f=await fixture();try{await f.session.resume.read('a');await flush();f.hold(true);await f.tick();f.live(false);f.hold(false);
  if(action==='release')f.session.resume.release('a');
  if(action==='fresh-read')await f.session.resume.read('a');
  if(action==='disconnect')await f.client.close();
  if(action==='dispose')await f.session.dispose();
  const before=f.session.views.get('a');f.late();await flush();assert.equal(f.timers.size,0);assert.equal(f.session.views.get('a'),before);
 }finally{await f.close();}
});


test('snapshot following only preserves the prior cursor at an ordinary history anchor', async () => {
  const f = await fixture();
  const turn = (id: string) => ({ id, status: 'completed', itemsView: 'full' as const, items: [] });
  const head = turn('head'), hit = turn('search-hit');
  try {
    f.setPage({ data: [head], nextCursor: 'old-tail' });
    await f.session.resume.read('a');
    assert.equal(f.reads, 2);
    f.setPage({ data: [head], nextCursor: 'redundant-tail' });
    await f.tick();
    assert.equal(f.session.views.get('a')?.turnsPagination.olderCursor, 'old-tail');
    f.session.views.hydrateNavigationTurn('a', hit, [hit.id, head.id], undefined, 'search');
    assert.deepEqual(f.session.views.get('a')?.navigationOnlyTurnIds, [hit.id]);

    f.setPage({ data: [turn('new-head'), hit], nextCursor: 'new-tail' });
    f.live(false);
    await f.tick();
    const view = f.session.views.get('a')!;
    assert.deepEqual(view.turns.map(candidate => candidate.id), [hit.id, 'new-head']);
    assert.equal(view.turnsPagination.oldestLoadedTurnId, hit.id);
    assert.equal(view.turnsPagination.olderCursor, 'new-tail');
    assert.equal(view.navigationOnlyTurnIds, undefined);
    assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
});


test('a new snapshot boundary revokes a held older-page read before admitting the next demand', async () => {
  const f = await fixture();
  const turn = (id: string) => ({ id, status: 'completed', itemsView: 'full' as const, items: [] });
  try {
    f.setPage({ data: [turn('old-head')], nextCursor: 'obsolete' });
    await f.session.resume.read('a');
    const request = f.session.resume.loadOlder('a');
    let settled = false;
    const retired = assert.rejects(request, { code: 'ABORTED' }).then(() => { settled = true; });
    await flush();
    assert.ok(f.older.has('obsolete'));

    f.setPage({ data: [turn('old-head')], nextCursor: 'same-range' });
    await f.tick();
    assert.equal(f.session.views.get('a')?.turnsPagination.olderCursor, 'obsolete');
    assert.equal(settled, false, 'an overlapping refresh keeps the current read alive');

    f.setPage({ data: [turn('fresh-head')], nextCursor: 'valid' });
    f.live(false);
    await f.tick();
    const next = f.session.resume.loadOlder('a');
    next.catch(() => {});
    await flush();
    assert.ok(f.older.has('valid'), 'the new provider cursor is requested while the obsolete peer stays held');
    await retired;
    f.older.get('valid')!();
    const view = await next;
    assert.deepEqual(view.turns.map(candidate => candidate.id), ['valid', 'fresh-head']);
    f.older.get('obsolete')!();
    await flush();
    assert.equal(f.session.views.get('a'), view);
  } finally { await f.close(); }
});


test('a partial snapshot replacement revokes exact navigation reads from the previous baseline', async () => {
  const f = await fixture();
  const turn = (id: string) => ({ id, status: 'completed', itemsView: 'full' as const,
    items: [{ id: 'item-' + id, type: 'agentMessage', text: id }] });
  const navigation = createV3ConversationNavigationSource({
    threadId: 'a',
    port: {
      getView: () => f.session.resume.navigationView('a'),
      subscribeView: listener => f.session.views.subscribeThread('a', listener),
      listTurns: (params, signal) => f.client.request('thread/turns/list', params, { signal }),
      commitHydratedTurn(value, order, baseline, intent) {
        const view = f.session.views.hydrateNavigationTurn('a', value, order, baseline, intent);
        return { hostId: view.hostId, threadId: view.threadId,
          connectionGeneration: view.connectionGeneration, viewRevision: view.revision };
      },
      projectionBarrier: { waitUntilProjected: async commit => commit.viewRevision },
    },
  });
  try {
    const oldHead = turn('old-head');
    f.setPage({ data: [oldHead], nextCursor: 'older' });
    await f.session.resume.read('a');
    const source = navigation.getSnapshot().generation;
    const signal = new AbortController().signal;
    const old = navigation.prepareLocatedTarget({ turnId: 'old-hit', itemId: 'item-old-hit', turnCursor: 'old-hit' }, signal);
    await flush();
    assert.ok(f.older.has('old-hit'));

    f.setPage({ data: [oldHead], nextCursor: 'same-range' });
    await f.tick();
    assert.equal(navigation.getSnapshot().generation, source);

    f.setPage({ data: [turn('new-head')], nextCursor: 'new-older' });
    f.live(false);
    await f.tick();
    f.older.get('old-hit')!({ data: [turn('old-hit')], nextCursor: null });
    assert.equal(await old, null, 'the old cursor must not reintroduce a Turn under the new baseline');
    assert.deepEqual(f.session.views.get('a')?.turns.map(value => value.id), ['new-head']);
    assert.notEqual(navigation.getSnapshot().generation, source);

    const current = navigation.prepareLocatedTarget({ turnId: 'current-hit', itemId: 'item-current-hit', turnCursor: 'current-hit' }, signal);
    await flush();
    assert.ok(f.older.has('current-hit'));
    f.older.get('current-hit')!({ data: [turn('current-hit')], nextCursor: null });
    assert.equal((await current)?.turnKey, 'current-hit');
  } finally { navigation.dispose(); await f.close(); }
});
