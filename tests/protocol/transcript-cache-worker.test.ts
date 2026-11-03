import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createServer,get} from 'node:http';
import {TranscriptReadCache} from '@opencraft/native-history-node';
import {TranscriptCacheWorker} from '../../packages/native-history-node/src/transcript-cache-worker.js';
import {resolveCacheDataDirectory} from '../../packages/native-history-node/src/cache-directory.js';

async function fixture(t:test.TestContext) {
 const root=await mkdtemp(join(tmpdir(),'transcript-worker-')),home=join(root,'native'),path=join(home,'rollout.jsonl');
 await mkdir(home);await writeFile(path,JSON.stringify({type:'turn_context',payload:{turn_id:'turn'}})+'\n');
 const turns=[{id:'turn',status:'completed',items:[{id:'text',type:'agentMessage',text:'synthetic'}]}];
 const cache=new TranscriptReadCache(root,{nativeHome:home,readThread:async id=>({id,path,turns:[]}),listTurns:async()=>({data:structuredClone(turns),nextCursor:null})});
 t.after(async()=>{await cache.close();await rm(root,{recursive:true,force:true});});
 return {root,cache};
}

test('cold/warm/rebuild/close perform no main-thread SQLite or synchronous filesystem IO',async t=>{
 const {root,cache}=await fixture(t);
 const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
 const probe=new DatabaseSync(':memory:'),proto=Object.getPrototypeOf(probe.prepare('SELECT 1'));
 const methods=new Map(['get','all','run','iterate'].map(key=>[key,proto[key]]));probe.close();
 const original=new Map<string,Function>(),builtin=fs as unknown as Record<string,any>;
 for(const key of ['statSync','lstatSync','accessSync','existsSync','mkdirSync','chmodSync','openSync','readFileSync','writeFileSync','appendFileSync','rmSync']) {
   original.set(key,builtin[key]);builtin[key]=(...args:any[])=>{
     if(typeof args[0]==='string'&&args[0].startsWith(root))throw Error('Synchronous filesystem IO on network thread: '+key);
     return original.get(key)!(...args);
   };
 }
 const forbidden=()=>{throw Error('SQLite on network main thread');};
 DatabaseSync.prototype.prepare=forbidden;DatabaseSync.prototype.exec=forbidden;
 for(const key of methods.keys())proto[key]=forbidden;
 syncBuiltinESMExports();
 try {
   const first=await cache.read('thread');
   assert.equal(first.initialTurnsPage.data[0]?.id,'turn');
   assert.deepEqual((await cache.read('thread')).initialTurnsPage,first.initialTurnsPage);
   await cache.invalidate('thread');
   assert.equal((await cache.read('thread')).initialTurnsPage.data[0]?.id,'turn');
   await cache.close();
 } finally {
   DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;
   for(const [key,value] of methods)proto[key]=value;
   for(const [key,value] of original)builtin[key]=value;
   syncBuiltinESMExports();
 }
});

test('a real cache writer lock cannot block HTTP; queued writes drain before close and reopen',async t=>{
 const {root,cache}=await fixture(t);await cache.read('thread');await cache.close();
 const worker=new TranscriptCacheWorker(root,2);await worker.meta('thread');
 const lock=new DatabaseSync(join(root,'cache','transcript-index.sqlite'));lock.exec('BEGIN IMMEDIATE');
 const server=createServer((_req,res)=>res.end('alive'));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
   let committed=false;
   const write=worker.hydrate('thread',[{id:'turn',status:'completed',items:[{id:'text',type:'agentMessage',text:'after lock'}]}]).then(()=>{committed=true;});
   const close=worker.close();
   await assert.rejects(worker.meta('thread'),/closing/);
   const port=(server.address() as {port:number}).port;
   for(let i=0;i<12;i++)await new Promise<void>((resolve,reject)=>{const req=get(`http://127.0.0.1:${port}`,res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.setTimeout(1000,()=>req.destroy(Error('HTTP blocked by cache lock')));});
   assert.equal(committed,false);
   lock.exec('ROLLBACK');await write;await close;
   const reopened=new TranscriptCacheWorker(root,2);
   try{assert.equal((await reopened.readPage('thread',null,10,'full','desc')).data[0]?.items[0]?.text,'after lock');}finally{await reopened.close();}
 } finally {try{lock.exec('ROLLBACK');}catch{}lock.close();await worker.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('unavailable cache storage fails without a synchronous fallback',async t=>{
 const root=await mkdtemp(join(tmpdir(),'transcript-worker-file-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'file');await writeFile(file,'not a directory');
 const worker=new TranscriptCacheWorker(file,2);
 await assert.rejects(worker.meta('thread'));
 await worker.close();
});

test('one configured disposable root isolates Host identities and preserves the default',()=>{
 assert.equal(resolveCacheDataDirectory('/host/a',''),'/host/a');
 assert.equal(resolveCacheDataDirectory('/host/a','/cache'),resolveCacheDataDirectory('/host/a','/cache'));
 assert.notEqual(resolveCacheDataDirectory('/host/a','/cache'),resolveCacheDataDirectory('/host/b','/cache'));
 assert.throws(()=>resolveCacheDataDirectory('/host/a','relative'),/absolute/);
});
