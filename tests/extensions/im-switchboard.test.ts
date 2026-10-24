import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ImPlugin, imSourceKey, type ImExecutionPort } from '../../plugins/im/src/server';
import { SwitchboardStore } from '../../plugins/im/src/store';
import type { ConversationRef } from '../../packages/appserver-protocol/src/collaboration';
import { encodeConversationRef } from '../../packages/appserver-protocol/src/collaboration';
import { readImConfiguration } from '../../scripts/im-plugins.mjs';

function deferred<T>() { let resolve!: (value:T) => void; const promise = new Promise<T>(r => {resolve=r;}); return {promise,resolve}; }

test('private configuration parse errors do not expose credential snippets or raw causes',async t => {
  const root=await mkdtemp(join(tmpdir(),'im-config-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'private.json');
  await writeFile(path,'{"secret":"sentinel-fixture-private-value",',{mode:0o600});
  await assert.rejects(readImConfiguration(path),(error:Error) => error.message === 'Unable to read private IM configuration' && error.cause === undefined);
  await writeFile(path,JSON.stringify({schemaVersion:1,endpoints:[]})); assert.deepEqual(await readImConfiguration(path),[]);
  await writeFile(path,JSON.stringify({schemaVersion:1,endpoints:[],module:'untrusted'})); await assert.rejects(readImConfiguration(path),/Invalid IM configuration/);
});
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(),'im-switchboard-')), path = join(root,'im.sqlite');
  const store = new SwitchboardStore(path), replies: string[] = [], inputs: {ref:ConversationRef; key:string; text:string}[] = [];
  const results = new Map<string,ReturnType<typeof deferred<string>>>();
  const revoked = new Set<string>(); let created = 0;
  const execution: ImExecutionPort = {
    human(actorId) { if (!['owner','sender'].includes(actorId) || revoked.has(actorId)) throw new Error('denied'); return {actorId,generation:1,credentialId:null,expiresAt:Date.now()+60000}; },
    authorize(context,ref) { if (revoked.has(context.actorId) || ref && ref.serverId !== 'server') throw new Error('denied'); },
    async create() { return {serverId:'server',threadId:`thread-${++created}`}; },
    async validate(context,ref) { this.authorize(context,ref); },
    async submit(_context,ref,key,text) { inputs.push({ref,key,text}); const id=String(inputs.length); results.set(id,deferred<string>()); return id; },
    async result(_context,_ref,id,signal) {
      return Promise.race([results.get(id)!.promise,new Promise<never>((_,reject) => {
        signal.addEventListener('abort',() => reject(signal.reason),{once:true});
      })]);
    },
  };
  const im = new ImPlugin(store,execution);
  im.register({id:'bot',ownerId:'owner',senders:{external:'sender'},groupScope:'chat'});
  t.after(async () => { await im.close(); await rm(root,{recursive:true,force:true}); });
  const source = {chatId:'chat',chatType:'group' as const,senderId:'external'};
  const message = (id:string,text:string,chatId='chat') => ({id,text,source:{...source,chatId},reply:async (text:string) => {replies.push(text);}});
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };
  return {root,path,store,im,replies,inputs,results,execution,source,message,tick,revoked,created:() => created};
}

test('switch while a turn runs preserves its source, conversation and reply closure',async t => {
  const f=await fixture(t), first=f.im.receive('bot',f.message('first','hello'));
  await f.tick(); assert.equal(f.inputs[0].ref.threadId,'thread-1');
  await f.im.receive('bot',f.message('new','/new'));
  assert.equal(f.store.get('bot',imSourceKey(f.source,'chat'))?.threadId,'thread-2');
  f.results.get('1')!.resolve('old answer'); await first;
  assert.equal(f.inputs[0].ref.threadId,'thread-1'); assert.equal(f.replies.at(-1),'old answer');
  const next=f.im.receive('bot',f.message('second','next')); await f.tick();
  assert.equal(f.inputs[1].ref.threadId,'thread-2'); f.results.get('2')!.resolve('new answer'); await next;
});

