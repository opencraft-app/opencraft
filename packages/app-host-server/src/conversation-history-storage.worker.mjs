// The Server installation owner opens/migrates the database before lending this
// connection. This child never acquires ownership, migrates, or imports files.
import { historyReadTiming, beginHistoryReadTiming } from './history-read-timing.ts';
import { parentPort, workerData } from 'node:worker_threads';
import {SqlObservation,observeSqlite} from './sqlite-observation.ts';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { ConversationHistory } from './conversation-history.ts';
import { searchTerm } from './conversation-search.ts';
if (!existsSync(workerData.path)) throw new Error('Server database is unavailable');
const readOnly = workerData.readOnly === true;
const database = new DatabaseSync(workerData.path, {readOnly});
if (readOnly) database.exec("PRAGMA query_only=ON");
database.exec('PRAGMA busy_timeout=0');
if (database.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw new Error('History worker requires the managed WAL database');
database.prepare('SELECT version FROM schema_migrations LIMIT 1').get();
observeSqlite(database);
const histories = new Map();
const methods = new Set(['publicTextRead','observe','initialization','hasThreads','reindex','revision','read','itemSourceCursor','sourceCursor',
  'catalogRevision','itemSourceDirection','itemRangeFence','directoryFence','directoryEpoch','directoryState','invalidateDirectory','importResult']);
const busy = error => typeof error?.errcode === 'number' && [5,6].includes(error.errcode & 255);
const reads = new Set(['publicTextRead','hasThreads','revision','read','itemSourceCursor','sourceCursor','catalogRevision','itemSourceDirection','itemRangeFence','directoryFence','directoryEpoch','directoryState']);
let tail = Promise.resolve();
let current;
const authorize = async (request, history) => {
  // Ask before opening a transaction. Never wait for gateway callbacks while
  // holding SQLite locks (the gateway may itself be updating account data).
  const [method, params] = request.args;
  const catalog = method === 'thread/list' && typeof params?.cursor === 'string' && params.cursor.startsWith('opencraft-catalog-snapshot-v1:merkle:');
  let catalogRevision;
  if(catalog) database.exec('BEGIN');
  let ids;
  try {
  if(catalog)catalogRevision=history.catalogRevision();
  ids = catalog ? database.prepare('SELECT id FROM conversation_threads WHERE scope=? AND deleted=0 AND archived=?').all(history.scope,Number(params.archived===true)).map(row=>row.id) : method === 'thread/search'
    ? database.prepare('SELECT DISTINCT d.thread_id FROM conversation_search s JOIN conversation_search_documents d ON d.id=s.rowid WHERE conversation_search MATCH ? AND d.scope=?').all(searchTerm(params.searchTerm).match,history.scope).map(row=>row.thread_id)
    : typeof params?.threadId === 'string' ? [params.threadId] : [];
  if(catalog)database.exec('COMMIT');
  }catch(error){if(catalog)database.exec('ROLLBACK');throw error;}
  if (!ids.length) return Object.assign(()=>false,catalog?{catalogReader:request.catalogReader,catalogRevision,catalogProjected:true,catalogPolicy:()=>undefined}:{});
  const signal = new Int32Array(new SharedArrayBuffer((ids.length+1)*4));
  parentPort.postMessage({ type:'authorize', id:request.id, ids, catalog, signal:signal.buffer });
  // This wait blocks only the worker, with no open SQL transaction.
  if (Atomics.wait(signal,0,0,30000) === 'timed-out') throw new Error('History authorization timed out');
  const allowed = new Set(ids.filter((_,i)=>signal[i+1]>0));
  const modes=new Map(ids.map((id,i)=>[id,signal[i+1]]));
  return Object.assign(id => allowed.has(id),catalog?{catalogReader:request.catalogReader,catalogRevision,catalogProjected:ids.every((id,i)=>signal[i+1]!==3),catalogPolicy:id=>modes.get(id)===1?'shared':modes.get(id)===2?'private':undefined}:{});
};
const execute = async request => {
  const started = performance.now();
  const trace=historyReadTiming.getStore();
  const cpuStart=trace && typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : undefined;
  if(trace)trace.sql=new SqlObservation();
  const queueMs=Number(process.hrtime.bigint()-request.enqueuedAt)/1e6;
  let busyWaitMs=0,busyRetries=0,authorizationMs=0;
  const timing=()=>{const cpu=cpuStart ? process.threadCpuUsage(cpuStart) : undefined;return {
    ...(trace?.sql?.summary() ?? {}),...(cpu ? {workerCpuMs:(cpu.user+cpu.system)/1000}:{}),
    fence:trace?.values,queueMs:Math.max(0,queueMs),executeMs:performance.now()-started,busyWaitMs,busyRetries,authorizationMs,directoryDetails:trace?.details};};
  try {
    if (request.method === 'close') {
      database.close(); parentPort.postMessage({type:'result',id:request.id}); parentPort.close(); return;
    }
    if (request.method === 'release') { histories.delete(request.handle); parentPort.postMessage({type:'result',id:request.id}); return; }
    if (request.method !== 'create' && !methods.has(request.method)) throw new Error('Unsupported history operation');
    if (readOnly && request.method !== "create" && !reads.has(request.method)) throw new Error("Read-only history worker cannot mutate storage");
    let result;
    for (;;) {
      try {
        if (request.method === 'create') {
          const history = new ConversationHistory(database,request.scope,readOnly);
          if (!readOnly) history.subscribeCommitted((threadIds,revision,updates,catalogChanged,deletedThreadIds)=>{
            // Keep commit facts with their operation; the parent performs fresh
            // watch authorization and cannot receive another client's discovery.
            current.commits.push({threadIds,revision,updates,catalogChanged,deletedThreadIds});
          });
          histories.set(request.handle,history);
        } else {
          const history = histories.get(request.handle);
          if (!history) throw new Error('History handle is closed');
          const args = [...request.args];
          if(request.method === 'importResult') {
            const signal = new Int32Array(new SharedArrayBuffer(4));
            parentPort.postMessage({type:'admit',id:request.id,signal:signal.buffer});
            if(Atomics.wait(signal,0,0,30000)==='timed-out' || signal[0]!==1) throw Object.assign(new Error('Conversation source is unavailable'),{code:-32074});
          }
          if (request.method === 'read') {
            const authorizationStarted=performance.now();
            try { args[2] = await authorize(request,history); }
            finally { authorizationMs+=performance.now()-authorizationStarted; }
          }
          current = {commits:[]};
          result = await history[request.method](...args);
        }
        break;
      } catch (error) {
        // A complete history operation rolls back its savepoint before retry.
        // Contention waits asynchronously here; it never sleeps the gateway.
        if (!busy(error) || performance.now()-started >= 5000) throw error;
        const waitStarted=performance.now();busyRetries++;
        await new Promise(resolve=>setTimeout(resolve,5));busyWaitMs+=performance.now()-waitStarted;
      }
    }
    parentPort.postMessage({type:'result',id:request.id,result,commits:current?.commits ?? [],timing:timing()});
  } catch (error) {
    parentPort.postMessage({type:'result',id:request.id,error:{name:error.constructor.name,message:error.message,code:error.code,data:error.data},timing:timing()});
  } finally { current=undefined; }
};
parentPort.on('message',request=>{tail=tail.then(()=>request.captureDiagnostics ? historyReadTiming.run(beginHistoryReadTiming(),()=>execute(request)) : execute(request));});
parentPort.postMessage({type:'ready'});
