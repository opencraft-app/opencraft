import assert from "node:assert/strict";
import test from "node:test";
import { createParticipationOverview } from "../../plugins/tencentoa/src/participation-overview";
import type { ParticipantsClient } from "../../plugins/tencentoa/src/participants-controller";
import { TENCENTOA_PARTICIPANTS_METHOD } from "../../plugins/tencentoa/src/contract";

test("overview provider preserves pending and partial outcomes without inventing people", async () => {
  const client = { connectionGeneration: 1, initializeResult: {capabilities:{extensions:{[TENCENTOA_PARTICIPANTS_METHOD]:{version:1}}}}, requestRaw: async () => ({ data: [{threadId:"a",revision:1,participants:["real"],creator:"creator",pending:false},{threadId:"b",revision:1,participants:[],pending:true}],errors:[{threadId:"c"}] }) } as unknown as ParticipantsClient;
  const result = await createParticipationOverview(()=>client,()=>"account").read("host",["a","b","c"],new AbortController().signal);
  assert.equal(result.length,2); assert.deepEqual(result[0]?.participants,["real"]); assert.equal(result[0]?.creator,"creator"); assert.equal(result[1]?.pending,true);
});

test("overview provider drops a response after account replacement", async () => {
  let account = "one";
  const client = { connectionGeneration: 1, initializeResult: {capabilities:{extensions:{[TENCENTOA_PARTICIPANTS_METHOD]:{version:1}}}}, requestRaw: async () => { account = "two"; return {data:[]}; } } as unknown as ParticipantsClient;
  await assert.rejects(createParticipationOverview(()=>client,()=>account).read("host",[],new AbortController().signal), /scope changed/);
});
