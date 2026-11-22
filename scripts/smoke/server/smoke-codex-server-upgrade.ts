// Upgrade drill for a single OpenCraft server: conversations created while the
// server runs Codex on the legacy path must still be listed, readable with
// their whole history and continuable after the server switches to the Codex
// provider bridge (its own Engine Host, --codex-bridge-programs), keep their
// IDs, and survive a rollback to the legacy path and a second upgrade.
//
// Real native Codex (runtime/codex), the server's split Core and AppServer
// (Core only reaches the local stand-in model), synthetic account, private
// data directory. The client is the Web Workbench's own App Host connection.
//
//   npm run build --workspace @opencraft/opencraft-daemon
//   node --import tsx scripts/smoke/server/smoke-codex-server-upgrade.ts [--identity employee|anonymous]
//
// --identity employee (default) runs as a signed-in person, as a deployment with
// an identity adapter does: every message carries a verified sender, which must
// be shown on the history before and after the upgrade. anonymous runs as an
// installation without sign-in.
//
// Output: .local/codex-server-upgrade/<time>/result.json
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { ActorStore } from "@opencraft/access-control/actors";
import { ServerSpacesRuntime } from "@opencraft/access-control/server-spaces";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { startFakeResponsesModel } from "../../../tests/fixtures/fake-responses-model.mjs";
import { drillCodexExecutable, prepareDrillPrograms, repositoryRoot } from "../execution/codex-bridge-drill-setup.mjs";

const identityMode = process.argv[process.argv.indexOf("--identity") + 1] === "anonymous" ? "anonymous" : "employee";
const out = join(repositoryRoot, ".local/codex-server-upgrade", new Date().toISOString().replace(/[:.]/gu, "-"));
const data = join(out, "data"),
  codexData = join(data, "codex"),
  run = join(out, "run");
await mkdir(codexData, { recursive: true, mode: 0o700 });
await mkdir(run, { recursive: true, mode: 0o700 });
const result: Record<string, unknown> = { out, identity: identityMode, phases: [] as unknown[] };
const phases = result.phases as unknown[];
const save = () => writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
const log = (line: string) => console.log(line);

const programs = await prepareDrillPrograms(join(out, "programs"));
const codex = await drillCodexExecutable();
const model = await startFakeResponsesModel();
process.env.OPENCRAFT_DRILL_UPSTREAM = model.url;
const store = new AccountPoolStore({
  databasePath: join(codexData, "account-pool.sqlite"),
  secretsDirectory: join(codexData, "secrets"),
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

const webRoot = join(out, "web");
await mkdir(webRoot);
await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Codex server upgrade drill</title>");
await writeFile(
  join(webRoot, "version.json"),
  JSON.stringify({
    schemaVersion: 1,
    buildId: "codex-server-upgrade",
    headlessServer: true,
    headlessHostId: "opencraft-server",
  }),
);
const token = randomBytes(32).toString("hex");
const tokenFile = join(run, "core.token");
await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
const sockets = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ocsu-"));
const coreEndpoint = join(sockets, "core.sock"),
  appServerEndpoint = join(sockets, "app-server.sock");
const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as import("node:net").AddressInfo;
      server.close(() => done(port));
    });
  });

/** The server's Core and AppServer, as the deployment runs them beside the gateway. */
async function startCore(): Promise<ChildProcess[]> {
  const children: ChildProcess[] = [];
  const start = (program: string, args: string[], ready: string) => {
    const child = spawn(
      process.execPath,
      ["--require", join(programs, "exit-with-parent.cjs"), join(programs, program), ...args],
      {
        cwd: run,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(child);
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (process.env.DRILL_VERBOSE) log(`[${program}] ${line}`);
    });
    return new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => reject(new Error(`${program} exited (${code})`)));
      createInterface({ input: child.stdout! }).on("line", (line) => {
        try {
          if (JSON.parse(line).type === ready) resolve();
        } catch {
          /* not a readiness line */
        }
      });
    });
  };
  const shared = [
    "--token-file",
    tokenFile,
    "--codex-executable",
    codex,
    "--runtime-directory",
    run,
    "--data-directory",
    codexData,
  ];
  await start(
    "codex-core.cjs",
    [
      "--endpoint",
      coreEndpoint,
      "--app-server-endpoint",
      appServerEndpoint,
      "--proxy-port",
      String(await freePort()),
      "--native-codex-home-directory",
      join(data, "native-codex"),
      ...shared,
    ],
    "codex-accounts-listening",
  );
  await start(
    "codex-app-server.cjs",
    ["--endpoint", appServerEndpoint, "--core-endpoint", coreEndpoint, ...shared],
    "codex-app-server-ready",
  );
  return children;
}
async function stopCore(children: ChildProcess[]) {
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    const exited = new Promise((done) => child.once("exit", done));
    child.stdin?.end();
    await exited;
  }
}

