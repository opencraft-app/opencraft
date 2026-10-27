import assert from 'node:assert/strict';
import test from 'node:test';
import { PreviewSessionPool, type PreviewIdentity } from '@opencraft/file-preview-core';
const id = (tabId: string, revision = '1', ownerId = 'host:a') : PreviewIdentity => ({ ownerId, tabId, resource: '/report.docx', revision, adapter: 'office:1' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = <T>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; };
function document() { return { disposed: 0, dispose() { this.disposed++; } }; }

test('idle LRU retains recent viewers; active leases cannot be evicted', async () => {
 const pool=new PreviewSessionPool(2,1000), a=document(), b=document(), c=document();
 const la=pool.acquire(id('a'),100,async()=>a);await tick();la.release();
 const lb=pool.acquire(id('b'),100,async()=>b);await tick();lb.release();
 const hit=pool.acquire(id('a'),100,async()=>{throw Error('must reuse')});const snapshot=hit.getSnapshot();assert.equal(snapshot.phase==='ready'&&snapshot.document,a);hit.release();
 const lc=pool.acquire(id('c'),100,async()=>c);await tick();assert.equal(b.disposed,1);assert.equal(a.disposed,0);
 const active=pool.acquire(id('a'),100,async()=>a);
 assert.throws(()=>pool.acquire(id('d'),100,async()=>document()),/capacity/);
 active.release();lc.release();pool.dispose();assert.equal(a.disposed,1);assert.equal(c.disposed,1);
});
test('cancelled parsing cannot publish late success or steal replacement ownership', async () => {
 const pool=new PreviewSessionPool(), old=deferred<ReturnType<typeof document>>(), late=document(), current=document();
 let signal!:AbortSignal;
 const a=pool.acquire(id('a'),100,s=>{signal=s;return old.promise});await tick();
 const b=pool.acquire(id('a','2'),100,async()=>current);await tick();
 assert.equal(signal.aborted,true);assert.equal(a.getSnapshot().phase,'released');
 old.resolve(late);await tick();assert.equal(late.disposed,1);assert.equal(b.getSnapshot().phase,'ready');
 a.release();b.release();pool.releaseTab('host:a','a');assert.equal(current.disposed,1);assert.equal(pool.size,0);
});
test('different owners and tabs do not share mutable engine instances',async()=>{
 const pool=new PreviewSessionPool(), a=document(),b=document();
 const la=pool.acquire(id('a'),1,async()=>a),lb=pool.acquire(id('a','1','host:b'),1,async()=>b);await tick();
 pool.releaseTab('host:a','a');assert.equal(a.disposed,1);assert.equal(lb.getSnapshot().phase,'ready');
 la.release();lb.release();pool.releaseAdapter('office:1');assert.equal(b.disposed,1);
});
test('abandoned work is aborted; timeout becomes retryable failure and cleans late work',async()=>{
 const pool=new PreviewSessionPool(3,1000,10), wait=deferred<ReturnType<typeof document>>(), late=document();
 let signal!:AbortSignal;
 const lease=pool.acquire(id('slow'),10,s=>{signal=s;return wait.promise});await new Promise(r=>setTimeout(r,25));
 assert.equal(lease.getSnapshot().phase,'failed');assert.equal(signal.aborted,true);
 wait.resolve(late);await tick();assert.equal(late.disposed,1);lease.release();assert.equal(pool.size,0);
 const next=pool.acquire(id('slow'),10,async()=>document());await tick();assert.equal(next.getSnapshot().phase,'ready');next.release();pool.dispose();
});
test('source budget evicts idle entries and rejects invalid admission without parsing',async()=>{
 const pool=new PreviewSessionPool(3,100), a=document();const lease=pool.acquire(id('a'),80,async()=>a);await tick();lease.release();
 const second=pool.acquire(id('b'),80,async()=>document());assert.equal(a.disposed,1);
 assert.throws(()=>pool.acquire(id('c'),101,async()=>document()),/limit/);
 assert.throws(()=>pool.acquire(id('c'),NaN,async()=>document()),/limit/);
 second.release();await tick();pool.dispose();assert.throws(()=>pool.acquire(id('d'),1,async()=>document()),/released/);
});

test('an engine failure after readiness retires its view and permits a fresh attempt', async () => {
 const pool = new PreviewSessionPool();
 let report!: (error: unknown) => void;
 let unsubscribed = 0;
 const viewer = { ...document(), subscribeFailure(listener: (error: unknown) => void) { report = listener; return () => { unsubscribed++; }; } };
 const lease = pool.acquire(id('a'), 10, async () => viewer); await tick();
 const error = new Error('worker failed'); report(error);
 assert.deepEqual(lease.getSnapshot(), { phase: 'failed', error });
 assert.equal(viewer.disposed, 1); assert.equal(unsubscribed, 1);
 lease.release(); assert.equal(pool.size, 0);
 const retry = pool.acquire(id('a', '2'), 10, async () => document()); await tick();
 report(new Error('late failure')); assert.equal(retry.getSnapshot().phase, 'ready');
 retry.release(); pool.dispose();
});
