import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as Y from 'yjs';
import {ThreadNoteStore} from '../../plugins/thread-summary/src/note-store';
import {ThreadNoteClient,encode,decode} from '../../plugins/thread-summary/src/note-client';

async function fixture(t:any) {
  const dir=await mkdtemp(join(tmpdir(),'thread-notes-'));
  let store=new ThreadNoteStore(join(dir,'notes.sqlite'));
  const clients:ThreadNoteClient[]=[];
  t.after(async()=>{for(const client of clients)client.close();store.close();await rm(dir,{recursive:true,force:true});});
  return {dir,get store(){return store;},restart(){store.close();store=new ThreadNoteStore(join(dir,'notes.sqlite'));},client(server='s',thread='t') {
    let offline=false;
    const client=new ThreadNoteClient({exchange:async(update,vector)=>{if(offline)throw Error('offline');return store.exchange(server,thread,update,vector);}});clients.push(client);
    return {client,offline(value:boolean){offline=value;}};
  }};
}

test('two offline concurrent Markdown writers converge, retry, preserve deletes and survive independent DB reopen',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await a.client.sync();await b.client.sync();
  a.client.replace('# Plan\n- first\n');await a.client.sync();await b.client.sync();
  a.offline(true);b.offline(true);
  a.client.doc.transact(()=>a.client.text.insert(7,'Alice '));
  b.client.doc.transact(()=>b.client.text.insert(b.client.text.length,'- Bob\n'));
  await a.client.sync();await b.client.sync();assert.equal(a.client.getSnapshot().status,'offline');
  a.offline(false);b.offline(false);await b.client.sync();await a.client.sync();await b.client.sync();
  assert.equal(a.client.text.toString(),b.client.text.toString());assert.match(a.client.text.toString(),/Alice/);assert.match(a.client.text.toString(),/Bob/);
  const duplicate=encode(Y.encodeStateAsUpdate(a.client.doc)),vector=encode(Y.encodeStateVector(a.client.doc));
  f.store.exchange('s','t',duplicate,vector);f.store.exchange('s','t',duplicate,vector);
  a.client.replace('');await a.client.sync();await b.client.sync();assert.equal(b.client.text.toString(),'');
  a.client.replace('## 决策\n保留');await a.client.sync();f.restart();const c=f.client();await c.client.sync();assert.equal(c.client.text.toString(),'## 决策\n保留');
  const foreign=f.client('other'),different=f.client('s','different');await foreign.client.sync();await different.client.sync();assert.equal(foreign.client.text.length,0);assert.equal(different.client.text.length,0);
});

test('local edits made during an in-flight acknowledgement remain pending; composition defers remote updates',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await a.client.sync();await b.client.sync();
  a.client.replace('基础');await a.client.sync();await b.client.sync();
  a.client.composition(true);b.client.replace('基础 remote');await b.client.sync();await a.client.sync();
  assert.equal(a.client.text.toString(),'基础');a.client.replace('基础中文');a.client.composition(false);await a.client.sync();await b.client.sync();
  assert.equal(a.client.text.toString(),b.client.text.toString());assert.match(a.client.text.toString(),/中文/);assert.match(a.client.text.toString(),/remote/);
  let release!:()=>void;
  const transport={exchange:async(update:string,vector:string)=>{const result=f.store.exchange('s','race',update,vector);await new Promise<void>(resolve=>release=resolve);return result;}};
  const c=new ThreadNoteClient(transport);t.after(()=>c.close());const initial=c.sync();release();await initial;
  c.replace('one');const inFlight=c.sync();c.replace('one two');release();await inFlight;assert.equal(c.getSnapshot().status,'saving');
  const next=c.sync();release();await next;assert.equal(c.getSnapshot().status,'saved');
  const doc=new Y.Doc();Y.applyUpdate(doc,decode(f.store.exchange('s','race','',encode(new Uint8Array([0]))).update));assert.equal(doc.getText('markdown').toString(),'one two');doc.destroy();
});

test('invalid/oversized CRDT updates roll back without changing the prior note',async t=>{
  const f=await fixture(t),a=f.client();await a.client.sync();a.client.replace('keep');await a.client.sync();
  assert.throws(()=>f.store.exchange('s','t','!!!','AA=='));
  assert.throws(()=>f.store.exchange('s','t','',encode(new Uint8Array([255]))));
  const huge=new Y.Doc();huge.getText('markdown').insert(0,'x'.repeat(65537));assert.throws(()=>f.store.exchange('s','t',encode(Y.encodeStateAsUpdate(huge)),'AA=='));huge.destroy();
  const b=f.client();await b.client.sync();assert.equal(b.client.text.toString(),'keep');
});

test('out-of-order dependent edits and duplicate deletion updates converge without losing Unicode',async t=>{
  const f=await fixture(t),doc=new Y.Doc(),updates:Uint8Array[]=[];
  doc.on('update',(update:Uint8Array)=>updates.push(update));
  doc.getText('markdown').insert(0,'😀中文');doc.getText('markdown').insert(4,'后续');doc.getText('markdown').delete(2,2);
  for(const update of [updates[2],updates[1],updates[0],updates[2]])f.store.exchange('s','t',encode(update!),'AA==');
  const a=f.client();await a.client.sync();assert.equal(a.client.text.toString(),doc.getText('markdown').toString());
  a.client.replace('😁后续');await a.client.sync();const b=f.client();await b.client.sync();assert.equal(b.client.text.toString(),'😁后续');doc.destroy();
});
