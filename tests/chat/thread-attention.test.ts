import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadAttention, projectAppServerThread } from '@opencraft/workbench-runtime';
import { BrowserThreadAttention } from '../../apps/workbench-web/src/runtime/browser-thread-attention';
import { PlatformAccountContributionRegistry } from '../../apps/workbench-web/src/runtime/platform-account-contributions';

function fixture(accountRegistry?: PlatformAccountContributionRegistry, resetBeforeSeconds = 0, saved = new Map<string, string>()) {
  let complete: (result: any) => void = () => {};
  let resolve: (page: any) => void = () => {};
  const calls: any[] = [];
  const client = { status: { state: 'open' }, connectionGeneration: 1,
    request: (_method: string, params: any) => { calls.push(params); return new Promise(done => { resolve = done; }); } };
  const source = { subscribe: (listener: any) => { complete = listener; return () => {}; } };
  const storage = saved;
  const accounts = accountRegistry ?? new PlatformAccountContributionRegistry();
  const store = new BrowserThreadAttention({get: () => client} as any, source as any, accounts,
    {getItem: key => storage.get(key) ?? null, setItem: (key,value) => {storage.set(key,value);}}, 'test', resetBeforeSeconds);
  return { store, client, calls, storage, complete: (turnId: string) => complete({hostId:'host',threadId:'thread',turnId,status:'completed'}),
    resolve: (turnId: string, completedAt?: number | null) => resolve({data:[{id:turnId,status:'completed',completedAt}]}) };
}
const profile = {hostId:'host',revision:1} as any;

test('execution waiting states enter attention without inventing acceptance', () => {
  const project = (status: any) => projectAppServerThread({id:'x',cwd:'/repo',updatedAt:1,status} as any).status;
  assert.equal(project({type:'active',activeFlags:[]}), 'running');
  assert.equal(project({type:'active'}), 'running', 'legacy active status without flags remains supported');
  for (const flag of ['waitingOnApproval','waitingOnUserInput']) assert.equal(project({type:'active',activeFlags:[flag]}), 'review');
  assert.equal(project({type:'idle'}), 'ready');
});
test('read receipts belong to exact host/thread/turn, including read-before-notification race', () => {
  const state = new ThreadAttention();
  state.acknowledge('a','same','old'); state.observe('a','same','old');
  assert.equal(state.unread('a','same'), false);
  state.observe('a','same','new'); state.acknowledge('a','same','old');
  assert.equal(state.unread('a','same'), true);
  state.observe('b','same','old'); assert.equal(state.unread('b','same'), true);
  state.acknowledge('a','same','new'); assert.equal(state.unread('a','same'), false);
});
test('background completion remains unread until its result is acknowledged and survives reload', () => {
  const f = fixture(); f.complete('turn'); assert.equal(f.store.unread('host','thread'), true);
  f.store.acknowledge(f.store.getScope(),'host','thread','turn'); assert.equal(f.store.unread('host','thread'), false);
  const saved = JSON.parse([...f.storage.values()][0]!);
  const restored = new ThreadAttention(saved); restored.observe('host','thread','turn');
  assert.equal(restored.unread('host','thread'), false); f.store.dispose();
});
test('tail catch-up is metadata-only, cached, and cannot overwrite a newer live result', async () => {
  const f = fixture();
  const read = f.store.catchUp(profile,[{id:'thread',updatedAt:1}],()=>true);
  assert.deepEqual(f.calls[0],{threadId:'thread',cursor:null,limit:1,itemsView:'notLoaded',sortDirection:'desc'});
  f.complete('new'); f.resolve('old'); await read;
  f.store.acknowledge(f.store.getScope(),'host','thread','old'); assert.equal(f.store.unread('host','thread'), true);
  await f.store.catchUp(profile,[{id:'thread',updatedAt:1}],()=>true); assert.equal(f.calls.length,1);
  f.store.acknowledge(f.store.getScope(),'host','thread','new'); assert.equal(f.store.unread('host','thread'), false);
  f.store.dispose();
});
test('offline catch-up creates an unread result; retired connections cannot publish', async () => {
  const f = fixture(); let read = f.store.catchUp(profile,[{id:'thread',updatedAt:1}],()=>true);
  f.resolve('offline'); await read; assert.equal(f.store.unread('host','thread'),true);
  f.store.acknowledge(f.store.getScope(),'host','thread','offline');
  read = f.store.catchUp(profile,[{id:'thread',updatedAt:2}],()=>true);
  f.client.connectionGeneration++; f.resolve('retired'); await read;
  assert.equal(f.store.unread('host','thread'),false); f.store.dispose();
});

