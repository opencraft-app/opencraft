import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync, gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore } from "@opencraft/account-pool-host";

import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { TokenUsageStateDatabase } from "../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../apps/opencraft-daemon/src/token-usage-ledger.js";
import { replayRolloutUsage } from "../apps/opencraft-daemon/src/token-usage-rollout.js";


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
    const output = String(payload.model).includes("luna") ? JSON.stringify({ title: "修复自动会话标题" }) : "Fixture response.";
    response.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "10" });
    const item = { id: `fixture-${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations: [] }] };
    for (const event of [
      { type: "response.created", response: { id: item.id, object: "response", created_at: 1, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: output },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: item.id, object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: 800, output_tokens: 200, total_tokens: 1000, input_tokens_details: {cached_tokens:300}, output_tokens_details: {reasoning_tokens:100} } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
});
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("Fixture did not bind");
const adapter = new CodexEngineAdapter({
  tokenUsage:{serverId:"ephemeral-probe",queryWorkerEntry:new URL("../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url).pathname,actor:context=>({id:context.actorId,kind:"human"})},
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
const request = async (id: number, method: string, params: Record<string, unknown>) => {
  await adapter.sendWithContext(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "title-smoke" }),{sender:null,actorContext:{actorId:"A",credentialId:null,generation:1,expiresAt:Date.now()+60000},tokenUsageAuthority:()=>({actorId:"A",administrator:false})});
  const reply = await waitFor(frame => frame.id === id); assert.equal(reply.error, undefined, JSON.stringify(reply.error)); return reply.result;
};
try {
  await adapter.connect();
  await request(1, "initialize", { clientInfo: { name: "opencraft-title-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  const started = await request(2, "thread/start", { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "read-only",ephemeral:true });
  const threadId = started.thread.id;
  const first = await request(3, "turn/start", { threadId, clientUserMessageId:"ephemeral-first", input: [{ type: "text", text: "synthetic metering probe", text_elements: [] }] });
  await waitFor(frame => frame.method === "turn/completed" && frame.params.turn.id === first.turn.id);
  const second = await request(4, "turn/start", { threadId, clientUserMessageId:"ephemeral-second", input: [{ type: "text", text: "synthetic second turn", text_elements: [] }] });
  await waitFor(frame => frame.method === "turn/completed" && frame.params.turn.id === second.turn.id);
  const notifications=frames.filter(frame=>["thread/tokenUsage/updated"].includes(frame.method)).map(frame=>frame.params);
  const acceptedInputs=frames.filter(frame=>frame.method==="item/completed").map(frame=>({threadId:frame.params.threadId,turnId:frame.params.turnId,type:frame.params.item?.type,keys:Object.keys(frame.params.item??{}),clientId:frame.params.item?.clientId??frame.params.item?.client_id??null}));
  const database=new DatabaseSync(join(dataDirectory,"token-usage.sqlite"),{readOnly:true});
  const reader={database,close:()=>database.close()};
  let collected;
  try {
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      const rows=reader.database.prepare("SELECT turn_id,observed_tokens,allocation_state FROM token_usage_turns WHERE thread_id=? ORDER BY started_ms").all(threadId);
      if(rows.length===2&&rows.every(row=>row.observed_tokens==="1000"&&row.allocation_state==="settled")){collected=rows;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(collected,"Host must persist each ephemeral turn as 1000, not the second cumulative 2000");
  }finally{reader.close();}
  await adapter.send(JSON.stringify({method:"runtime/client/disconnect",[LOGICAL_CLIENT_FIELD]:"title-smoke"}));
  await request(7,"initialize",{clientInfo:{name:"ephemeral-query",version:"0.1.0"},capabilities:{experimentalApi:true}});
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(Date.now());
  const query=await request(8,"opencraft/token-usage/query",{from:today,through:today});
  assert.equal(query.summary.tokens,"2000");assert.equal(query.rows.length,2);
  console.log(JSON.stringify({retainedAfterClientDisconnect:true,authorizedTotal:query.summary.tokens,collected,realCodexCLI:true,syntheticUpstream:true,ephemeral:started.thread.ephemeral,path:started.thread.path,initialTurns:started.thread.turns?.length,turns:[first.turn.id,second.turn.id],notifications,acceptedInputs}));
} finally { await adapter.close(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
