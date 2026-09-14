import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,stat,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelConfigurationRepository,ModelCredentialRepository} from '../apps/local-agent-host/src/model-config/repository';
import {ModelConfigurationService} from '../apps/local-agent-host/src/model-config/service';
import type {ConfiguredProvider} from '../apps/local-agent-host/src/model-config/model-document';
import {migrateDshModels} from '../apps/local-agent-host/src/model-config/migrate-dsh';
const provider:ConfiguredProvider={id:'custom-test',name:'Test',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',credentialRef:'TEST_REF',enabled:true,models:[{id:'model-test',enabled:true}]};

test('OpenCraft JSON survives a fresh repository and engine replacement without engine fields or secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opencraft-model-store-'));try{
  const repo=new ModelConfigurationRepository(dir),credentials=new ModelCredentialRepository(dir);await repo.initialize();await credentials.set('TEST_REF','synthetic-private-value');
  const failed=new ModelConfigurationService(repo,credentials,{apply:async()=>{throw Error('engine down')}});
  await failed.update(0,d=>{d.providers.push(provider)});assert.equal(failed.application.state,'failed');
  const text=await readFile(repo.path,'utf8');assert.doesNotMatch(text,/llm-pi-ai|settingsNs|apiKeyEnv|synthetic-private-value/);
  assert.equal((await stat(repo.path)).mode&0o777,0o600);
  const fresh=new ModelConfigurationRepository(dir);assert.equal((await fresh.read()).providers[0]?.models[0]?.id,'model-test');
  let applied=false;const replacement=new ModelConfigurationService(fresh,credentials,{apply:async(d,resolver)=>{assert.equal(d.providers[0]?.id,'custom-test');assert.deepEqual(Object.keys(resolver),['resolve']);applied=true}});await replacement.synchronize();assert.equal(applied,true);assert.equal(replacement.application.state,'applied');
  const results=await Promise.allSettled([repo.update(1,d=>{d.providers[0]!.name='A'}),fresh.update(1,d=>{d.providers[0]!.name='B'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('invalid or engine-specific JSON does not overwrite the committed document',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opencraft-model-store-'));try{const repo=new ModelConfigurationRepository(dir);await repo.initialize();await assert.rejects(repo.update(0,d=>{(d as any)['llm-pi-ai']={}}));assert.equal((await repo.read()).revision,0);await assert.rejects(repo.update(0,d=>{d.providers.push({...provider,baseUrl:'https://user:secret@example.invalid'})}));assert.equal((await repo.read()).providers.length,0)}finally{await rm(dir,{recursive:true,force:true})}
});
test('legacy DSH import is one-way, preserves IDs and leaves secrets out of models.json',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opencraft-model-migration-'));try{
  const old=join(root,'old'),target=join(root,'product');await mkdir(old);
  const settings='llm-pi-ai:\n  providers:\n    custom-old:\n      displayName: Old connection\n      api: openai-completions\n      baseURL: http://127.0.0.1:1/v1\n      apiKeyEnv: LEGACY_KEY\n      enabled: true\n      models:\n        - id: old-model\n';
  await writeFile(join(old,'settings.yaml'),settings,{mode:0o600});await writeFile(join(old,'.credentials.yaml'),'version: 1\nrefs:\n  LEGACY_KEY: synthetic-legacy-secret\n',{mode:0o600});
  const repo=new ModelConfigurationRepository(target),credentials=new ModelCredentialRepository(target);
  assert.equal((await migrateDshModels(repo,credentials,old)).count,1);
  assert.equal(await credentials.resolve('LEGACY_KEY'),'synthetic-legacy-secret');
  assert.equal((await repo.read()).providers[0]?.id,'custom-old');
  assert.doesNotMatch(await readFile(repo.path,'utf8'),/synthetic-legacy-secret|apiKeyEnv|llm-pi-ai/);
  assert.equal(await readFile(join(old,'settings.yaml'),'utf8'),settings);
  assert.equal((await migrateDshModels(repo,credentials,old)).migrated,false);
 }finally{await rm(root,{recursive:true,force:true})}
});
