// Windows drill of the desktop Codex bridge stack: the stack as the daemon
// starts it (split Core and AppServer on named pipes, native Codex on a
// token-guarded loopback WebSocket, the Engine Host with the host-process
// backend), the Host chain on top, and one conversation answered by a local
// stand-in model. Synthetic account only. The same drill runs on Linux and
// macOS over Unix sockets.
//
// Run it through scripts/smoke/execution/run-codex-bridge-stack-drill.mjs,
// which builds the bundle, the programs directory (the daemon's codex-bridge
// bundle with the Core replaced by tests/fixtures/bridge-stack-core.ts) and the
// pinned native Codex, then starts it on Electron's own Node:
//   drill.mjs <programs-dir> <codex-executable> <state-root> <result-file> [upstream-url]
// Without an upstream URL the drill starts tests/fixtures/fake-responses-model.mjs itself.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AccountPoolStore, CodexCoreControlClient, openCodexNativeSocket } from "@opencraft/account-pool-host";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { startCodexBridgeStack } from "../../../apps/opencraft-daemon/src/codex-bridge-stack.js";
import { createCodexBridgeHost } from "../../../apps/opencraft-daemon/src/codex-bridge-host.js";
import { startFakeResponsesModel } from "../../../tests/fixtures/fake-responses-model.mjs";

const [programs, codexExecutable, root, resultFile, explicitUpstream] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string | undefined,
];
const localModel = explicitUpstream ? undefined : await startFakeResponsesModel();
const upstream = explicitUpstream ?? localModel!.url;
const steps: string[] = [];
const report = async (result: string, error?: unknown) => {
  steps.push(`${result}${error ? `: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` : ""}`);
  await writeFile(resultFile, steps.join("\n") + "\n");
};
const log = (line: string) => void steps.push(line);

process.env.OPENCRAFT_DRILL_UPSTREAM = upstream;
const codexDataDirectory = join(root, "codex"),
  runtimeDirectory = join(root, "runtime");
