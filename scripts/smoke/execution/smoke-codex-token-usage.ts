import { zstdDecompressSync, gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore } from "@opencraft/account-pool-host";

import { CodexEngineAdapter } from "../../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { DatabaseSync } from "node:sqlite";


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
    const responseIndex=requests.length;
    const firstHuman=payload.text?.format?.type!=="json_schema"&&requests.filter(row=>row.text?.format?.type!=="json_schema").length===1;
    setTimeout(() => {
    const output = String(payload.model).includes("luna") ? JSON.stringify({ title: "修复自动会话标题" }) : "Fixture response.";
    response.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "10" });
    const item:Record<string,any> = firstHuman ? {id:`fixture-${responseIndex}`,type:"function_call",name:"synthetic_wait",call_id:"usage-wait",arguments:"{}",status:"completed"} : { id: `fixture-${responseIndex}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations: [] }] };
    for (const event of [
      { type: "response.created", response: { id: item.id, object: "response", created_at: 1, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: output },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: item.id, object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: 800, output_tokens: 200, total_tokens: 1000, input_tokens_details: {cached_tokens:300}, output_tokens_details: {reasoning_tokens:100} } } },
    ].filter(event=>!firstHuman||event.type!=="response.output_text.delta")) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
    },firstHuman ? 100 : payload.text?.format?.type === "json_schema" ? 200 : 1000);
  });
});
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("Fixture did not bind");
const adapter = new CodexEngineAdapter({
  tokenUsage: {queryWorkerEntry:new URL("../../../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url).pathname,serverId:"synthetic-usage-server",actor:context=>context.generation===1&&context.expiresAt>Date.now() ? {id:context.actorId,kind:"human"}:null},
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
const request = async (id: number, method: string, params: Record<string, unknown>, actorId="A",administrator=false) => {
  await adapter.sendWithContext(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "usage-smoke" }),{sender:null,tokenUsageAuthority:()=>({actorId,administrator}),actorContext:{actorId,generation:1,credentialId:null,expiresAt:Date.now()+60000}});
  const reply = await waitFor(frame => frame.id === id); assert.equal(reply.error, undefined, JSON.stringify(reply.error)); return reply.result;
};
try {
  await adapter.connect();
  await request(1, "initialize", { clientInfo: { name: "opencraft-title-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  const started = await request(2, "thread/start", { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "read-only",dynamicTools:[{type:"function",name:"synthetic_wait",description:"Synthetic usage barrier",inputSchema:{type:"object",properties:{},additionalProperties:false}}] });
  const threadId = started.thread.id;
  const first=await request(3,"turn/start",{threadId,clientUserMessageId:"start-A",input:[{type:"text",text:"SENSITIVE_SYNTHETIC_START",text_elements:[]}]},"A");
  const tool=await waitFor(frame=>frame.method === "item/tool/call" && frame.params.tool === "synthetic_wait");
  await adapter.send(JSON.stringify({id:tool.id,result:{success:true,contentItems:[{type:"inputText",text:"Synthetic tool complete"}]},[LOGICAL_CLIENT_FIELD]:"usage-smoke"}));
  await waitFor(frame=>frame.method === "thread/tokenUsage/updated" && frame.params.turnId === first.turn.id);
  const steer=await request(4,"turn/steer",{threadId,expectedTurnId:first.turn.id,clientUserMessageId:"steer-B",actorId:"UNTRUSTED_CLAIM",input:[{type:"text",text:"SENSITIVE_SYNTHETIC_STEER",text_elements:[]}]},"B");
  assert.equal(steer.turnId,first.turn.id);
  await adapter.send(JSON.stringify({method:"runtime/client/disconnect",params:{},[LOGICAL_CLIENT_FIELD]:"usage-smoke"}));
  const reader=new DatabaseSync(join(dataDirectory,"token-usage.sqlite"),{readOnly:true});
  try {
    const deadline=Date.now()+20000;
    let turn;
    while(Date.now()<deadline){
      turn=reader.prepare("SELECT * FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id=?").get("synthetic-usage-server",threadId,first.turn.id);
      if(turn?.allocation_state === "settled") break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const gaps=reader.prepare("SELECT reason,ends_ms FROM token_usage_gaps").all();
    assert.equal(turn?.allocation_state,"settled",JSON.stringify({turn,gaps}));
    const expected=2000n; // first acknowledged tool response plus the final acknowledged message response; canceled requests do not report usage.
    assert.equal(turn.observed_tokens,expected.toString(),JSON.stringify({modelRequests:requests.map(row=>({model:row.model,structured:row.text?.format?.type??null})),sources:reader.prepare("SELECT turn_id,source_id,source_kind,counts_json FROM token_usage_sources").all()}));
    const allocations=reader.prepare("SELECT actor_id,tokens FROM token_usage_allocations WHERE turn_id=? ORDER BY actor_id").all(first.turn.id);
    assert.deepEqual(allocations,[{actor_id:"A",tokens:(expected/2n).toString()},{actor_id:"B",tokens:(expected/2n).toString()}].map(value=>Object.assign(Object.create(null),value)));
    await request(20,"initialize",{clientInfo:{name:"usage-query",version:"0.1.0"},capabilities:{experimentalApi:true}});
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(Date.now());
    const query=await request(21,"opencraft/token-usage/query",{from:today,through:today},"A");
    assert.equal(query.summary.tokens,"1000");
    assert.equal(query.coverage.partial,false);
    const systemTurns=reader.prepare("SELECT thread_id,observed_tokens,allocation_state FROM token_usage_turns WHERE source_kind='system'").all();
    assert.ok(systemTurns.some(row=>row.observed_tokens==="1000"&&row.allocation_state==="system"),JSON.stringify(systemTurns));
    for(const row of systemTurns)assert.equal(reader.prepare("SELECT count(*) AS n FROM token_usage_allocations WHERE thread_id=?").get(row.thread_id!)!.n,0);
    const attempts=reader.prepare("SELECT input_id,actor_id,mode,outcome FROM token_usage_attempts ORDER BY input_id").all();
    assert.deepEqual(attempts.filter(row=>row.input_id==="start-A"||row.input_id==="steer-B").map(row=>[row.input_id,row.actor_id,row.mode,row.outcome]),[["start-A","A","start","accepted"],["steer-B","B","steer","accepted"]]);
    assert.equal(query.rows[0].rawTokens,"2000");
    assert.doesNotMatch(JSON.stringify(query),/"B"|SENSITIVE_SYNTHETIC|UNTRUSTED_CLAIM/);
    await adapter.sendWithContext(JSON.stringify({id:22,method:"opencraft/token-usage/query",params:{from:today,through:today,actorId:"B"},[LOGICAL_CLIENT_FIELD]:"usage-smoke"}),{sender:null,tokenUsageAuthority:()=>({actorId:"A",administrator:false})});
    assert.equal((await waitFor(frame=>frame.id===22)).error.code,403);
    await adapter.sendWithContext(JSON.stringify({id:23,method:"opencraft/token-usage/configure",params:{enabled:false},[LOGICAL_CLIENT_FIELD]:"usage-smoke"}),{sender:null,tokenUsageAuthority:()=>({actorId:"A",administrator:false})});
    assert.equal((await waitFor(frame=>frame.id===23)).error.code,403);
    await adapter.sendWithContext(JSON.stringify({id:24,method:"opencraft/token-usage/configure",params:{enabled:false},[LOGICAL_CLIENT_FIELD]:"usage-smoke"}),{sender:null,tokenUsageAuthority:()=>null});
    assert.equal((await waitFor(frame=>frame.id===24)).error.code,401);
    await adapter.sendWithContext(JSON.stringify({id:25,method:"opencraft/token-usage/configure",params:{enabled:false,serverId:"other"},[LOGICAL_CLIENT_FIELD]:"usage-smoke"}),{sender:null,tokenUsageAuthority:()=>({actorId:"admin",administrator:true})});
    assert.equal((await waitFor(frame=>frame.id===25)).error.code,-32602);
    const modelCallsBeforeConfigure=requests.length;
    for(let n=0;n<20;n++){
      const enabled=n%2===1;
      const configured=await request(100+n,"opencraft/token-usage/configure",{enabled},"admin",true);
      assert.equal(configured.enabled,enabled);assert.equal(configured.enabledAt,query.coverage.enabledAt);
    }
    const afterConfigure=await request(130,"opencraft/token-usage/query",{from:today,through:today},"A");
    assert.equal(afterConfigure.summary.tokens,"1000");assert.equal(afterConfigure.coverage.enabled,true);
    assert.equal(requests.length,modelCallsBeforeConfigure,"Changing collection configuration must not infer, cancel or replay a model request");
    const rows=reader.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'token_usage_%'").all();
    const dump=rows.map(row=>reader.prepare(`SELECT * FROM ${String(row.name)}`).all());
    assert.doesNotMatch(JSON.stringify(dump),/SENSITIVE_SYNTHETIC|UNTRUSTED_CLAIM|fixture-account-access|fixture-refresh/);
    console.log(JSON.stringify({passed:true,realCodexCLI:true,syntheticUpstream:true,identityBoundary:"synthetic trusted Host Actor port; not real login",allLogicalClientsDisconnected:true,authorizedQuery:true,forgedOtherActorRejected:true,configureAuthorization:true,configurationToggles:20,turnTokens:turn.observed_tokens,allocations,gaps,attempts,systemTurns}));
  } finally {reader.close();}

} finally { await adapter.close(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
