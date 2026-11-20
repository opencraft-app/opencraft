import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TranscriptReadCache, NativeItemPaginationUnsupported, type NativeTranscriptPort} from '@opencraft/native-history-node';
import type {AppServerTurn} from '@opencraft/appserver-protocol';

async function fixture(t:test.TestContext) {
 const root=await mkdtemp(join(tmpdir(),'history-batch-')),home=join(root,'native'),path=join(home,'rollout.jsonl');await mkdir(home);
 const turns:AppServerTurn[]=Array.from({length:12},(_,n)=>({id:`t-${n}`,status:'completed',items:[{id:`i-${n}`,type:'agentMessage',text:`answer ${n}`}]}));
 await writeFile(path,turns.map(x=>JSON.stringify({type:'turn_context',payload:{turn_id:x.id}})+'\n').join(''));
 const reads:string[]=[],batches:string[][]=[];
 const port:NativeTranscriptPort={nativeHome:home,
  async readThread(){return{id:'t',path,turns:[],historyMode:'paginated'};},
  async listTurns(_id,cursor,limit){const offset=Number(cursor??0);return{data:structuredClone(turns.slice().reverse().slice(offset,offset+limit)),nextCursor:offset+limit<turns.length?String(offset+limit):null};},
  async listTurnItems(_id,id){reads.push(id);return structuredClone(turns.find(x=>x.id===id)!.items);},
  async prepareImageResources(_id,values){if(values.some(x=>x.items?.length))batches.push(values.map(x=>x.id));return{};},
 };
 port.listTurnHeaders=async(id,cursor,limit)=>{const p=await port.listTurns(id,cursor,limit);return{...p,data:p.data.map(x=>({...x,items:[],itemsView:'notLoaded'}))};};
 const cache=new TranscriptReadCache(root,port);
 t.after(async()=>{await cache.close();await rm(root,{recursive:true,force:true});});
 const stored=async()=>{const text=await readFile(join(cache.directory,'t.turns.jsonl'),'utf8');return text.trim().split('\n').map(x=>JSON.parse(x)).filter(x=>x.itemsView==='full').map(x=>x.id);};
 return{cache,port,turns,reads,batches,stored};
}
for(const view of ['full','presentation']as const)test(`batches await real storage before more reads; ${view} page stays complete and ordered`,async t=>{
 const f=await fixture(t),read=f.port.listTurnItems!;
 f.port.listTurnItems=async(...args)=>{const index=f.reads.length;if(index===4||index===8)assert.equal((await f.stored()).length,index,'prior batch must be on disk before starting the next');return read(...args);};
 const page=await f.cache.read('t',10,undefined,view);
 assert.deepEqual(f.batches.map(x=>x.length),[4,4,2]);
 assert.deepEqual(page.initialTurnsPage.data,f.turns.slice(-10).reverse().map(x=>({...x,itemsView:'full'})));
 const older=await f.cache.page('t',page.initialTurnsPage.nextCursor,10,undefined,view);
 assert.deepEqual(older.data,f.turns.slice(0,2).reverse().map(x=>({...x,itemsView:'full'})));assert.equal(older.nextCursor,null);
 f.reads.length=0;await f.cache.read('t',10,undefined,view);assert.equal(f.reads.length,0,'warm read reuses persisted bodies');
});
test('failure after a persisted batch rejects the whole page; retry reuses only completed batches',async t=>{
 const f=await fixture(t),read=f.port.listTurnItems!;let fail=true;
 f.port.listTurnItems=async(...args)=>{if(fail&&args[1]==='t-7')throw Error('transient native read');return read(...args);};
 await assert.rejects(f.cache.read('t',12),/transient native read/);assert.equal((await f.stored()).length,4);
 fail=false;f.reads.length=0;const page=await f.cache.read('t',12);assert.equal(f.reads.length,8);assert.equal(page.initialTurnsPage.data.length,12);
});
test('cancellation during a later resource batch cannot persist or publish its bodies',async t=>{
 const f=await fixture(t),prepare=f.port.prepareImageResources!,abort=new AbortController();let count=0;
 f.port.prepareImageResources=async(...args)=>{const value=await prepare(...args);if(args[1].some(x=>x.items?.length)&&++count===2)abort.abort();return value;};
 await assert.rejects(f.cache.read('t',12,undefined,'presentation',abort.signal),{name:'AbortError'});assert.equal((await f.stored()).length,4);
 f.port.prepareImageResources=prepare;f.reads.length=0;const page=await f.cache.read('t',12);assert.equal(page.initialTurnsPage.data.length,12);assert.equal(f.reads.length,8);
});
test('unsupported Item pagination after a batch drops derived fragments and falls back losslessly',async t=>{
 const f=await fixture(t),read=f.port.listTurnItems!;
 f.port.listTurnItems=async(...args)=>{if(args[1]==='t-7')throw new NativeItemPaginationUnsupported();return read(...args);};
 const page=await f.cache.read('t',12);assert.deepEqual(page.initialTurnsPage.data,f.turns.slice().reverse());
});