test('one bot isolates sources and coalesces duplicate callbacks without another execution or reply',async t => {
  const f=await fixture(t), message=f.message('id','hello');
  const a=f.im.receive('bot',message), duplicate=f.im.receive('bot',message), b=f.im.receive('bot',f.message('id','hello','other'));
  await f.tick(); assert.equal(f.inputs.length,2); assert.notEqual(f.inputs[0].ref.threadId,f.inputs[1].ref.threadId);
  assert.notEqual(f.inputs[0].key,f.inputs[1].key);
  await assert.rejects(f.im.receive('bot',{...message,text:'changed'}),/invalid_message/);
  f.results.get('1')!.resolve('one'); f.results.get('2')!.resolve('two'); await Promise.all([a,duplicate,b]);
  assert.deepEqual(f.replies.sort(),['one','two']);
});

test('unknown senders, invalid switch targets and revoked owners fail before execution or disclosure',async t => {
  const f=await fixture(t);
  await assert.rejects(f.im.receive('bot',{...f.message('1','hello'),source:{...f.source,senderId:'unknown'}}),/denied/);
  await assert.rejects(f.im.receive('bot',f.message('2','/switch '+encodeConversationRef({serverId:'foreign',threadId:'t'}))),/denied/);
  assert.equal(f.created(),0); assert.equal(f.inputs.length,0);
  const running=f.im.receive('bot',f.message('3','hello')); await f.tick(); f.revoked.add('owner');
  f.results.get('1')!.resolve('secret'); await assert.rejects(running,/denied/); assert.equal(f.replies.length,0);
});

test('switch validates and updates only the binding, including server identity',async t => {
  const f=await fixture(t), ref={serverId:'server',threadId:'existing'};
  await f.im.receive('bot',f.message('switch','/switch '+encodeConversationRef(ref)));
  assert.deepEqual(f.store.get('bot',imSourceKey(f.source,'chat')),ref); assert.equal(f.inputs.length,0); assert.equal(f.created(),0);
});

test('source tuples distinguish platform chat, thread and optional member without delimiter collisions',() => {
  const source={chatId:'a:b',chatType:'group' as const,senderId:'c'};
  assert.notEqual(imSourceKey(source,'sender'),imSourceKey({...source,chatId:'a',senderId:'b:c'},'sender'));
  assert.equal(imSourceKey(source,'chat'),imSourceKey({...source,senderId:'other'},'chat'));
  assert.notEqual(imSourceKey(source,'chat'),imSourceKey({...source,threadId:'thread'},'chat'));
});

test('managed bindings survive reopen and checksum drift is rejected without losing data',async t => {
  const root=await mkdtemp(join(tmpdir(),'im-store-')); t.after(() => rm(root,{recursive:true,force:true}));
  const path=join(root,'im.sqlite'), ref={serverId:'s',threadId:'t'};
  let store=new SwitchboardStore(path); store.bind('bot','source',ref); store.close();
  store=new SwitchboardStore(path); assert.deepEqual(store.get('bot','source'),ref); assert.equal(store.outcome.status,'up-to-date'); store.close();
  const db=new DatabaseSync(path); db.exec("UPDATE schema_migrations SET checksum='bad' WHERE version=1"); db.close();
  assert.throws(() => new SwitchboardStore(path));
  const preserved=new DatabaseSync(path,{readOnly:true}); assert.equal(preserved.prepare('SELECT count(*) AS n FROM switchboard').get()!.n,1); preserved.close();
});

test('shutdown aborts reply waits and rejects late delivery without changing accepted execution',async t => {
  const f=await fixture(t), running=f.im.receive('bot',f.message('1','hello'));
  const rejected=assert.rejects(running); await f.tick(); await f.im.close(); await rejected;
  assert.equal(f.inputs.length,1); assert.deepEqual(f.replies,[]);
  await assert.rejects(f.im.receive('bot',f.message('2','later')),/closed/);
});
