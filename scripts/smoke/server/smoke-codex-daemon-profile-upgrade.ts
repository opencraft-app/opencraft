// Upgrade drill for a managed execution unit on the daemon profile
// (scripts/server-deployment/gateway.mjs: gateway, OpenCraft daemon and a
// standalone Codex Core). A conversation created while Codex runs on the local
// Host path must still be listed, readable and continuable once the release's
// Engine Host is present (Codex through the provider bridge by default), new
// conversations must be created on the bridge, and both must survive a rollback
// (OPENCRAFT_CODEX_BRIDGE=0) and a second upgrade.
//
// The gateway and daemon are bundled as the release bundles them, into a release
// tree under .local, with the release's codex-bridge programs. Real native Codex
// (runtime/codex), the drill Core (only reaches the local stand-in model),
// synthetic account, private state directory.
//   npm run build --workspace @opencraft/opencraft-daemon
//   node --import tsx scripts/smoke/server/smoke-codex-daemon-profile-upgrade.ts
// Output: .local/codex-daemon-profile-upgrade/<time>/result.json
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import WebSocket from "ws";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { startFakeResponsesModel } from "../../../tests/fixtures/fake-responses-model.mjs";
import { buildCodexBridgeRuntime, executionModuleOptions } from "../../packaging/package-web-server.mjs";
import { drillCodexExecutable, prepareDrillPrograms, repositoryRoot } from "../execution/codex-bridge-drill-setup.mjs";

const out = join(
  repositoryRoot,
  ".local/codex-daemon-profile-upgrade",
  new Date().toISOString().replace(/[:.]/gu, "-"),
);
const release = join(out, "release"),
  state = join(out, "state"),
  cwd = join(out, "cwd"),
  sockets = join(out, "s");
for (const directory of [join(release, "execution"), join(state, "codex"), cwd, sockets])
  await mkdir(directory, { recursive: true, mode: 0o700 });
const result: Record<string, unknown> = { out, phases: [] as unknown[] };
const phases = result.phases as unknown[];
const save = () => writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
const log = (line: string) => console.log(line);

// The release tree: gateway and daemon bundled as packaging bundles them; node-pty and ssh2
// resolve from the repository's node_modules (the tree lives under it).
log("bundling the release");
for (const [entry, target, format] of [
  ["scripts/server-deployment/gateway.mjs", "gateway.mjs", "esm"],
  ["apps/opencraft-daemon/src/bin.ts", "daemon.cjs", "cjs"],
  // The workers packaging places beside them (scripts/packaging/package-web-server.mjs).
  ...([
    "apps/local-agent-host/src/dsh-session-routing.worker.ts:dsh-session-routing-worker.mjs",
    "apps/opencraft-daemon/src/token-usage-query-worker.ts:token-usage-query-worker.mjs",
    "packages/access-control/src/orchestration-runtime.worker.ts:orchestration-runtime-worker.mjs",
    "packages/native-history-node/src/transcript-cache-storage.worker.ts:transcript-cache-storage-worker.mjs",
    "apps/agent-bridge-host/src/storage.worker.ts:storage.worker.mjs",
  ].map((pair) => [...pair.split(":"), "esm"]) as [string, string, "esm"][]),
] as const)
  await build({
    entryPoints: [join(repositoryRoot, entry)],
    outfile: join(release, "execution", target),
    bundle: true,
    platform: "node",
    format,
    target: "node22",
    define: executionModuleOptions(format).define,
    banner: executionModuleOptions(format).banner,
    external: ["bufferutil", "utf-8-validate", "cpu-features", "*.node", "node-pty", "ssh2", "@earendil-works/*"],
    logLevel: "error",
  });
await writeFile(
  join(release, "package.json"),
  JSON.stringify({ version: "0.0.0-drill", opencraftWeb: { buildId: "drill" } }),
);
const bridgePrograms = join(release, "execution/codex-bridge");
const installBridge = () => buildCodexBridgeRuntime(bridgePrograms, { nodePty: "node-pty" });

const programs = await prepareDrillPrograms(join(out, "programs"));
const codex = await drillCodexExecutable();
const model = await startFakeResponsesModel();
process.env.OPENCRAFT_DRILL_UPSTREAM = model.url;
const coreEndpoint = join(sockets, "core.sock"),
  appServerEndpoint = join(sockets, "app.sock"),
  tokenFile = join(state, "daemon.token");
