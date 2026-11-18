import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicOutputSchema } from '../../packages/account-pool-host/src/anthropic-output-schema.js';
import { anthropicRequest } from '../../packages/account-pool-host/src/anthropic-request.js';
import { anthropicHttpError } from '../../packages/account-pool-host/src/anthropic-response.js';
import { forwardConfiguredResponses } from '../../packages/account-pool-host/src/configured-forward.js';
// @ts-expect-error The independent assistant contract is an ES module without TypeScript declarations.
import { routingSchema, selectedSchema, decodeRoutes, decodeSelected } from '../../apps/personal-assistant/src/adapters/models/structured-output.mjs';

test('schema projection is recursive and non-mutating, preserving property names, values and references', () => {
  const data={maxItems:99,minimum:7},schema={type:'object',properties:{maxItems:{type:'array',minItems:2,maxItems:4,items:{$ref:'#/$defs/bounded'}},
    exact:{const:data,default:data,examples:[data]},nested:{anyOf:[{type:'null'},{type:'string',minLength:2,maxLength:40}]}},
    required:['maxItems'],additionalProperties:false,$defs:{bounded:{type:'integer',minimum:1,maximum:10,description:'Count'}}};
  const before=structuredClone(schema),wire=anthropicOutputSchema(schema);
  assert.deepEqual(schema,before); assert.equal(wire.properties.maxItems.maxItems,undefined);
  assert.equal(wire.properties.maxItems.minItems,undefined);assert.match(wire.properties.maxItems.description,/"maxItems":4/);
  assert.equal(wire.properties.maxItems.items.$ref,'#/$defs/bounded');
  assert.deepEqual(wire.properties.exact,schema.properties.exact);
  assert.match(wire.$defs.bounded.description,/Count\n.*"minimum":1.*"maximum":10/);
  assert.equal(wire.$defs.bounded.maximum,undefined);assert.equal(wire.properties.nested.anyOf[1].maxLength,undefined);
  assert.deepEqual(wire.required,schema.required);assert.equal(wire.additionalProperties,false);
});

test('all assistant routing/parameter branches project without unsupported bounds; original operation limits remain', () => {
  for(const input of [{},{targetWork:{id:'work',revision:1}},{source:{kind:'execution-report'}}]) {
    const route=routingSchema(input),wire=anthropicOutputSchema(route);
    assert.equal(wire.properties.operations.minItems,1);assert.equal(wire.properties.operations.maxItems,undefined);
    for(const branch of route.properties.operations.items.enum) {
      const projected=anthropicOutputSchema(selectedSchema([branch],input));
      const scan=(v:any):void=>{if(!v||typeof v!=='object')return;for(const k of ['maxItems','minimum','maximum'])assert.equal(Object.hasOwn(v,k),false);for(const [k,c]of Object.entries(v))if(k!=='description')Array.isArray(c)?c.forEach(scan):scan(c);};
      scan(projected);
    }
  }
  assert.throws(()=>decodeRoutes(JSON.stringify({operations:Array(5).fill('reply')}),{}));
  assert.throws(()=>decodeRoutes(JSON.stringify({operations:['reply','reply']}),{targetWork:{id:'work',revision:1}}));
  assert.throws(()=>decodeRoutes(JSON.stringify({operations:[]}),{}));
  assert.deepEqual(decodeRoutes(JSON.stringify({operations:['reply']}),{}),['reply']);
});

test('query bounds remain enforced locally after they become wire descriptions', () => {
  const routes=['query:works.list'];
  const schema=selectedSchema(routes,{}),wire=anthropicOutputSchema(schema);
  const value=(limit:number)=>JSON.stringify({proposal:{kind:'query',name:'works.list',params:{limit}}});
  assert.ok(JSON.stringify(wire).includes('locally validated constraints'));
  assert.throws(()=>decodeSelected(value(0),routes,{}));assert.throws(()=>decodeSelected(value(1_000_000),routes,{}));
  assert.equal(decodeSelected(value(1),routes,{}).params.limit,1);
});

test('Anthropic wire projects schema but Responses passthrough and ordinary tool schemas stay unchanged', async () => {
  const schema=routingSchema({}),payload={model:'ep',input:'hello',text:{format:{type:'json_schema',name:'route',strict:true,schema}},stream:true};
  const requests:any[]=[];
  const fetcher=(async(_url:any,init:any)=>{requests.push(JSON.parse(init.body));return Response.json({error:{message:'synthetic'}} ,{status:400});}) as typeof fetch;
  for(const protocol of ['anthropic-messages','openai-responses'] as const)await forwardConfiguredResponses({configured:{protocol,baseUrl:'https://example.invalid/v1',model:'ep'},payload,publicModel:'ep',accept:null,signal:AbortSignal.timeout(2000),fetch:fetcher});
  assert.equal(requests[0].output_config.format.schema.properties.operations.maxItems,undefined);
  assert.equal(requests[1].text.format.schema.properties.operations.maxItems,4);
  const tool={type:'function',name:'bounded',parameters:{type:'object',properties:{count:{type:'integer',minimum:1}}}};
  assert.deepEqual(anthropicRequest({model:'ep',input:'hi',tools:[tool]}).body.tools[0].input_schema,tool.parameters);
});

test('safe upstream diagnostics retain unsupported keyword without copying provider content', async () => {
  const diagnostics:any[]=[];
  await anthropicHttpError(Response.json({error:{code:'400001',message:"private prompt and credential: property 'maxItems' is not supported"}},{status:400}),'credential','request',d=>diagnostics.push(d));
  assert.deepEqual(diagnostics,[{category:'unsupported_schema_constraint',keyword:'maxItems'}]);
  await anthropicHttpError(Response.json({error:{message:'secret arbitrary error'}},{status:500}),undefined,'request',d=>diagnostics.push(d));
  assert.deepEqual(diagnostics[1],{category:'upstream_http_error'});
});

