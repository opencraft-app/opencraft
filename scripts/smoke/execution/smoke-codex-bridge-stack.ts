// Desktop bridge stack drill: the daemon launches Core, AppServer and the Engine
// Host as children and runs Codex Threads through the provider bridge.
// Explicit opt-in real native Codex, synthetic account, private HOME, local model only.
// Requires `npm run build --workspace @opencraft/opencraft-daemon` first.
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { build } from "esbuild";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import {
  DaemonJsonLineChannel,
  OPENCRAFT_DAEMON_BUILD_ID,
  OPENCRAFT_DAEMON_PROTOCOL_VERSION,
  type DaemonServerMessage,
} from "@opencraft/daemon-ipc";
import { startOpenCraftDaemon } from "../../../apps/opencraft-daemon/src/main.js";
import { CodexEngineAdapter } from "../../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { CODEX_BRIDGE_PROGRAMS } from "../../../apps/opencraft-daemon/src/codex-bridge-stack.js";

const executable = process.env.OPENCRAFT_CODEX_EXECUTABLE;
if (!executable) throw new Error("Set OPENCRAFT_CODEX_EXECUTABLE to the native Codex CLI under test");
const repository = resolve(import.meta.dirname, "../../..");
const root = await mkdtemp(join(process.env.OPENCRAFT_STACK_DRILL_ROOT ?? tmpdir(), "stack-drill-"));
const result: Record<string, unknown> = { root, scenarios: [] as unknown[] };
const scenarios = result.scenarios as unknown[];