await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
await mkdir(join(state, "codex", "runtime"), { recursive: true });
await writeFile(join(state, "codex", "runtime", "config.toml"), 'model = "gpt-test"\n');
const store = new AccountPoolStore({
  databasePath: join(state, "codex", "account-pool.sqlite"),
  secretsDirectory: join(state, "codex", "secrets"),
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
const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as import("node:net").AddressInfo;
      server.close(() => done(port));
    });
  });

function started(child: ChildProcess, name: string, ready: (line: string) => boolean) {
  createInterface({ input: child.stderr! }).on("line", (line) => {
    if (process.env.DRILL_VERBOSE) log(`[${name}] ${line}`);
  });
  return new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`${name} exited (${code})`)));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (process.env.DRILL_VERBOSE) log(`[${name}] ${line}`);
      if (ready(line)) resolve();
    });
  });
}
/** The standalone Core and AppServer, kept running across gateway restarts as in production. */
async function startCore(): Promise<ChildProcess[]> {
  const children: ChildProcess[] = [];
  const shared = [
    "--token-file",
    tokenFile,
    "--codex-executable",
    codex,
    "--runtime-directory",
    cwd,
    "--data-directory",
    join(state, "codex"),
  ];
  for (const [program, args, ready] of [
    [
      "codex-core.cjs",
      [
        "--endpoint",
        coreEndpoint,
        "--app-server-endpoint",
        appServerEndpoint,
        "--proxy-port",
        String(await freePort()),
        "--native-codex-home-directory",
        join(state, "native-codex"),
        ...shared,
      ],
      "codex-accounts-listening",
    ],
    [
      "codex-app-server.cjs",
      ["--endpoint", appServerEndpoint, "--core-endpoint", coreEndpoint, ...shared],
      "codex-app-server-ready",
    ],
  ] as const) {
    const child = spawn(
      process.execPath,
      ["--require", join(programs, "exit-with-parent.cjs"), join(programs, program), ...args],
      {
        cwd,
        env: { ...process.env, NODE_OPTIONS: "" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(child);
    await started(child, program, (line) => {
      try {
        return JSON.parse(line).type === ready;
      } catch {
        return false;
      }
    });
  }
  return children;
}

type Gateway = { url: string; child: ChildProcess };
async function startGateway(bridge: boolean): Promise<Gateway> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(release, "execution/gateway.mjs")], {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      OPENCRAFT_EXECUTION_CWD: cwd,
      OPENCRAFT_EXECUTION_STATE: state,
      OPENCRAFT_CODEX_CORE_ENDPOINT: coreEndpoint,
      OPENCRAFT_GATEWAY_PORT: String(port),
      OPENCRAFT_DSH_EXECUTABLE: "/nonexistent-dsh",
      OPENCRAFT_CODEX_BRIDGE: bridge ? "" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `ws://127.0.0.1:${port}/rpc/codex`;
  child.stdout!.on("data", () => undefined);
  createInterface({ input: child.stderr! }).on("line", (line) => {
    if (process.env.DRILL_VERBOSE) log(`[gateway] ${line}`);
  });
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`gateway exited (${child.exitCode})`);
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return { url, child };
    await delay(500);
  }
  throw new Error("gateway did not become healthy");
}
async function stopGateway(gateway: Gateway) {
  if (gateway.child.exitCode !== null) return;
  const exited = new Promise((done) => gateway.child.once("exit", done));
  gateway.child.kill("SIGTERM");
  await exited;
}

