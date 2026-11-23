import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { MembershipStore } from "@opencraft/access-control";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { ThreadIdentityDatabase } from "@opencraft/opencraft-daemon/thread-identity-database";
import { ExecutionLeaseStore, snapshotExecutionSubmission } from "@opencraft/opencraft-daemon/execution-lease-store";
import { observeNativeExecutionProcess } from "@opencraft/opencraft-daemon/native-execution-origin";
import {
  EnvironmentLaunchIssuer,
  type EnvironmentLaunchContext,
} from "@opencraft/execution-environment/environment-delivery";
import { openExecutionAdmission } from "@opencraft/execution-environment/execution-admission";
import { createRemoteEnvironmentLaunch } from "@opencraft/execution-environment/remote-environment-launch";
import { Worker } from "node:worker_threads";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { AccountEnvironment } from "@opencraft/execution-environment/account-environment";
import { ExecutionEnvironmentRuntime, environmentProjectId } from "@opencraft/execution-environment";
import type { GitExecutionLocator } from "@opencraft/execution-environment/git-execution";
import type { CapabilitySession } from "@opencraft/session-capabilities";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { createNodePasswordHasher } from "../../plugins/local-account/src/password-hash-node.js";
import { createAssetsStorage } from "../../plugins/assets/src/server/storage.js";
import { openAssetConfigurations } from "../../plugins/assets/src/server/worker.js";
import { openHeadlessAssetsStorage } from "../../apps/headless-server/src/headless-assets-storage.js";
import { createHostEnvironmentLaunch } from "../../apps/headless-server/src/host-environment-launch.ts";
import { environmentLaunchOwner } from "../../apps/headless-server/src/headless-identity.mjs";
import { sealedEnvironmentIssuerKey } from "@opencraft/execution-environment/environment-launch-owner";
import { unissuableEnvironmentIssuer } from "../../scripts/server-deployment/environment-issuer.mjs";

const admissionWorker = fileURLToPath(
  new URL("../../apps/headless-server/src/execution-admission.worker.ts", import.meta.url),
);
const attachment = "server:fixture:dsh";
const SECRET = "synthetic-durable-only-value";

/** Real Actor store and real execution lease store, as the Gateway writes them. */
async function durable(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "env-owner-")),
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
  const identities = new ThreadIdentityDatabase(join(directory, "thread-identities/opencraft-server")),
    leases = new ExecutionLeaseStore(identities.database);
  const native = await observeNativeExecutionProcess(process.pid);
  const context = {
    sender: null,
    executionPrincipal: principal,
    actorContext: login.login.context,
    validUntil: principal.expiresAt,
  };
  const admit = (
    threadId: string,
    inputId: string,
    turnId: string,
    owner: typeof context | { sender: null } = context,
  ) => {
    leases.capture(threadId, inputId, snapshotExecutionSubmission(owner), "accepted");
    const executionId = leases.begin(threadId, inputId, native.incarnation);
    leases.started(threadId, turnId, inputId, native.incarnation);
    return executionId;
  };
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
    root,
    directory,
    leases,
    native,
    admit,
    account: `actor:${login.login.context.actorId}`,
    actors,
    actorId: login.login.context.actorId,
  };
}

/** A relay that seals exactly what it is told. Only the owner's admission can refuse. */
function relay(issuer: EnvironmentLaunchIssuer, state: { context: EnvironmentLaunchContext | null }) {
  return {
    async hostEnvironment(_threadId: string, _source: unknown, recipient: string) {
      if (!state.context) return { context: null };
      const capsule = issuer.seal(
        { purpose: "dsh", instance: attachment, key: recipient },
        state.context,
        () => ({ SERVICE_KEY: SECRET }),
        () => {},
      );
      return { context: state.context, capsule };
    },
  };
}