type Server = { url: string; close(): Promise<void> };
async function startServer(bridge: boolean): Promise<Server> {
  const { startHeadlessServer } = await import("../../../apps/headless-server/src/headless-server.mjs");
  return startHeadlessServer(
    {
      dataDirectory: data,
      webRoot,
      port: 0,
      codexCoreEndpoint: coreEndpoint,
      codexCoreAuthToken: token,
      codexExecutable: codex,
      runtimeDirectory: run,
      ...(bridge ? { codexBridgePrograms: programs } : {}),
      startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", async close() {} }),
    },
    identityMode === "employee" ? { createIdentity: signedInIdentity } : {},
  );
}

const verified = () => ({
  provider: "drill-directory",
  subject: "alice",
  displayName: "Alice",
  expiresAt: Date.now() + 3_600_000,
});
/** The onboarding a signed-in deployment does once: the person owns the server's spaces. */
async function onboardEmployee() {
  const storage = await openServerDatabase(data);
  try {
    const actor = new ActorStore(storage).resolveHuman(verified())!;
    const spaces = new ServerSpacesRuntime({ path: join(data, "opencraft-server.sqlite"), bootstrapInstance: true });
    await spaces.ready;
    await spaces.bootstrap(actor.actorId);
    await spaces.close();
  } finally {
    await storage.close();
  }
}

/** A deployment identity adapter that signs every connection in as one employee. */
async function signedInIdentity({ actors }: { actors: any }) {
  return {
    providers: [{ authenticate: () => verified() }],
    service: {
      admissionStatus: () => 204,
      connectionContext: () => ({
        sender: { kind: "employee", loginName: "alice" },
        validUntil: Date.now() + 3_600_000,
        actorContext: actors.resolveHuman(verified()),
      }),
      handle: async () => false,
    },
    close() {},
  };
}

