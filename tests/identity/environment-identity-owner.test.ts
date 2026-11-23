import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { MembershipStore } from "@opencraft/access-control";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { ThreadIdentityDatabase } from "@opencraft/opencraft-daemon/thread-identity-database";
import { ExecutionLeaseStore, snapshotExecutionSubmission } from "@opencraft/opencraft-daemon/execution-lease-store";
import { observeNativeExecutionProcess } from "@opencraft/opencraft-daemon/native-execution-origin";
import type { DuplexTransport, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { openExecutionAdmission } from "@opencraft/execution-environment/execution-admission";
import { createRemoteEnvironmentLaunch } from "@opencraft/execution-environment/remote-environment-launch";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { AccountEnvironment } from "@opencraft/execution-environment/account-environment";
import { environmentProjectId } from "@opencraft/execution-environment/environment-metadata";
import type { EnvironmentLaunchContext } from "@opencraft/execution-environment/environment-delivery";
import type { GitExecutionLocator } from "@opencraft/execution-environment/git-execution";
import type { CapabilitySession } from "@opencraft/session-capabilities";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { createNodePasswordHasher } from "../../plugins/local-account/src/password-hash-node.js";
import { openHeadlessAssetsStorage } from "../../apps/headless-server/src/headless-assets-storage.js";
import { createHostEnvironmentLaunch } from "../../apps/headless-server/src/host-environment-launch.ts";
import { createEnvironmentAdmissionHandoff } from "../../apps/headless-server/src/environment-admission-handoff.ts";
import { EnvironmentMetadataTransport } from "../../apps/headless-server/src/environment-metadata-transport.ts";
import { validateHeadlessIdentity } from "../../apps/headless-server/src/headless-identity.mjs";

const HOST = "opencraft-server";
const attachment = "server:fixture:dsh";
const admissionWorker = fileURLToPath(
  new URL("../../apps/headless-server/src/execution-admission.worker.ts", import.meta.url),
);
const SECRET = "synthetic-identity-owner-secret";
const PROJECT_VALUE = "synthetic-identity-owner-project";

/** Real Actor and execution lease stores; Project values exist, no Thread yet. */
async function durable(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "env-identity-owner-")),
    directory = join(root, "data");
  const storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    accounts = new HumanAccounts(storage, actors),
    members = new MembershipStore(storage);
  accounts.registerLocalAccounts(new LocalAccountServerPlugin(accounts.localAccountRepository, createNodePasswordHasher()));
  const management = new HumanAccountManagement(storage, accounts, actors, members);
  const principal = await management.initialize({
    mode: "web",
    username: "owner",
    password: "Only-synthetic-test-password-42",
  });
  const login = accounts.issue(principal);
  const context: TransportSubmissionContext = {
    sender: null,
    executionPrincipal: principal,
    actorContext: login.login.context,
    validUntil: principal.expiresAt,
  };
  const identities = new ThreadIdentityDatabase(join(directory, "thread-identities/opencraft-server")),
    leases = new ExecutionLeaseStore(identities.database);
  const native = await observeNativeExecutionProcess(process.pid);
  const account = `actor:${login.login.context.actorId}`;
  const vault = await EmployeeGitVaultStore.open(directory);
  try {
    const environment = new AccountEnvironment(vault);
    environment.replace(account, { projectId: null }, 0, [{ name: "SERVICE_KEY", value: SECRET, secret: true }]);
    environment.replace(account, { projectId: environmentProjectId(HOST, "alpha") }, 0, [
      { name: "SHARED", value: PROJECT_VALUE, secret: true },
    ]);
  } finally {
    vault.close();
  }
  t.after(async () => {
    identities.close();
    management.close();
    accounts.close();
    members.close();
    actors.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    directory,
    context,
    admit(threadId: string, inputId: string, turnId: string) {
      leases.capture(threadId, inputId, snapshotExecutionSubmission(context), "accepted");
      leases.begin(threadId, inputId, native.incarnation);
      leases.started(threadId, turnId, inputId, native.incarnation);
    },
  };
}

