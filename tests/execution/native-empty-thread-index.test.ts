import assert from "node:assert/strict";
import test from "node:test";
import { ensureNativeCreationIndex } from "../../apps/opencraft-daemon/src/native-empty-thread-index";
const missing = () => Object.assign(new Error("list_turns is not supported yet"), { code: -32601 });
const thread = (overrides = {}) => ({id:"new",historyMode:"paginated",ephemeral:false,status:{type:"idle"},projectId:null,...overrides});

test("healthy pagination does not write metadata", async () => {
  const calls:string[]=[];
  await ensureNativeCreationIndex("new",async method=>{calls.push(method);return {data:[]};});
  assert.deepEqual(calls,["thread/turns/list"]);
});
for (const projectId of [null,"existing-project"]) test(`native owns index registration and preserves project ${projectId}`,async()=>{
  const calls:Array<[string,Record<string,unknown>]> = [];
  let probes=0;
  await ensureNativeCreationIndex("new",async(method,params)=>{
    calls.push([method,params]);
    if(method==="thread/turns/list"){if(++probes===1)throw missing();return {data:[]};}
    return {thread:thread({projectId})};
  });
  assert.deepEqual(calls.map(([method])=>method),["thread/turns/list","thread/read","thread/metadata/update","thread/turns/list"]);
  assert.deepEqual(calls[2][1],{threadId:"new",projectId:projectId??""});
});
for (const overrides of [{id:"other"},{historyMode:"legacy"},{ephemeral:true},{status:{type:"active"}},{status:{type:"notLoaded"}},{projectId:undefined},{projectId:""}]) test(`unsafe creation is not rewritten: ${JSON.stringify(overrides)}`,async()=>{
  const calls:string[]=[];
  await assert.rejects(ensureNativeCreationIndex("new",async method=>{
    calls.push(method);if(method==="thread/turns/list")throw missing();return {thread:thread(overrides)};
  }),/cannot safely/);
  assert.equal(calls.includes("thread/metadata/update"),false);
});
for(const cause of [Object.assign(new Error("unrelated"),{code:-32601}),Object.assign(new Error("list_turns is not supported yet"),{code:-32000})]) test(`unrelated failure is preserved: ${cause.message}/${cause.code}`,async()=>{
  let count=0;await assert.rejects(ensureNativeCreationIndex("new",async()=>{count++;throw cause;}),error=>error===cause);assert.equal(count,1);
});
test("failed repair is not retried or treated as ready",async()=>{
  let probes=0,writes=0;
  await assert.rejects(ensureNativeCreationIndex("new",async method=>{
    if(method==="thread/turns/list"){probes++;throw missing();}
    if(method==="thread/metadata/update")writes++;
    return {thread:thread()};
  }),/list_turns/);
  assert.equal(probes,2);assert.equal(writes,1);
});
test("changed metadata is not reported ready",async()=>{
  let probes=0;
  await assert.rejects(ensureNativeCreationIndex("new",async method=>{
    if(method==="thread/turns/list"){probes++;throw missing();}
    return {thread:thread(method==="thread/metadata/update"?{projectId:"changed"}:{})};
  }),/metadata was not confirmed/);assert.equal(probes,1);
});
test("malformed successful pagination is not ready",async()=>{
  await assert.rejects(ensureNativeCreationIndex("new",async()=>({})),/index was not confirmed/);
});
