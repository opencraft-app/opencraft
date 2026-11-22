// Prepares an isolated desktop profile for bridge UI verification: a synthetic
// account and one conversation made by the legacy local Codex Host, in the
// directories the desktop uses for --user-data-dir=PROFILE. Local model only.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

const [profile, upstream, executable, nativeHome] = process.argv.slice(2) as [string, string, string, string];
if (!profile || !upstream?.startsWith("http://127.0.0.1:") || !executable || !nativeHome)
  throw new Error("Usage: PROFILE UPSTREAM CODEX NATIVE_HOME");
const codex = join(profile, "codex");
await mkdir(join(codex, "runtime"), { recursive: true, mode: 0o700 });
await mkdir(join(profile, "runtime"), { recursive: true, mode: 0o700 });
// Native Codex has no model catalog from the stand-in; give it a default model.
await writeFile(join(codex, "runtime", "config.toml"), 'model = "gpt-test"\n');
const store = new AccountPoolStore({
  databasePath: join(codex, "account-pool.sqlite"),
  secretsDirectory: join(codex, "secrets"),
});
if (!store.listAccounts().some((a: { id: string }) => a.id === "synthetic"))
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

const token = "seed-legacy-codex-profile-token-".repeat(2);
const endpoint = join(profile, "seed-daemon.sock");
const local = (input: string | URL | Request, init?: RequestInit) => {
  const raw = input instanceof Request ? input.url : String(input);
  const target = raw.includes("/wham/usage") ? `${upstream}/usage` : raw;
  if (new URL(target).hostname !== "127.0.0.1") throw new Error("Non-local request");
  return fetch(target, init);
};
const daemon = await startOpenCraftDaemon({
  endpoint,
  runtimeDirectory: join(profile, "runtime"),
  authToken: token,
  dataDirectory: join(profile, "dsh"),
  dshExecutable: "/missing-engine",
  codexExecutable: executable,
  codexDataDirectory: codex,
  nativeCodexHomeDirectory: nativeHome,
  createCodexTransport: (configuration) =>
    new CodexEngineAdapter({ ...configuration, upstreamBaseUrl: upstream, fetch: local }),
});
try {
  const socket = connect(endpoint),
    channel = new DaemonJsonLineChannel(socket);
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
        connectionId: "seed",
        role: "app-host",
      }),
    );
  });
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  channel.subscribeMessage((value) => {
    const message = value as DaemonServerMessage;
    if (message.type === "app-host/message")
      for (const listener of listeners) listener({ data: message.payload } as MessageEvent<unknown>);
  });
  const appHost = new MessagePortAppHostClient(
    {
      postMessage: (m) => channel.send({ type: "app-host/message", payload: m }),
      addEventListener: (_t, l) => void listeners.add(l),
      removeEventListener: (_t, l) => void listeners.delete(l),
      start() {},
      close() {
        channel.close();
      },
    },
    "seed",
  );
  await appHost.waitUntilReady();
  const transport = appHost.createTransport("local-codex");
  const client = new JsonRpcAppServerClient({ hostId: "local-codex", transport });
  await transport.connect();
  await client.connect({ clientInfo: { name: "seed", version: "1" }, capabilities: { experimentalApi: true } } as any);
  const started: any = await client.request("thread/start" as any, { cwd: join(profile, "runtime") } as any);
  const threadId = started.thread.id as string;
  await client.request("thread/name/set" as any, { threadId, name: "Legacy conversation" } as any);
  await client.request(
    "turn/start" as any,
    {
      threadId,
      clientUserMessageId: "seed-1",
      input: [{ type: "text", text: "LEGACY-SEED", text_elements: [] }],
    } as any,
  );
  for (let attempt = 0; ; attempt++) {
    const read: any = await client.request("thread/read" as any, { threadId, includeTurns: true } as any);
    const last = read.thread.turns?.at(-1);
    if (last?.status === "completed" && last.items?.some((item: any) => item.type === "agentMessage")) break;
    assert.ok(attempt < 240, "legacy seed turn did not complete");
    await delay(250);
  }
  await client.close();
  appHost.close();
  console.log(JSON.stringify({ threadId }));
} finally {
  await daemon.close();
}
