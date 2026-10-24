import { zstdDecompressSync, gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore } from "@opencraft/account-pool-host";

import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { nativeAcceptedInputFact } from "../apps/opencraft-daemon/src/token-usage-native-facts.js";


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
    setTimeout(() => {
    const output = String(payload.model).includes("luna") ? JSON.stringify({ title: "修复自动会话标题" }) : "Fixture response.";
    response.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "10" });
    const item = { id: `fixture-${responseIndex}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations: [] }] };
    for (const event of [
      { type: "response.created", response: { id: item.id, object: "response", created_at: 1, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: output },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: item.id, object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: 800, output_tokens: 200, total_tokens: 1000, input_tokens_details: {cached_tokens:300}, output_tokens_details: {reasoning_tokens:100} } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
    },200);
  });
});
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("Fixture did not bind");
const adapter = new CodexEngineAdapter({
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
  await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "title-smoke" }));
  const reply = await waitFor(frame => frame.id === id); assert.equal(reply.error, undefined, JSON.stringify(reply.error)); return reply.result;
};
try {
  await adapter.connect();
  await request(1, "initialize", { clientInfo: { name: "opencraft-title-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  const started = await request(2, "thread/start", { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "read-only" });
  const threadId = started.thread.id;
  const first = await request(3, "turn/start", { threadId, clientUserMessageId:"probe-start-A", input: [{ type: "text", text: "synthetic initiator", text_elements: [] }] });
  const steered = await request(4, "turn/steer", {threadId,expectedTurnId:first.turn.id,clientUserMessageId:"probe-steer-B",input:[{type:"text",text:"synthetic steering input",text_elements:[]}]});
  assert.equal(steered.turnId,first.turn.id);
  await assert.rejects(request(5,"turn/steer",{threadId,expectedTurnId:"00000000-0000-7000-8000-000000000000",clientUserMessageId:"probe-rejected-C",input:[{type:"text",text:"synthetic rejected input",text_elements:[]}]}));
  await waitFor(frame => frame.method === "turn/completed" && frame.params.turn.id === first.turn.id);
  const {thread} = await request(6,"thread/read",{threadId,includeTurns:true});
  const rollout = (await readFile(thread.path,"utf8")).split("\n").filter(Boolean).map(line=>JSON.parse(line));
  const inputEvidence = rollout.flatMap(row=>{
    const p=row.payload??{};
    if(row.type === "response_item" && p.type === "message" && p.role === "user") return [{kind:"user-message",metadata:p.internal_chat_message_metadata_passthrough??null,id:p.id??null}];
    if(row.type === "event_msg" && p.type === "item_completed" && p.item?.type === "userMessage") return [{kind:"user-item",turnId:p.turn_id,itemId:p.item.id,clientUserMessageId:p.item.clientUserMessageId,keys:Object.keys(p.item)}];
    return [];
  });
  const correlationEvidence: {rowType:string,path:string,value:string}[]=[];
  const findCorrelations = (value:unknown,path:string,rowType:string) => {
    if(value === "probe-start-A" || value === "probe-steer-B" || value === "probe-rejected-C") {correlationEvidence.push({rowType,path,value});return;}
    if(value && typeof value === "object") for(const [key,child] of Object.entries(value)) findCorrelations(child,`${path}.${key}`,rowType);
  };
  for(const row of rollout) {
    const before=correlationEvidence.length;
    findCorrelations(row.payload,"payload",row.type);
    if(correlationEvidence.length>before) Object.assign(correlationEvidence[before],{
      eventType:row.payload?.type,itemType:row.payload?.item?.type,turnId:row.payload?.turn_id,threadId:row.payload?.thread_id,
    });
  }
  assert.ok(!correlationEvidence.some(row=>row.value === "probe-rejected-C"));
  const acceptedInputs=rollout.map(row=>nativeAcceptedInputFact(row,threadId)).filter(Boolean);
  assert.deepEqual(acceptedInputs,[{threadId,turnId:first.turn.id,inputId:"probe-start-A"},{threadId,turnId:first.turn.id,inputId:"probe-steer-B"}]);
  console.log(JSON.stringify({acceptedInputs,correlationEvidence,rejectedInputAbsent:true,realCodexCLI:true,syntheticUpstream:true,startTurnId:first.turn.id,steerTurnId:steered.turnId,inputEvidence}));

} finally { await adapter.close(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
