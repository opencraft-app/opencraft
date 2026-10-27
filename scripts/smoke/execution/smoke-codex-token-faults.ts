import { zstdDecompressSync, gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

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
    const firstHuman=false;
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
const evidence:any[]=[];let passed=false;const evidenceFile=process.env.OPENCRAFT_TOKEN_FAULT_EVIDENCE??'.local/token-usage-faults.json';let writer:DatabaseSync|null=null,locked=false;
try {
 await adapter.connect();await request(1,'initialize',{clientInfo:{name:'isolated-native-fault',version:'0.1'},capabilities:{experimentalApi:true}});
 writer=new DatabaseSync(join(dataDirectory,'token-usage.sqlite'));writer.exec('PRAGMA busy_timeout=0');
 let id=100;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
 for(const fault of ['healthy','token-write-rejected','sqlite-lock','source-offline-60s']){
  const start=await request(id++,'thread/start',{cwd:root,model:'gpt-test',approvalPolicy:'never',sandbox:'read-only'});const threadId=start.thread.id;
  if(fault==='token-write-rejected')writer.exec("CREATE TRIGGER token_fault BEFORE INSERT ON token_usage_sources BEGIN SELECT RAISE(ABORT,'synthetic token write unavailable');END");
  if(fault==='sqlite-lock'){writer.exec('BEGIN IMMEDIATE');locked=true;}
  const before=performance.now(),beforeRequests=requests.length,started=await request(id++,'turn/start',{threadId,clientUserMessageId:'fault-'+fault,input:[{type:'text',text:'SYNTHETIC_FAULT_INPUT',text_elements:[]}]});
  let hiddenPath:string|null=null;
  if(fault==='source-offline-60s'){const native=await request(id++,'thread/read',{threadId,includeTurns:false});hiddenPath=native.thread.path;assert.ok(hiddenPath?.startsWith(root+'/'));await rename(hiddenPath!,hiddenPath!+'.offline');}
  await waitFor(f=>f.method==='turn/completed'&&f.params.turn.id===started.turn.id);
  await new Promise(r=>setTimeout(r,200));
  const q=id++,qStart=performance.now();await adapter.sendWithContext(JSON.stringify({id:q,method:'opencraft/token-usage/query',params:{from:today,through:today},[LOGICAL_CLIENT_FIELD]:'usage-smoke'}),{sender:null,tokenUsageAuthority:()=>({actorId:'A',administrator:false})});
  const reply=await waitFor(f=>f.id===q);const queryMs=performance.now()-qStart;
  evidence.push({fault,completed:true,executionMs:performance.now()-before,queryMs,queryError:reply.error??null,coverage:reply.result?.coverage,tokens:reply.result?.summary.tokens,modelRequests:requests.length-beforeRequests});
  if(locked){writer.exec('ROLLBACK');locked=false;}
  if(fault==='token-write-rejected')writer.exec('DROP TRIGGER token_fault');
  assert.ok(queryMs<2000,'statistics reply bounded');
  if(fault!=='healthy')assert.ok(reply.error||reply.result.coverage.partial,'failed writes must not return complete coverage '+fault);
  if(hiddenPath){await new Promise(r=>setTimeout(r,60000-(performance.now()-before)));await rename(hiddenPath+'.offline',hiddenPath);let recovered:any;const deadline=Date.now()+15000;while(Date.now()<deadline){recovered=await request(id++,'opencraft/token-usage/query',{from:today,through:today,scope:'team',threadId},'admin',true);if(recovered.summary.categories.settled==='1000')break;await new Promise(r=>setTimeout(r,250));}assert.equal(recovered.summary.categories.settled,'1000','source reconcilation after60seconds');evidence.push({fault:'source-restored',settled:recovered.summary.categories.settled,partial:recovered.coverage.partial});}
  await new Promise(r=>setTimeout(r,2500));
 }
 const baseline=evidence.find(row=>row.fault==='healthy').modelRequests;for(const row of evidence.filter(row=>row.completed))assert.equal(row.modelRequests,baseline,'fault must not add model calls');assert.equal(requests.length,baseline*4);passed=true;console.log(JSON.stringify({passed,realNativeCLI:true,syntheticUpstream:true,evidence}));
}finally{
 if(locked)writer?.exec('ROLLBACK');writer?.exec('DROP TRIGGER IF EXISTS token_fault');writer?.close();
 await mkdir(dirname(evidenceFile),{recursive:true});await writeFile(evidenceFile,JSON.stringify({passed,evidence,scope:'isolated real native Host + synthetic upstream and trusted Actor, not production/real login'},null,2));
 await adapter.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await rm(root,{recursive:true,force:true});
}
