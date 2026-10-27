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
  const first = await request(3, "turn/start", { threadId, input: [{ type: "text", text: "synthetic metering probe", text_elements: [] }] });
  await waitFor(frame => frame.method === "turn/completed" && frame.params.turn.id === first.turn.id);
  const second = await request(4, "turn/start", { threadId, input: [{ type: "text", text: "synthetic second turn", text_elements: [] }] });
  await waitFor(frame => frame.method === "turn/completed" && frame.params.turn.id === second.turn.id);
  const {thread} = await request(5, "thread/read", { threadId, includeTurns: true });
  const notifications = frames.filter(frame => ["rawResponse/completed","thread/tokenUsage/updated"].includes(frame.method));
  const rollout = thread.path ? (await readFile(thread.path,"utf8")).split("\n").filter(Boolean).map(line=>JSON.parse(line)) : [];
  const exactUsage = rollout.filter(row=>row.type === "token_usage_record").map(row=>row.payload);
  const usageState = new TokenUsageStateDatabase(join(root,"metering-probe"));
  let recovery;
  try {
    const ledger = new OpenCraftTokenUsageLedger(usageState,"probe-server",()=>0);
    for (const turn of thread.turns) ledger.startTurn({threadId,turnId:turn.id},turn.startedAt*1000,"unknown");
    const options = {path:thread.path,nativeHome:join(dataDirectory,"runtime"),threadId,ledger};
    const firstReplay = await replayRolloutUsage(options);
    const secondReplay = await replayRolloutUsage(options);
    assert.equal(firstReplay.changed,2);
    assert.equal(secondReplay.changed,0);
    assert.deepEqual(thread.turns.map((turn:any)=>ledger.readTurn({threadId,turnId:turn.id})?.observedTokens),["1000","1000"]);
    recovery = {firstReplay,secondReplay,turnTokens:["1000","1000"]};
  } finally {usageState.close();}
  const facts = rollout.filter(row => row.type === "event_msg" && row.payload?.type === "token_count")
    .map(row=>({timestamp:row.timestamp,info:row.payload.info}));
  console.log(JSON.stringify({realCodexCLI:true,syntheticUpstream:true,notifications,exactUsage,recovery,
    rolloutStructure: rollout.map(row=>({type:row.type,payloadType:row.payload?.type,keys:Object.keys(row.payload??{}),turnId:row.payload?.turn_id,model:row.payload?.model,provider:row.payload?.model_provider})),
    turnMetadata:thread.turns.map((turn:any)=>({id:turn.id,startedAt:turn.startedAt,status:turn.status})),rolloutUsage:facts}));

} finally { await adapter.close(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