/** A JSON-RPC client of the gateway's local-codex Host, as the Web connects. */
async function connect(gateway: Gateway) {
  const socket = new WebSocket(gateway.url);
  await new Promise((resolve, reject) => (socket.once("open", resolve), socket.once("error", reject)));
  let next = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.id !== undefined && frame.method === undefined && pending.has(frame.id)) {
      const waiter = pending.get(frame.id)!;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error).slice(0, 400)));
      else waiter.resolve(frame.result);
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject: (error) => reject(new Error(`${method}: ${error.message}`)) });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await request("initialize", {
    clientInfo: { name: "daemon-profile-upgrade", version: "1" },
    capabilities: { experimentalApi: true },
  });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  return { request, close: () => socket.close() };
}
type Client = Awaited<ReturnType<typeof connect>>;
async function transcript(client: Client, threadId: string): Promise<string[]> {
  const read = await client.request("thread/read", { threadId, includeTurns: true });
  return (read.thread.turns ?? []).flatMap((turn: any) =>
    (turn.items ?? []).flatMap((item: any) =>
      item.type === "userMessage"
        ? [`user: ${(item.content ?? []).map((part: any) => part.text ?? "").join("")}`]
        : item.type === "agentMessage"
          ? [`agent: ${item.text}`]
          : [],
    ),
  );
}
async function open(client: Client, threadId: string) {
  await client.request("thread/resume", { threadId });
  return transcript(client, threadId);
}
async function say(client: Client, threadId: string, text: string) {
  // A conversation without a first message has no turns native Codex can list yet.
  const before = (await transcript(client, threadId).catch(() => [] as string[])).length;
  await client.request("turn/start", {
    threadId,
    clientUserMessageId: `drill-${randomBytes(6).toString("hex")}`,
    input: [{ type: "text", text, text_elements: [] }],
  });
  for (let attempt = 0; attempt < 240; attempt++) {
    const lines = await transcript(client, threadId).catch(() => [] as string[]);
    if (lines.length >= before + 2 && lines.at(-1) === `agent: echo: ${text}`) return lines;
    await delay(500);
  }
  throw new Error(`${threadId} did not answer "${text}"`);
}
async function listed(client: Client): Promise<string[]> {
  const page = await client.request("thread/list", { limit: 50 });
  return page.data.map((thread: any) => thread.id);
}
const expect = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

let core: ChildProcess[] = [];
let gateway: Gateway | undefined;
const phase = async (name: string, bridge: boolean, body: (client: Client) => Promise<Record<string, unknown>>) => {
  log(`phase: ${name} (${bridge ? "bridge" : "local Host"})`);
  gateway = await startGateway(bridge);
  const client = await connect(gateway);
  try {
    phases.push({ name, bridge, ...(await body(client)) });
  } finally {
    client.close();
    await stopGateway(gateway);
    gateway = undefined;
  }
  await save();
};
try {
  core = await startCore();
  let legacy = "",
    fresh = "";
  // Before the upgrade: a release without Engine Host programs.
  await phase("before the upgrade", false, async (c) => {
    legacy = (await c.request("thread/start", { model: "gpt-test", cwd })).thread.id;
    const history = await say(c, legacy, "DAEMON-LEGACY");
    return { legacy, history };
  });
  await installBridge();
  await phase("after the upgrade", true, async (c) => {
    expect((await listed(c)).includes(legacy), "the legacy conversation is not listed");
    const opened = await open(c, legacy);
    expect(opened.join("|") === "user: DAEMON-LEGACY|agent: echo: DAEMON-LEGACY", `legacy history changed: ${opened}`);
    const continued = await say(c, legacy, "DAEMON-AFTER-UPGRADE");
    fresh = (await c.request("thread/start", { model: "gpt-test", cwd })).thread.id;
    expect(fresh.startsWith("bridge:codex:"), `a new conversation was not created on the bridge: ${fresh}`);
    const freshHistory = await say(c, fresh, "DAEMON-NEW-ON-BRIDGE");
    expect((await listed(c)).includes(fresh), "the new bridge conversation is not listed");
    return { continued, fresh, freshHistory };
  });
  await phase("rolled back", false, async (c) => {
    expect((await listed(c)).includes(legacy), "the legacy conversation is not listed after rollback");
    await open(c, legacy);
    const continued = await say(c, legacy, "DAEMON-ROLLED-BACK");
    return { continued };
  });
  await phase("upgraded again", true, async (c) => {
    await open(c, legacy);
    await open(c, fresh);
    const legacyHistory = await say(c, legacy, "DAEMON-AGAIN");
    const freshHistory = await say(c, fresh, "DAEMON-BRIDGE-AGAIN");
    return { legacyHistory, freshHistory };
  });
  result.outcome = "PASS";
} catch (error) {
  result.outcome = "FAIL";
  result.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  if (gateway) await stopGateway(gateway).catch(() => undefined);
  for (const child of core.reverse()) child.stdin?.end();
  await model.close();
  await save();
  log(JSON.stringify({ outcome: result.outcome, failure: result.failure, phases }, null, 2));
  process.exit(result.outcome === "PASS" ? 0 : 1);
}
