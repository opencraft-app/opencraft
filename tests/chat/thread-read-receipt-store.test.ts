import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SqliteDocumentStore} from '@opencraft/document-storage/sqlite';
import {ThreadReadReceiptStore} from '../../scripts/thread-read-receipt-store';
const receipt=(turn:string)=>JSON.stringify(['server','thread',turn]);
test('existing document data, restart, account isolation and two writers retain receipts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'thread-read-'));const path=join(directory,'receipts.sqlite');
 try {
  const old=new SqliteDocumentStore(path);old.compareAndSet('unrelated',0,1,{retained:true});old.close();
  const a=new ThreadReadReceiptStore(path),b=new ThreadReadReceiptStore(path);
  a.merge('a',[receipt('old')]);b.merge('a',[receipt('new')]);a.merge('a',[receipt('old')]);b.merge('b',[receipt('other')]);
  assert.deepEqual(a.read('a'),[receipt('old'),receipt('new')]);assert.deepEqual(a.read('b'),[receipt('other')]);a.close();b.close();
  const restored=new ThreadReadReceiptStore(path);assert.deepEqual(restored.read('a'),[receipt('old'),receipt('new')]);restored.close();
  const inspect=new SqliteDocumentStore(path);assert.deepEqual(inspect.read('unrelated')?.value,{retained:true});inspect.close();
 } finally {await rm(directory,{recursive:true,force:true});}
});
test('malformed receipts cannot replace existing account data',()=>{
 const store=new ThreadReadReceiptStore(':memory:');store.merge('a',[receipt('valid')]);
 for(const input of [null,['not-json'],['["s","t"]'],['["s","t",""]'],new Array(4097).fill(receipt('x'))])assert.throws(()=>store.merge('a',input));
 assert.deepEqual(store.read('a'),[receipt('valid')]);store.close();
});
test('future account format fails closed',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'thread-read-future-'));const path=join(directory,'receipts.sqlite');
 try {
  const documents=new SqliteDocumentStore(path);documents.compareAndSet('thread-read:'+createHash('sha256').update('a').digest('hex'),0,2,[]);documents.close();
  const store=new ThreadReadReceiptStore(path);assert.throws(()=>store.read('a'));assert.throws(()=>store.merge('a',[receipt('new')]));store.close();
 } finally {await rm(directory,{recursive:true,force:true});}
});
