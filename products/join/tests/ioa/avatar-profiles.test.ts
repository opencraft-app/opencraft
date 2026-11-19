import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {VerifiedAvatarProfiles,avatarProfilePath} from '../../plugins/tencentoa/src/avatar-profiles.mjs';

test('verified numeric OA subject carries an explicit account across process restarts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'avatar-profile-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let now=Date.now();const path=avatarProfilePath(dir),profiles=new VerifiedAvatarProfiles(path,()=>now);
 const actors={get:()=>({enabled:true,kind:'human'}),bindings:()=>[{provider:'tencentoa',subject:'12345'}]};
 assert.equal(profiles.forActor(actors,'actor'),null);
 profiles.observePrincipal({provider:'local',subject:'12345',displayName:'alice',attributes:{loginName:'alice'},expiresAt:now+1000});
 assert.equal(profiles.forActor(actors,'actor'),null);
 profiles.observePrincipal({provider:'tencentoa',subject:'12345',displayName:'unrelated label',attributes:{loginName:'alice'},expiresAt:now+1000});
 const reader=new VerifiedAvatarProfiles(path,()=>now);
 assert.deepEqual(reader.forActor(actors,'actor'),{kind:'employee',name:'alice'});
 assert.equal(reader.forActor({...actors,bindings:()=>[{provider:'local',subject:'12345'}]},'actor'),null,'binding is checked on each read');
 assert.equal(reader.forActor({...actors,get:()=>({enabled:false,kind:'human'})},'actor'),null);
 now+=61*86400000;
 assert.equal(reader.forActor(actors,'actor'),null);
});
test('authenticated directory profiles are isolated by exact source and opaque sender, not labels',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'avatar-directory-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const profiles=new VerifiedAvatarProfiles(avatarProfilePath(dir));
 const source=JSON.stringify(['wecom-customer-service','wxcorp','fwservice','wrgroup']);
 const id=(source:string,raw:string)=>'external:'+createHash('sha256').update(JSON.stringify([source,raw])).digest('hex');
 profiles.observeDirectory(source,'T123A','alice');
 assert.deepEqual(profiles.forExternal(source,id(source,'T123A')),{kind:'employee',name:'alice'});
 assert.equal(profiles.forExternal(source,id(source,'alice')),null);
 assert.equal(profiles.forExternal(source+'other',id(source,'T123A')),null);
});
test('unsafe or malformed on-disk photo cache fails closed',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'avatar-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=avatarProfilePath(dir),reader=new VerifiedAvatarProfiles(path);
 await writeFile(path,'not-json',{mode:0o600});assert.equal(reader.lookup('identity'),null);
 await writeFile(path,JSON.stringify({version:1,rows:[{key:'identity',loginName:'alice',at:Date.now()}]}));
 await chmod(path,0o644);assert.equal(reader.lookup('identity'),null);
 await chmod(path,0o600);assert.deepEqual(reader.lookup('identity'),{kind:'employee',name:'alice'});
});

test('old verified logins use the existing read-only IOA owner metadata, not names or new registrations',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'avatar-prior-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=new DatabaseSync(join(dir,'employee-admission.sqlite'));t.after(()=>db.close());
 db.exec('CREATE TABLE employee_policy_identities(subject TEXT PRIMARY KEY,login_name TEXT NOT NULL)');
 db.prepare('INSERT INTO employee_policy_identities VALUES(?,?)').run('12345','trusted-old-account');
 const actors={get:()=>({enabled:true,kind:'human',displayName:'wrong-name'}),bindings:()=>[{provider:'tencentoa',subject:'12345'}]};
 const reader=new VerifiedAvatarProfiles(avatarProfilePath(dir)),scope=new Map();
 assert.deepEqual(reader.forActor(actors,'actor',scope),{kind:'employee',name:'trusted-old-account'});
 db.prepare('UPDATE employee_policy_identities SET login_name=? WHERE subject=?').run('changed-account','12345');
 assert.deepEqual(reader.forActor(actors,'actor',scope),{kind:'employee',name:'trusted-old-account'},'read scope deduplicates metadata');
 assert.deepEqual(reader.forActor(actors,'actor'),{kind:'employee',name:'changed-account'},'next read sees current verified association');
 assert.equal(reader.forActor({...actors,bindings:()=>[]},'actor'),null,'removing OA binding revokes lookup');
 assert.equal(reader.forActor({...actors,bindings:()=>[{provider:'local',subject:'12345'}]},'actor'),null);
 assert.equal(reader.forActor({...actors,get:()=>({enabled:false,kind:'human'})},'actor'),null);
 await writeFile(join(dir,'join-native-member-identities.json'),JSON.stringify({schemaVersion:1,identities:{'12345':['conflicting-account']}}),{mode:0o600});
 assert.equal(reader.forActor(actors,'actor'),null,'conflicting durable sources fail closed');
 db.prepare('DELETE FROM employee_policy_identities').run();
 await writeFile(join(dir,'join-native-member-identities.json'),JSON.stringify({schemaVersion:1,identities:{'12345':['same-account'],'67890':['same-account']}}));
 assert.equal(reader.forActor(actors,'actor'),null,'one account mapped to two stable subjects is ambiguous');
});
