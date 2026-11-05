import test from 'node:test';
import assert from 'node:assert/strict';
import {CustomResponsesGateway,customModelId} from '../scripts/codex-custom-responses.mjs';
import {generateCustomImage} from '../scripts/custom-image-generation.mjs';
import {CustomModelNativeTransport} from '../scripts/codex-custom-model-transport.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
const chosen={provider:{id:'image-test',baseUrl:'https://example.invalid/generate'},model:{id:'image-deployment'},apiKey:'image-secret',binding:'revision-1'};
function imageFetch(calls){return async(url,options={})=>{
  calls.push({url:String(url),...options});
  return options.method==='POST'?Response.json({status:'succeeded',choices:[{delta:{type:'image',image:{url:'https://fixture.cos.example.myqcloud.com/test.png'}}}]}):new Response(png);
};}
test('Hunyuan adapter maps deployment and reference, isolates session and keeps download credentials empty',async()=>{
  const calls=[],fetchImpl=imageFetch(calls),input={prompt:'draw a cat',model:'gpt-image-2',size:'auto',quality:'auto',background:'opaque'};
  const result=await generateCustomImage(input,chosen,{fetchImpl});
  assert.equal(result.data[0].b64_json,png.toString('base64'));
  let body=JSON.parse(calls[0].body);assert.equal(body.model,'image-deployment');assert.deepEqual(body.messages,[{role:'user',content:[{type:'text',text:'draw a cat'}]}]);
  assert.equal(calls[0].headers.Authorization,'Bearer image-secret');assert.equal(calls[1].headers,undefined);assert.equal(calls[1].redirect,'manual');
  const previous=body.session;await generateCustomImage({...input,images:[{image_url:'data:image/png;base64,'+png.toString('base64')}]},chosen,{fetchImpl});
  body=JSON.parse(calls[2].body);assert.notEqual(body.session,previous);assert.equal(body.messages[0].content[1].image_url.url,'data:image/png;base64,'+png.toString('base64'));
});
test('unsupported image parameters and artifact sources fail explicitly',async()=>{
  for(const fields of [{background:'transparent'},{images:[{file_id:'private-file'}]},{images:[{},{}]},{size:'1024x1024'},{n:2}])
    await assert.rejects(generateCustomImage({prompt:'cat',...fields},chosen,{fetchImpl:()=>{throw Error('must not dispatch')}}),/图像|参考图/);
  await assert.rejects(generateCustomImage({prompt:'cat'},chosen,{fetchImpl:async()=>Response.json({status:'succeeded',choices:[{delta:{type:'image',image:{url:'https://127.0.0.1/private'}}}]})}),/不受支持/);
});
test('only an admitted custom-model turn can dispatch a separate image service; changed or disabled bindings fail closed',async t=>{
  let selection=chosen;const imageCalls=[];let catalog=[{provider:{id:'text-provider',baseUrl:'https://text.invalid/v1'},model:{id:'thinking-model',input:['text','image']},apiKey:'text-secret'}];
  const gateway=new CustomResponsesGateway({catalog:async()=>catalog,imageConfiguration:async()=>selection,imageFetch:imageFetch(imageCalls),fetchImpl:async(_url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer text-secret');assert.equal(options.headers['x-openai-actor-authorization'],undefined);
    return Response.json({id:'resp',output:[]});
  }});await gateway.start();t.after(()=>gateway.close());
  const post=(path,body,headers={})=>fetch(gateway.baseUrl+path,{method:'POST',headers:{Authorization:'Bearer '+gateway.secret,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const actor={'x-openai-actor-authorization':gateway.secret,'x-codex-image-turn-id':'custom-turn'};
  assert.equal((await post('/images/generations',{prompt:'cat'},actor)).status,409);
  await post('/responses',{model:customModelId('text-provider','thinking-model'),input:'test'}, {'x-openai-actor-authorization':gateway.secret,'x-codex-turn-metadata':JSON.stringify({turn_id:'custom-turn'})});
  assert.equal((await post('/images/generations',{prompt:'cat',model:'gpt-image-2'},actor)).status,200);assert.equal(imageCalls.length,2);
  assert.equal((await post('/images/generations',{prompt:'cat'},{...actor,'x-codex-image-turn-id':'subscription-turn'})).status,409);
  selection={...chosen,binding:'revision-2'};assert.equal((await post('/images/generations',{prompt:'cat'},actor)).status,409);
  selection=null;assert.equal((await post('/images/generations',{prompt:'cat'},actor)).status,409);
  selection=chosen;catalog=[];assert.equal((await post('/images/generations',{prompt:'cat'},actor)).status,409);assert.equal(imageCalls.length,2);
});
test('image configuration enables custom native tools without changing reasoning; subscription creation passes unchanged',async()=>{
  const gateway=new CustomResponsesGateway({catalog:async()=>[],imageConfiguration:async()=>chosen});
  const listeners=new Set();const sent=[];
  const inner={status:{state:'open'},subscribeMessage(fn){listeners.add(fn);return()=>listeners.delete(fn)},subscribeStatus(){return()=>{}},async close(){},async send(frame){const r=JSON.parse(frame);sent.push(r);for(const fn of listeners)fn(JSON.stringify({id:r.id,result:{thread:{id:'subscription'},model:r.params.model}}))}};
  const transport=new CustomModelNativeTransport(inner,gateway);
  try{
    const params={model:'official-model',config:{'features.image_generation':true}};
    await transport.route({method:'thread/start',params});assert.deepEqual(sent[0].params,params);
    const custom=await transport.definition({}, {provider:{id:'custom'},model:{id:'thinking',input:['text','image'],reasoningEfforts:{high:'high'}}});
    assert.equal(custom.config['features.image_generation'],true);assert.equal(custom.config.model_reasoning_effort,'high');
    assert.equal(custom.config['model_providers.opencraft-custom-responses'].http_headers['x-openai-actor-authorization'],gateway.secret);
    const textOnly=await transport.definition({}, {provider:{id:'custom'},model:{id:'thinking',input:['text']}});assert.equal(textOnly.config['features.image_generation'],false);
  }finally{await transport.close();}
});
