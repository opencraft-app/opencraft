import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ImageGenerationConfiguration,IMAGE_GENERATION} from '../../apps/local-agent-host/src/model-config/image-generation';
import {ModelCredentialRepository} from '../../apps/local-agent-host/src/model-config/repository';
import {ImageModelTransport} from '../../apps/local-agent-host/src/image-model-transport';
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'image-config-'));const credentials=new ModelCredentialRepository(dir);return{dir,credentials,config:new ImageGenerationConfiguration(dir,credentials)};}
test('image configuration separates chat defaults, uses CAS and never persists credential values in declarations',async()=>{
  const f=await fixture();await f.config.apply({target:{kind:'create',id:'image-test'},expectedRevision:0,api:IMAGE_GENERATION.api,baseURL:IMAGE_GENERATION.baseURL,displayName:'Image',credential:{kind:'replace',value:'test-only-secret'},enabled:true,models:[{id:'ep-test',type:'image'}]});
  await f.config.select(1,{provider:'image-test',model:'ep-test'});assert.equal((await f.config.resolve())?.model.id,'ep-test');assert.doesNotMatch(await readFile(f.config.path,'utf8'),/test-only-secret/);
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
