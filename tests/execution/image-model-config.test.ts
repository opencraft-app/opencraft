import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ImageGenerationConfiguration,IMAGE_GENERATION} from '../../apps/local-agent-host/src/model-config/image-generation';
import {ModelCredentialRepository} from '../../apps/local-agent-host/src/model-config/repository';
import {ImageModelTransport} from '../../apps/local-agent-host/src/image-model-transport';
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'image-config-'));const credentials=new ModelCredentialRepository(dir);return{dir,credentials,config:new ImageGenerationConfiguration(fileStateDocumentStore(dir),credentials)};}
test('image configuration separates chat defaults, uses CAS and never persists credential values in declarations',async()=>{
  const f=await fixture();await f.config.apply({target:{kind:'create',id:'image-test'},expectedRevision:0,api:IMAGE_GENERATION.api,baseURL:IMAGE_GENERATION.baseURL,displayName:'Image',credential:{kind:'replace',value:'test-only-secret'},enabled:true,models:[{id:'ep-test',type:'image'}]});
  await f.config.select(1,{provider:'image-test',model:'ep-test'});assert.equal((await f.config.resolve())?.model.id,'ep-test');assert.doesNotMatch(await readFile(join(f.dir,'image-generation.json'),'utf8'),/test-only-secret/);
  await assert.rejects(f.config.select(1,null),/其他窗口/);await f.config.setEnabled(2,'image-test',false);assert.equal(await f.config.resolve(),null);assert.deepEqual((await f.config.read()).defaultModel,{provider:'image-test',model:'ep-test'});
  await assert.rejects(readFile(join(f.dir,'models.json')),/ENOENT/);
});
test('Host image directory and writes retain client routing and exclude image models from ordinary chat listing',async()=>{
  const f=await fixture(),listeners=new Set<(v:string)=>void>(),sent:any[]=[],output:any[]=[];
  const inner:any={status:{state:'open'},async connect(){},async close(){},subscribeStatus(){return()=>{}},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn)},async send(frame:string){sent.push(JSON.parse(frame))},captureMessageScope(){return()=>true}};
  const transport=new ImageModelTransport(inner,f.config);transport.subscribeMessage(v=>output.push(JSON.parse(v)));
  const request=(id:number,method:string,params:any)=>transport.send(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'client-image'}));
  await request(1,'runtime/providers/apply',{target:{kind:'create',id:'image-test'},expectedRevision:0,api:IMAGE_GENERATION.api,baseURL:IMAGE_GENERATION.baseURL,credential:{kind:'replace',value:'test-only-key'},models:[{id:'ep-test',type:'image'}],enabled:true});
  assert.equal(sent.length,0);assert.equal(output[0][LOGICAL_CLIENT_FIELD],'client-image');assert.equal(output[0].result.saved,true);
  for(const [id,includeDisabled]of [[2,false],[3,true]]as const){
    await request(id,'runtime/models/list',{includeDisabled});for(const fn of listeners)fn(JSON.stringify({id,[LOGICAL_CLIENT_FIELD]:'client-image',result:{groups:[{id:'chat',models:[]}]}}));
    for(let i=0;i<50&&!output.some(row=>row.id===id);i++)await new Promise(r=>setTimeout(r,2));
    const result=output.find(row=>row.id===id).result;assert.equal(result.groups.length,includeDisabled?2:1);if(includeDisabled)assert.equal(result.groups[1].models[0].type,'image');
  }
  await transport.close();
});
test('concurrent key replacements never leave a declaration pointing at another writer key',async()=>{
  const f=await fixture(),models=[{id:'ep-test',type:'image' as const}];
  await f.config.apply({target:{kind:'create',id:'image-race'},expectedRevision:0,api:IMAGE_GENERATION.api,baseURL:'https://first.example.com/v1',credential:{kind:'replace',value:'original-key'},enabled:true,models});
  const originalRef=(await f.config.read()).providers[0]!.credentialRef;
  const write=(host:string,value:string)=>f.config.apply({target:{kind:'update',id:'image-race'},expectedRevision:1,api:IMAGE_GENERATION.api,baseURL:`https://${host}.example.com/v1`,credential:{kind:'replace',value},enabled:true,models});
  const outcomes=await Promise.allSettled([write('alpha','alpha-key'),write('beta','beta-key')]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1,'exactly one writer commits');
  assert.match(String((outcomes.find(o=>o.status==='rejected') as PromiseRejectedResult).reason),/其他窗口/);
  const provider=(await f.config.read()).providers[0]!,winner=provider.baseURL.startsWith('https://alpha.')?'alpha-key':'beta-key';
  assert.equal(await f.credentials.resolve(provider.credentialRef),winner,'the declaration resolves the key written for its endpoint');
  assert.equal(await f.credentials.resolve(originalRef),undefined,'the replaced key is retired');
  const stored=JSON.parse(await readFile(join(f.dir,'credentials.json'),'utf8')).entries as Record<string,string>;
  assert.deepEqual(Object.values(stored),[winner],'the losing writer removes its own key');
});