test('account changes retire pending reads and stale acknowledgements, preserving isolated receipts', async () => {
  let accountScope = 'a'; let changed = () => {};
  const account = {getSnapshot: () => ({readStateScope:accountScope}), subscribe:(listener:any)=>{changed=listener;return()=>{};}};
  const accounts = {getSnapshot:()=>({contribution:account}),subscribe:()=>()=>{}} as any;
  const f = fixture(accounts); f.complete('for-a');
  const oldScope = f.store.getScope();
  const pending = f.store.catchUp(profile,[{id:'thread',updatedAt:1}],()=>true);
  accountScope='b';changed();f.complete('for-b');
  f.resolve('from-a');await pending;
  f.store.acknowledge(oldScope,'host','thread','for-b');
  assert.equal(f.store.unread('host','thread'),true);
  f.store.acknowledge(f.store.getScope(),'host','thread','for-b');
  accountScope='a';changed();f.complete('for-b');
  assert.equal(f.store.unread('host','thread'),true,'account b receipt never reads account a');
  f.store.dispose();
});


test('fixed historical baseline reads old results without swallowing newer offline replies', async () => {
  for (const completedAt of [99,100,101,null]) {
    const f = fixture(undefined,100);
    const pending=f.store.catchUp(profile,[{id:'thread',updatedAt:99}],()=>true);
    f.resolve('history',completedAt);await pending;
    assert.equal(f.store.unread('host','thread'),completedAt===101);
    if(completedAt!==101) {
      const restored=new ThreadAttention(JSON.parse([...f.storage.values()][0]!));
      restored.observe('host','thread','history');assert.equal(restored.unread('host','thread'),false);
    }
    f.complete('new-live');assert.equal(f.store.unread('host','thread'),true);
    f.store.dispose();
  }
});
test('baseline is opt-in and invalid deployment values cannot clear unread results', async () => {
  for(const cutoff of [0,-1,NaN,Infinity]) {
    const f=fixture(undefined,cutoff);
    const pending=f.store.catchUp(profile,[{id:'thread',updatedAt:0}],()=>true);
    f.resolve('history',0);await pending;
    assert.equal(f.store.unread('host','thread'),true);f.store.dispose();
  }
});
test('historical baseline cannot read a newer completion racing with catch-up', async () => {
  const f=fixture(undefined,100);
  const pending=f.store.catchUp(profile,[{id:'thread',updatedAt:99}],()=>true);
  f.complete('new-live');f.resolve('history',99);await pending;
  assert.equal(f.store.unread('host','thread'),true);assert.equal(f.storage.size,0);f.store.dispose();
});

test('one fixed deployment baseline applies to every account, including later first visits', async () => {
  let accountScope='a';let changed=()=>{};
  const account={getSnapshot:()=>({readStateScope:accountScope}),subscribe:(listener:any)=>{changed=listener;return()=>{};}};
  const accounts={getSnapshot:()=>({contribution:account}),subscribe:()=>()=>{}} as any;
  const f=fixture(accounts,100);
  for(const scope of ['a','b']) {
    accountScope=scope;changed();
    let pending=f.store.catchUp(profile,[{id:'thread',updatedAt:99}],()=>true);
    f.resolve('old',99);await pending;assert.equal(f.store.unread('host','thread'),false);
    pending=f.store.catchUp(profile,[{id:'thread',updatedAt:101}],()=>true);
    f.resolve('offline-new',101);await pending;assert.equal(f.store.unread('host','thread'),true);
  }
  assert.equal(f.storage.size,2,'baseline receipts remain account scoped');f.store.dispose();
});

function remoteAccount(port: any, initial = 'a') {
  let scope: string | null = initial; let changed = () => {};
  return { accounts: {getSnapshot:()=>({contribution:{readReceipts:port,getSnapshot:()=>({readStateScope:scope}),subscribe:(listener:any)=>{changed=listener;return()=>{};}}}),subscribe:()=>()=>{}} as any,
    setScope:(next:string|null)=>{scope=next;changed();} };
}
function receiptServer() {
 const records=new Map<string,Set<string>>();
 const port={read:async(scope:string)=>[...(records.get(scope)??[])],merge:async(scope:string,receipts:string[])=>{const union=records.get(scope)??new Set<string>();for(const r of receipts)union.add(r);records.set(scope,union);return [...union];}};
 return {records,port};
}
test('unchanged foreground synchronization does not write storage or invalidate consumers', async () => {
 const server=receiptServer(), account=remoteAccount(server.port);
 let writes=0;
 const store=new BrowserThreadAttention({get:()=>undefined} as any,{subscribe:()=>()=>{}} as any,account.accounts,
   {getItem:()=>null,setItem:()=>{writes++;}},'test');
 await store.synchronize();
 let publications=0;store.subscribe(()=>publications++);writes=0;
 for(let i=0;i<3;i++)await store.synchronize();
 assert.equal(writes,0);assert.equal(publications,0);
 store.dispose();
});

