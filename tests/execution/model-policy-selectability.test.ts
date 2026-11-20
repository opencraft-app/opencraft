import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelPolicyStore,projectModels,assertModelPolicy} from '@opencraft/model-usage-policy';
test('an effort restriction does not disable the whole model; execution still rejects that effort',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'policy-selectability-')),path=join(dir,'policy.sqlite'),store=new ModelPolicyStore(path);
 try{
  store.write(0,[{engine:'codex',effort:'ultra'}],'fixture-admin');
  const model={model:'fixture-model',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'ultra'}]};
  const [choice]=projectModels(path,'codex',[model]);
  assert.equal(choice.policyRestricted,false);assert.equal(choice.hidden,false);
  assert.deepEqual(choice.policyRestrictedEfforts,['ultra']);
  assert.deepEqual(choice.supportedReasoningEfforts,[{reasoningEffort:'high'}]);
  assert.equal(assertModelPolicy(path,'codex','fixture-model','high'),1);
  assert.throws(()=>assertModelPolicy(path,'codex','fixture-model','ultra'),/restricted|Contact/);
  store.write(1,[{engine:'codex',model:'fixture-model'}],'fixture-admin');
  const [blocked]=projectModels(path,'codex',[model]);assert.equal(blocked.policyRestricted,true);assert.equal(blocked.hidden,true);
  assert.throws(()=>assertModelPolicy(path,'codex','fixture-model','high'),/Contact/);
 }finally{store.close();await rm(dir,{recursive:true,force:true})}
});