/** The vault-owner port an identity composition supplies: the issuer, its
 * durable admission read and its metadata port, all on its own vault Worker. */
async function identityPort(directory: string) {
  const assets = await openHeadlessAssetsStorage(directory, { environmentLaunch: true });
  const port = {
    issuer: assets.environmentLaunch!.issuer,
    seal: assets.environmentLaunch!.seal,
    admission: async (locator: GitExecutionLocator): Promise<EnvironmentLaunchContext | null> => {
      const handoff = await assets.store.executionGitGrant(locator);
      return handoff && { scope: handoff.scope, native: handoff.native };
    },
    metadata: assets.environmentMetadata!,
  };
  return { assets, port };
}

/** A Host that creates one Thread and records what reached it. */
function host() {
  const listeners = new Set<(frame: string) => void>();
  const sent: Record<string, any>[] = [];
  const inner: DuplexTransport = {
    status: { state: "open" } as DuplexTransport["status"],
    async connect() {},
    async close() {
      listeners.clear();
    },
    subscribeStatus: () => () => {},
    subscribeMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    captureMessageScope: () => () => true,
    async send(frame) {
      sent.push(JSON.parse(frame));
    },
  };
  return {
    inner,
    sent,
    reply: (value: unknown) => {
      for (const listener of [...listeners]) listener(JSON.stringify(value));
    },
  };
}
const until = async (condition: () => boolean, label: string) => {
  const end = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

function receiver(
  port: Awaited<ReturnType<typeof identityPort>>["port"],
  reader: ReturnType<typeof openExecutionAdmission>,
  live: { authorize: () => boolean } = { authorize: () => true },
  admission = port.admission,
) {
  const route = createHostEnvironmentLaunch({
    port,
    handoff: createEnvironmentAdmissionHandoff({
      admission,
      authorize: () => live.authorize(),
      inspect: async () => true,
      closed: () => false,
    }),
    routes: () => true,
  });
  return createRemoteEnvironmentLaunch({
    purpose: "dsh",
    instance: attachment,
    issuer: port.issuer,
    capabilities: {
      hostEnvironment: (threadId, source, recipient) =>
        route({ serverId: attachment, threadId, execution: source } as CapabilitySession, recipient),
    },
    admission: (input) => reader.resolve(input),
  });
}

test("an identity-owned vault port with admission and metadata records a new Thread's Project and delivers its ENV", async (t) => {
  const f = await durable(t);
  const seen: string[] = [];
  const emit = Worker.prototype.emit;
  Worker.prototype.emit = function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event === "message") seen.push(JSON.stringify(args[0]) ?? "");
    return emit.call(this, event, ...args);
  } as typeof emit;
  t.after(() => {
    Worker.prototype.emit = emit;
  });
  const { assets, port } = await identityPort(f.directory);
  t.after(() => assets.close());
  // The composition passes the same validation core applies at startup.
  validateHeadlessIdentity({ providers: [], close() {}, environmentLaunch: port });
  // Core relays Host traffic through the composition's metadata port.
  const h = host();
  const transport = new EnvironmentMetadataTransport(h.inner, port.metadata, HOST);
  const frames: Record<string, any>[] = [];
  transport.subscribeMessage((frame) => frames.push(JSON.parse(frame)));
  await transport.sendWithContext(
    JSON.stringify({ id: 1, method: "thread/start", params: { projectId: "alpha" } }),
    f.context,
  );
  assert.equal(h.sent[0]!.method, "thread/start");
  h.reply({ id: 1, result: { thread: { id: "dsh-new" } } });
  await until(() => frames.length === 1, "creation response");
  assert.equal(frames[0]!.result.thread.id, "dsh-new");
  assert.equal(await port.metadata.project(HOST, "dsh-new"), "alpha", "the Thread->Project binding was recorded");
  // A Turn on the new Thread receives personal and Project values.
  f.admit("dsh-new", "new-input", "dsh-turn-dsh-new-1");
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(() => reader.close());
  const launch = receiver(port, reader);
  try {
    const values = (await launch.prepare({ hostId: HOST, threadId: "dsh-new", turnId: "dsh-turn-dsh-new-1" })).apply(
      {},
    );
    assert.equal(values.SERVICE_KEY, SECRET);
    assert.equal(values.SHARED, PROJECT_VALUE);
  } finally {
    launch.close();
    await transport.close();
  }
  assert.ok(seen.length > 0);
  for (const message of seen)
    for (const value of [SECRET, PROJECT_VALUE]) assert.ok(!message.includes(value), "no plaintext reached Main");
});

