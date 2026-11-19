import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {EmployeeAdmissionPolicy} from '../../plugins/tencentoa/src/admission-policy';
test('persisted provider metadata resolves RTX by stable OA subject without an active login, and ambiguous aliases fail closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-rtx-'));let policy:EmployeeAdmissionPolicy|undefined;
 try{
  policy=new EmployeeAdmissionPolicy(join(dir,'admission.sqlite'),{id:'fixture',name:'Fixture'},()=>undefined);
  await policy.prepare({provider:'tencentoa',subject:'206880',displayName:'Arbitrary display label',attributes:{loginName:'walkercao'},expiresAt:Date.now()+60000});
  policy.close();policy=new EmployeeAdmissionPolicy(join(dir,'admission.sqlite'),{id:'fixture',name:'Fixture'},()=>undefined);
  assert.deepEqual(policy.employeeBindingForSubject('206880'),{subject:'206880',loginName:'walkercao'});
  assert.equal(policy.employeeBindingForSubject('walkercao'),null);
  await policy.prepare({provider:'tencentoa',subject:'999',displayName:'Another employee',attributes:{loginName:'walkercao'},expiresAt:Date.now()+60000});
  assert.equal(policy.employeeBindingForSubject('206880'),null);
  assert.equal(policy.employeeBindingForSubject('999'),null);
 }finally{policy?.close();await rm(dir,{recursive:true,force:true});}
});
