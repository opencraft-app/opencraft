import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {observeSqlite,SqlObservation,sqlFingerprint} from '../../packages/app-host-server/src/sqlite-observation';
import {historyReadTiming,beginHistoryReadTiming} from '../../packages/app-host-server/src/history-read-timing';
test('native SQLite receivers, prepared reuse, partial iteration and errors preserve behavior and bounded statistics',()=>{
 const db=new DatabaseSync(':memory:');observeSqlite(db);observeSqlite(db);db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, text TEXT)');
 const insert=db.prepare('INSERT INTO sample VALUES(?,?)');for(let i=0;i<5;i++)insert.run(i,'private-canary');
 const all=db.prepare('SELECT * FROM sample ORDER BY id'),trace=beginHistoryReadTiming();trace.sql=new SqlObservation();
 try{historyReadTiming.run(trace,()=>{
  assert.equal(all.all().length,5);assert.equal(db.prepare('SELECT * FROM sample WHERE id=?').get(1)!.id,1);
  for(const row of all.iterate()){assert.equal(row.id,0);break;}
  assert.throws(()=>insert.run(1,'private-canary'));
 });const summary=trace.sql.summary();assert.equal(summary.sqlCalls,4);assert.equal(summary.sqlRows,7);assert.equal(summary.sqlErrors,1);assert.equal(summary.sqlPrepareCalls,1);assert(Number(summary.sqlMs)>=0);assert(!JSON.stringify(summary).includes('private'));assert.match(String(summary.sqlTopFingerprint),/^[a-f0-9]{16}$/u);
 assert.equal(all.all().length,5);assert.equal(trace.sql.calls,4,'outside-context work cannot mutate old request');
 const other=beginHistoryReadTiming();other.sql=new SqlObservation();historyReadTiming.run(other,()=>all.all());assert.equal(other.sql.calls,1);assert.equal(trace.sql.calls,4);
 assert.equal(sqlFingerprint("SELECT * FROM sample WHERE text='secret-a' AND id=12"),sqlFingerprint(" select * from sample where text='secret-b' and id=89 "));
 }finally{db.close();}
});
