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
    response.end(JSON.stringify({ object: "list", data: [
      { id: "gpt-test", object: "model", owned_by: "fixture" },
      { id: "gpt-6.1-sol", object: "model", owned_by: "fixture" },
    ] }));
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

const createAdapter = () => new CodexEngineAdapter({
  executable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex",
  runtimeDirectory: root,
  dataDirectory,
  nativeCodexHomeDirectory: join(root, "native-codex"),
  upstreamBaseUrl: `http://127.0.0.1:${address.port}/backend-api/codex`,
  fetch: async (input, init) => String(input).includes("/wham/usage")
    ? Response.json({ plan_type: "fixture", rate_limit: { primary_window: { used_percent: 0 } } })
    : fetch(input, init),
});
const adapter = createAdapter();
let restartedAdapter: CodexEngineAdapter | null = null;
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
  await adapter.send(JSON.stringify({ id: 15, method: "model/list", params: {}, [LOGICAL_CLIENT_FIELD]: client }));
  const models = await waitFor(frame => frame.id === 15);
  assert.equal(models.error, undefined, `Model list failed: ${JSON.stringify(models.error)}`);
  assert.ok(models.result.data.some((entry: { model: string }) => entry.model === "gpt-6.1-sol"));
  await adapter.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root, model: "gpt-test", approvalPolicy: "never", sandbox: "danger-full-access", dynamicTools: OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS }, [LOGICAL_CLIENT_FIELD]: client }));
  const started = await waitFor(frame => frame.id === 2);
  const threadId = started.result.thread.id as string;
  await adapter.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: "Reply with fixture response", text_elements: [] }] }, [LOGICAL_CLIENT_FIELD]: client }));
  await waitFor(frame => frame.method === "turn/completed" && frame.params.threadId === threadId);
  assert.equal(modelRequests, 1);
  await adapter.send(JSON.stringify({ id: 4, method: "thread/fork", params: { threadId }, [LOGICAL_CLIENT_FIELD]: client }));
  const durableFork = await waitFor(frame => frame.id === 4);
  assert.equal(durableFork.error, undefined, `Durable Fork failed: ${JSON.stringify(durableFork.error)}`);
  assert.notEqual(durableFork.result.thread.id, threadId);
  assert.equal(durableFork.result.thread.forkedFromId, threadId);
  assert.equal(durableFork.result.thread.ephemeral, false);
  assert.equal(durableFork.result.thread.turns.length, 1);
  await adapter.send(JSON.stringify({ id: 8, method: "thread/read", params: { threadId: durableFork.result.thread.id, includeTurns: true }, [LOGICAL_CLIENT_FIELD]: client }));
  const durableRead = await waitFor(frame => frame.id === 8);
  assert.equal(durableRead.error, undefined, `Durable Fork read failed: ${JSON.stringify(durableRead.error)}`);
  assert.equal(durableRead.result.thread.forkedFromId, threadId);
  assert.equal(durableRead.result.thread.turns.length, 1);
  await adapter.send(JSON.stringify({ id: 9, method: "thread/list", params: { limit: 20 }, [LOGICAL_CLIENT_FIELD]: client }));
  const listed = await waitFor(frame => frame.id === 9);
  assert.equal(listed.error, undefined, `Durable Fork listing failed: ${JSON.stringify(listed.error)}`);
  const listedBeforeChildTurn = listed.result.data.some((thread: { id: string }) => thread.id === durableFork.result.thread.id);
  await adapter.send(JSON.stringify({ id: 10, method: "turn/start", params: { threadId: durableFork.result.thread.id, input: [{ type: "text", text: "Reply with fixture response", text_elements: [] }] }, [LOGICAL_CLIENT_FIELD]: client }));
  await waitFor(frame => frame.method === "turn/completed" && frame.params.threadId === durableFork.result.thread.id);
  await adapter.send(JSON.stringify({ id: 11, method: "thread/list", params: { limit: 20 }, [LOGICAL_CLIENT_FIELD]: client }));
  const listedAfterTurn = await waitFor(frame => frame.id === 11);
  assert.equal(listedAfterTurn.error, undefined);
  assert.ok(listedAfterTurn.result.data.some((thread: { id: string }) => thread.id === durableFork.result.thread.id),
    `Fork absent after first child Turn: ${JSON.stringify(listedAfterTurn.result.data.map((thread: { id: string; source?: unknown }) => ({ id: thread.id, source: thread.source })))}`);
  await adapter.send(JSON.stringify({ id: 5, method: "thread/fork", params: { threadId, ephemeral: true, excludeTurns: true }, [LOGICAL_CLIENT_FIELD]: client }));
  const ephemeralFork = await waitFor(frame => frame.id === 5);
  assert.equal(ephemeralFork.error, undefined, `Ephemeral Fork failed: ${JSON.stringify(ephemeralFork.error)}`);
  assert.notEqual(ephemeralFork.result.thread.id, threadId);
  assert.equal(ephemeralFork.result.thread.ephemeral, true);
  await adapter.send(JSON.stringify({ id: 7, method: "thread/inject_items", params: { threadId: ephemeralFork.result.thread.id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fixture side-chat boundary" }] }] }, [LOGICAL_CLIENT_FIELD]: client }));
  const injected = await waitFor(frame => frame.id === 7);
  assert.equal(injected.error, undefined, `Ephemeral history injection failed: ${JSON.stringify(injected.error)}`);
  await adapter.send(JSON.stringify({ id: 6, method: "thread/unsubscribe", params: { threadId: ephemeralFork.result.thread.id }, [LOGICAL_CLIENT_FIELD]: client }));
  const unsubscribed = await waitFor(frame => frame.id === 6);
  assert.equal(unsubscribed.error, undefined, `Ephemeral unsubscribe failed: ${JSON.stringify(unsubscribed.error)}`);
  await adapter.send(JSON.stringify({ id: 12, method: "thread/fork", params: { threadId }, [LOGICAL_CLIENT_FIELD]: client }));
  const blankFork = await waitFor(frame => frame.id === 12);
  assert.equal(blankFork.error, undefined);
  await adapter.close();
  restartedAdapter = createAdapter();
  restartedAdapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  await restartedAdapter.connect();
  await restartedAdapter.send(JSON.stringify({ id: 13, method: "initialize", params: { clientInfo: { name: "opencraft-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } }, [LOGICAL_CLIENT_FIELD]: client }));
  await waitFor(frame => frame.id === 13);
  await restartedAdapter.send(JSON.stringify({ id: 14, method: "thread/read", params: { threadId: blankFork.result.thread.id, includeTurns: true }, [LOGICAL_CLIENT_FIELD]: client }));
  const blankForkAfterRestart = await waitFor(frame => frame.id === 14);
  assert.equal(blankForkAfterRestart.error, undefined, `Blank Fork recovery failed: ${JSON.stringify(blankForkAfterRestart.error)}`);
  assert.equal(blankForkAfterRestart.result.thread.forkedFromId, threadId);
  assert.deepEqual([...upstreamAccounts], ["fixture-chatgpt-account"]);
  assert.ok(frames.filter(frame => frame.method === "turn/completed").every(frame => frame[LOGICAL_CLIENT_FIELD] === client));
  console.log(JSON.stringify({
    result: "passed",
    transport: "production CodexEngineAdapter stdio",
    localFixtureModelRequests: modelRequests,
    externalModelRequests: 0,
    durableFork: true,
    durableForkListedBeforeChildTurn: listedBeforeChildTurn,
    durableForkListedAfterChildTurn: true,
    blankForkReadableAfterRestart: true,
    ephemeralFork: true,
    ephemeralInjectItems: true,
  }));
} finally {
  await restartedAdapter?.close().catch(() => undefined);
  await adapter.close().catch(() => undefined);
  await new Promise<void>(resolve => model.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