test("DSH reads its own durable admission in a Worker and refuses a relay that disagrees with it", async (t) => {
  const f = await durable(t);
  const threadId = "dsh-durable",
    turnId = `dsh-turn-${threadId}-3`;
  const executionId = f.admit(threadId, "original-input", turnId);
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(() => reader.close());
  const locator = { hostId: "opencraft-server" as const, threadId, turnId };
  const owned = (await reader.resolve(locator))!;
  assert.deepEqual(owned, {
    scope: {
      account: f.account,
      hostId: "opencraft-server",
      threadId,
      inputId: "original-input",
      executionId,
      leaseGeneration: 1,
      actorGeneration: owned.scope.actorGeneration,
      membershipRevision: owned.scope.membershipRevision,
      projectId: null,
    },
    native: { turnId, incarnation: f.native.incarnation },
  });
  // A locator cannot select a Project: the read ignores it.
  assert.equal((await reader.resolve({ ...locator, projectId: "selected" }))?.scope.projectId, null);

  const issuer = new EnvironmentLaunchIssuer();
  t.after(() => issuer.close());
  const state = { context: owned as EnvironmentLaunchContext | null };
  const launch = createRemoteEnvironmentLaunch({
    purpose: "dsh",
    instance: attachment,
    issuer: issuer.key,
    capabilities: relay(issuer, state),
    admission: (input) => reader.resolve(input),
  });
  t.after(() => launch.close());
  assert.equal((await launch.prepare(locator)).apply({}).SERVICE_KEY, SECRET);
  for (const scope of [{ executionId: "relayed-execution" }, { leaseGeneration: 7 }, { inputId: "relayed-input" }]) {
    state.context = { ...owned, scope: { ...owned.scope, ...scope } };
    await assert.rejects(launch.prepare(locator), { message: "environment_launch_unavailable" });
  }
  // The owner holds a Human admission; a relay claiming none is refused.
  state.context = null;
  await assert.rejects(launch.prepare(locator));
  // The lease ends: the durable admission is gone and nothing opens.
  state.context = owned;
  f.leases.finished(threadId, turnId);
  await assert.rejects(reader.resolve(locator));
  await assert.rejects(launch.prepare(locator));
});

test("Pi reads its own durable admission by input in a Worker; a capsule for the DSH attachment never opens", async (t) => {
  const f = await durable(t);
  const threadId = "pi_durable",
    inputId = "pi-input",
    turnId = "pi-native-turn";
  const executionId = f.admit(threadId, inputId, turnId);
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(() => reader.close());
  // Pi locates its execution by the admitted input, not by a native Turn id.
  const locator = { hostId: "opencraft-server" as const, threadId, inputId, projectId: null };
  const owned = (await reader.resolve(locator))!;
  assert.equal(owned.scope.executionId, executionId);
  assert.equal(owned.native.turnId, turnId);
  const issuer = new EnvironmentLaunchIssuer();
  t.after(() => issuer.close());
  let purpose: "pi" | "dsh" = "pi";
  const piAttachment = "server:fixture:pi";
  const launch = createRemoteEnvironmentLaunch({
    purpose: "pi",
    instance: piAttachment,
    issuer: issuer.key,
    capabilities: {
      async hostEnvironment(_threadId: string, _source: unknown, recipient: string) {
        const capsule = issuer.seal(
          { purpose, instance: purpose === "pi" ? piAttachment : attachment, key: recipient },
          owned,
          () => ({ SERVICE_KEY: SECRET }),
          () => {},
        );
        return { context: owned, capsule };
      },
    },
    admission: (input) => reader.resolve(input),
  });
  t.after(() => launch.close());
  assert.equal((await launch.prepare(locator)).apply({}).SERVICE_KEY, SECRET);
  purpose = "dsh";
  await assert.rejects(launch.prepare(locator), { message: "environment_launch_unavailable" });
  purpose = "pi";
  f.leases.finished(threadId, turnId);
  await assert.rejects(launch.prepare(locator));
});