// A local Responses model: answers each user text with "echo: <text>".
const requests: string[] = [];
const event = (response: ServerResponse, value: Record<string, unknown>) =>
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (request.url === "/usage") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"plan_type":"pro"}');
    return;
  }
  if (request.url?.endsWith("/models")) return void response.end('{"models":[]}');
  if (request.url !== "/responses") return void response.writeHead(404).end();
  const raw = Buffer.concat(chunks);
  const body = JSON.parse(
    (request.headers["content-encoding"] === "zstd"
      ? zstdDecompressSync(raw)
      : request.headers["content-encoding"] === "gzip"
        ? gunzipSync(raw)
        : raw
    ).toString(),
  );
  const users = (body.input ?? []).filter((item: any) => item.role === "user");
  const text = String(users.at(-1)?.content?.find((part: any) => part.type === "input_text")?.text ?? "");
  requests.push(text);
  const id = `response-${requests.length}`;
  const item = {
    type: "message",
    id: `message-${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: `echo: ${text}`, annotations: [] }],
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  event(response, {
    type: "response.created",
    response: { id, object: "response", status: "in_progress", output: [] },
  });
  event(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  event(response, { type: "response.output_item.done", output_index: 0, item });
  event(response, {
    type: "response.completed",
    response: {
      id,
      object: "response",
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  response.end();
});
await new Promise<void>((accept) => model.listen(0, "127.0.0.1", accept));
const upstream = `http://127.0.0.1:${(model.address() as import("node:net").AddressInfo).port}`;

// The packaged programs, with Core replaced by the drill entry that only moves its upstream.
const programs = join(root, "programs");
await cp(join(repository, "apps/opencraft-daemon/dist/codex-bridge"), programs, { recursive: true });
await build({
  entryPoints: [join(repository, "tests/fixtures/bridge-stack-core.ts")],
  outfile: join(programs, CODEX_BRIDGE_PROGRAMS.core),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["node-pty"],
  logLevel: "warning",
});
process.env.OPENCRAFT_DRILL_UPSTREAM = upstream;
process.env.HOME = join(root, "home");
await mkdir(process.env.HOME, { recursive: true, mode: 0o700 });

const codexDataDirectory = join(root, "codex");
await mkdir(codexDataDirectory, { recursive: true, mode: 0o700 });
const store = new AccountPoolStore({
  databasePath: join(codexDataDirectory, "account-pool.sqlite"),
  secretsDirectory: join(codexDataDirectory, "secrets"),
});
store.addAccount(
  {
    id: "synthetic",
    provider: "codex",
    label: "Synthetic",
    upstreamAccountId: "synthetic",
    enabled: true,
    priority: 0,
  },
  { accessToken: "synthetic-no-upstream-access", refreshToken: null, expiresAt: null },
);
store.close();

const token = "synthetic-stack-drill-token-".repeat(3);
const runtimeDirectory = join(root, "runtime");
await mkdir(runtimeDirectory, { recursive: true });
const endpoint = join(root, "daemon.sock");
const daemonOptions = {
  endpoint,
  runtimeDirectory,
  authToken: token,
  dataDirectory: join(root, "data"),
  dshExecutable: "/missing-engine",
  codexExecutable: executable,
  codexDataDirectory,
  nativeCodexHomeDirectory: join(root, "native-home"),
  codexBridgeStack: { programs },
};

async function openClient() {
  const socket = connect(endpoint);
  const channel = new DaemonJsonLineChannel(socket);
  await new Promise<void>((accept, reject) => {
    channel.subscribeMessage((value) => {
      const message = value as DaemonServerMessage;
      if (message.type === "daemon/fatal") reject(new Error(message.message));
      if (message.type === "daemon/ready") accept();
    });
    socket.once("connect", () =>
      channel.send({
        type: "daemon/hello",
        protocolVersion: OPENCRAFT_DAEMON_PROTOCOL_VERSION,
        buildId: OPENCRAFT_DAEMON_BUILD_ID,
        authToken: token,
        connectionId: "stack-drill",
        role: "app-host",
      }),
    );
  });
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const stop = channel.subscribeMessage((value) => {
    const message = value as DaemonServerMessage;
    if (message.type === "app-host/message")
      for (const listener of listeners) listener({ data: message.payload } as MessageEvent<unknown>);
  });
  const appHost = new MessagePortAppHostClient(
    {
      postMessage: (message) => channel.send({ type: "app-host/message", payload: message }),
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
      start() {},
      close() {
        stop();
        channel.close();
      },
    },
    "stack-drill",
  );
  await appHost.waitUntilReady();
  const transport = appHost.createTransport("local-codex");
  const client = new JsonRpcAppServerClient({ hostId: "local-codex", transport });
  const notifications: { method: string; params: any }[] = [];
  client.subscribeNotification((notification) => notifications.push(notification as any));
  await transport.connect();
  await client.connect({
    clientInfo: { name: "stack-drill", version: "1" },
    capabilities: { experimentalApi: true },
  } as any);
  return {
    client,
    notifications,
    close: async () => {
      await client.close();
      appHost.close();
    },
  };
}

async function answer(client: JsonRpcAppServerClient, threadId: string, text: string, clientUserMessageId: string) {
  await client.request(
    "turn/start" as any,
    { threadId, clientUserMessageId, input: [{ type: "text", text, text_elements: [] }] } as any,
  );
  const deadline = Date.now() + 90_000;
  for (;;) {
    const read: any = await client.request("thread/read" as any, { threadId, includeTurns: true } as any);
    const turns = read.thread.turns ?? [];
    const last = turns.at(-1);
    const reply = last?.items?.find((item: any) => item.type === "agentMessage")?.text;
    if (last?.status === "completed" && reply) return { reply, turns: turns.length, read };
    if (Date.now() > deadline)
      throw new Error(`No completed answer for ${text}: ${JSON.stringify(last)?.slice(0, 600)}`);
    await delay(250);
  }
}

let daemon: Awaited<ReturnType<typeof startOpenCraftDaemon>> | undefined;
const children = async () => {
  const record = await readFile(join(root, "data/codex-bridge/children.json"), "utf8").catch(() => "[]");
  return (JSON.parse(record) as { pid: number }[]).map((row) => row.pid);
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
try {
  // A Thread made by the previous local Codex Host, before the desktop moved to the bridge.
  const { codexBridgeStack: _, ...legacyOptions } = daemonOptions;
  daemon = await startOpenCraftDaemon({
    ...legacyOptions,
    createCodexTransport: (configuration) =>
      new CodexEngineAdapter({
        ...configuration,
        upstreamBaseUrl: upstream,
        fetch: (input, init) => {
          const raw = input instanceof Request ? input.url : String(input);
          const target = raw.includes("/wham/usage") ? `${upstream}/usage` : raw;
          if (new URL(target).hostname !== "127.0.0.1") throw new Error("Non-local request in isolated drill");
          return fetch(target, init);
        },
      }),
  });
  let legacy = await openClient();
  const old: any = await legacy.client.request(
    "thread/start" as any,
    { cwd: runtimeDirectory, model: "gpt-test" } as any,
  );
  const oldId = old.thread.id as string;
  assert.equal((await answer(legacy.client, oldId, "LEGACY-FIRST", "legacy-first")).reply, "echo: LEGACY-FIRST");
  await legacy.close();
  await daemon.close();
  daemon = undefined;

  daemon = await startOpenCraftDaemon(daemonOptions);
  legacy = await openClient();
  const adopted = await answer(legacy.client, oldId, "LEGACY-SECOND", "legacy-second");
  assert.equal(adopted.reply, "echo: LEGACY-SECOND");
  assert.equal(adopted.turns, 2, "the adopted Thread keeps its history");
  scenarios.push({
    name: "an existing local Thread continues on the bridge under its own ID",
    threadId: oldId,
    reply: adopted.reply,
  });
  await legacy.close();
  await daemon.close();
  daemon = undefined;

  daemon = await startOpenCraftDaemon(daemonOptions);
  const launched = await children();
  assert.equal(launched.length, 3, "Core, AppServer and Engine Host run as daemon children");
  let session = await openClient();
  const started: any = await session.client.request(
    "thread/start" as any,
    { cwd: runtimeDirectory, model: "gpt-test" } as any,
  );
  const threadId = started.thread.id as string;
  assert.match(threadId, /^bridge:codex:/, "new Threads are created through the provider bridge");
  const first = await answer(session.client, threadId, "STACK-FIRST", "stack-first");
  assert.equal(first.reply, "echo: STACK-FIRST");
  scenarios.push({ name: "new Thread runs through the bridge on real native Codex", threadId, reply: first.reply });
  const listed: any = await session.client.request("thread/list" as any, {} as any);
  assert.ok(
    listed.data.some((row: any) => row.id === threadId),
    "bridge Thread is listed by its public ID",
  );
  await session.close();

  await daemon.close();
  daemon = undefined;
  assert.deepEqual(launched.filter(alive), [], "children stop with the daemon");
  scenarios.push({ name: "daemon shutdown stops the stack", children: launched.length });

  daemon = await startOpenCraftDaemon(daemonOptions);
  session = await openClient();
  const reread: any = await session.client.request("thread/read" as any, { threadId, includeTurns: true } as any);
  assert.equal(reread.thread.turns.length, 1, "history survives the restart under the same ID");
  const second = await answer(session.client, threadId, "STACK-SECOND", "stack-second");
  assert.equal(second.reply, "echo: STACK-SECOND");
  assert.equal(second.turns, 2);
  scenarios.push({ name: "after a full restart the same Thread continues", threadId, reply: second.reply });
  await session.close();
  assert.deepEqual(
    requests,
    ["LEGACY-FIRST", "LEGACY-SECOND", "STACK-FIRST", "STACK-SECOND"],
    "each input reached the model exactly once",
  );
  result.result = "passed";
  console.log(`PASS: ${JSON.stringify(result, null, 2)}`);
} finally {
  await daemon?.close().catch(() => undefined);
  await new Promise<void>((accept) => model.close(() => accept()));
  if (result.result === "passed" && !process.env.OPENCRAFT_STACK_DRILL_KEEP)
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  else await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2)).catch(() => undefined);
}
