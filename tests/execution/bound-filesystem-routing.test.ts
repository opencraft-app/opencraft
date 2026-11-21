import test from 'node:test';
import assert from 'node:assert/strict';
import { HostFileSystemSession } from '../../apps/headless-server/src/host-filesystem-transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
const context = { sender: null };
const frame = (id: string, method: string, params: unknown = {}) => JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'client' });
async function initialize(session: HostFileSystemSession) {
  await session.receive(frame('init', 'initialize'), context);
  session.project(JSON.stringify({ id: 'init', result: { capabilities: {} }, [LOGICAL_CLIENT_FIELD]: 'client' }));
}
test('trusted selected files receive requests and no Host/native fallback is possible', async () => {
  let localCalls = 0, remoteCalls = 0, allowed = true;
  const replies: any[] = [];
  const session = new HostFileSystemSession({ request: async () => { localCalls++; throw Error('local forbidden'); } }, () => {}, async () => {
    if (!allowed) throw Error('missing binding');
    return { files: { request: async (method, params) => { remoteCalls++; assert.equal(method, 'fs/readFile'); assert.deepEqual(params, { path: '/workspace/a' }); return { dataBase64: 'b2s=' }; } }, assertCurrent() {} };
  });
  session.subscribeMessage(value => replies.push(JSON.parse(value))); await initialize(session);
  assert.equal(await session.receive(frame('read', 'fs/readFile', { path: '/workspace/a' }), context), true);
  assert.deepEqual(replies.at(-1).result, { dataBase64: 'b2s=' });
  allowed = false; await session.receive(frame('lost', 'fs/readFile', { path: '/workspace/a' }), context);
  assert.ok(replies.at(-1).error); assert.equal(localCalls, 0); assert.equal(remoteCalls, 1); session.close();
});
test('lease changes during a remote read suppress contents and never reselect a successor', async () => {
  let settle!: (value: unknown) => void, began!: () => void, current = true, selections = 0;
  const started = new Promise<void>(resolve => began = resolve), replies: any[] = [];
  const session = new HostFileSystemSession({ request: async () => { throw Error('local'); } }, () => {}, async () => {
    selections++; return { files: { request: async () => { began(); return new Promise(resolve => settle = resolve); } }, assertCurrent() { if (!current) throw Error('retired'); } };
  });
  session.subscribeMessage(value => replies.push(JSON.parse(value))); await initialize(session);
  const pending = session.receive(frame('read', 'fs/readFile', { path: '/workspace/a' }), context); await started;
  current = false; settle({ dataBase64: 'secret' }); await pending;
  assert.equal(selections, 1); assert.equal(replies.at(-1).result, undefined); assert.ok(replies.at(-1).error); session.close();
});
test('disconnect aborts selected file operation and suppresses its reply', async () => {
  let began!: () => void, signal: AbortSignal | undefined, finish!: () => void;
  const started = new Promise<void>(resolve => began = resolve), replies: any[] = [];
  const session = new HostFileSystemSession({ request: async () => { throw Error('local'); } }, () => {}, async () => ({ files: {
    request: async (_method, _params, s) => { signal = s; began(); await new Promise<void>(resolve => finish = resolve); return {}; },
  }, assertCurrent() {} }));
  session.subscribeMessage(value => replies.push(JSON.parse(value))); await initialize(session);
  const pending = session.receive(frame('read', 'fs/readFile'), context); await started;
  await session.receive(frame('bye', 'runtime/client/disconnect'), context); assert.equal(signal?.aborted, true);
  finish(); await pending; assert.equal(replies.length, 0); session.close();
});
test('undefined selector result and unauthorized context do not touch local files', async () => {
  let calls = 0, selects = 0, permitted = true;
  const session = new HostFileSystemSession({ request: async () => { calls++; return {}; } }, () => { if (!permitted) throw Error('denied'); }, async () => { selects++; return undefined as any; });
  const replies: any[] = []; session.subscribeMessage(value => replies.push(JSON.parse(value))); await initialize(session);
  await session.receive(frame('missing', 'fs/readFile'), context); permitted = false;
  await session.receive(frame('denied', 'fs/readFile'), context);
  assert.equal(calls, 0); assert.equal(selects, 1); assert.equal(replies.length, 2); assert.ok(replies.every(r => r.error)); session.close();
});
test('unconfigured selection preserves local files and disconnect/revocation reply fencing',async()=>{
 let allowed=true,calls=0,settle!:(value:unknown)=>void;const replies:any[]=[];
 const session=new HostFileSystemSession({async request(){calls++;return new Promise(resolve=>settle=resolve)}},()=>{if(!allowed)throw Error('revoked')});
 session.subscribeMessage(value=>replies.push(JSON.parse(value)));await initialize(session);
 const first=session.receive(frame('local','fs/readFile',{path:'/local/a'}),context);assert.equal(calls,1);
 allowed=false;settle({dataBase64:'c2VjcmV0'});await first;assert.ok(replies.at(-1).error);assert.equal(replies.at(-1).result,undefined);
 allowed=true;const second=session.receive(frame('later','fs/readFile',{path:'/local/a'}),context);assert.equal(calls,2);
 await session.receive(frame('bye','runtime/client/disconnect'),context);const count=replies.length;settle({dataBase64:'c2VjcmV0'});await second;assert.equal(replies.length,count);session.close();
});

test('workspace file scope is validated and stripped only after trusted selection',async()=>{
 let calls=0;const replies:any[]=[];
 const session=new HostFileSystemSession({async request(){throw Error('local fallback')}},()=>{},async(_context,params)=>{
  assert.deepEqual(params,{path:'/workspace/a',workspaceThreadId:'thread-a'});assert.equal(Object.isFrozen(params),true);
  return {assertCurrent(){},files:{async request(_method,params){calls++;assert.deepEqual(params,{path:'/workspace/a'});return {dataBase64:'YQ=='}}}};
 });
 session.subscribeMessage(v=>replies.push(JSON.parse(v)));await initialize(session);
 await session.receive(frame('scoped','fs/readFile',{path:'/workspace/a',workspaceThreadId:'thread-a'}),context);
 assert.equal(calls,1);assert.deepEqual(replies.at(-1).result,{dataBase64:'YQ=='});
 await session.receive(frame('invalid','fs/readFile',{path:'/workspace/a',workspaceThreadId:''}),context);
 assert.equal(calls,1);assert.ok(replies.at(-1).error);session.close();
});
test('scoped requests cannot silently use local files when selection is not installed',async()=>{
 let calls=0;const replies:any[]=[];
 const session=new HostFileSystemSession({async request(){calls++;return {}}},()=>{});
 session.subscribeMessage(v=>replies.push(JSON.parse(v)));await initialize(session);
 for(const workspaceThreadId of ['thread-a',null,4,'bad\nthread'])
  await session.receive(frame('scope','fs/readFile',{path:'/workspace/a',workspaceThreadId}),context);
 assert.equal(calls,0);assert.equal(replies.length,4);assert.ok(replies.every(v=>v.error));session.close();
});
