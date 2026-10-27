import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync, gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore } from "@opencraft/account-pool-host";

import { CodexEngineAdapter } from "../../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { TokenUsageStateDatabase } from "../../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { replayRolloutUsage } from "../../../apps/opencraft-daemon/src/token-usage-rollout.js";


const root = await mkdtemp(join(tmpdir(), "opencraft-codex-usage-probe-"));
const dataDirectory = join(root, "codex");
const store = new AccountPoolStore({ databasePath: join(dataDirectory, "account-pool.sqlite"), secretsDirectory: join(dataDirectory, "secrets") });
store.addAccount({
  id: "fixture-account",
  provider: "codex",
  label: "Fixture",
  upstreamAccountId: "fixture-chatgpt-account",
  priority: 1,
  enabled: true,
}, { accessToken: "fixture-account-access", refreshToken: "fixture-refresh", expiresAt: null });
store.close();

// Real CLI and product adapter; only the upstream model response is synthetic.
const requests: Array<Record<string, any>> = [];
const model = createServer((request, response) => {
  if (request.url?.endsWith("/models")) {
    request.resume(); response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: ["gpt-test", "gpt-6-luna"].map(id => ({ id, object: "model", owned_by: "fixture" })) })); return;
  }
  const chunks: Buffer[] = []; request.on("data", data => { chunks.push(Buffer.from(data)); });
  request.on("end", () => {
    const raw = Buffer.concat(chunks);
    const body = (request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
    if (!body) { response.writeHead(200, {"content-type":"application/json"}); response.end("{}"); return; }
    const payload = JSON.parse(body); requests.push(payload);
    const human=payload.model==="gpt-test",humanIndex=requests.filter(row=>row.model==="gpt-test").length;
    const tokens=human?(humanIndex===1?500:100):1000;
    const output = String(payload.model).includes("luna") ? JSON.stringify({ title: "修复自动会话标题" }) : "Fixture response.";
    response.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "10" });
    const item = { id: `fixture-${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations: [] }] };
    for (const event of [
      { type: "response.created", response: { id: item.id, object: "response", created_at: 1, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: output },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: item.id, object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: tokens-20, output_tokens: 20, total_tokens: tokens, input_tokens_details: {cached_tokens:0}, output_tokens_details: {reasoning_tokens:0} } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
});
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("Fixture did not bind");
const adapter = new CodexEngineAdapter({
  tokenUsage:{serverId:"fork-probe",queryWorkerEntry:new URL("../../../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url).pathname,actor:context=>({id:context.actorId,kind:"human"})},
  executable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex", runtimeDirectory: root, dataDirectory,
  nativeCodexHomeDirectory: join(root, "native-codex"),
  upstreamBaseUrl: `http://127.0.0.1:${address.port}/backend-api/codex`,
  fetch: async (input, init) => String(input).includes("/wham/usage")
    ? Response.json({ plan_type: "fixture", rate_limit: { primary_window: { used_percent: 0 } } }) : fetch(input, init),
  logDiagnostic: () => undefined,
});
const frames: Array<Record<string, any>> = [];
adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
const waitFor = async (predicate: (frame: Record<string, any>) => boolean) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) { const found = frames.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out; methods=${frames.map(f => f.method ?? f.id).join(",")}; models=${requests.map(r => r.model)}`);
};
const request = async (id: number, method: string, params: Record<string, unknown>,actorId="A") => {
  await adapter.sendWithContext(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "title-smoke" }),{sender:null,actorContext:{actorId,credentialId:null,generation:1,expiresAt:Date.now()+60000},tokenUsageAuthority:()=>({actorId,administrator:actorId==="admin"})});
  const reply = await waitFor(frame => frame.id === id); assert.equal(reply.error, undefined, JSON.stringify(reply.error)); return reply.result;
};
try {
 await adapter.connect();await request(1,"initialize",{clientInfo:{name:"fork-metering-smoke",version:"1"},capabilities:{experimentalApi:true}});
 const parent=await request(2,"thread/start",{cwd:root,model:"gpt-test",approvalPolicy:"never",sandbox:"read-only"});
 const parentId=parent.thread.id;
 const original=await request(3,"turn/start",{threadId:parentId,clientUserMessageId:"parent-A",input:[{type:"text",text:"Synthetic original turn",text_elements:[]}]});
 await waitFor(frame=>frame.method==="turn/completed"&&frame.params.turn.id===original.turn.id);
 const fork=await request(4,"thread/fork",{threadId:parentId,cwd:root,model:"gpt-test",approvalPolicy:"never",sandbox:"read-only"});
 const childId=fork.thread.id;assert.notEqual(childId,parentId);
 const next=await request(5,"turn/start",{threadId:childId,clientUserMessageId:"child-B",input:[{type:"text",text:"Synthetic fork followup",text_elements:[]}]},"B");
 await waitFor(frame=>frame.method==="turn/completed"&&frame.params.turn.id===next.turn.id);
 const reader=new DatabaseSync(join(dataDirectory,"token-usage.sqlite"),{readOnly:true});
 try{
  const deadline=Date.now()+20000;let rows;
  while(Date.now()<deadline){rows=reader.prepare("SELECT thread_id,turn_id,observed_tokens,allocation_state FROM token_usage_turns WHERE thread_id IN (?,?) ORDER BY thread_id,turn_id").all(parentId,childId);if(rows.length===2&&rows.every(row=>row.allocation_state==="settled"))break;await new Promise(resolve=>setTimeout(resolve,30));}
  assert.equal(rows?.length,2,JSON.stringify(rows));
  assert.equal(rows?.find(row=>row.thread_id===parentId)?.observed_tokens,"500");assert.equal(rows?.find(row=>row.thread_id===childId)?.observed_tokens,"100");
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(Date.now());
  const parentQuery=await request(6,"opencraft/token-usage/query",{from:today,through:today,scope:"team",threadId:parentId},"admin");
  const childQuery=await request(7,"opencraft/token-usage/query",{from:today,through:today,scope:"team",threadId:childId},"admin");
  assert.equal(parentQuery.summary.tokens,"500");assert.equal(childQuery.summary.tokens,"100");assert.equal(childQuery.summary.turns,1);
  await request(8,"thread/archive",{threadId:parentId});await request(9,"thread/archive",{threadId:childId});
  assert.equal((await request(10,"opencraft/token-usage/query",{from:today,through:today,scope:"team",threadId:childId},"admin")).summary.tokens,"100");
  const rolloutPaths:string[]=[];
  for(const [n,threadId] of [parentId,childId].entries()){
   const native=await request(20+n,"thread/read",{threadId,includeTurns:false});
   assert.ok(typeof native.thread.path==="string"&&native.thread.path.startsWith(root+"/"));
   rolloutPaths.push(native.thread.path);
  }
  // Exercise the actual native delete API after archive, with history intact, then read the
  // Host ledger again. Deleting presentation/history must not erase accounting.
  await request(30,"thread/delete",{threadId:childId});
  await request(31,"thread/delete",{threadId:parentId});
  assert.equal((await request(32,"opencraft/token-usage/query",{from:today,through:today,scope:"team",threadId:parentId},"admin")).summary.tokens,"500");
  assert.equal((await request(33,"opencraft/token-usage/query",{from:today,through:today,scope:"team",threadId:childId},"admin")).summary.tokens,"100");
  for(const path of rolloutPaths) await rm(path,{force:true});
  await adapter.close();
  const reopened=new TokenUsageStateDatabase(dataDirectory);
  try{
   const ledger=new OpenCraftTokenUsageLedger(reopened,"fork-probe");
   assert.equal(ledger.query({from:today,through:today},()=>({actorId:"A",administrator:false})).summary.tokens,"500");
   assert.equal(ledger.query({from:today,through:today},()=>({actorId:"B",administrator:false})).summary.tokens,"100");
  }finally{reopened.close();}
  console.log(JSON.stringify({passed:true,realCodexCLI:true,syntheticUpstream:true,identityBoundary:"synthetic trusted Host Actor port; not real login",inheritedTokens:500,newTokens:100,archiveRetainsUsage:true,nativeDeleteApiRetainsUsage:true,fixtureRolloutRemovalAndHostRestartRetainUsage:true,parentTurnCount:1,childTurnCount:1}));
 }finally{reader.close();}
}finally{await adapter.close();await new Promise(resolve=>model.close(resolve));await rm(root,{recursive:true,force:true});}