test('a failed initial cache write is retried even when receipts do not change', async () => {
 const server=receiptServer(),account=remoteAccount(server.port);let writes=0;
 const store=new BrowserThreadAttention({get:()=>undefined} as any,{subscribe:()=>()=>{}} as any,account.accounts,
   {getItem:()=>null,setItem:()=>{if(++writes===1)throw Error('quota');}},'test');
 await store.synchronize();await store.synchronize();await store.synchronize();
 assert.equal(writes,2);store.dispose();
});
test('separate devices converge, new browser restores reads and stale turn receipts leave newer replies unread',async()=>{
 const server=receiptServer(),account=remoteAccount(server.port);
 const a=fixture(account.accounts),b=fixture(account.accounts);
 await Promise.all([a.store.synchronize(),b.store.synchronize()]);a.complete('one');b.complete('one');
 a.store.acknowledge('a','host','thread','one');await a.store.synchronize();await b.store.synchronize();
 assert.equal(b.store.unread('host','thread'),false);
 const fresh=fixture(account.accounts);await fresh.store.synchronize();fresh.complete('one');assert.equal(fresh.store.unread('host','thread'),false);
 b.complete('two');await b.store.synchronize();assert.equal(b.store.unread('host','thread'),true);
 b.store.acknowledge('a','host','thread','one');assert.equal(b.store.unread('host','thread'),true);
 for(const f of [a,b,fresh])f.store.dispose();
});
test('legacy local receipts merge with remote data; unknown committed writes recover by read without data loss',async()=>{
 const server=receiptServer(),account=remoteAccount(server.port);
 const old=JSON.stringify(['host','thread','old']),other=JSON.stringify(['host','thread','other']);
 server.records.set('a',new Set([other]));const saved=new Map([['test:"a"',JSON.stringify([old])]]);
 const f=fixture(account.accounts,0,saved);await f.store.synchronize();assert.deepEqual(new Set(server.records.get('a')),new Set([old,other]));
 const merge=server.port.merge;let fail=true;
 server.port.merge=async(scope,receipts)=>{const result=await merge(scope,receipts);if(fail){fail=false;throw Error('lost acknowledgement');}return result;};
 f.complete('new');f.store.acknowledge('a','host','thread','new');await f.store.synchronize();
 await f.store.synchronize();assert.equal(f.store.unread('host','thread'),false);assert.equal(server.records.get('a')?.size,3);f.store.dispose();
});
test('offline acknowledgements survive browser reload and upload when service recovers',async()=>{
 const server=receiptServer();let offline=true;const read=server.port.read;server.port.read=async scope=>{if(offline)throw Error('offline');return read(scope);};
 const account=remoteAccount(server.port),f=fixture(account.accounts);await f.store.synchronize();f.complete('offline');f.store.acknowledge('a','host','thread','offline');await f.store.synchronize();
 const restored=fixture(account.accounts,0,f.storage);f.store.dispose();await restored.store.synchronize();offline=false;await restored.store.synchronize();
 assert.ok(server.records.get('a')?.has(JSON.stringify(['host','thread','offline'])));restored.store.dispose();
});
test('account switch/logout/disposal revoke late remote reads and stale local acknowledgements',async()=>{
 let resolve:(receipts:string[])=>void=()=>{};
 const server=receiptServer();server.port.read=scope=>scope==='a'?new Promise(done=>{resolve=done;}):Promise.resolve([]);
 const account=remoteAccount(server.port),f=fixture(account.accounts);const pending=f.store.synchronize();await Promise.resolve();f.complete('old');
 account.setScope('b');await f.store.synchronize();f.complete('new');resolve([JSON.stringify(['host','thread','new'])]);await pending;
 assert.equal(f.store.unread('host','thread'),true);f.store.acknowledge('a','host','thread','new');assert.equal(f.store.unread('host','thread'),true);
 account.setScope(null);assert.equal(f.store.getScope(),null);f.store.dispose();
});
