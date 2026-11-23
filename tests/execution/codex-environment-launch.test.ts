import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { MembershipStore } from "@opencraft/access-control";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { OpenCraftHostStateDatabase } from "@opencraft/opencraft-daemon/opencraft-host-state-database";
import { ExecutionLeaseStore, snapshotExecutionSubmission } from "@opencraft/opencraft-daemon/execution-lease-store";
import { observeNativeExecutionProcess } from "@opencraft/opencraft-daemon/native-execution-origin";
import { EnvironmentLaunchIssuer } from "@opencraft/execution-environment/environment-delivery";
import type { EnvironmentLaunchLocator } from "@opencraft/execution-environment/environment-launch-receiver";
import { openExecutionAdmission } from "@opencraft/execution-environment/execution-admission";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { AccountEnvironment } from "@opencraft/execution-environment/account-environment";
import { ExecutionEnvironmentRuntime, environmentProjectId } from "@opencraft/execution-environment";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { openHeadlessAssetsStorage } from "../../apps/headless-server/src/headless-assets-storage.js";
import { openAssetConfigurations } from "@opencraft/plugin-assets/server";
import {
  codexExecutionGit,
  coreCodexEnvironmentLaunch,
} from "../../apps/headless-server/src/codex-environment-launch.ts";
import { validateHeadlessIdentity } from "../../apps/headless-server/src/headless-identity.mjs";
import { buildGitIdentityRuntime } from "../../scripts/packaging/package-git-identity-runtime.mjs";
import type { GitExecutionLocator } from "@opencraft/execution-environment/git-execution";
import { environmentCreationReservationMethods } from "../../packages/storage-node/src/server/environment-creation-reservations.js";
import { createCodexEnvironmentLaunch } from "../../apps/codex-core/src/environment-launch.js";
import { startOrchestrationCallbackRelay } from "../../apps/codex-core/src/orchestration-callback-lane.js";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { startControlServer } from "../../apps/codex-core/src/control-server.js";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const identityVaultWorker = new URL("../fixtures/identity-vault-execution.worker.ts", import.meta.url);
const admissionWorker = fileURLToPath(
  new URL("../../apps/headless-server/src/execution-admission.worker.ts", import.meta.url),
);
const INSTANCE = "server:fixture:codex";
const SECRET = "synthetic-codex-delivered-value";
const PROJECT_VALUE = "synthetic-codex-project-value";
const POLICY = "shell_environment_policy.set";
const unavailable = { code: -32084, message: "Execution environment unavailable", data: { notSubmitted: true } };

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("Timed out");
    await delay(5);
  }
}

/** Real Server owner (Actors and creation reservations), the Codex lease store
 * the Gateway writes, and the vault seeded with values for the Human Actor. */