test("an unowned Turn reads as no admission; a closed reader refuses instead of reading on this thread", async (t) => {
  const f = await durable(t);
  const threadId = "dsh-unowned",
    turnId = `dsh-turn-${threadId}-1`;
  f.admit(threadId, "system-input", turnId, { sender: null });
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  assert.equal(await reader.resolve({ hostId: "opencraft-server", threadId, turnId }), null);
  // An unknown Turn is not "unowned": it cannot become an empty launch.
  await assert.rejects(reader.resolve({ hostId: "opencraft-server", threadId, turnId: "dsh-turn-missing" }));
  await reader.close();
  await assert.rejects(reader.resolve({ hostId: "opencraft-server", threadId, turnId }));
  assert.throws(() => openExecutionAdmission({ workerFile: "relative.mjs", directory: f.directory }));
});

const PROJECT_VALUE = "synthetic-alpha-project-value";
const GLOBAL_VALUE = "synthetic-global-only-value";
/** Values and the Thread->Project binding exist before the vault owner starts. */
async function seed(directory: string, account: string, bindings: Record<string, string | null>) {
  const vault = await EmployeeGitVaultStore.open(directory);
  try {
    const environment = new AccountEnvironment(vault);
    environment.replace(account, { projectId: null }, 0, [
      { name: "SERVICE_KEY", value: SECRET, secret: true },
      { name: "SHARED", value: GLOBAL_VALUE, secret: false },
    ]);
    for (const [project, value] of [
      ["alpha", PROJECT_VALUE],
      ["beta", "synthetic-beta-project-value"],
    ])
      environment.replace(account, { projectId: environmentProjectId("opencraft-server", project!) }, 0, [
        { name: "SHARED", value: value!, secret: true },
      ]);
    const metadata = new ExecutionEnvironmentRuntime(directory, vault, false, "disabled");
    for (const [threadId, project] of Object.entries(bindings)) metadata.bind("opencraft-server", threadId, project);
  } finally {
    vault.close();
  }
}
/** Gateway relay with the real route logic; its port is the vault Worker's. */
function gateway(
  assets: Awaited<ReturnType<typeof openHeadlessAssetsStorage>>,
  reader: ReturnType<typeof openExecutionAdmission>,
  issuer = assets.environmentLaunch!.issuer,
) {
  const route = createHostEnvironmentLaunch({
    port: assets.environmentLaunch!,
    handoff: (locator) => assets.store.executionGitGrant(locator),
    routes: () => true,
  });
  return createRemoteEnvironmentLaunch({
    purpose: "dsh",
    instance: attachment,
    issuer,
    capabilities: {
      hostEnvironment: (threadId, source, recipient) =>
        route({ serverId: attachment, threadId, execution: source } as CapabilitySession, recipient),
    },
    admission: (input) => reader.resolve(input),
  });
}

test("the core vault owner issues capsules in its Worker: values never reach Main, Project comes from Thread metadata", async (t) => {
  const f = await durable(t);
  const alpha = { hostId: "opencraft-server" as const, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-1" };
  const plain = { hostId: "opencraft-server" as const, threadId: "dsh-plain", turnId: "dsh-turn-dsh-plain-1" };
  f.admit(alpha.threadId, "alpha-input", alpha.turnId);
  f.admit(plain.threadId, "plain-input", plain.turnId);
  await seed(f.directory, f.account, { [alpha.threadId]: "alpha" });
  // Record every message the Worker sends to this (Main) thread.
  const seen: string[] = [];
  const emit = Worker.prototype.emit;
  Worker.prototype.emit = function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event === "message") seen.push(JSON.stringify(args[0]) ?? "");
    return emit.call(this, event, ...args);
  } as typeof emit;
  t.after(() => {
    Worker.prototype.emit = emit;
  });
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  const launch = gateway(assets, reader);
  try {
    assert.match(assets.environmentLaunch!.issuer, /^[A-Za-z0-9_-]+$/u);
    const bound = (await launch.prepare(alpha)).apply({});
    assert.equal(bound.SERVICE_KEY, SECRET);
    assert.equal(bound.SHARED, PROJECT_VALUE, "the Thread's own Project override wins");
    const unbound = (await launch.prepare(plain)).apply({});
    assert.equal(unbound.SHARED, GLOBAL_VALUE, "an unbound Thread receives personal values only");
    assert.ok(seen.length > 0, "the spy observed Worker replies");
    for (const message of seen)
      for (const value of [SECRET, PROJECT_VALUE, GLOBAL_VALUE])
        assert.ok(!message.includes(value), "no decrypted value crossed into Main");
    // The Worker serves no decrypted getter: unknown methods never run.
    const store = assets.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const method of ["readDocument", "launchEnvironment", "snapshot"])
      await assert.rejects(store[method]!(f.account, "document-env"));
  } finally {
    launch.close();
    await reader.close();
    await assets.close();
  }
});

