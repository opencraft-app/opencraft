// Not applicable while the container Gateway attaches Brain's own Codex runtime through the
// workspace endpoint (docs/operations/managed-headless.md); kept for the bridge provider work.
// The 4-container deployment (deploy/docker/compose.yaml) moving Codex to the
// provider bridge: a conversation made while the Gateway runs the legacy path
// (OPENCRAFT_CODEX_BRIDGE=0) stays listed, readable and continuable after the
// Gateway is recreated on the bridge (its default), a new conversation is
// created on the bridge, the Codex Engine Host runs in the Gateway container,
// native commands stay out of Brain and Gateway, and a further Gateway restart
// keeps every conversation continuable.
//
// The image must carry the drill Core (tests/fixtures/bridge-stack-core.ts as
// runtime/codex-core.cjs) so Brain's Core only reaches the local stand-in model:
//   OPENCRAFT_IMAGE=opencraft:bridge-drill node --import tsx scripts/smoke/server/smoke-container-codex-bridge.ts
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chown, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { prepareLayout } from "../../container-deployment/layout.mjs";
import { startFakeResponsesModel } from "../../../tests/fixtures/fake-responses-model.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const image = process.env.OPENCRAFT_IMAGE ?? "opencraft:bridge-drill";
const name = `opencraft-bridge-${randomBytes(5).toString("hex")}`;
const directory = await mkdtemp(join(tmpdir(), name));
const data = join(directory, "state"),
  workspace = join(directory, "workspaces"),
  logs = join(directory, "logs");
const uid = process.getuid!() === 0 ? 1000 : process.getuid!(),
  gid = process.getgid!() === 0 ? 1000 : process.getgid!();
const model = await startFakeResponsesModel();
const env: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCRAFT_IMAGE: image,
  OPENCRAFT_DATA_DIR: data,
  OPENCRAFT_HOST_DATA_DIR: data,
  OPENCRAFT_HOST_WORKSPACE_DIR: workspace,
  OPENCRAFT_HOST_LOG_DIR: logs,
  OPENCRAFT_LOG_DIR: "/var/log/opencraft",
  OPENCRAFT_HOST_EXECUTION_DIR: join(data, "execution"),
  OPENCRAFT_EXECUTION_DIR: join(data, "execution"),
  OPENCRAFT_BROWSER_DATA_DIR: join(data, "execution", "browser"),
  OPENCRAFT_CODEX_PROJECTLESS_DIR: join(workspace, "sessions", "codex"),
  OPENCRAFT_DSH_PROJECTLESS_DIR: join(workspace, "sessions", "dsh"),
  OPENCRAFT_GATEWAY_HOME: join(data, "home", "gateway"),
  OPENCRAFT_WORKSPACE_DIR: workspace,
  OPENCRAFT_UID: String(uid),
  OPENCRAFT_GID: String(gid),
  OPENCRAFT_PLATFORM: `linux/${execFileSync("docker", ["image", "inspect", image, "--format", "{{.Architecture}}"], { encoding: "utf8" }).trim()}`,
  OPENCRAFT_DRILL_UPSTREAM: model.url,
};
// Brain's drill Core reads the stand-in model; the Gateway chooses its Codex path.
const override = join(directory, "compose.drill.yaml");
await writeFile(
  override,
  [
    "services:",
    "  brain:",
    "    environment:",
    "      OPENCRAFT_DRILL_UPSTREAM: ${OPENCRAFT_DRILL_UPSTREAM}",
    "  gateway:",
    "    environment:",
    "      OPENCRAFT_CODEX_BRIDGE: ${OPENCRAFT_CODEX_BRIDGE:-1}",
    "",
  ].join("\n"),
);
const docker = (args: string[]) =>
  (
    execFileSync("docker", args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 600_000,
      stdio: ["ignore", "pipe", "pipe"],
    }) ?? ""
  ).trim();
const compose = (args: string[]) =>
  docker([
    "compose",
    "--env-file",
    "/dev/null",
    "-f",
    join(root, "deploy/docker/compose.yaml"),
    "-f",
    override,
    "-p",
    name,
    ...args,
  ]);
const processes = (service: string) => docker(["top", compose(["ps", "-q", service]), "-eo", "pid,args"]);
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

async function freePort() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const listener = createServer();
    const bound = await new Promise<boolean>((done) => {
      listener.once("error", () => done(false));
      listener.listen(port, "127.0.0.1", () => done(true));
    });
    if (bound) {
      await new Promise((done) => listener.close(done));
      return port;
    }
  }
  throw new Error("no free port below the ephemeral range");
}
async function ready(origin: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(12_000) });
      const body: any = await response.json();
      if (response.status === 200 && body.ok && body.hosts?.["local-codex"]?.state === "ready") return body;
    } catch {
      /* not yet */
    }
    await delay(500);
  }
  throw new Error("the deployment did not become ready");
}
async function client(origin: string) {
  (globalThis as any).window = { location: { href: origin + "/" } };
  const { connectWebSocketAppHost } = await import("../../../apps/workbench-web/src/runtime/websocket-app-host.ts");
  const host = connectWebSocketAppHost((url) => new WebSocket(url, { origin }) as unknown as globalThis.WebSocket, {
    retryDelaysMs: [200, 500, 1000],
    reportFailure: () => undefined,
  });
  const rpc = new JsonRpcAppServerClient({ hostId: "local-codex", transport: host.createTransport("local-codex") });
  await rpc.connect({
    clientInfo: { name: "container-bridge-drill", version: "1" },
    capabilities: { experimentalApi: true },
  } as any);
  const request = (method: string, params: unknown) =>
    (rpc.request(method as any, params as any) as Promise<any>).catch((error) => {
      throw new Error(`${method}: ${error instanceof Error ? error.message : String(error)}`);
    });
  const transcript = async (threadId: string) =>
    ((await request("thread/read", { threadId, includeTurns: true })).thread.turns ?? []).flatMap((turn: any) =>
      (turn.items ?? []).flatMap((item: any) =>
        item.type === "userMessage"
          ? [`user: ${(item.content ?? []).map((part: any) => part.text ?? "").join("")}`]
          : item.type === "agentMessage"
            ? [`agent: ${item.text}`]
            : [],
      ),
    ) as string[];
  const say = async (threadId: string, text: string) => {
    await request("turn/start", {
      threadId,
      clientUserMessageId: `drill-${randomBytes(6).toString("hex")}`,
      input: [{ type: "text", text, text_elements: [] }],
    });
    for (let attempt = 0; attempt < 240; attempt++) {
      const lines = await transcript(threadId).catch(() => [] as string[]);
      if (lines.at(-1) === `agent: echo: ${text}`) return lines;
      await delay(500);
    }
    throw new Error(`${threadId} did not answer "${text}"`);
  };
  return { request, transcript, say, close: () => (rpc.close(), host.close()) };
}