async function durable(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codex-env-")),
    directory = join(root, "data");
  const storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    accounts = new HumanAccounts(storage, actors),
    members = new MembershipStore(storage);
  accounts.registerLocalAccounts(new LocalAccountServerPlugin(accounts.localAccountRepository));
  const management = new HumanAccountManagement(storage, accounts, actors, members);
  const principal = await management.initialize({
    mode: "web",
    username: "owner",
    password: "Only-synthetic-test-password-42",
  });
  const login = accounts.issue(principal);
  const codex = new OpenCraftHostStateDatabase(join(directory, "codex")),
    leases = new ExecutionLeaseStore(codex.database);
  let hostStateOpen = true;
  // A test whose adapter owns the Codex lease store releases this copy first.
  const closeHostState = () => {
    if (hostStateOpen) codex.close();
    hostStateOpen = false;
  };
  const native = await observeNativeExecutionProcess(process.pid);
  const context = {
    sender: null,
    executionPrincipal: principal,
    actorContext: login.login.context,
    validUntil: principal.expiresAt,
  };
  const actorId = login.login.context.actorId,
    account = `actor:${actorId}`;
  // A Codex input is admitted and begun (pending) before its Thread is reconfigured.
  const pending = (threadId: string, inputId: string) => {
    leases.capture(threadId, inputId, snapshotExecutionSubmission(context), "accepted");
    return leases.begin(threadId, inputId, native.incarnation);
  };
  const vault = new EmployeeGitVaultStore(directory);
  try {
    const environment = new AccountEnvironment(vault);
    environment.replace(account, { projectId: null }, 0, [{ name: "SERVICE_KEY", value: SECRET, secret: true }]);
    environment.replace(account, { projectId: environmentProjectId("local-codex", "alpha") }, 0, [
      { name: "PROJECT_KEY", value: PROJECT_VALUE, secret: true },
    ]);
    new ExecutionEnvironmentRuntime(directory, vault, false, "disabled").bind("local-codex", "bound-thread", "alpha");
  } finally {
    vault.close();
  }
  const reservations = environmentCreationReservationMethods(storage.database);
  t.after(async () => {
    closeHostState();
    management.close();
    accounts.close();
    members.close();
    actors.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    directory,
    leases,
    native,
    pending,
    actors,
    actorId,
    account,
    reservations,
    context,
    storage,
    closeHostState,
    generation: login.login.context.generation,
  };
}

/** A fake native app-server behind the real Codex Core relay; the client socket
 * stands in for the execution adapter in Main and records every frame. */
async function relayFixture(
  t: test.TestContext,
  root: string,
  environment?: ReturnType<typeof createCodexEnvironmentLaunch>,
) {
  const nativePath = join(root, `native-${Math.random().toString(36).slice(2)}.sock`),
    proxy = join(root, `relay-${Math.random().toString(36).slice(2)}.sock`);
  const http = createServer(),
    wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(nativePath, resolve));
  const requests: any[] = [];
  let nativeError: unknown;
  wss.on("connection", (socket) =>
    socket.on("message", (frame) => {
      const message = JSON.parse(String(frame));
      requests.push(message);
      if (message.id === undefined) return;
      const result =
        message.method === "initialize"
          ? { userAgent: "fixture" }
          : message.method === "thread/start" || message.method === "thread/fork" || message.method === "thread/resume"
            ? { thread: { id: message.params.threadId ?? "created-thread", turns: [] } }
            : {};
      if (message.method === "fixture/fail") socket.send(JSON.stringify({ id: message.id, error: nativeError }));
      else socket.send(JSON.stringify({ id: message.id, result }));
    }),
  );
  const relay = await startOrchestrationCallbackRelay(proxy, nativePath, environment ? { environment } : {});
  const socket = new WebSocket(`ws+unix://${proxy}:/`),
    received: any[] = [],
    sent: string[] = [];
  socket.on("message", (frame) => received.push(JSON.parse(String(frame))));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(async () => {
    socket.terminate();
    await relay.close();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  let sequence = 0;
  const call = async (method: string, params: object) => {
    const id = `main-${++sequence}`,
      frame = JSON.stringify({ id, method, params });
    sent.push(frame);
    socket.send(frame);
    await until(() => received.some((m) => m.id === id));
    return received.find((m) => m.id === id);
  };
  await call("initialize", { clientInfo: { name: "adapter" }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: "initialized" }));
  return {
    requests,
    received,
    sent,
    call,
    failNative(error: unknown) {
      nativeError = error;
    },
  };
}

function receiverFor(
  f: Awaited<ReturnType<typeof durable>>,
  assets: Awaited<ReturnType<typeof openHeadlessAssetsStorage>>,
  reader: ReturnType<typeof openExecutionAdmission>,
  incarnation = async () => f.native.incarnation,
) {
  return createCodexEnvironmentLaunch({
    issuer: assets.environmentLaunch!.issuer,
    instance: INSTANCE,
    admission: (locator) => reader.admission(locator),
    incarnation,
  });
}

async function owners(t: test.TestContext, f: Awaited<ReturnType<typeof durable>>) {
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(async () => {
    await reader.close();
    await assets.close();
  });
  const port = coreCodexEnvironmentLaunch(
    assets.environmentLaunch,
    {
      call: {
        reserveEnvironmentCreation: async (record) => f.reservations.reserveEnvironmentCreation(record),
        settleEnvironmentCreation: async (hostId, operationId, outcome) =>
          f.reservations.settleEnvironmentCreation(hostId, operationId, outcome),
      },
    },
    "/fixture/codex-core.sock",
    INSTANCE,
  )!;
  return { assets, reader, port };
}

const noPlaintext = (frames: readonly unknown[]) => {
  for (const frame of frames) {
    const text = typeof frame === "string" ? frame : JSON.stringify(frame);
    assert.ok(!text.includes(SECRET) && !text.includes(PROJECT_VALUE), "no delivered value crosses Main");
  }
};

test("a creation reserved by core is opened by Codex Core and installed into native; Main relays capsules only", async (t) => {
  const f = await durable(t);
  const { assets, reader, port } = await owners(t, f);
  const environment = receiverFor(f, assets, reader);
  t.after(() => environment.close());
  const relay = await relayFixture(t, f.root, environment);

  const capability = (await relay.call("opencraft/environment/launch", {})).result;
  assert.equal(capability.purpose, "codex");
  assert.equal(capability.instance, INSTANCE);
  assert.deepEqual(capability.kinds, ["creation", "turn"]);
  const target = { purpose: "codex" as const, instance: INSTANCE, key: capability.key };

  const operationId = "creation-alpha";
  await port.reserveCreation({
    operationId,
    actorId: f.actorId,
    actorGeneration: f.generation,
    source: null,
    incarnation: f.native.incarnation,
    projectId: "alpha",
  });
  const locator: EnvironmentLaunchLocator = { kind: "creation", hostId: "local-codex", operationId };
  const reply = await port.launch(target, locator);
  const staged = (await relay.call("opencraft/environment/stage", { locator, reply })).result;
  assert.match(staged.key, /^[A-Za-z0-9_-]+$/u);
  const created = await relay.call("thread/start", {
    cwd: "/workspace",
    config: { [POLICY]: { OPENCRAFT_GIT_CAPABILITY: "git-only" } },
    __opencraftEnvironmentLaunch: { locator, key: staged.key },
  });
  assert.equal(created.result.thread.id, "created-thread");
  const start = relay.requests.find((m) => m.method === "thread/start");
  assert.equal(start.params.__opencraftEnvironmentLaunch, undefined, "the private field never reaches native");
  assert.deepEqual(start.params.config[POLICY], {
    OPENCRAFT_GIT_CAPABILITY: "git-only",
    SERVICE_KEY: SECRET,
    PROJECT_KEY: PROJECT_VALUE,
  });
  noPlaintext([reply, ...relay.sent, ...relay.received]);

  // Replay: neither the capsule nor the staged launch opens twice, and a fresh
  // capsule for the same reservation is refused by this receiver.
  assert.deepEqual((await relay.call("opencraft/environment/stage", { locator, reply })).error, unavailable);
  assert.deepEqual(
    (await relay.call("thread/start", { __opencraftEnvironmentLaunch: { locator, key: staged.key } })).error,
    unavailable,
  );
  const again = await port.launch(target, locator);
  assert.deepEqual((await relay.call("opencraft/environment/stage", { locator, reply: again })).error, unavailable);
  assert.equal(
    relay.requests.filter((m) => m.method === "thread/start").length,
    1,
    "refused launches never reach native",
  );

  // Once launched the reservation is no longer pending: nothing is sealed for it.
  await port.settleCreation(operationId, "launched");
  await assert.rejects(port.launch(target, locator));

  // Codex Core redacts what native reports; Main never held the values.
  relay.failNative({ code: -32000, message: `failed with ${SECRET} and ${PROJECT_VALUE}` });
  const failed = await relay.call("fixture/fail", {});
  assert.equal(failed.error.message, "failed with [REDACTED] and [REDACTED]");
  noPlaintext(relay.received);
});

test("a pending Codex input reloads its Thread with delivered values; a replaced lease or revoked Actor is refused", async (t) => {
  const f = await durable(t);
  const { assets, reader, port } = await owners(t, f);
  const environment = receiverFor(f, assets, reader);
  t.after(() => environment.close());
  const relay = await relayFixture(t, f.root, environment);
  const target = {
    purpose: "codex" as const,
    instance: INSTANCE,
    key: (await relay.call("opencraft/environment/launch", {})).result.key,
  };
  const stage = async (locator: EnvironmentLaunchLocator) =>
    relay.call("opencraft/environment/stage", { locator, reply: await port.launch(target, locator) });

  f.pending("bound-thread", "input-1");
  const turn: EnvironmentLaunchLocator = {
    kind: "turn",
    hostId: "local-codex",
    threadId: "bound-thread",
    inputId: "input-1",
  };
  const staged = (await stage(turn)).result;
  // Same account and values stage to the same digest, so an unchanged Thread is not reloaded.
  assert.equal((await stage(turn)).result.key, staged.key);
  // A Turn launch only reconfigures its own Thread.
  assert.deepEqual(
    (
      await relay.call("thread/resume", {
        threadId: "other",
        __opencraftEnvironmentLaunch: { locator: turn, key: staged.key },
      })
    ).error,
    unavailable,
  );
  const second = (await stage(turn)).result;
  await relay.call("thread/resume", {
    threadId: "bound-thread",
    config: {},
    __opencraftEnvironmentLaunch: { locator: turn, key: second.key },
  });
  const resume = relay.requests.find((m) => m.method === "thread/resume");
  assert.deepEqual(resume.params.config[POLICY], { SERVICE_KEY: SECRET, PROJECT_KEY: PROJECT_VALUE });
  noPlaintext([...relay.sent, ...relay.received]);

  // The lease leaves its pending state (native Turn started) between stage and launch.
  const third = (await stage(turn)).result;
  f.leases.started("bound-thread", "turn-1", "input-1", f.native.incarnation);
  assert.deepEqual(
    (
      await relay.call("thread/resume", {
        threadId: "bound-thread",
        __opencraftEnvironmentLaunch: { locator: turn, key: third.key },
      })
    ).error,
    unavailable,
  );

  // A creation of the same Actor: revoked between the reservation and the launch.
  f.pending("bound-thread", "input-2");
  const next: EnvironmentLaunchLocator = {
    kind: "turn",
    hostId: "local-codex",
    threadId: "bound-thread",
    inputId: "input-2",
  };
  const operationId = "creation-revoked";
  await port.reserveCreation({
    operationId,
    actorId: f.actorId,
    actorGeneration: f.generation,
    source: null,
    incarnation: f.native.incarnation,
    projectId: null,
  });
  const creation: EnvironmentLaunchLocator = { kind: "creation", hostId: "local-codex", operationId };
  const stagedCreation = (await stage(creation)).result;
  const sealed = await port.launch(target, next);
  f.actors.setEnabled(f.actorId, false, "fixture");
  assert.deepEqual(
    (await relay.call("thread/start", { __opencraftEnvironmentLaunch: { locator: creation, key: stagedCreation.key } }))
      .error,
    unavailable,
  );
  assert.deepEqual(
    (await relay.call("opencraft/environment/stage", { locator: next, reply: sealed })).error,
    unavailable,
  );
  assert.equal(relay.requests.filter((m) => m.method === "thread/start").length, 0);
});

test("wrong purpose, kind, recipient, attachment or native process are refused; an owner without delivery refuses the field", async (t) => {
  const f = await durable(t);
  const { assets, reader, port } = await owners(t, f);
  let live = f.native.incarnation;
  const environment = receiverFor(f, assets, reader, async () => live);
  t.after(() => environment.close());
  const relay = await relayFixture(t, f.root, environment);
  const key = (await relay.call("opencraft/environment/launch", {})).result.key;
  const reserve = async (operationId: string) => {
    await port.reserveCreation({
      operationId,
      actorId: f.actorId,
      actorGeneration: f.generation,
      source: null,
      incarnation: f.native.incarnation,
      projectId: null,
    });
    return { kind: "creation", hostId: "local-codex", operationId } as EnvironmentLaunchLocator;
  };
  const stage = (locator: EnvironmentLaunchLocator, reply: unknown) =>
    relay.call("opencraft/environment/stage", { locator, reply });

  const creation = await reserve("creation-matrix");
  // Wrong purpose: the issuer seals a Codex creation only for purpose `codex`.
  for (const purpose of ["dsh", "pi", "acp", "terminal"] as const)
    await assert.rejects(assets.environmentLaunch!.launch!({ purpose, instance: INSTANCE, key }, creation));
  // Wrong recipient or attachment: sealed for another receiver.
  const other = new EnvironmentLaunchIssuer().key;
  assert.deepEqual(
    (await stage(creation, await port.launch({ purpose: "codex", instance: INSTANCE, key: other }, creation))).error,
    unavailable,
  );
  assert.deepEqual(
    (await stage(creation, await port.launch({ purpose: "codex", instance: "server:other:codex", key }, creation)))
      .error,
    unavailable,
  );
  // Wrong kind: a creation reply never opens for a Turn record.
  f.pending("thread", "input");
  const turn: EnvironmentLaunchLocator = { kind: "turn", hostId: "local-codex", threadId: "thread", inputId: "input" };
  const target = { purpose: "codex" as const, instance: INSTANCE, key };
  assert.deepEqual((await stage(turn, await port.launch(target, creation))).error, unavailable);
  // A Turn's staged launch never creates a Thread.
  const stagedTurn = (await stage(turn, await port.launch(target, turn))).result;
  assert.deepEqual(
    (await relay.call("thread/start", { __opencraftEnvironmentLaunch: { locator: turn, key: stagedTurn.key } })).error,
    unavailable,
  );
  // A replaced native process: the admission names another incarnation.
  const replaced = await reserve("creation-replaced");
  const sealed = await port.launch(target, replaced);
  live = "another-native-process";
  assert.deepEqual((await stage(replaced, sealed)).error, unavailable);
  assert.equal(relay.requests.filter((m) => ["thread/start", "thread/resume"].includes(m.method)).length, 0);

  // A Core without delivery refuses the field instead of forwarding it, and
  // forwards ordinary requests unchanged.
  const plain = await relayFixture(t, f.root);
  assert.deepEqual(
    (await plain.call("thread/start", { __opencraftEnvironmentLaunch: { locator: creation, key: "x" } })).error,
    unavailable,
  );
  assert.ok((await plain.call("opencraft/environment/launch", {})).error);
  await plain.call("thread/start", { cwd: "/workspace", config: { model: "m" } });
  assert.deepEqual(plain.requests.find((m) => m.method === "thread/start").params, {
    cwd: "/workspace",
    config: { model: "m" },
  });
});

test("the Codex adapter requires one ENV owner, a Codex Core and the Git owner for delivery; the composition offers it only for a vault owner with record readers", () => {
  const port = {
    instance: INSTANCE,
    launch: async () => ({ context: null }),
    reserveCreation: async () => {},
    settleCreation: async () => {},
  };
  const base = { executable: process.execPath, runtimeDirectory: "/tmp", dataDirectory: "/tmp/codex" };
  assert.throws(() => new CodexEngineAdapter({ ...base, environmentLaunch: port }), /one ENV owner/u);
  assert.throws(
    () =>
      new CodexEngineAdapter({
        ...base,
        coreEndpoint: "/tmp/core.sock",
        coreAuthToken: "synthetic-".padEnd(40, "x"),
        coreHostOverlays: true,
        environmentLaunch: port,
      }),
    /one ENV owner/u,
  );
  const server = { call: { reserveEnvironmentCreation: async () => {}, settleEnvironmentCreation: async () => true } };
  const core = { launch: async () => ({ context: null }) as const, admitCreation: async () => ({}) as never };
  assert.equal(coreCodexEnvironmentLaunch(undefined, server, "/core.sock", INSTANCE), undefined);
  // A port without the record readers (`launch`, `admitCreation`) seals Turns only.
  assert.equal(coreCodexEnvironmentLaunch({}, server, "/core.sock", INSTANCE), undefined);
  assert.equal(coreCodexEnvironmentLaunch(core, server, undefined, INSTANCE), undefined, "no Codex Core, no receiver");
  assert.equal(coreCodexEnvironmentLaunch(core, server, "/core.sock", INSTANCE)?.instance, INSTANCE);
});

test("the Codex adapter reserves a Human creation and forwards only a staged capsule to the split Core", async (t) => {
  const f = await durable(t);
  const { assets, reader, port } = await owners(t, f);
  // The native process the split Core owns, a child of this process as the
  // AppServer owns its native child.
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const incarnation = (await observeNativeExecutionProcess(child.pid!)).incarnation;
  const environment = receiverFor(f, assets, reader, async () => incarnation);
  t.after(() => environment.close());
  const nativePath = join(f.root, "adapter-native.sock"),
    proxy = join(f.root, "adapter-relay.sock"),
    endpoint = join(f.root, "control.sock");
  const http = createServer(),
    wss = new WebSocketServer({ server: http }),
    requests: any[] = [];
  await new Promise<void>((resolve) => http.listen(nativePath, resolve));
  wss.on("connection", (socket) =>
    socket.on("message", (frame) => {
      const message = JSON.parse(String(frame));
      requests.push(message);
      if (message.id === undefined) return;
      const result =
        message.method === "initialize"
          ? { userAgent: "fixture", platformFamily: "unix", capabilities: { extensions: {} } }
          : message.method === "thread/start"
            ? { thread: { id: "adapter-thread", cwd: f.root, turns: [], status: { type: "idle" } } }
            : message.method === "thread/list"
              ? { data: [], nextCursor: null }
              : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    }),
  );
  const relay = await startOrchestrationCallbackRelay(proxy, nativePath, { environment });
  const token = "synthetic-" + randomUUID();
  const control = await startControlServer(endpoint, token, async () => ({
    status: 200,
    value: {
      protocolVersion: 1,
      pid: process.pid,
      codexPid: child.pid,
      nativeSocket: proxy,
      environmentVariablesVersion: 1,
      environmentLaunchVersion: 1,
      dataDirectory: join(f.root, "codex"),
      proxyBaseUrl: "http://127.0.0.1:9",
    },
  }));
  // Every value the adapter relays crosses this port.
  const relayed: unknown[] = [];
  const observed = {
    ...port,
    launch: async (...args: Parameters<typeof port.launch>) => {
      const reply = await port.launch(...args);
      relayed.push(reply);
      return reply;
    },
  };
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: f.root,
    dataDirectory: join(f.root, "codex-adapter"),
    coreEndpoint: endpoint,
    coreAuthToken: token,
    coreHostOverlays: true,
    environmentLaunch: observed,
    createExecutionGit: () => ({
      reserve: async () => {
        throw Error("unused");
      },
      prepare: async () => {
        throw Error("unused");
      },
      close: async () => {},
    }),
    logDiagnostic() {},
  });
  const frames: any[] = [];
  adapter.subscribeMessage((frame) => frames.push(JSON.parse(frame)));
  t.after(async () => {
    await adapter.close();
    await control.close();
    await relay.close();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  let sequence = 0;
  const call = async (method: string, params: object, context: object = f.context) => {
    const id = ++sequence;
    await adapter.sendWithContext(
      JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "client" }),
      context as never,
    );
    await until(() => frames.some((frame) => frame.id === id));
    return frames.find((frame) => frame.id === id);
  };
  await adapter.connect();
  await call("initialize", {});
  const created = await call("thread/start", { cwd: f.root, projectId: "alpha" });
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const start = requests.find((m) => m.method === "thread/start");
  assert.equal(start.params.__opencraftEnvironmentLaunch, undefined);
  assert.equal(start.params.config[POLICY].SERVICE_KEY, SECRET);
  assert.equal(start.params.config[POLICY].PROJECT_KEY, PROJECT_VALUE);
  assert.equal(relayed.length, 1);
  noPlaintext([...relayed, ...frames]);
  // The reservation left its admissible state once native answered.
  const states = () =>
    f.storage.database
      .prepare("SELECT state FROM environment_creation_reservations")
      .all()
      .map((row) => row.state);
  await until(() => states().join() === "launched");
  // An unowned creation stays empty and reserves nothing.
  const anonymous = await call("thread/start", { cwd: f.root }, { sender: null });
  assert.equal(anonymous.error, undefined);
  assert.equal(relayed.length, 1);
  assert.equal(requests.filter((m) => m.method === "thread/start").at(-1).params.config?.[POLICY], undefined);
});

