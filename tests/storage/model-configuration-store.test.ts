import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,stat,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelConfigurationRepository,ModelCredentialRepository} from '../../apps/local-agent-host/src/model-config/repository';
import {ModelConfigurationService} from '../../apps/local-agent-host/src/model-config/service';
import {DshModelEngineAdapter,fromDshProfile} from '../../apps/local-agent-host/src/model-config/dsh-adapter';
import type {ConfiguredProvider} from '../../apps/local-agent-host/src/model-config/model-document';
import {migrateDshModels} from '../../apps/local-agent-host/src/model-config/migrate-dsh';
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
test('model reasoning efforts persist in the product document and survive engine replacement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opencraft-reasoning-store-'));try{
  const repo=new ModelConfigurationRepository(dir);await repo.initialize();
  await repo.update(0,d=>d.providers.push({...provider,models:[{id:'thinking-model',enabled:true,reasoningEfforts:{low:'low',high:'high',max:'max'}}]}));
  const fresh=new ModelConfigurationRepository(dir);
  assert.deepEqual((await fresh.read()).providers[0]?.models[0]?.reasoningEfforts,{low:'low',high:'high',max:'max'});
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('saved reasoning efforts reach the DSH model declaration and survive the settings projection',async()=>{
 const model={id:'thinking-model',enabled:true,reasoningEfforts:{low:'low',high:'high',max:'max'}};
 const writes:Array<{ns:string;ops:Array<{path:string[];value:unknown}>}>=[];
 const engine=new DshModelEngineAdapter({call:async(method:string,payload:any)=>{
  if(method==='settings.describe')return {namespaces:[
   {ns:'llm-pi-ai',revision:1,value:{providers:{}}},
   {ns:'llm-deepseek',revision:1,value:{},base:{}},
   {ns:'agent-default-model',revision:1,value:{}},
  ]};
  if(method==='settings.mutate'){writes.push(payload);return {revision:2};}
  if(method==='credentials.set')return {};
  throw new Error(`Unexpected DSH command: ${method}`);
 }} as any);
 await engine.apply({schemaVersion:1,revision:1,providers:[{...provider,models:[model]}],defaultModel:null},{resolve:async()=> 'synthetic-key'});
 const providerWrite=writes.find(write=>write.ns==='llm-pi-ai')?.ops.find(op=>op.path[0]==='providers')?.value as any;
 assert.deepEqual(providerWrite['custom-test'].models[0].reasoningEfforts,model.reasoningEfforts);
 assert.deepEqual(fromDshProfile('custom-test',providerWrite['custom-test'],[]).models[0]?.reasoningEfforts,model.reasoningEfforts);
});
test('invalid or engine-specific JSON does not overwrite the committed document',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opencraft-model-store-'));try{const repo=new ModelConfigurationRepository(dir);await repo.initialize();await assert.rejects(repo.update(0,d=>{(d as any)['llm-pi-ai']={}}));assert.equal((await repo.read()).revision,0);await assert.rejects(repo.update(0,d=>{d.providers.push({...provider,baseUrl:'https://user:secret@example.invalid'})}));await assert.rejects(repo.update(0,d=>{d.providers.push({...provider,models:[{id:'invalid-off-only',enabled:true,reasoningEfforts:{off:null}}]})}));assert.equal((await repo.read()).providers.length,0)}finally{await rm(dir,{recursive:true,force:true})}
});
test('an existing enabled provider without models reports an actionable failure without touching DSH',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opencraft-empty-provider-'));try{
  const repo=new ModelConfigurationRepository(dir),credentials=new ModelCredentialRepository(dir);
  await repo.initialize({schemaVersion:1,revision:0,providers:[{...provider,models:[]}],defaultModel:null});
  let calls=0;
  const service=new ModelConfigurationService(repo,credentials,new DshModelEngineAdapter({call:async()=>{calls++;throw Error('DSH should not be called')}} as any));
  await service.synchronize();
  assert.equal(service.application.state,'failed');
  assert.match(service.application.error??'',/没有已启用模型。请先获取模型/);
  assert.equal(calls,0);
 }finally{await rm(dir,{recursive:true,force:true})}
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


test('explicit no-auth persists across restart, excludes keys, and projects without resolving credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opencraft-no-auth-'));try{
  const repo=new ModelConfigurationRepository(dir);await repo.initialize();
  await repo.update(0,d=>d.providers.push({...provider,authentication:'none',credentialRef:null}));
  const doc=await new ModelConfigurationRepository(dir).read();assert.equal(doc.providers[0]!.authentication,'none');
  const writes:any[]=[];
  const engine=new DshModelEngineAdapter({call:async(method:string,payload:any)=>{
    if(method==='settings.describe')return {namespaces:[{ns:'llm-pi-ai',revision:1,value:{providers:{}}},{ns:'llm-deepseek',revision:1,value:{},base:{}},{ns:'agent-default-model',revision:1,value:{}}]};
    if(method==='settings.mutate'){writes.push(payload);return {revision:2}};
    throw Error('No credential operations expected');
  }} as any);
  await engine.apply(doc,{resolve:async()=>{throw Error('No credential resolution expected')}});
  const projected=writes.find(v=>v.ns==='llm-pi-ai').ops.find((v:any)=>v.path[0]==='providers').value['custom-test'];
  assert.equal(projected.authentication,'none');assert.equal(Object.hasOwn(projected,'apiKeyEnv'),false);
  assert.equal(fromDshProfile('custom-test',projected,[]).authentication,'none');
  await assert.rejects(repo.update(1,d=>{d.providers[0]!.credentialRef='SHARED_KEY'}));
  await assert.rejects(repo.update(1,d=>{d.providers[0]!.protocol='anthropic-messages'}));
  assert.equal((await repo.read()).revision,1);
 }finally{await rm(dir,{recursive:true,force:true})}
});
