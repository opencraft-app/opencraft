import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { GitExecutionContextReader } from '../../scripts/git-execution-context';
import { ExecutionEnvironmentSnapshot } from '../../scripts/execution-environment';
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE execution_leases(thread_id TEXT,input_id TEXT,execution_id TEXT,engine_incarnation TEXT,
    state TEXT,boot_id TEXT,admitted_at_ms REAL,ended_at_ms REAL,admitted_at_boot_ms REAL,ended_at_boot_ms REAL);
    CREATE TABLE execution_submissions(thread_id TEXT,input_id TEXT,principal_json TEXT,ownership TEXT,admission TEXT);`);
  for (const [id,input,user,birth,end,state] of [['exec-A','input-A','alice',1000,2000,'ended'],['exec-B','input-B','bob',2000,null,'unknown']] as const) {
    db.prepare('INSERT INTO execution_leases VALUES(?,?,?,?,?,?,?,?,?,?)').run('shared',input,id,'native',state,'boot',birth,end,birth,end);
    db.prepare('INSERT INTO execution_submissions VALUES(?,?,?,?,?)').run('shared',input,JSON.stringify({provider:'fixture',subject:user}),'human','accepted');
  }
  return { db, reader: new GitExecutionContextReader(db) };
}
test('attribution survives suspension/completion; commands in one thread keep their original user', t => {
  const f = fixture(t);
  for (const [id,user] of [['exec-A','alice'],['exec-B','bob']] as const) {
    const r=f.reader.resolveExecution('shared',id); assert.equal(r.status,'active');
    if(r.status==='active')assert.equal(r.lease.principal?.subject,user);
  }
  const r=f.reader.resolveJobOrigin({threadId:'shared',engineIncarnation:'native',startedAtMs:1500,uncertaintyMs:10,bootId:'boot',startedAtBootMs:1500});
  assert.equal(r.status,'active');if(r.status==='active')assert.equal(r.lease.executionId,'exec-A');
  assert.equal(f.reader.resolveExecution('other','exec-A').status,'unknown');
  assert.equal(f.reader.resolveExecution('shared','missing').status,'unknown');
  f.db.prepare("UPDATE execution_submissions SET admission='rejected' WHERE input_id='input-A'").run();
  assert.equal(f.reader.resolveExecution('shared','exec-A').status,'unknown');
});
test('legacy locators reject ambiguous boundaries instead of choosing the latest sender',t=>{
  const f=fixture(t);
  for(const birth of [1000,1995,2000,2005])assert.equal(f.reader.resolveJobOrigin({threadId:'shared',engineIncarnation:'native',startedAtMs:birth,uncertaintyMs:10,bootId:'boot',startedAtBootMs:birth}).status,'unknown');
});
test('snapshots isolate IDs, replace stale inherited locators, and rotate execution workers',()=>{
  const scope={account:'fixture:alice',hostId:'host',threadId:'shared',projectId:null};
  const a=new ExecutionEnvironmentSnapshot({...scope,executionId:'exec-A'},{}), b=new ExecutionEnvironmentSnapshot({...scope,executionId:'exec-B'},{});
  assert.notEqual(a.key,b.key);assert.equal(a.owner,b.owner);
  assert.equal(a.apply({OPENCRAFT_EXECUTION_ID:'stale'}).OPENCRAFT_EXECUTION_ID,'exec-A');
  assert.equal(b.overlay().OPENCRAFT_EXECUTION_ID,'exec-B');
  assert.equal(new ExecutionEnvironmentSnapshot(scope,{}).apply({OPENCRAFT_EXECUTION_ID:'stale'}).OPENCRAFT_EXECUTION_ID,'');
  assert.deepEqual(a.toJSON(),{configured:false});
});