/** The vault owner of an identity composition that owns its vault: a Worker
 * that seals capsules and grants, composed only from public entry points
 * (`@opencraft/headless-server/assets-execution-records`). Main receives only
 * this port, shaped like `identity.environmentLaunch` with the Codex record
 * readers and Git owner. */
async function identityVaultOwner(t: test.TestContext, f: Awaited<ReturnType<typeof durable>>) {
  const vault = await openAssetConfigurations(f.directory, { entry: identityVaultWorker, environmentLaunch: true });
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(async () => {
    await reader.close();
    await vault.close();
  });
  const owner = vault.environmentLaunch!;
  const environmentLaunch = {
    issuer: owner.issuer,
    seal: owner.seal,
    launch: owner.launch,
    admitCreation: owner.admitCreation,
    git: {
      hosts: vault.gitHosts,
      authority: vault.gitAuthority!,
      grant: (locator: GitExecutionLocator) => vault.store.executionGitGrant(locator),
      reservation: (locator: GitExecutionLocator) => vault.store.executionGitReservation(locator),
    },
  };
  // Core's live Actor check, as Headless composes it around every await.
  const authorize = (scope: { account: string; actorGeneration?: number }) => {
    const actor = f.actors.get(scope.account.slice("actor:".length));
    return actor?.enabled === true && actor.kind === "human" && actor.generation === scope.actorGeneration;
  };
  const server = {
    call: {
      reserveEnvironmentCreation: async (record: Parameters<typeof f.reservations.reserveEnvironmentCreation>[0]) =>
        f.reservations.reserveEnvironmentCreation(record),
      settleEnvironmentCreation: async (hostId: string, operationId: string, outcome: "launched" | "abandoned") =>
        f.reservations.settleEnvironmentCreation(hostId, operationId, outcome),
    },
  };
  const port = coreCodexEnvironmentLaunch(
    environmentLaunch,
    server as never,
    "/fixture/codex-core.sock",
    INSTANCE,
    (actor) => authorize({ account: `actor:${actor.actorId}`, actorGeneration: actor.actorGeneration }),
  )!;
  return { vault, reader, environmentLaunch, authorize, port };
}

