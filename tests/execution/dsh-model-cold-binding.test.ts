import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {ModelConfigurationService} from '../../apps/local-agent-host/src/model-config/service.ts';
import {ModelConfigurationRepository,ModelCredentialRepository} from '../../apps/local-agent-host/src/model-config/repository.ts';
test('cold configuration proof rejects out-of-band document or credential changes',async t=>{
 const root=await mkdtemp('/tmp/dsh-model-binding-');t.after(()=>rm(root,{recursive:true,force:true}));
 const repository=new ModelConfigurationRepository(root),credentials=new ModelCredentialRepository(root);
 await repository.initialize();let applied=0;
 const service=new ModelConfigurationService(repository,credentials,{apply:async()=>{applied++;}});
 await service.synchronize();assert.equal(await service.appliedStateCurrent(),true);
 const doc=await repository.read();doc.providers.push({id:'fixture',name:'Fixture',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1',credentialRef:null,enabled:false,models:[]});
 await writeFile(repository.path,JSON.stringify(doc));assert.equal(await service.appliedStateCurrent(),false);
 await service.synchronize(true);assert.equal(await service.appliedStateCurrent(),true);
 await credentials.set('FIXTURE','synthetic');assert.equal(await service.appliedStateCurrent(),false);
 await service.synchronize();assert.equal(await service.appliedStateCurrent(),true);assert.equal(applied,3);
});
