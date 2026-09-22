import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { OPENCRAFT_THREAD_START_DURABILITY_EXTENSION } from "@opencraft/appserver-protocol";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS } from "../apps/workbench-web/src/runtime/workbench-dynamic-tools.js";

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

let modelRequests = 0;
const upstreamAccounts = new Set<string>();
const model = createServer((request, response) => {
  request.resume();
  if (request.url === "/backend-api/codex/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-test", object: "model", owned_by: "fixture" }] }));
    return;
  }
  modelRequests += 1;
  upstreamAccounts.add(String(request.headers["chatgpt-account-id"] ?? ""));
  response.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "10" });
  const item = { id: "fixture-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture response.", annotations: [] }] };
  for (const event of [
    { type: "response.created", response: { id: "fixture-response", object: "response", created_at: 1, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Fixture response." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fixture-response", object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise<void>((resolve, reject) => {
  model.once("error", reject);
  model.listen(0, "127.0.0.1", () => { model.off("error", reject); resolve(); });
});
const address = model.address();
if (!address || typeof address === "string") throw new Error("Fixture model did not bind");

const adapter = new CodexEngineAdapter({
  executable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex",
  runtimeDirectory: root,
  dataDirectory,
  nativeCodexHomeDirectory: join(root, "native-codex"),
  upstreamBaseUrl: `http://127.0.0.1:${address.port}/backend-api/codex`,
  fetch: async (input, init) => String(input).includes("/wham/usage")
    ? Response.json({ plan_type: "fixture", rate_limit: { primary_window: { used_percent: 0 } } })
    : fetch(input, init),
});
const frames: Array<Record<string, any>> = [];
adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
const waitFor = async (predicate: (frame: Record<string, any>) => boolean, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Codex Engine frame");
};
const client = "smoke-client";
try {
  await adapter.connect();
  await adapter.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "opencraft-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } }, [LOGICAL_CLIENT_FIELD]: client }));
  const initialized = await waitFor(frame => frame.id === 1);
  assert.deepEqual(
    initialized.result.capabilities.extensions[OPENCRAFT_THREAD_START_DURABILITY_EXTENSION],
    { version: 1, durableAfter: "first-turn-accepted" },
  );
  await adapter.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "danger-full-access", dynamicTools: OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS }, [LOGICAL_CLIENT_FIELD]: client }));
  const started = await waitFor(frame => frame.id === 2);
  const threadId = started.result.thread.id as string;
  await adapter.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: "Reply with fixture response", text_elements: [] }] }, [LOGICAL_CLIENT_FIELD]: client }));
  await waitFor(frame => frame.method === "turn/completed" && frame.params.threadId === threadId);
  assert.equal(modelRequests, 1);
  assert.deepEqual([...upstreamAccounts], ["fixture-chatgpt-account"]);
  assert.ok(frames.filter(frame => frame.method === "turn/completed").every(frame => frame[LOGICAL_CLIENT_FIELD] === client));
  console.log(JSON.stringify({
    result: "passed",
    transport: "production CodexEngineAdapter stdio",
    localFixtureModelRequests: modelRequests,
    externalModelRequests: 0,
  }));
} finally {
  await adapter.close().catch(() => undefined);
  await new Promise<void>(resolve => model.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
