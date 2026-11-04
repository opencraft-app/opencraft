import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ActorStore } from '../../packages/access-control/src/actors';

function fixture(t: test.TestContext) {
  const root=mkdtempSync(join(tmpdir(),'count-bindings-'));
  const path=join(root,'actors.sqlite'), store=new ActorStore(path);
  const owner=store.resolveHuman({provider:'fixture',subject:'owner',displayName:'owner',expiresAt:Date.now()+60000})!;
  const other=store.resolveHuman({provider:'fixture',subject:'other',displayName:'other',expiresAt:Date.now()+60000})!;
  const writer=new DatabaseSync(path);
  t.after(()=>{writer.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {path,store,owner,other,writer};
}
function populate(db:DatabaseSync, actorId:string, size:number) {
  const insert=db.prepare('INSERT INTO actor_bindings(binding,actor_id) VALUES(?,?)');
  db.exec('BEGIN');try {
    for(let i=0;i<size;i++)insert.run(JSON.stringify(['fixture','filler-'+i]),actorId);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}

test('128/1k/12k/16k global bindings yield without old unbounded lookup and return only original human aliases',async t=>{
  for (const size of [128,1000,12000,16000]) {
    await t.test(String(size),async t=>{
      const {store,owner,other,writer}=fixture(t);populate(writer,other.actorId,size);
      // Cover a legal negative rowid; scanning from zero would silently miss it.
      writer.prepare('UPDATE actor_bindings SET rowid=-7 WHERE binding=?').run(JSON.stringify(['fixture','owner']));
      store.bindings=()=>{throw Error('old unbounded bindings must not run');};
      let ticks=0;const timer=setInterval(()=>ticks++,0);
      const started=performance.now();
      const view=await store.captureCountBindings(owner,()=>{assert.ok(performance.now()-started<9000);});
      clearInterval(timer);
      assert.ok(view);assert.deepEqual(view.bindings,[{provider:'fixture',subject:'owner'}]);
      assert.equal(view.validate(),true);
      if(size>256)assert.ok(ticks>0,'control lane remains available');
      t.diagnostic(JSON.stringify({globalBindings:size+2,milliseconds:performance.now()-started}));
    });
  }
});

test('global cap, byte cap, malformed fields and own alias cap produce incomplete view',async t=>{
  for(const mode of ['global','bytes','bad','aliases'])await t.test(mode,async t=>{
    const {store,owner,other,writer}=fixture(t);
    if(mode==='global')populate(writer,other.actorId,32768);
    if(mode==='bytes'){
      const insert=writer.prepare('INSERT INTO actor_bindings(binding,actor_id) VALUES(?,?)');
      writer.exec('BEGIN');
      for(let i=0;i<8000;i++)insert.run('x'.repeat(600)+i,other.actorId);
      writer.exec('COMMIT');
    }
    if(mode==='bad')writer.prepare('INSERT INTO actor_bindings(binding,actor_id) VALUES(?,?)').run('x'.repeat(1025),other.actorId);
    if(mode==='aliases')populate(writer,owner.actorId,32);
    assert.equal(await store.captureCountBindings(owner,()=>{}),null);
  });
});

test('external ABA during a yield, own write, expiration and cancellation cannot publish a stale view',async t=>{
  const {store,owner,other,writer}=fixture(t);populate(writer,other.actorId,1000);
  setImmediate(()=>{writer.prepare('UPDATE actors SET enabled=0 WHERE id=?').run(owner.actorId);writer.prepare('UPDATE actors SET enabled=1 WHERE id=?').run(owner.actorId);});
  assert.equal(await store.captureCountBindings(owner,()=>{}),null);
  const view=await store.captureCountBindings(owner,()=>{});assert.ok(view);
  store.setEnabled(owner.actorId,false,'fixture');store.setEnabled(owner.actorId,true,'fixture');
  assert.equal(view.validate(),false);
  assert.equal(await store.captureCountBindings({...owner,expiresAt:0},()=>{}),null);
  const cancelled=new Error('cancelled');let calls=0;
  await assert.rejects(store.captureCountBindings({...owner,generation:store.get(owner.actorId)!.generation},()=>{if(++calls===3)throw cancelled;}),e=>e===cancelled);
});
