import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { CodexEngineAdapter } from "../../../apps/opencraft-daemon/src/codex-engine-adapter.js";
const executable = process.env.OPENCRAFT_CODEX_EXECUTABLE;
if (!executable) throw new Error("Set OPENCRAFT_CODEX_EXECUTABLE to the isolated native CLI under test");
const root = await mkdtemp(join(tmpdir(), "input-delivery-native-")),
  dataDirectory = join(root, "codex");
const store = new AccountPoolStore({
  databasePath: join(dataDirectory, "account-pool.sqlite"),
  secretsDirectory: join(dataDirectory, "secrets"),
});
store.addAccount(
  {
    id: "fixture",
    provider: "codex",
    label: "Fixture",
    upstreamAccountId: "fixture",
    priority: 1,
    enabled: true,
  },
  {
    accessToken: "fixture-access",
    refreshToken: "fixture-refresh",
    expiresAt: null,
  },
);
store.close();
let requests = 0;
let allowCompletion = false;
const upstream = createServer((req, res) => {
  req.resume();
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "gpt-test", object: "model", owned_by: "fixture" }],
      }),
    );
    return;
  }
  requests++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r-" + requests, object: "response", status: "in_progress", output: [] } })}\n\n`,
  );
  if (!allowCompletion) return; // Deliberately hold inference while the user steers and stops.
  const item = {
    id: "m-" + requests,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "new-intent-complete", annotations: [] }],
  };
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "r-" + requests,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const port = (upstream.address() as { port: number }).port;
const create = () =>
  new CodexEngineAdapter({
    executable,
    runtimeDirectory: root,
    dataDirectory,
    nativeCodexHomeDirectory: join(root, "native-codex"),
    upstreamBaseUrl: `http://127.0.0.1:${port}/backend-api/codex`,
    fetch: async (input, init) =>
      String(input).includes("/wham/usage")
        ? Response.json({
            plan_type: "fixture",
            rate_limit: { primary_window: { used_percent: 0 } },
          })
        : fetch(input, init),
    logDiagnostic: () => {},
  });
let adapter = create();
let seq = 0;
const frames: any[] = [];
const subscribe = () => adapter.subscribeMessage((line) => frames.push(JSON.parse(line)));
subscribe();
const wait = async (predicate: () => any) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const found = predicate();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    "Native input delivery observation timed out: " + JSON.stringify({ requests, frames: frames.slice(-5) }),
  );
};
const rpc = async (method: string, params: object) => {
  const id = "native:" + ++seq;
  await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "probe" }));
  const f = await wait(() => frames.find((f) => f.id === id));
  if (f.error) throw new Error(JSON.stringify(f.error));
  return f.result;
};
const initialize = async () => {
  await adapter.connect();
  await rpc("initialize", {
    clientInfo: { name: "input-delivery-smoke", version: "1" },
    capabilities: { experimentalApi: true },
  });
};
try {
  await initialize();
  const threadId = (
    await rpc("thread/start", {
      cwd: root,
      model: "gpt-test",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    })
  ).thread.id;
  const turnId = (
    await rpc("turn/start", {
      threadId,
      clientUserMessageId: "first",
      input: [{ type: "text", text: "Hold inference" }],
    })
  ).turn.id;
  await wait(() => requests >= 1);
  const ack = await rpc("turn/steer", {
    threadId,
    expectedTurnId: turnId,
    clientUserMessageId: "follow",
    input: [{ type: "text", text: "Continue" }],
  });
  assert.equal(ack.delivery.custody, "accepted");
  assert.equal(ack.delivery.nativeAdmission, "accepted");
  await rpc("turn/interrupt", { threadId, turnId });
  await wait(() => frames.find((f) => f.method === "turn/completed" && f.params.turn.id === turnId));
  await rpc("thread/queue/list", { threadId, receiptTurnIds: [turnId] });
  const receipt = (adapter as any).queueStore().findByClientId(threadId, "follow").delivery;
  assert.equal(receipt.execution, "interrupted");
  assert.equal(receipt.custody, "accepted");
  const stoppedTurns = await rpc("thread/turns/list", {
    threadId,
    itemsView: "notLoaded",
  });
  assert.equal(stoppedTurns.data.length, 1, "stop alone never restarts the follow-up");
  allowCompletion = true;
  await rpc("thread/queue/add", {
    threadId,
    clientUserMessageId: "next",
    input: [{ type: "text", text: "New intention" }],
  });
  await wait(() => frames.find((f) => f.method === "turn/completed" && f.params.turn.id !== turnId));
  assert.equal(
    (await rpc("thread/turns/list", { threadId, itemsView: "notLoaded" })).data.length,
    2,
    "exactly one fresh user Turn",
  );
  await adapter.close();
  adapter = create();
  subscribe();
  await initialize();
  await rpc("thread/resume", { threadId, excludeTurns: true });
  await rpc("thread/queue/list", { threadId, receiptTurnIds: [turnId] });
  const recovered = (adapter as any).queueStore().findByClientId(threadId, "follow").delivery;
  assert.equal(recovered.execution, "interrupted");
  assert.equal((await rpc("thread/turns/list", { threadId, itemsView: "notLoaded" })).data.length, 2);
  console.log(
    JSON.stringify({
      native: true,
      syntheticModel: true,
      requests,
      receipt,
      recovered,
      result: "passed",
    }),
  );
} finally {
  await adapter.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