test("core keeps the live checks over an identity-owned admission; nothing falls back", async (t) => {
  const f = await durable(t);
  const { assets, port } = await identityPort(f.directory);
  t.after(() => assets.close());
  await port.metadata.bind(HOST, "dsh-alpha", "alpha");
  f.admit("dsh-alpha", "alpha-input", "dsh-turn-dsh-alpha-1");
  const locator = { hostId: HOST, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-1" } as const;
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(() => reader.close());
  const live = { authorize: () => true };
  const launch = receiver(port, reader, live);
  t.after(() => launch.close());
  assert.equal((await launch.prepare(locator)).apply({}).SHARED, PROJECT_VALUE);
  // A revoked Actor is refused even though the composition still has the record.
  live.authorize = () => false;
  await assert.rejects(launch.prepare(locator));
  // A record that is not this locator's, or that names a Project, is refused.
  const owned = (await port.admission(locator))!;
  for (const forged of [
    { ...owned, scope: { ...owned.scope, threadId: "dsh-other" } },
    { ...owned, scope: { ...owned.scope, projectId: "beta" } },
    { ...owned, native: { ...owned.native, turnId: "dsh-turn-dsh-alpha-9" } },
    { ...owned, scope: { ...owned.scope, account: "directory:staff-7" } },
  ]) {
    const handoff = createEnvironmentAdmissionHandoff({
      admission: async () => forged as EnvironmentLaunchContext,
      authorize: () => true,
      inspect: async () => true,
      closed: () => false,
    });
    await assert.rejects(handoff(locator), { message: "environment_launch_unavailable" });
  }
  // A failing admission read is an error, never an empty launch.
  const failing = createEnvironmentAdmissionHandoff({
    admission: async () => {
      throw Error("store unavailable");
    },
    authorize: () => true,
    inspect: async () => true,
    closed: () => false,
  });
  await assert.rejects(failing(locator), { message: "environment_launch_unavailable" });
  const closed = createEnvironmentAdmissionHandoff({
    admission: port.admission,
    authorize: () => true,
    inspect: async () => true,
    closed: () => true,
  });
  await assert.rejects(closed(locator));
});

test("an identity port's parts are validated up front", () => {
  const base = { providers: [], close() {} };
  const metadata = { admit() {}, project() {}, bind() {}, bindCreator() {}, rememberProjects() {} };
  const port = { issuer: "a".repeat(44), seal: async () => "" };
  validateHeadlessIdentity({ ...base, environmentLaunch: port });
  validateHeadlessIdentity({ ...base, environmentLaunch: { ...port, metadata } });
  validateHeadlessIdentity({ ...base, environmentLaunch: { ...port, admission: async () => null, metadata } });
  for (const environmentLaunch of [
    // An admission without metadata would lose new Threads' Project ENV.
    { ...port, admission: async () => null },
    { ...port, admission: "durable", metadata },
    { ...port, metadata: { ...metadata, bindCreator: undefined } },
    { ...port, metadata: null },
  ])
    assert.throws(() => validateHeadlessIdentity({ ...base, environmentLaunch }), /Invalid Headless identity adapter/);
  // Never beside the synchronous runtime.
  assert.throws(
    () =>
      validateHeadlessIdentity({
        ...base,
        executionEnvironment: { close() {} },
        environmentLaunch: { ...port, admission: async () => null, metadata },
      }),
    /Invalid Headless identity adapter/,
  );
});
