import assert from 'node:assert/strict';
import test from 'node:test';
import {checkSavedModel} from '../apps/local-agent-host/src/saved-model-check';
import type {ModelDocument} from '../apps/local-agent-host/src/model-config/model-document';

const document=():ModelDocument=>({schemaVersion:1,revision:3,providers:[{id:'saved',name:'Saved',protocol:'openai-completions',baseUrl:'https://example.invalid/v1',credentialRef:'REF',enabled:false,models:[{id:'model',enabled:true}]}],defaultModel:null});
test('saved check resolves credentials on the host and uses only the committed endpoint',async()=>{
 const doc=document();let credentialReads=0;let request:any;
 const result=await checkSavedModel({provider:'saved',model:'model',expectedRevision:3},{read:async()=>structuredClone(doc),credential:async ref=>{assert.equal(ref,'REF');credentialReads++;return 'synthetic-saved-key'}},async params=>{request=params;return {ok:true,elapsedMs:1,model:params.model}});
 assert.equal(credentialReads,1);assert.equal(request.baseURL,'https://example.invalid/v1');assert.equal(request.apiKey,'synthetic-saved-key');assert.doesNotMatch(JSON.stringify(result),/synthetic-saved-key/);assert.equal(doc.providers[0]?.enabled,false);
});
test('missing keys, stale versions, unknown models and caller destinations never make model requests',async()=>{
 for(const mode of ['missing','stale','unknown','injected']){
  let requests=0;const input:any={provider:'saved',model:mode==='unknown'?'other':'model',expectedRevision:mode==='stale'?2:3};if(mode==='injected')input.baseURL='https://other.invalid';
  await assert.rejects(checkSavedModel(input,{read:async()=>document(),credential:async()=>mode==='missing'?undefined:'synthetic'},async()=>{requests++;return {ok:true,elapsedMs:1,model:'model'}}));assert.equal(requests,0);
 }
});
test('a connection changed during credential lookup cannot receive the captured key',async()=>{
 const doc=document();let requests=0;
 await assert.rejects(checkSavedModel({provider:'saved',model:'model',expectedRevision:3},{read:async()=>structuredClone(doc),credential:async()=>{doc.providers[0]!.baseUrl='https://other.invalid/v1';return 'synthetic'}},async()=>{requests++;return {ok:true,elapsedMs:1,model:'model'}}),/配置已更新/);assert.equal(requests,0);
});
