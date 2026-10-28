import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {DshConsumerReceipts} from '../../scripts/server-deployment/dsh-consumer-receipts.mjs';
test('unknown consumer lease survives disconnect/restart and requires exact response receipt',async t=>{
 const root=await mkdtemp('/tmp/dsh-consumer-');t.after(()=>rm(root,{recursive:true,force:true}));
 const old=new DshConsumerReceipts(root);const finish=old.begin({id:1,method:'turn/start',params:{input:'synthetic'}});
 const ready=finish({id:1,result:{turnId:'one'}});
 assert.equal(old.observation().activeCount,1);
 const next=new DshConsumerReceipts(root);assert.equal(next.observation().activeCount,1);
 assert.throws(()=>next.acknowledge({...ready,receipt:'cancelled'}));assert.equal(next.observation().activeCount,1);
 next.acknowledge(ready);assert.equal(next.observation().activeCount,0);
 next.begin({id:2,method:'turn/start'}); // Simulate lost output before a receipt exists.
 const uncertain=new DshConsumerReceipts(root);assert.equal(uncertain.observation().activeCount,1);
 assert.throws(()=>uncertain.acknowledge(ready));
});
