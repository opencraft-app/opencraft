import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,symlink,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {provisionProductParent,preserveFullTargetRoot} from '../../scripts/full-upgrade/install.mjs';
import {fullTargetDirectory} from '../../scripts/full-upgrade/service-config.mjs';
import {sha256} from '../../scripts/full-upgrade/durable.mjs';

test('normal installation invokes the signed product adapter with its real deployment FD',{skip:process.getuid?.()!==0},async t=>{
 const root=await mkdtemp('/root/parent-installer-');t.after(()=>rm(root,{recursive:true,force:true}));
 const {mkdir}=await import('node:fs/promises');await mkdir(join(root,'runtime'));const script=join(root,'runtime/product.py'),bytes=Buffer.from('# fixed adapter\n');await writeFile(script,bytes,{mode:0o600});
 const record={components:[{fileList:[['runtime/product.py',sha256(bytes),bytes.length]]}],release:{source:{revision:'a'.repeat(40)}}};
 const calls=[];const run=async(...args)=>calls.push(args);const options={profile:{parentProvisioner:'runtime/product.py'},root,record,fd:9};
 assert.equal(await provisionProductParent(options,run),true);assert.equal(calls[0][2].fd,9);assert.deepEqual(calls[0][1],['OPENCRAFT_HELD_LOCK_FD=3','/usr/bin/python3',script,'a'.repeat(40)]);
 assert.equal(await provisionProductParent({...options,previousConfig:{fullRecipePath:'/existing'}},run),true);
 await writeFile(script,'modified');await assert.rejects(provisionProductParent(options,run),/unsigned-parent-provisioner/);assert.equal(calls.length,2);
});
test('deployments without product composition retain their installation behavior',async()=>{
 const run=()=>assert.fail('must not run a provisioner');
 assert.equal(await provisionProductParent({profile:{}},run),false);
 await assert.rejects(provisionProductParent({profile:{parentProvisioner:'runtime/../escape.py'}},run),/invalid-parent-provisioner/);
});
test('custom full target roots survive installation without moving retained targets', {skip:process.getuid?.()!==0},async t=>{
 const root=await mkdtemp('/root/opencraft-target-config-');t.after(()=>rm(root,{recursive:true,force:true}));
 const old=join(root,'old'),next=join(root,'next');await mkdir(old);await mkdir(next);await writeFile(join(old,'retained'),'recovery');
 const config={targetRoot:'/existing/inspection-artifact',fullRecipePath:'/existing/recipe'};
 await preserveFullTargetRoot(config,{fullTargetRoot:next});
 assert.equal(config.fullTargetRoot,next);assert.equal(await fullTargetDirectory(config),next);
 assert.equal(config.targetRoot,'/existing/inspection-artifact');assert.equal(config.fullRecipePath,'/existing/recipe');
 assert.equal(await readFile(join(old,'retained'),'utf8'),'recovery');
 const legacy={};await preserveFullTargetRoot(legacy,{});assert.equal(Object.hasOwn(legacy,'fullTargetRoot'),false);
 const link=join(root,'link');await symlink(next,link);
 await assert.rejects(fullTargetDirectory({fullTargetRoot:link}),/root-owned-path-required/);
 await chmod(next,0o777);await assert.rejects(fullTargetDirectory({fullTargetRoot:next}),/root-owned-path-required/);
 await chmod(next,0o700);const file=join(root,'file');await writeFile(file,'not directory');
 await assert.rejects(fullTargetDirectory({fullTargetRoot:file}),/full-target-directory-required/);
 await assert.rejects(fullTargetDirectory({fullTargetRoot:join(root,'missing')}),{code:'ENOENT'});
});
test('custom target configuration rejects relative, null and traversal paths',async()=>{
 for(const fullTargetRoot of ['relative',null,'/opt/../data/targets']) await assert.rejects(fullTargetDirectory({fullTargetRoot}),/absolute-config-path-required/);
});