const result: Record<string, unknown> = { image };
let passed = false;
try {
  const layout = await prepareLayout(env, { uid: process.getuid!(), gid: process.getgid!() });
  // A synthetic account for Brain's Core, in the Codex data directory it opens.
  await mkdir(join(data, "codex"), { recursive: true, mode: 0o700 });
  const store = new AccountPoolStore({
    databasePath: join(data, "codex", "account-pool.sqlite"),
    secretsDirectory: join(data, "codex", "secrets"),
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
  if (process.getuid!() === 0) {
    for (const path of [
      directory,
      layout.state,
      layout.execution,
      layout.gitCredentials,
      layout.workspace,
      layout.logs,
      ...["brain", "gateway", "hands"].map((service) => join(logs, service)),
    ])
      await chown(path, uid, gid).catch(() => undefined);
    // The seeded account (store and secrets) belongs to the containers' user.
    execFileSync("chown", ["-R", `${uid}:${gid}`, join(data, "codex")]);
  }
  env.OPENCRAFT_PORT = String(await freePort());
  const origin = `http://127.0.0.1:${env.OPENCRAFT_PORT}`;

  // Legacy path.
  env.OPENCRAFT_CODEX_BRIDGE = "0";
  compose(["up", "-d", "--no-build", "--wait"]);
  await ready(origin);
  let c = await client(origin);
  const legacy = (await c.request("thread/start", { model: "gpt-test" })).thread.id as string;
  const before = await c.say(legacy, "CONTAINER-LEGACY");
  c.close();
  check(
    !processes("gateway").includes("codex-bridge/engine-host.mjs"),
    "the legacy Gateway started a Codex Engine Host",
  );
  result.legacy = { thread: legacy, history: before };

  // The Gateway recreated on the bridge (its default).
  env.OPENCRAFT_CODEX_BRIDGE = "1";
  compose(["up", "-d", "--no-deps", "--force-recreate", "gateway"]);
  await ready(origin);
  check(
    processes("gateway").includes("codex-bridge/engine-host.mjs"),
    "the Gateway did not start its Codex Engine Host",
  );
  c = await client(origin);
  const listed = ((await c.request("thread/list", { limit: 50 })).data ?? []).map((thread: any) => thread.id);
  check(listed.includes(legacy), "the legacy conversation is missing after the upgrade");
  await c.request("thread/resume", { threadId: legacy });
  check(
    JSON.stringify(await c.transcript(legacy)) === JSON.stringify(before),
    "the legacy conversation's history changed",
  );
  const continued = await c.say(legacy, "CONTAINER-AFTER-UPGRADE");
  const fresh = (await c.request("thread/start", { model: "gpt-test" })).thread.id as string;
  check(fresh.startsWith("bridge:codex:"), `a new conversation is not on the bridge: ${fresh}`);
  await c.say(fresh, "CONTAINER-NEW-ON-BRIDGE");
  c.close();
  for (const service of ["brain", "gateway"])
    check(
      !/exec-server --listen stdio/u.test(
        processes(service)
          .split("\n")
          .filter((line) => !line.includes("sandbox-command.mjs"))
          .join("\n"),
      ),
      `${service} runs native Codex commands itself`,
    );
  result.upgraded = { continued: continued.slice(-2), fresh };

  // Another Gateway restart: the Engine Host comes back and every conversation continues.
  compose(["up", "-d", "--no-deps", "--force-recreate", "gateway"]);
  await ready(origin);
  c = await client(origin);
  await c.request("thread/resume", { threadId: legacy });
  await c.say(legacy, "CONTAINER-AFTER-RESTART");
  await c.request("thread/resume", { threadId: fresh });
  await c.say(fresh, "CONTAINER-FRESH-AFTER-RESTART");
  c.close();
  result.outcome = "PASS";
  passed = true;
} catch (error) {
  result.outcome = "FAIL";
  result.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    result.logs = compose(["logs", "--tail=60"]).slice(-8000);
  } catch {
    /* no logs */
  }
} finally {
  if (!(passed && process.env.OPENCRAFT_CONTAINER_SMOKE_KEEP === "1")) {
    try {
      compose(["down", "--remove-orphans"]);
    } catch {
      /* already down */
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  await model.close();
}
console.log(JSON.stringify(result, null, 2));
process.exit(passed ? 0 : 1);
