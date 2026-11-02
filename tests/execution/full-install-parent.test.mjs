import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {provisionProductParent} from '../../scripts/full-upgrade/install.mjs';
import {sha256} from '../../scripts/full-upgrade/durable.mjs';

test('normal installation invokes the signed product adapter with its real deployment FD',async t=>{
 const root=await mkdtemp(join(tmpdir(),'parent-installer-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {mkdir}=await import('node:fs/promises');await mkdir(join(root,'runtime'));const script=join(root,'runtime/product.py'),bytes=Buffer.from('# fixed adapter\n');await writeFile(script,bytes,{mode:0o600});
 const record={components:[{fileList:[['runtime/product.py',sha256(bytes),bytes.length]]}],release:{source:{revision:'a'.repeat(40)}}};
 const calls=[];const run=async(...args)=>calls.push(args);const options={profile:{parentProvisioner:'runtime/product.py'},root,record,fd:9};
 assert.equal(await provisionProductParent(options,run),true);assert.equal(calls[0][2].fd,9);assert.deepEqual(calls[0][1],['OPENCRAFT_HELD_LOCK_FD=3','/usr/bin/python3',script,'a'.repeat(40)]);
 await writeFile(script,'modified');await assert.rejects(provisionProductParent(options,run),/unsigned-parent-provisioner/);assert.equal(calls.length,1);
});
test('existing parent and deployments without product composition retain their installation behavior',async()=>{
 const run=()=>assert.fail('must not run a provisioner');
 assert.equal(await provisionProductParent({profile:{}},run),false);
 assert.equal(await provisionProductParent({profile:{parentProvisioner:'runtime/product.py'},previousConfig:{fullRecipePath:'/existing'}},run),false);
 await assert.rejects(provisionProductParent({profile:{parentProvisioner:'runtime/../escape.py'}},run),/invalid-parent-provisioner/);
});
