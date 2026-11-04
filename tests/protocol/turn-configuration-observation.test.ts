import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, appendFile, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeItemReadScheduler, TranscriptReadCache } from '../../packages/native-history-node/src/transcript-read-cache';
const thread='fixture-thread',turn='fixture-turn';
const row=(type:string,payload:any,timestamp='2026-11-03T01:00:00.000Z')=>JSON.stringify({type,payload,timestamp})+'\n';
const seed=()=>row('session_meta',{id:thread})+row('event_msg',{type:'task_started',turn_id:turn})+row('turn_context',{turn_id:turn,model:'original',effort:'medium'});
async function fixture(t:any,text=seed()) {
 const root=await mkdtemp(join(tmpdir(),'turn-config-'));const home=join(root,'native');await mkdir(home);const path=join(home,'rollout.jsonl');await writeFile(path,text);
 let visible=true,epoch='one';const calls:string[]=[];
 const port={nativeHome:home,async readThread(){calls.push('read');return{id:thread,path,turns:[]};},async resolveSource(){const captured=epoch;return{nativeHome:home,key:captured,async validate(){if(epoch!==captured)throw Error('replaced');}};},async listTurns(){calls.push('headers');return{data:visible?[{id:turn,status:'completed',itemsView:'notLoaded',items:[]}]:[],nextCursor:null};}};
 const cache=new TranscriptReadCache(root,port as any);t.after(async()=>{await cache.close();await rm(root,{recursive:true,force:true});});
 return{root,cache,path,port,calls,setVisible:(x:boolean)=>{visible=x;},setEpoch:(x:string)=>{epoch=x;}};
}
test('configuration observation reads first exact context, stable across other Turn appends and reopen',async t=>{
 const f=await fixture(t);const first=await f.cache.configuration(thread,turn);assert.equal(first.status,'observed');assert.equal(first.model,'original');assert.equal(first.reasoningEffort,'medium');assert.equal(first.recordedAt,'2026-11-03T01:00:00.000Z');assert.equal(first.scope,'turn-first-recorded-context');assert.equal(first.initiality,'start-boundary-observed');assert.deepEqual(await readdir(f.root),['native'],'read must not create a cold history index');
 await appendFile(f.path,row('turn_context',{turn_id:'other',model:'other',effort:'low'}));assert.equal((await f.cache.configuration(thread,turn)).watermark,first.watermark);
 const reopened=new TranscriptReadCache(join(tmpdir(),'no-config-index'),f.port as any);try{assert.equal((await reopened.configuration(thread,turn)).watermark,first.watermark);}finally{await reopened.close();}
});
for(const [name,text] of [
 ['missing start',row('session_meta',{id:thread})+row('turn_context',{turn_id:turn,model:'original'})],
 ['wrong session',seed().replace('fixture-thread','wrong-thread')],
 ['conflict',seed()+row('turn_context',{turn_id:turn,model:'different',effort:'medium'})],
 ['compaction',seed()+row('compacted',{})],
 ['bad context',seed()+'{"type":"turn_context","payload":\n'],
 ['partial last line',seed()+'{"type":"event_msg"'],
 ['invalid time',seed().replaceAll('2026-11-03T01:00:00.000Z','bad')],
] as const)test(`configuration observation refuses ${name}`,async t=>{const f=await fixture(t,text);const r=await f.cache.configuration(thread,turn);assert.equal(r.status,'unknown');assert.equal(r.model,null);assert.equal(r.watermark,null);});
test('equal duplicates preserve first time; missing field never borrows defaults',async t=>{
 const f=await fixture(t,seed()+row('turn_context',{turn_id:turn,model:'original',effort:'medium'},'2026-11-03T02:00:00.000Z'));assert.equal((await f.cache.configuration(thread,turn)).recordedAt,'2026-11-03T01:00:00.000Z');
 await writeFile(f.path,row('session_meta',{id:thread})+row('event_msg',{type:'task_started',turn_id:turn})+row('turn_context',{turn_id:turn}));const r=await f.cache.configuration(thread,turn);assert.equal(r.status,'observed');assert.equal(r.model,null);assert.equal(r.reasoningEffort,null);
});
test('invisible Native Turn is not revived from disk; deadline cancels without launching execution',async t=>{
 const f=await fixture(t);f.setVisible(false);assert.equal((await f.cache.configuration(thread,turn)).status,'unknown');
 f.setVisible(true);const aborted=new AbortController();aborted.abort();await assert.rejects(f.cache.configuration(thread,turn,aborted.signal));assert.ok(f.calls.every(x=>['read','headers'].includes(x)));
});