/** A Workbench client of the server's local Codex Host, through the Web's own App Host connection. */
async function connectClient(server: Server) {
  (globalThis as any).window = { location: { href: server.url + "/" } };
  const { connectWebSocketAppHost } = await import("../../../apps/workbench-web/src/runtime/websocket-app-host.ts");
  const host = connectWebSocketAppHost(
    (url) => new WebSocket(url, { origin: server.url }) as unknown as globalThis.WebSocket,
    {
      retryDelaysMs: [200, 500, 1000],
      reportFailure: () => undefined,
    },
  );
  const client = new JsonRpcAppServerClient({ hostId: "local-codex", transport: host.createTransport("local-codex") });
  await client.connect({
    clientInfo: { name: "codex-server-upgrade", version: "1" },
    capabilities: { experimentalApi: true },
  } as any);
  const request = (method: string, params: unknown) =>
    (client.request(method as any, params as any) as Promise<any>).catch((error) => {
      throw new Error(
        `${method} ${JSON.stringify(params).slice(0, 160)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  return { request, close: () => (client.close(), host.close()) };
}

type Client = Awaited<ReturnType<typeof connectClient>>;
/** User texts and answers of a thread, in order. */
async function transcript(client: Client, threadId: string): Promise<string[]> {
  const read = await client.request("thread/read", { threadId, includeTurns: true });
  return (read.thread.turns ?? []).flatMap((turn: any) =>
    (turn.items ?? []).flatMap((item: any) =>
      item.type === "userMessage"
        ? [
            `user(${item.sender?.loginName ?? "-"}): ${(item.content ?? []).map((part: any) => part.text ?? "").join("")}`,
          ]
        : item.type === "agentMessage"
          ? [`agent: ${item.text}`]
          : [],
    ),
  );
}
/** Open a conversation as the Workbench does on selecting it: resume, then read. */
async function open(client: Client, threadId: string): Promise<string[]> {
  await client.request("thread/resume", { threadId });
  return transcript(client, threadId);
}
async function say(client: Client, threadId: string, text: string) {
  const before = (await transcript(client, threadId)).length;
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
  return (page.data ?? []).map((thread: any) => thread.id);
}
const check = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

let core: ChildProcess[] = [];
let server: Server | undefined;
let client: Client | undefined;
const phase = async (name: string, bridge: boolean, body: (client: Client) => Promise<Record<string, unknown>>) => {
  log(`phase: ${name} (${bridge ? "bridge" : "legacy"})`);
  core = await startCore();
  server = await startServer(bridge);
  client = await connectClient(server);
  const outcome = await body(client);
  phases.push({ name, bridge, ...outcome });
  await save();
  client.close();
  client = undefined;
  await server.close();
  server = undefined;
  await stopCore(core);
  core = [];
};

let failed = false;
try {
  if (identityMode === "employee") await onboardEmployee();
  const project = join(out, "project");
  await mkdir(project);
  const threads: Record<string, string> = {};
  const history: Record<string, string[]> = {};

  await phase("before the upgrade", false, async (c) => {
    threads.projectless = (await c.request("thread/start", { model: "gpt-test" })).thread.id;
    await say(c, threads.projectless, "LEGACY-ONE");
    threads.twoTurns = (await c.request("thread/start", { model: "gpt-test" })).thread.id;
    await say(c, threads.twoTurns, "LEGACY-TWO-A");
    await say(c, threads.twoTurns, "LEGACY-TWO-B");
    threads.project = (await c.request("thread/start", { model: "gpt-test", cwd: project })).thread.id;
    await say(c, threads.project, "LEGACY-PROJECT");
    for (const [name, id] of Object.entries(threads)) history[name] = await transcript(c, id);
    if (identityMode === "employee")
      check(
        Object.values(history)
          .flat()
          .filter((line) => line.startsWith("user"))
          .every((line) => line.startsWith("user(alice)")),
        "legacy history lost a sender",
      );
    return { threads: { ...threads }, history };
  });

  await phase("after the upgrade", true, async (c) => {
    const ids = await listed(c);
    for (const [name, id] of Object.entries(threads)) {
      check(ids.includes(id), `${name} (${id}) is missing from the list`);
      check(JSON.stringify(await open(c, id)) === JSON.stringify(history[name]), `${name} history changed`);
    }
    const continued = await say(c, threads.projectless, "AFTER-UPGRADE");
    check(continued.length === history.projectless!.length + 2, "continued history does not extend the old one");
    history.projectless = continued;
    const fresh = (await c.request("thread/start", { model: "gpt-test" })).thread.id;
    check(fresh.startsWith("bridge:codex:"), `a new conversation is not on the bridge: ${fresh}`);
    await say(c, fresh, "NEW-ON-BRIDGE");
    threads.fresh = fresh;
    history.fresh = await transcript(c, fresh);
    if (identityMode === "employee")
      check(
        [...continued, ...history.fresh]
          .filter((line) => line.startsWith("user"))
          .every((line) => line.startsWith("user(alice)")),
        `a bridge message lost its sender: ${JSON.stringify([...continued, ...history.fresh])}`,
      );
    return { listed: ids.length, continued: threads.projectless, fresh };
  });

  await phase("rolled back", false, async (c) => {
    const ids = await listed(c);
    for (const name of ["projectless", "twoTurns", "project"]) {
      const id = threads[name]!;
      check(ids.includes(id), `${name} is missing after rollback`);
      check(
        JSON.stringify(await open(c, id)) === JSON.stringify(history[name]),
        `${name} history changed after rollback`,
      );
    }
    history.twoTurns = await say(c, threads.twoTurns!, "DURING-ROLLBACK");
    return { listed: ids.length, bridgeConversationListed: ids.includes(threads.fresh!) };
  });

  await phase("upgraded again", true, async (c) => {
    const ids = await listed(c);
    for (const [name, id] of Object.entries(threads)) {
      check(ids.includes(id), `${name} is missing after the second upgrade`);
      check(
        JSON.stringify(await open(c, id)) === JSON.stringify(history[name]),
        `${name} history changed after the second upgrade`,
      );
    }
    await say(c, threads.twoTurns!, "AFTER-SECOND-UPGRADE");
    await say(c, threads.fresh!, "FRESH-AGAIN");
    return { listed: ids.length };
  });
  result.outcome = "PASS";
} catch (error) {
  failed = true;
  result.outcome = "FAIL";
  result.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  client?.close();
  await server?.close().catch(() => undefined);
  await stopCore(core).catch(() => undefined);
  await model.close();
  await rm(sockets, { recursive: true, force: true });
  await save();
}
console.log(JSON.stringify({ outcome: result.outcome, failure: result.failure, out }, null, 2));
process.exit(failed ? 1 : 0);
