import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ProvisionalThreads} from '../../apps/opencraft-daemon/src/provisional-threads';

test('reobserving persisted creation evidence does not perform another logical update',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'provisional-idempotence-'));
  const store=new ProvisionalThreads(directory);
  const observer=new DatabaseSync(join(directory,'thread-creations.sqlite'));
  t.after(async()=>{observer.close();store.close();await rm(directory,{recursive:true,force:true});});
  store.created('thread',{thread:{id:'thread'}},'environment');
  store.accepted('thread','input','turn');
  store.persisted('thread');
  observer.exec(`CREATE TABLE repeated_updates(n INTEGER NOT NULL);
    INSERT INTO repeated_updates VALUES(0);
    CREATE TRIGGER count_repeated_persistence AFTER UPDATE ON thread_creations
    WHEN OLD.phase='persisted' AND NEW.phase='persisted'
    BEGIN UPDATE repeated_updates SET n=n+1; END;`);
  for(let i=0;i<100;i++)store.persisted('thread');
  assert.equal(observer.prepare('SELECT n FROM repeated_updates').get()!.n,0,'already-persisted evidence must not execute another row update');
  assert.equal(store.get('thread')?.phase,'persisted');
  assert.equal(store.get('thread')?.inputId,'input');
  assert.equal(store.get('thread')?.turnId,'turn');
  store.persisted('unknown');
  assert.equal(store.get('unknown'),null,'observation cannot manufacture creation evidence');
});
