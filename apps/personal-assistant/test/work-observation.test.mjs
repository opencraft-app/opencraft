import test from 'node:test';
import assert from 'node:assert/strict';
import { workObservation, readWorkObservation } from '../src/runtime/work-observation.mjs';
test('work observation is bounded to current work and never exports private execution fields', () => {
  const rows=Array.from({length:15},(_,i)=>({id:'work-'+i,text:'Task '+i,status:i===0?'completed':'running',updated_at:i,error:'secret',delegation:{credential:'private'}}));
  const projected=workObservation(rows);
  assert.equal(projected.length,8);assert.equal(projected[0].id,'work-14');assert.equal(projected[1].id,'work-13');
  assert.deepEqual(Object.keys(projected[0]).sort(),['id','status','title','updatedAt']);
  assert.equal(rows[0].id,'work-0');assert.deepEqual(readWorkObservation(projected),projected);
});
test('invalid or unbounded worker observations cannot become task UI facts',()=>{
  assert.deepEqual(workObservation([{id:'a',text:'x',status:'invented',updated_at:1}]),[]);
  assert.equal(readWorkObservation([{id:'a',title:'x',status:'invented',updatedAt:1}]),undefined);
  assert.equal(readWorkObservation(Array(9).fill({id:'a',title:'x',status:'running',updatedAt:1})),undefined);
  assert.equal(readWorkObservation([{id:'a',title:'x',status:'running',updatedAt:Number.MAX_VALUE}]),undefined);
  assert.equal(readWorkObservation(Array(2).fill({id:'a',title:'x',status:'running',updatedAt:1})),undefined);
  assert.equal(workObservation([{id:'a',text:'x'.repeat(900),status:'blocked',updated_at:1}])[0].title.length,512);
});

test('terminal history never fills empty current slots, including legacy Worker observations', () => {
  const rows = ['completed', 'cancelled', 'failed'].map((status, i) => ({id:status,text:'old reminder',status,updated_at:i}));
  assert.deepEqual(workObservation(rows), []);
  assert.deepEqual(readWorkObservation(rows.map(({text,updated_at,...row})=>({...row,title:text,updatedAt:updated_at}))), []);
  assert.equal(rows.length,3, 'projection does not delete history');
  for (const status of ['queued','running','waiting_input','awaiting_review','awaiting_delivery','blocked']) {
    assert.deepEqual(workObservation([...rows,{id:'current',text:'task',status,updated_at:10}]).map(row=>row.id), ['current']);
  }
});