/** Records every vault access on this (Main) thread from now on. */
function spyVault(t: test.TestContext) {
  const calls: string[] = [],
    prototype = EmployeeGitVaultStore.prototype as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const original = prototype[name];
    if (name === "constructor" || typeof original !== "function") continue;
    prototype[name] = function (this: unknown, ...args: unknown[]) {
      calls.push(name);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    t.after(() => {
      prototype[name] = original;
    });
  }
  return calls;
}

test(
  "an identity vault port drives a human Codex creation and Turn: ENV and a personal Git grant reach native, Main holds no value and opens no vault",
  { timeout: 60_000 },
  async (t) => {
    const f = await durable(t);
    // The adapter owns the Codex lease store the vault owner and receiver read.
    f.closeHostState();
    const runtime = join(f.root, "git-runtime");
    await buildGitIdentityRuntime(runtime);
    const { reader, environmentLaunch, authorize, port } = await identityVaultOwner(t, f);
    assert.doesNotThrow(() => validateHeadlessIdentity({ providers: [], close() {}, environmentLaunch }));
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    t.after(() => child.kill("SIGKILL"));
    const incarnation = (await observeNativeExecutionProcess(child.pid!)).incarnation;
    const environment = createCodexEnvironmentLaunch({
      issuer: environmentLaunch.issuer,
      instance: INSTANCE,
      admission: (locator) => reader.admission(locator),
      incarnation: async () => incarnation,
    });
    t.after(() => environment.close());
    const nativePath = join(f.root, "identity-native.sock"),
      proxy = join(f.root, "identity-relay.sock"),
      endpoint = join(f.root, "identity-control.sock");
    const http = createServer(),
      wss = new WebSocketServer({ server: http }),
      requests: any[] = [],
      status = new Map<string, string>();
    await new Promise<void>((resolve) => http.listen(nativePath, resolve));
    wss.on("connection", (socket) =>
      socket.on("message", (frame) => {
        const message = JSON.parse(String(frame)),
          params = message.params ?? {};
        requests.push(message);
        if (message.id === undefined) return;
        const thread = (id: string) => ({
          id,
          cwd: f.root,
          turns: [],
          status: { type: status.get(id) ?? "notLoaded" },
        });
        let result: unknown = {};
        if (message.method === "initialize")
          result = { userAgent: "fixture", platformFamily: "unix", capabilities: { extensions: {} } };
        else if (message.method === "thread/start") {
          status.set("identity-thread", "idle");
          result = { thread: thread("identity-thread") };
        } else if (message.method === "thread/list") result = { data: [], nextCursor: null };
        else if (message.method === "thread/read") result = { thread: thread(params.threadId) };
        else if (message.method === "thread/unsubscribe") status.set(params.threadId, "notLoaded");
        else if (message.method === "thread/resume") {
          if (params.config) status.set(params.threadId, "idle");
          result = { thread: thread(params.threadId), model: "fixture", sandbox: { type: "workspaceWrite" } };
        } else if (message.method === "turn/start") {
          status.set(params.threadId, "active");
          result = { turn: { id: "identity-turn", status: "inProgress", items: [] } };
        }
        socket.send(JSON.stringify({ id: message.id, result }));
      }),
    );
    const relay = await startOrchestrationCallbackRelay(proxy, nativePath, { environment });
    const token = "synthetic-" + randomUUID();
    const control = await startControlServer(endpoint, token, async () => ({
      status: 200,
      value: {
        protocolVersion: 1,
        pid: process.pid,
        codexPid: child.pid,
        nativeSocket: proxy,
        environmentVariablesVersion: 1,
        environmentLaunchVersion: 1,
        dataDirectory: join(f.root, "codex-core"),
        proxyBaseUrl: "http://127.0.0.1:9",
      },
    }));
    const relayed: unknown[] = [];
    const observed = {
      ...port,
      launch: async (...args: Parameters<typeof port.launch>) => {
        const reply = await port.launch(...args);
        relayed.push(reply);
        return reply;
      },
    };
    const vaultCalls = spyVault(t);
    const adapter = new CodexEngineAdapter({
      executable: process.execPath,
      runtimeDirectory: f.root,
      // The Codex lease store core's durable admission reads.
      dataDirectory: join(f.directory, "codex"),
      coreEndpoint: endpoint,
      coreAuthToken: token,
      coreHostOverlays: true,
      environmentLaunch: observed,
      // Headless's composition of the identity's Git execution owner.
      createExecutionGit: codexExecutionGit(environmentLaunch.git, {
        directory: f.directory,
        runtimeDirectory: join(f.root, "codex-git"),
        workerFile: join(runtime, "personal-git-worker.mjs"),
        authorize,
      }),
      logDiagnostic() {},
    });
    const frames: any[] = [];
    adapter.subscribeMessage((frame) => frames.push(JSON.parse(frame)));
    t.after(async () => {
      await adapter.close();
      await control.close();
      await relay.close();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    let sequence = 0;
    const call = async (method: string, params: object) => {
      const id = ++sequence;
      await adapter.sendWithContext(
        JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "client" }),
        f.context as never,
      );
      await until(() => frames.some((frame) => frame.id === id));
      return frames.find((frame) => frame.id === id);
    };
    await adapter.connect();
    await call("initialize", {});

    // Creation: reserved through the identity's admission, opened by Codex Core.
    const created = await call("thread/start", { cwd: f.root, projectId: "alpha" });
    assert.equal(created.error, undefined, JSON.stringify(created.error));
    const start = requests.find((m) => m.method === "thread/start");
    assert.equal(start.params.config[POLICY].SERVICE_KEY, SECRET);
    assert.equal(start.params.config[POLICY].PROJECT_KEY, PROJECT_VALUE);

    // Turn: the pending lease admits the Git reservation and the ENV capsule.
    const turn = await call("turn/start", {
      threadId: "identity-thread",
      clientUserMessageId: "identity-input",
      input: [{ type: "text", text: "synthetic" }],
    });
    assert.equal(turn.error, undefined, JSON.stringify(turn.error));
    const reload = requests.find((m) => m.method === "thread/resume" && m.params.config);
    assert.equal(reload.params.__opencraftEnvironmentLaunch, undefined);
    const installed = reload.params.config[POLICY];
    assert.equal(installed.SERVICE_KEY, SECRET);
    assert.match(
      installed.OPENCRAFT_GIT_CAPABILITY,
      /^v3\./u,
      "a personal Git grant sealed by the identity vault owner",
    );
    assert.equal(installed.OPENCRAFT_GIT_BROKER_AUTHORITY, environmentLaunch.git.authority);
    assert.ok(requests.some((m) => m.method === "turn/start" && m.params.clientUserMessageId === "identity-input"));
    // The Turn restages before dispatch; an unchanged digest does not reload twice.
    assert.ok(relayed.length >= 2, "capsules for the creation and the Turn");
    assert.equal(requests.filter((m) => m.method === "thread/resume" && m.params.config).length, 1);
    noPlaintext([...relayed, ...frames]);
    assert.deepEqual(vaultCalls, [], "Main never opens the vault");
  },
);