const authToken = "windows-stack-drill-token-".repeat(3);
/** Each native thread's full read, straight from native Codex through Core, with native's own errors. */
async function nativeReads(coreEndpoint: string, token: string): Promise<string> {
  try {
    const { nativeSocket } = await new CodexCoreControlClient(coreEndpoint, token).health();
    const socket = openCodexNativeSocket(nativeSocket, { handshakeTimeout: 5000 });
    await new Promise((resolve, reject) => (socket.once("open", resolve), socket.once("error", reject)));
    let next = 0;
    const call = (method: string, params: unknown) =>
      new Promise<any>((resolve) => {
        const id = ++next;
        const timer = setTimeout(() => resolve({ error: "no answer" }), 10_000);
        socket.on("message", function listen(data) {
          const frame = JSON.parse(String(data));
          if (frame.id !== id) return;
          socket.off("message", listen);
          clearTimeout(timer);
          resolve(frame);
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    await call("initialize", {
      clientInfo: { name: "drill-probe", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    const listed = await call("thread/list", { limit: 5 });
    const ids: string[] = (listed.result?.data ?? []).map((thread: any) => thread.id);
    const reads = [];
    for (const id of ids) {
      const read = await call("thread/read", { threadId: id, includeTurns: true });
      reads.push({ id, error: read.error, turns: read.result?.thread?.turns?.length });
    }
    socket.close();
    return JSON.stringify({ list: listed.error ?? ids.length, reads }).slice(0, 1500);
  } catch (error) {
    return `probe failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

let stack: Awaited<ReturnType<typeof startCodexBridgeStack>> | undefined;
let host: ReturnType<typeof createCodexBridgeHost> | undefined;
try {
  await mkdir(join(codexDataDirectory, "runtime"), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  // The stand-in model has one model; native Codex uses it by default.
  await writeFile(join(codexDataDirectory, "runtime", "config.toml"), 'model = "gpt-test"\n');
  const store = new AccountPoolStore({
    databasePath: join(codexDataDirectory, "account-pool.sqlite"),
    secretsDirectory: join(codexDataDirectory, "secrets"),
  });
  if (!store.listAccounts().length)
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
  log("seeded");

  stack = await startCodexBridgeStack({
    programs,
    node: process.execPath,
    codexExecutable,
    codexDataDirectory,
    nativeCodexHomeDirectory: join(root, "native-home"),
    runtimeDirectory,
    stateDirectory: join(root, "state"),
    authToken,
    startupTimeoutMs: 120_000,
    log: (line) => log(`child: ${line}`),
  });
  log(`stack up: core=${stack.coreEndpoint} host=${stack.bridge.url}`);

  host = createCodexBridgeHost({
    coreEndpoint: stack.coreEndpoint,
    coreAuthToken: authToken,
    bridge: stack.bridge,
    codexDataDirectory,
  });
  const frames: Record<string, any>[] = [];
  host.subscribeMessage((raw) => frames.push(JSON.parse(raw)));
  await host.connect();
  let sequence = 0;
  const request = async (method: string, params: unknown) => {
    const id = `drill-${++sequence}`;
    await host!.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "drill" }));
    for (let attempt = 0; attempt < 1200; attempt++) {
      const frame = frames.find((candidate) => candidate.id === id);
      if (frame) {
        if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
        return frame.result;
      }
      await delay(50);
    }
    throw new Error(`${method}: no answer`);
  };
  const init = await request("initialize", {
    clientInfo: { name: "drill", version: "1" },
    capabilities: { experimentalApi: true },
  });
  log(`initialized: ${String(init.userAgent).slice(0, 80)}`);
  const started = await request("thread/start", { model: "gpt-test" });
  const threadId = started.thread.id as string;
  log(`thread: ${threadId} cwd=${started.cwd ?? started.thread.cwd ?? ""}`);
  await request("turn/start", {
    threadId,
    clientUserMessageId: "win-1",
    input: [{ type: "text", text: "WIN-HELLO", text_elements: [] }],
  });
  // Every refused read is recorded with what native Codex itself answers to the same
  // read (the bridge reports only the outcome kind); polling goes on, so a transient
  // refusal is told apart from a lasting one. Any refusal still fails the drill.
  let refusals = 0;
  for (let attempt = 0; ; attempt++) {
    let read: any;
    try {
      read = await request("thread/read", { threadId, includeTurns: true });
    } catch (error) {
      refusals++;
      log(`thread/read refused (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`);
      if (refusals <= 3) log(`native: ${await nativeReads(stack.coreEndpoint, authToken)}`);
      if (attempt > 240) throw error;
      await delay(500);
      continue;
    }
    const last = read.thread.turns?.at(-1);
    const reply = last?.items?.find((item: any) => item.type === "agentMessage")?.text;
    if (last?.status === "completed" && reply) {
      log(`reply: ${reply}`);
      log(`native after the answer: ${await nativeReads(stack.coreEndpoint, authToken)}`);
      if (refusals) throw new Error(`answered, but ${refusals} thread reads were refused first`);
      break;
    }
    if (attempt > 240) throw new Error(`no completed answer: ${JSON.stringify(last)?.slice(0, 400)}`);
    await delay(500);
  }
  await delay(5000);
  const health = await fetch(new URL("/health", stack.bridge.url), {
    headers: { authorization: `Bearer ${stack.bridge.token}` },
  }).then(
    async (response) => `${response.status} ${(await response.text()).slice(0, 120)}`,
    (error) => `unreachable ${error.message}`,
  );
  log(`engine host before close: ${health}`);
  if (process.env.DRILL_SKIP_HOST_CLOSE !== "1") {
    log("closing the Host chain");
    await host.close().catch((error) => log(`host close failed: ${error.message}`));
    host = undefined;
    await delay(3000);
    const after = await fetch(new URL("/health", stack.bridge.url), {
      headers: { authorization: `Bearer ${stack.bridge.token}` },
    }).then(
      (response) => `${response.status}`,
      (error) => `unreachable ${error.message}`,
    );
    log(`engine host after Host chain closed: ${after}`);
  }
  log("closing the stack");
  await stack.close();
  stack = undefined;
  await localModel?.close();
  await report("PASS");
  process.exit(0);
} catch (error) {
  await host?.close().catch(() => undefined);
  await stack?.close().catch(() => undefined);
  await localModel?.close();
  await report("FAIL", error);
  process.exit(1);
}
