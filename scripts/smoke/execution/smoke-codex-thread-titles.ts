import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore } from "@opencraft/account-pool-host";

import { CodexEngineAdapter } from "../../../apps/opencraft-daemon/src/codex-engine-adapter.js";


const root = await mkdtemp(join(tmpdir(), "opencraft-codex-engine-smoke-"));
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
  let body = ""; request.on("data", data => { body += data; });
  request.on("end", () => {
    const payload = JSON.parse(body); requests.push(payload);
    const output = payload.model.includes("luna") ? JSON.stringify({ title: "修复自动会话标题" }) : "Fixture response.";
    response.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "10" });
    const item = { id: `fixture-${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations: [] }] };
    for (const event of [
      { type: "response.created", response: { id: item.id, object: "response", created_at: 1, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: output },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: item.id, object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
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
  await request(3, "turn/start", { threadId, input: [{ type: "text", text: "修复自动会话标题", text_elements: [] }] });
  await waitFor(frame => frame.method === "thread/name/updated" && frame.params.threadId === threadId);
  assert.equal((await request(4, "thread/read", { threadId, includeTurns: false })).thread.name, "修复自动会话标题");
  const listed = await request(5, "thread/list", { limit: 100 });
  assert.equal(listed.data.length, 1);
  const inference = requests.find(row => row.model === "gpt-6-luna"); assert.ok(inference);
  assert.equal(inference.text.format.type, "json_schema");
  assert.equal(inference.text.format.schema.additionalProperties, false);
  assert.deepEqual((inference.tools ?? []).map((tool: any) => tool.name ?? tool.type), [], "private inference must have no tools");
  assert.equal(frames.filter(frame => frame.method === "turn/completed").length, 1);
  assert.ok(frames.filter(frame => frame.method === "thread/started").every(frame => frame.params.thread.id === threadId));
  console.log(JSON.stringify({ passed: true, realCodexCLI: true, syntheticUpstream: true, title: "修复自动会话标题", requests: requests.length, inferenceModel: inference.model, visibleThreads: listed.data.length }));
} finally { await adapter.close(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