test('configuration respects shared cold byte/page budgets and cancels oversized scans',async t=>{
 const f=await fixture(t,seed()+row('response_item',{body:'x'.repeat(2*1024*1024)}));assert.equal((await f.cache.configuration(thread,turn)).status,'unknown');
 const {findNextNewline}=await import('../../packages/native-history-node/src/codex-rollout-reader');
 const controller=new AbortController();let reads=0;
 const file={async read(buffer:Buffer){reads++;buffer.fill(65);if(reads===2)controller.abort();return{bytesRead:buffer.length};}};
 await assert.rejects(findNextNewline(file as any,0,64*1024*1024,controller.signal));assert.equal(reads,2,'no background scan after cancellation');
});
test('source changes, same-inode edits and rollback during scan cannot publish a stale observation',async t=>{
 for(const change of ['epoch','inode','rewrite','rollback']){
  const f=await fixture(t);let validates=0;
  const original=f.port.resolveSource;
  f.port.resolveSource=async()=>{const source=await original();return{...source,async validate(){validates++;if(validates===3){
   if(change==='epoch')f.setEpoch('two');
   if(change==='inode'){await rename(f.path,f.path+'.old');await writeFile(f.path,seed());}
   if(change==='rewrite')await writeFile(f.path,seed().replace('original','rewritten'));
   if(change==='rollback')f.setVisible(false);
  }await source.validate();}};};
  assert.notEqual((await f.cache.configuration(thread,turn)).status,'observed',change);
 }
});

test('configuration queue wait shares the read deadline and creates no Native lookup when cancelled',async t=>{
 const f=await fixture(t),scheduler=new NativeItemReadScheduler(1);let release!:()=>void;
 const blocked=scheduler.run('other',undefined,()=>new Promise<void>(resolve=>{release=resolve;}));
 await new Promise(resolve=>setImmediate(resolve));
 const cache=new TranscriptReadCache(join(tmpdir(),'no-config-queue-index'),f.port as any,{itemReadScheduler:scheduler});
 const controller=new AbortController();const pending=cache.configuration(thread,turn,controller.signal);controller.abort();
 await assert.rejects(pending);assert.equal(f.calls.length,0);
 release();await blocked;await cache.close();
});
test('before/after checks share twenty header pages and missing source remains unavailable',async t=>{
 const f=await fixture(t);let pages=0;
 (f.port as any).listTurns=async(_thread:string,cursor:string|null)=>{pages++;const n=cursor===null?0:Number(cursor);return{data:[{id:n===19?turn:'other-'+n,status:'completed',items:[],itemsView:'notLoaded'}],nextCursor:n===19?null:String(n+1)};};
 assert.equal((await f.cache.configuration(thread,turn)).status,'unknown');assert.equal(pages,20);
 (f.port as any).listTurns=async()=>({data:[{id:turn,status:'completed',items:[],itemsView:'notLoaded'}],nextCursor:null});
 await rm(f.path);assert.equal((await f.cache.configuration(thread,turn)).status,'unavailable');
});

test('a closed Transcript owner cannot publish configuration or begin a new lookup',async t=>{
 const f=await fixture(t);await f.cache.close();assert.equal((await f.cache.configuration(thread,turn)).status,'unavailable');assert.equal(f.calls.length,0);
});
