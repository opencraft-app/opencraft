import assert from "node:assert/strict";
import test from "node:test";
import { nativeUsageFact, nativeAcceptedInputFact, nativeLiveAcceptedInputFact } from "../../apps/opencraft-daemon/src/token-usage-native-facts.js";

const record = (overrides: Record<string, unknown> = {}) => ({type:"token_usage_record",payload:{
  thread_id:"thread",turn_id:"turn",session_id:"session",response_id:"response",
  usage:{total_tokens:1000,input_tokens:800,cached_input_tokens:300,output_tokens:200,reasoning_output_tokens:100},
  turn_token_usage:{total_tokens:7000},thread_token_usage:{total_tokens:100000}, ...overrides,
}});
test("exact response usage ignores cumulative totals and sensitive extras", () => {
  const fact = nativeUsageFact(record({prompt:"SENSITIVE_PROMPT",access_token:"SENSITIVE_CREDENTIAL"}),"thread");
  assert.equal(fact?.kind,"source");
  if(fact?.kind!=="source") return;
  assert.equal(fact.source.counts.totalTokens,"1000");
  assert.equal(fact.source.counts.cachedInputTokens,"300");
  assert.equal(fact.source.counts.cacheWriteInputTokens,null);
  assert.equal(fact.source.provider,null); assert.equal(fact.source.model,null);
  assert.equal(fact.turnCounts?.totalTokens,"7000");
  assert.doesNotMatch(JSON.stringify(fact.source),/SENSITIVE|100000|7000/);
  assert.deepEqual(nativeUsageFact(record(),"thread"),fact);

  const identified = nativeUsageFact(record(),"thread",{provider:"opencraft-account-pool",model:"gpt-6.1-sol"});
  assert.equal(identified?.kind,"source");
  if(identified?.kind==="source"){
    assert.equal(identified.source.provider,"opencraft-account-pool");
    assert.equal(identified.source.model,"gpt-6.1-sol");
    assert.equal(identified.source.counts.totalTokens,"1000");
    assert.doesNotMatch(JSON.stringify(identified.source.counts),/opencraft-account-pool|gpt-6.1-sol/);
  }
});
test("fork history and legacy thread counters never produce new response facts",()=>{
  assert.equal(nativeUsageFact(record(),"fork"),null);
  assert.equal(nativeUsageFact({type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{total_tokens:1000}}}},"thread"),null);
});
test("missing identity and malformed numbers remain explicit missing facts",()=>{
  assert.deepEqual(nativeUsageFact(record({response_id:null}),"thread"),{kind:"missing",reason:"missing-response-identity"});
  for(const count of [null,-1,0.5,Number.MAX_SAFE_INTEGER+1,"1e3"]){
    assert.deepEqual(nativeUsageFact(record({usage:{total_tokens:count}}),"thread"),{kind:"missing",reason:"invalid-usage-record"});
  }
  const fact=nativeUsageFact(record({usage:{total_tokens:"9007199254740993123"}}),"thread");
  assert.equal(fact?.kind==="source"&&fact.source.counts.totalTokens,"9007199254740993123");
});

test("durable native admission contains only exact input/target IDs, without guessing actor or mode",()=>{
  const event={type:"event_msg",payload:{type:"item_completed",thread_id:"thread",turn_id:"actual-target",item:{type:"UserMessage",client_id:"accepted-input",content:"SENSITIVE_BODY",actorId:"untrusted-claim"}}};
  assert.deepEqual(nativeAcceptedInputFact(event,"thread"),{threadId:"thread",turnId:"actual-target",inputId:"accepted-input"});
  assert.equal(nativeAcceptedInputFact(event,"fork"),null);
  assert.equal(nativeAcceptedInputFact({...event,payload:{...event.payload,item:{type:"UserMessage"}}},"thread"),null);
  assert.equal(nativeAcceptedInputFact({...event,payload:{...event.payload,item:{...event.payload.item,type:"AgentMessage"}}},"thread"),null);
});


test("live native admission retains exact ephemeral target without retaining content or accepting durable casing",()=>{
 const value={threadId:"ephemeral",turnId:"actual-turn",item:{type:"userMessage",clientId:"stable-input",content:"SENSITIVE",sender:{actorId:"FORGED"}}};
 assert.deepEqual(nativeLiveAcceptedInputFact("item/completed",value),{threadId:"ephemeral",turnId:"actual-turn",inputId:"stable-input"});
 assert.equal(nativeLiveAcceptedInputFact("item/started",value),null);
 assert.equal(nativeLiveAcceptedInputFact("item/completed",{...value,item:{...value.item,type:"UserMessage"}}),null);
 assert.equal(nativeLiveAcceptedInputFact("item/completed",{...value,item:{type:"userMessage",id:"not-client-id"}}),null);
 assert.equal(nativeLiveAcceptedInputFact("item/completed",{...value,turnId:""}),null);
});