test("the vault owner refuses wrong-project, forged and cross-Thread contexts", async (t) => {
  const f = await durable(t);
  const alpha = { hostId: "opencraft-server" as const, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-1" };
  const beta = { hostId: "opencraft-server" as const, threadId: "dsh-beta", turnId: "dsh-turn-dsh-beta-1" };
  f.admit(alpha.threadId, "alpha-input", alpha.turnId);
  f.admit(beta.threadId, "beta-input", beta.turnId);
  await seed(f.directory, f.account, { [alpha.threadId]: "alpha", [beta.threadId]: "beta" });
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  const launch = gateway(assets, reader);
  try {
    const owned = (await reader.resolve(alpha))!;
    const target = { purpose: "dsh" as const, instance: attachment, key: new EnvironmentLaunchIssuer().key };
    const seal = (context: EnvironmentLaunchContext) => assets.environmentLaunch!.seal(target, context);
    assert.match(await seal(owned), /^env1\./u);
    const forged: EnvironmentLaunchContext[] = [
      // A caller selecting a Project, even its own Thread's, is refused.
      { ...owned, scope: { ...owned.scope, projectId: "beta" } },
      { ...owned, scope: { ...owned.scope, projectId: "alpha" } },
      // Contexts that are not the durable admission of that Turn.
      { ...owned, scope: { ...owned.scope, executionId: "forged-execution" } },
      { ...owned, scope: { ...owned.scope, account: "actor:human://fixture/other" } },
      { ...owned, scope: { ...owned.scope, threadId: beta.threadId } },
      { ...owned, native: { ...owned.native, incarnation: "native-other" } },
      { ...owned, scope: { ...owned.scope, hostId: "local-codex" } },
    ];
    for (const context of forged) await assert.rejects(seal(context), JSON.stringify(context.scope));
    // The receiver never forwards a Project: a locator naming one is refused.
    await assert.rejects(launch.prepare({ ...alpha, projectId: "beta" } as GitExecutionLocator));
    // Each Thread still receives exactly its own Project values.
    assert.equal((await launch.prepare(beta)).apply({}).SHARED, "synthetic-beta-project-value");
    assert.equal((await launch.prepare(alpha)).apply({}).SHARED, PROJECT_VALUE);
  } finally {
    launch.close();
    await reader.close();
    await assets.close();
  }
});

test("one ENV owner: two owners or an issuer that did not start are refused at startup", async (t) => {
  const port = { issuer: "a".repeat(44), seal: async () => "" };
  assert.equal(environmentLaunchOwner(undefined, undefined), null);
  assert.equal(environmentLaunchOwner(undefined, { executionEnvironment: {} }), null);
  // Delivery does not name the owner: core's Worker unless the identity
  // composition supplies the port; the earlier spelling means the same.
  for (const delivery of ["opaque", "vault-owner"]) {
    assert.equal(environmentLaunchOwner(delivery, { providers: [] }), "core");
    assert.equal(environmentLaunchOwner(delivery, { environmentLaunch: port }), "identity");
    assert.throws(() => environmentLaunchOwner(delivery, { executionEnvironment: {} }), {
      message: "Execution ENV cannot have two owners",
    });
    assert.throws(() => environmentLaunchOwner(delivery, { executionEnvironment: {}, environmentLaunch: port }), {
      message: "Execution ENV cannot have two owners",
    });
  }
  assert.equal(environmentLaunchOwner(undefined, { environmentLaunch: port }), "identity");
  assert.throws(() => environmentLaunchOwner("synchronous", undefined));
  const f = await durable(t);
  // Without durable admission the vault owner would have to trust the relay.
  await assert.rejects(createAssetsStorage(f.directory, [], undefined, undefined, { environmentLaunch: true }), {
    message: "Environment delivery requires execution admission",
  });
  // A Worker build that cannot issue refuses to start instead of running without ENV.
  await assert.rejects(openAssetConfigurations(f.directory, { environmentLaunch: true }));
});

test("close drains an in-flight seal and retires the issuer; a restarted owner keeps its sealed key", async (t) => {
  const f = await durable(t);
  const alpha = { hostId: "opencraft-server" as const, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-1" };
  f.admit(alpha.threadId, "alpha-input", alpha.turnId);
  await seed(f.directory, f.account, { [alpha.threadId]: "alpha" });
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(() => reader.close());
  const owned = (await reader.resolve(alpha))!;
  const target = { purpose: "dsh" as const, instance: attachment, key: new EnvironmentLaunchIssuer().key };
  const first = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  const pinned = gateway(first, reader);
  assert.equal((await pinned.prepare(alpha)).apply({}).SHARED, PROJECT_VALUE);
  const inFlight = first.environmentLaunch!.seal(target, owned);
  const closed = first.close();
  assert.match(await inFlight, /^env1\./u, "a seal accepted before close completes");
  await closed;
  await assert.rejects(first.environmentLaunch!.seal(target, owned), "no seal after close");
  // Restart: the issuer key is sealed in the vault, so an execution owner that
  // pinned it before the restart keeps receiving ENV without being relaunched.
  const second = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  try {
    assert.equal(second.environmentLaunch!.issuer, first.environmentLaunch!.issuer);
    const survivor = createRemoteEnvironmentLaunch({
      purpose: "dsh",
      instance: attachment,
      issuer: first.environmentLaunch!.issuer,
      capabilities: {
        hostEnvironment: (threadId, source, recipient) =>
          createHostEnvironmentLaunch({
            port: second.environmentLaunch!,
            handoff: (locator) => second.store.executionGitGrant(locator),
            routes: () => true,
          })({ serverId: attachment, threadId, execution: source } as CapabilitySession, recipient),
      },
      admission: (input) => reader.resolve(input),
    });
    const once = (await survivor.prepare(alpha)).apply({});
    assert.equal(once.SHARED, PROJECT_VALUE);
    survivor.close();
  } finally {
    pinned.close();
    await second.close();
  }
});

test("explicit rotation replaces the sealed key; the publication follows it and old pins fail closed", async (t) => {
  const f = await durable(t);
  const alpha = { hostId: "opencraft-server" as const, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-1" };
  f.admit(alpha.threadId, "alpha-input", alpha.turnId);
  seed(f.directory, f.account, { [alpha.threadId]: "alpha" });
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(() => reader.close());
  const publish = join(f.root, "run", "environment-issuer.json");
  const published = async () => JSON.parse(await readFile(publish, "utf8")) as { schemaVersion: number; issuer: string };
  const open = (generation?: string) =>
    openHeadlessAssetsStorage(f.directory, {
      environmentLaunch: true,
      environmentIssuer: { publish, ...(generation ? { generation } : {}) },
    });
  const first = await open();
  const original = first.environmentLaunch!.issuer;
  await first.close();
  assert.deepEqual(await published(), { schemaVersion: 1, issuer: original });
  assert.equal((await stat(publish)).mode & 0o777, 0o600);
  // Generation "1" names a rotation from the unlabelled key; repeating it keeps the new key.
  const rotated = await open("1");
  const next = rotated.environmentLaunch!.issuer;
  await rotated.close();
  assert.notEqual(next, original);
  assert.deepEqual(await published(), { schemaVersion: 1, issuer: next });
  const rotatedAt = (await stat(publish)).mtimeMs;
  const again = await open("1");
  try {
    assert.equal(again.environmentLaunch!.issuer, next);
    // An unchanged key is not rewritten, so a watching supervisor relaunches nothing.
    assert.equal((await stat(publish)).mtimeMs, rotatedAt);
    // An owner still pinned to the retired key fails closed; the new pin works.
    const stale = gateway(again, reader, original);
    await assert.rejects(stale.prepare(alpha), { message: "environment_launch_unavailable" });
    stale.close();
    const current = gateway(again, reader, next);
    assert.equal((await current.prepare(alpha)).apply({}).SERVICE_KEY, SECRET);
    current.close();
  } finally {
    await again.close();
  }
  // Without a generation the stored key is kept, whatever its label.
  const kept = await open();
  assert.equal(kept.environmentLaunch!.issuer, next);
  await kept.close();
  // A publication without delivery, or a malformed generation, is refused.
  await assert.rejects(createAssetsStorage(f.directory, [], undefined, undefined, { environmentIssuer: { publish } }));
  await assert.rejects(open("not a generation"));
});

test("a stored issuer document that is not a key is refused instead of silently rotated", () => {
  const documents = new Map<string, { revision: number; document: unknown }>();
  const vault = {
    readDocument: (account: string, namespace: string) =>
      documents.get(`${account}/${namespace}`) ?? { revision: 0, document: null },
    writeDocument: (account: string, namespace: string, revision: number, document: unknown) => {
      documents.set(`${account}/${namespace}`, { revision: revision + 1, document });
    },
  };
  const key = sealedEnvironmentIssuerKey(vault);
  assert.equal(key.asymmetricKeyType, "x25519");
  const [stored] = [...documents.values()];
  assert.equal(stored!.revision, 1);
  // The stored form is only the private key in the vault's sealed document.
  assert.deepEqual(Object.keys(stored!.document as object).sort(), ["generation", "privateKey", "version"]);
  for (const document of [
    { version: 1, generation: null, privateKey: "AAAA" },
    { version: 2, generation: null, privateKey: (stored!.document as { privateKey: string }).privateKey },
    { version: 1, generation: null, privateKey: (stored!.document as { privateKey: string }).privateKey, extra: true },
    "not a document",
  ]) {
    documents.set([...documents.keys()][0]!, { revision: 1, document });
    assert.throws(() => sealedEnvironmentIssuerKey(vault), { message: "environment_launch_unavailable" });
  }
});

test("a receiver pinned to an unissuable key fails closed for a Human Turn and leaves unowned Turns empty", async (t) => {
  const f = await durable(t);
  const alpha = { hostId: "opencraft-server" as const, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-1" };
  const plain = { hostId: "opencraft-server" as const, threadId: "dsh-unowned", turnId: "dsh-turn-dsh-unowned-1" };
  f.admit(alpha.threadId, "alpha-input", alpha.turnId);
  f.admit(plain.threadId, "system-input", plain.turnId, { sender: null });
  seed(f.directory, f.account, { [alpha.threadId]: "alpha" });
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  // What a supervisor pins while no key is published.
  const pending = gateway(assets, reader, await unissuableEnvironmentIssuer());
  try {
    await assert.rejects(pending.prepare(alpha), { message: "environment_launch_unavailable" });
    assert.deepEqual(Object.keys((await pending.prepare(plain)).apply({})), []);
  } finally {
    pending.close();
    await reader.close();
    await assets.close();
  }
});