test("identity vault ports are rechecked after every await: a revoked Actor or a replaced lease is refused", async (t) => {
  const f = await durable(t);
  const { environmentLaunch, authorize, port } = await identityVaultOwner(t, f);
  const creation = (operationId: string) => ({
    operationId,
    actorId: f.actorId,
    actorGeneration: f.generation,
    source: null,
    incarnation: f.native.incarnation,
    projectId: null,
  });
  // The vault owner answers for exactly the request; a substituted record is refused.
  const substituted = coreCodexEnvironmentLaunch(
    {
      ...environmentLaunch,
      admitCreation: async (request) => ({ ...(await environmentLaunch.admitCreation(request)), operationId: "other" }),
    },
    {
      call: {
        reserveEnvironmentCreation: async () => assert.fail("not written"),
        settleEnvironmentCreation: async () => true,
      },
    } as never,
    "/core.sock",
    INSTANCE,
  )!;
  await assert.rejects(substituted.reserveCreation(creation("substituted")), /environment_launch_unavailable/u);

  // Revoked while the identity's vault owner answers: core refuses after the await.
  let revoke = false;
  const racing = coreCodexEnvironmentLaunch(
    {
      ...environmentLaunch,
      admitCreation: async (request) => {
        const record = await environmentLaunch.admitCreation(request);
        if (revoke) f.actors.setEnabled(f.actorId, false, "fixture");
        return record;
      },
    },
    {
      call: {
        reserveEnvironmentCreation: async () => assert.fail("not written"),
        settleEnvironmentCreation: async () => true,
      },
    } as never,
    "/core.sock",
    INSTANCE,
    (actor) => authorize({ account: `actor:${actor.actorId}`, actorGeneration: actor.actorGeneration }),
  )!;

  // A pending Codex lease, its Git reservation handed off before revocation.
  f.pending("thread", "input");
  const locator = { hostId: "local-codex" as const, threadId: "thread", inputId: "input" };
  const held = await environmentLaunch.git.reservation(locator);
  assert.ok(held, "the identity's Git owner admits the pending lease");
  await port.reserveCreation(creation("admitted"));
  let live = true;
  const git = codexExecutionGit(
    { ...environmentLaunch.git, reservation: async () => held },
    {
      directory: f.directory,
      runtimeDirectory: join(f.root, "unused-git"),
      workerFile: join(f.root, "unused.mjs"),
      authorize,
    },
  )({ inspect: async () => live, inspectReservation: async () => live });
  t.after(() => git.close());
  // The native process holding the lease was replaced: the stale handoff is refused.
  live = false;
  await assert.rejects(git.reserve(locator), /git_execution_unavailable/u);
  live = true;

  revoke = true;
  await assert.rejects(racing.reserveCreation(creation("revoked-during")), /environment_launch_unavailable/u);
  await assert.rejects(port.reserveCreation(creation("revoked-before")), /environment_launch_unavailable/u);
  await assert.rejects(git.reserve(locator), /git_execution_unavailable/u);
  const written = f.storage.database
    .prepare("SELECT operation_id AS id FROM environment_creation_reservations")
    .all()
    .map((row) => row.id);
  assert.deepEqual(written, ["admitted"]);
});
