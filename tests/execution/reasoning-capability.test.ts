import assert from "node:assert/strict";
import test from "node:test";
import { reasoningCapability, resolveReasoningEffort, type SubmitIntent } from "@opencraft/composer-core";
import { compileSubmitIntent, createAppServerConversationCommandPort, SubmitCompileError } from "@opencraft/composer-appserver";
import { AppServerClientError } from "@opencraft/appserver-client";
import { projectComposerModelChoices } from "../../packages/workbench-runtime/src/composer-model-catalog";

function intent(effort?:string):SubmitIntent{return {commandId:'reasoning-test',clientMessageId:'reasoning-message',target:{type:'existing-thread',key:{hostId:'local',threadId:'test'} as any},document:{version:1,blocks:[{type:'paragraph',children:[{type:'text',text:'Hello'}]}]},attachments:[],context:[],selections:{model:'model-test',...(effort===undefined?{}:{effort})},options:{autoContext:false},createdAt:0};}
test('absence never invents a default and clears stale none/high in display and compilation',()=>{
 const capability=reasoningCapability([],null);
 assert.equal(capability.defaultEffort,null);
 for(const stale of ['none','high',undefined]){
  assert.equal(resolveReasoningEffort(capability,stale),undefined);
  assert.equal(Object.hasOwn(compileSubmitIntent(intent(stale),{reasoning:capability}).turnOptions,'effort'),false);
 }
 const projected=projectComposerModelChoices([{id:'model-test',model:'model-test',displayName:'Model',description:'',hidden:false,isDefault:false,supportedReasoningEfforts:[],defaultReasoningEffort:'none'} as any]);
 assert.equal(projected[0]?.defaultEffort,null,'legacy required-string placeholders must not become a capability');
});
test('none is a real option only if declared, and UI/compiler use the same supported default',()=>{
 const capability=reasoningCapability(['none','high'],'high');
 assert.equal(resolveReasoningEffort(capability,'none'),'none');
 assert.equal(compileSubmitIntent(intent('none'),{reasoning:capability}).turnOptions.effort,'none');
 for(const stale of ['max',undefined]){
  assert.equal(resolveReasoningEffort(capability,stale),'high');
  assert.equal(compileSubmitIntent(intent(stale),{reasoning:capability}).turnOptions.effort,'high');
 }
 const optional=reasoningCapability(['low','high']);
 assert.equal(resolveReasoningEffort(optional,undefined),undefined);
 assert.equal(Object.hasOwn(compileSubmitIntent(intent(),{reasoning:optional}).turnOptions,'effort'),false);
});
test('invalid defaults are rejected instead of silently selecting another global effort',()=>{
 assert.throws(()=>reasoningCapability(['low','high'],'none'),/outside/);
 assert.throws(()=>reasoningCapability(['high','high'],'high'),/choices/);
 const from=reasoningCapability(['high'],'high'),to=reasoningCapability([],null);
 assert.equal(resolveReasoningEffort(to,resolveReasoningEffort(from,'high')),undefined);
});
for (const scenario of ['catalog timeout', 'stalled catalog', 'unsupported Fast', 'supported Fast', 'unavailable model', 'cancelled']) {
 test(`${scenario} preserves submission semantics`, async () => {
  const writes: any[] = [];
  const port = createAppServerConversationCommandPort({hostId:'local',client:{hostId:'local',request:async(method, params)=>{writes.push({method, params});return {turn:{id:'turn'}} as any}},interactions:{respond:async()=>{}},resolveCompilerOptions:async()=>{
   if (scenario === 'stalled catalog') return new Promise(() => {});
   if (scenario === 'catalog timeout') throw new AppServerClientError('TIMEOUT','catalog timeout');
   if (scenario === 'cancelled') throw new AppServerClientError('NOT_DISPATCHED','cancelled');
   if (scenario === 'unavailable model') throw new SubmitCompileError('CAPABILITY_UNAVAILABLE','所选模型已不可用，请重新选择');
   return {serviceTiers: scenario === 'supported Fast' ? ['fast'] : []};
  }});
  const submission = intent('high');
  const started = Date.now();
  const result = port.submit({...submission,selections:{...submission.selections,serviceTier:'fast'}});
  if (scenario === 'unavailable model' || scenario === 'cancelled') {
   await assert.rejects(result);
   assert.equal(writes.length,0);
  } else {
   await result;
   assert.ok(Date.now() - started < 3000);
   assert.equal(writes.length,1);
   assert.equal(writes[0].method,'turn/start');
   assert.equal(writes[0].params.model,'model-test');
   assert.equal(writes[0].params.effort,'high');
   assert.equal(Object.hasOwn(writes[0].params,'serviceTier'),scenario === 'supported Fast');
  }
 });
}
