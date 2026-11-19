import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {createNativeMemberOwnerDirectory} from '../../plugins/tencentoa/src/native-member-owner-directory.mjs';
const principal=(subject='206880',rtx='walkercao')=>({provider:'tencentoa',subject,attributes:{loginName:rtx},aliases:['login:'+rtx],displayName:'untrusted label',expiresAt:2000});
function fixture(t){const d=fs.mkdtempSync(join(os.tmpdir(),'native-owner-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('startup reads real legacy admission metadata without an InstanceAccess admissionPolicy',t=>{
 const d=fixture(t),db=new DatabaseSync(join(d,'employee-admission.sqlite'));db.exec('CREATE TABLE employee_policy_identities(subject TEXT PRIMARY KEY, login_name TEXT)');db.prepare('INSERT INTO employee_policy_identities VALUES(?,?)').run('206880','walkercao');db.close();
 const directory=createNativeMemberOwnerDirectory(d,()=>1000);assert.equal(directory.lookup('206880'),'walkercao');assert.equal(directory.lookup('walkercao'),null);directory.close();
 assert.equal(fs.existsSync(join(d,'join-native-member-identities.json')),false);
});
test('verified principal metadata persists independently of session expiry and arbitrary display names',t=>{
 const d=fixture(t);let directory=createNativeMemberOwnerDirectory(d,()=>1000);directory.observe(principal());assert.equal(directory.lookup('206880'),'walkercao');directory.close();
 directory=createNativeMemberOwnerDirectory(d,()=>3000);assert.equal(directory.lookup('206880'),'walkercao');directory.close();
 assert.equal(fs.statSync(join(d,'join-native-member-identities.json')).mode&0o777,0o600);
});
test('missing verification, expired claims and labels cannot seed an association',t=>{
 const d=fixture(t),directory=createNativeMemberOwnerDirectory(d,()=>1000),p=principal();
 for(const bad of [{...p,provider:'other'},{...p,aliases:[]},{...p,expiresAt:999},{...p,expiresAt:undefined},{...p,attributes:{}}])directory.observe(bad);
 assert.equal(directory.lookup('206880'),null);assert.equal(fs.existsSync(join(d,'join-native-member-identities.json')),false);directory.close();
});
test('conflicting provider accounts are retained and never chosen by insertion order',t=>{
 const d=fixture(t),directory=createNativeMemberOwnerDirectory(d,()=>1000);directory.observe(principal());directory.observe(principal('999'));
 assert.equal(directory.lookup('206880'),null);assert.equal(directory.lookup('999'),null);directory.close();
});
test('reverse RTX lookup uses exact legacy admission metadata without creating storage',t=>{
 const d=fixture(t),db=new DatabaseSync(join(d,'employee-admission.sqlite'));db.exec('CREATE TABLE employee_policy_identities(subject TEXT PRIMARY KEY, login_name TEXT)');db.prepare('INSERT INTO employee_policy_identities VALUES(?,?)').run('206880','walkercao');db.close();
 const directory=createNativeMemberOwnerDirectory(d,()=>1000);try{assert.deepEqual(directory.resolve('walkercao'),{state:'resolved',subject:'206880'});assert.deepEqual(directory.resolve('missing'),{state:'unresolved'});}finally{directory.close();}assert.equal(fs.existsSync(join(d,'join-native-member-identities.json')),false);
});
test('reverse lookup persists conflicts across legacy and fresh verified records',t=>{
 const d=fixture(t),db=new DatabaseSync(join(d,'employee-admission.sqlite'));db.exec('CREATE TABLE employee_policy_identities(subject TEXT PRIMARY KEY, login_name TEXT)');db.prepare('INSERT INTO employee_policy_identities VALUES(?,?)').run('206880','walkercao');db.close();
 const directory=createNativeMemberOwnerDirectory(d,()=>1000);try{directory.observe(principal('999'));assert.deepEqual(directory.resolve('walkercao'),{state:'conflict'});}finally{directory.close();}
});
test('one numeric subject with contradictory RTX claims cannot resolve either alias',t=>{
 const d=fixture(t),directory=createNativeMemberOwnerDirectory(d,()=>1000);try{directory.observe(principal());directory.observe(principal('206880','different'));assert.deepEqual(directory.resolve('walkercao'),{state:'conflict'});assert.deepEqual(directory.resolve('different'),{state:'conflict'});}finally{directory.close();}
});
