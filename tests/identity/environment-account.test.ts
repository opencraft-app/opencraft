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
import { openExecutionAdmission } from "@opencraft/execution-environment/execution-admission";
import { EnvironmentLaunchIssuer } from "@opencraft/execution-environment/environment-delivery";
import { EnvironmentLaunchOwner } from "@opencraft/execution-environment/environment-launch-owner";
import { createRemoteEnvironmentLaunch } from "@opencraft/execution-environment/remote-environment-launch";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { AccountEnvironment } from "@opencraft/execution-environment/account-environment";
import { EnvironmentMetadata, environmentProjectId } from "@opencraft/execution-environment/environment-metadata";
import {
  EnvironmentAccountPartitions,
  type EnvironmentAccountMapping,
  type EnvironmentAccountOwner,
  type EnvironmentLoginBinding,
} from "@opencraft/execution-environment/environment-account";
import type { CapabilitySession } from "@opencraft/session-capabilities";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { openAssetConfigurations } from "../../plugins/assets/src/server/worker.js";
import { openHeadlessAssetsStorage } from "../../apps/headless-server/src/headless-assets-storage.js";
import { createHostEnvironmentLaunch } from "../../apps/headless-server/src/host-environment-launch.ts";

const HOST = "opencraft-server";
const attachment = "server:fixture:dsh";
const admissionWorker = fileURLToPath(
  new URL("../../apps/headless-server/src/execution-admission.worker.ts", import.meta.url),
);
const mappedEntry = new URL("../fixtures/assets-environment-account.worker.ts", import.meta.url);
const LOGIN_SECRET = "synthetic-login-partition-secret";
const LOGIN_PROJECT = "synthetic-login-partition-project";
const CANONICAL_SECRET = "synthetic-canonical-partition-secret";

// ---------------------------------------------------------------------------
// The resolver's own rules, against an in-memory Actor projection.

function projection(owners: Record<string, EnvironmentAccountOwner>) {
  const state = { owners };
  return {
    state,
    reader: {
      owner: (actorId: string) => state.owners[actorId] ?? null,
      actorOf: (binding: EnvironmentLoginBinding) =>
        Object.values(state.owners).find((o) =>
          o.bindings.some((b) => b.provider === binding.provider && b.subject === binding.subject),
        )?.actorId ?? null,
    },
  };
}
const ownerA = (): EnvironmentAccountOwner => ({
  actorId: "human://fixture/a",
  actorGeneration: 3,
  bindings: [
    { provider: "local", subject: "a" },
    { provider: "directory", subject: "staff-7" },
  ],
});
const directory: EnvironmentAccountMapping = (owner) => {
  const logins = owner.bindings.filter((b) => b.provider === "directory");
  return logins.length === 1 ? `${logins[0]!.provider}:${logins[0]!.subject}` : null;
};
const refused = { message: "environment_account_unavailable" };

test("the mapping chooses only among the Actor's own verified partitions", () => {
  const { reader } = projection({ "human://fixture/a": ownerA() });
  const accounts = new EnvironmentAccountPartitions(reader, directory);
  const selected = accounts.forActor("actor:human://fixture/a", 3);
  assert.equal(selected.partition, "directory:staff-7");
  assert.equal(selected.current(), true);
  // The canonical partition stays a valid choice.
  assert.equal(
    new EnvironmentAccountPartitions(reader, (o) => `actor:${o.actorId}`).forActor("actor:human://fixture/a", 3)
      .partition,
    "actor:human://fixture/a",
  );
  // The same verified owner, reached from a login account of a submission.
  assert.equal(accounts.forLogin("local:a").partition, "directory:staff-7");
  assert.equal(accounts.forLogin("directory:staff-7").partition, "directory:staff-7");
  for (const mapping of [
    () => "directory:staff-8", // not a binding of this Actor
    () => "actor:human://fixture/b", // another Actor's canonical partition
    () => "platform:environment", // installation documents
    () => "",
    () => null,
    () => Promise.resolve("directory:staff-7") as never, // a mapping cannot await
    () => {
      throw Error("mapping failed");
    },
  ] as EnvironmentAccountMapping[])
    assert.throws(
      () => new EnvironmentAccountPartitions(reader, mapping).forActor("actor:human://fixture/a", 3),
      refused,
    );
  // A different generation, a non-canonical account and an unknown login are refused.
  assert.throws(() => accounts.forActor("actor:human://fixture/a", 2), refused);
  assert.throws(() => accounts.forActor("directory:staff-7", 3), refused);
  assert.throws(() => accounts.forLogin("directory:staff-9"), refused);
  assert.throws(() => new EnvironmentAccountPartitions(reader, "directory" as never));
});

test("ambiguous mappings fail closed", () => {
  const two = ownerA();
  const { reader } = projection({
    [two.actorId]: { ...two, bindings: [...two.bindings, { provider: "directory", subject: "staff-8" }] },
  });
  // Two logins of one provider: the composition picked one, core refuses it.
  const first: EnvironmentAccountMapping = (o) => {
    const b = o.bindings.find((x) => x.provider === "directory")!;
    return `${b.provider}:${b.subject}`;
  };
  assert.throws(() => new EnvironmentAccountPartitions(reader, first).forActor(`actor:${two.actorId}`, 3), refused);
  assert.throws(() => new EnvironmentAccountPartitions(reader, directory).forActor(`actor:${two.actorId}`, 3), refused);
  // A login account that two bindings spell the same way names no single owner.
  const split = projection({
    "human://fixture/x": {
      actorId: "human://fixture/x",
      actorGeneration: 1,
      bindings: [{ provider: "a:b", subject: "c" }],
    },
    "human://fixture/y": {
      actorId: "human://fixture/y",
      actorGeneration: 1,
      bindings: [{ provider: "a", subject: "b:c" }],
    },
  });
  assert.throws(
    () => new EnvironmentAccountPartitions(split.reader, (o) => `actor:${o.actorId}`).forLogin("a:b:c"),
    refused,
  );
  // The same spelling inside one Actor is ambiguous as a partition too.
  const same = projection({
    "human://fixture/z": {
      actorId: "human://fixture/z",
      actorGeneration: 1,
      bindings: [
        { provider: "a:b", subject: "c" },
        { provider: "a", subject: "b:c" },
      ],
    },
  });
  assert.throws(
    () => new EnvironmentAccountPartitions(same.reader, () => "a:b:c").forActor("actor:human://fixture/z", 1),
    refused,
  );
});

test("a binding revoked after an await point is refused at the recheck", async () => {
  const p = projection({ "human://fixture/a": ownerA() });
  const accounts = new EnvironmentAccountPartitions(p.reader, directory);
  const selected = accounts.forActor("actor:human://fixture/a", 3);
  const login = accounts.forLogin("local:a");
  await new Promise((resolve) => setTimeout(resolve, 1));
  // The directory login is removed without a generation change.
  p.state.owners = { "human://fixture/a": { ...ownerA(), bindings: [{ provider: "local", subject: "a" }] } };
  assert.equal(selected.current(), false);
  assert.equal(login.current(), false);
  assert.throws(() => accounts.forActor("actor:human://fixture/a", 3), refused);
  // A disabled Actor reads as no owner.
  p.state.owners = {};
  assert.throws(() => accounts.forLogin("local:a"), refused);
});

test("the issuer rechecks the mapping around the value read and refuses a binding revoked meanwhile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "env-account-issuer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EmployeeGitVaultStore(join(root, "data"));
  t.after(() => store.close());
  new AccountEnvironment(store).replace("directory:staff-7", { projectId: null }, 0, [
    { name: "SERVICE_KEY", value: LOGIN_SECRET, secret: true },
  ]);
  const p = projection({ "human://fixture/a": ownerA() });
  let revokeOnRead = false;
  const vault = {
    readDocument: (partition: string, key: string) => {
      if (revokeOnRead && partition === "directory:staff-7")
        p.state.owners = { "human://fixture/a": { ...ownerA(), bindings: [{ provider: "local", subject: "a" }] } };
      return store.readDocument(partition, key);
    },
    writeDocument: store.writeDocument.bind(store),
  };
  const admitted = {
    scope: {
      account: "actor:human://fixture/a",
      hostId: HOST,
      threadId: "dsh-alpha",
      inputId: "input",
      executionId: "execution",
      leaseGeneration: 1,
      actorGeneration: 3,
      membershipRevision: 0,
      projectId: null,
    },
    native: { turnId: "dsh-turn-dsh-alpha-1", incarnation: "native" },
  } as const;
  const issuer = new EnvironmentLaunchOwner(
    vault,
    () => admitted,
    {},
    {
      accounts: new EnvironmentAccountPartitions(p.reader, directory),
    },
  );
  t.after(() => issuer.close());
  const target = { purpose: "dsh" as const, instance: attachment, key: new EnvironmentLaunchIssuer().key };
  assert.match(issuer.seal(target, admitted), /^env1\./u);
  revokeOnRead = true;
  assert.throws(() => issuer.seal(target, admitted), { message: "environment_launch_unavailable" });
});

test("metadata admission records the mapped partition; without a mapping it is unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "env-account-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = new EmployeeGitVaultStore(join(root, "data"));
  t.after(() => vault.close());
  const p = projection({ "human://fixture/a": ownerA() });
  const mapped = new EnvironmentMetadata(vault, new EnvironmentAccountPartitions(p.reader, directory));
  const scope = mapped.admit({ account: "local:a", hostId: HOST, threadId: null, projectId: "alpha" });
  assert.deepEqual(scope, { account: "directory:staff-7", hostId: HOST, threadId: null, projectId: "alpha" });
  mapped.bindCreator(scope, "task-1");
  mapped.bind(HOST, "task-1", "alpha");
  assert.deepEqual(mapped.creator(HOST, "task-1"), { account: "directory:staff-7" });
  assert.equal(
    mapped.admit({ account: "directory:staff-7", hostId: HOST, threadId: "task-1", projectId: null }).projectId,
    "alpha",
  );
  // An unknown login or an anonymous request to a creator's Thread is refused.
  assert.throws(() => mapped.admit({ account: "local:other", hostId: HOST, threadId: null, projectId: null }));
  assert.throws(() => mapped.admit({ account: null, hostId: HOST, threadId: "task-1", projectId: null }));
  const plain = new EnvironmentMetadata(vault);
  assert.equal(plain.admit({ account: "local:a", hostId: HOST, threadId: null, projectId: null }).account, "local:a");
});

// ---------------------------------------------------------------------------
// The real vault Worker, Actor store and execution lease store.

async function durable(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "env-account-")),
    dataDirectory = join(root, "data");
  const storage = await openServerDatabase(dataDirectory),
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
  const owner = login.login.context;
  const verified = (subject: string) => ({
    provider: "directory",
    subject,
    displayName: "Synthetic directory login",
    expiresAt: Date.now() + 60_000,
  });
  const identities = new ThreadIdentityDatabase(join(dataDirectory, "thread-identities/opencraft-server")),
    leases = new ExecutionLeaseStore(identities.database);
  const native = await observeNativeExecutionProcess(process.pid);
  const admit = (threadId: string, inputId: string, turnId: string) => {
    const context = {
      sender: null,
      executionPrincipal: principal,
      actorContext: actors.get(owner.actorId) ? { ...owner, generation: actors.get(owner.actorId)!.generation } : owner,
      validUntil: principal.expiresAt,
    };
    leases.capture(threadId, inputId, snapshotExecutionSubmission(context), "accepted");
    leases.begin(threadId, inputId, native.incarnation);
    leases.started(threadId, turnId, inputId, native.incarnation);
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
    directory: dataDirectory,
    admit,
    login: `${principal.provider}:${principal.subject}`,
    canonical: `actor:${owner.actorId}`,
    bind: (subject: string) =>
      actors.bindHuman({ ...owner, generation: actors.get(owner.actorId)!.generation }, verified(subject)),
    unbind: (subject: string) =>
      actors.unbindHuman(
        { ...owner, generation: actors.get(owner.actorId)!.generation },
        { provider: "directory", subject },
      ),
  };
}
/** Values exist under the login partition (existing data) and, differently,
 * under the canonical partition; the Thread is bound to Project alpha. */
function seed(directoryPath: string, canonical: string, threadId: string) {
  const vault = new EmployeeGitVaultStore(directoryPath);
  try {
    const environment = new AccountEnvironment(vault);
    environment.replace("directory:staff-7", { projectId: null }, 0, [
      { name: "SERVICE_KEY", value: LOGIN_SECRET, secret: true },
    ]);
    environment.replace("directory:staff-7", { projectId: environmentProjectId(HOST, "alpha") }, 0, [
      { name: "SHARED", value: LOGIN_PROJECT, secret: true },
    ]);
    environment.replace(canonical, { projectId: null }, 0, [
      { name: "SERVICE_KEY", value: CANONICAL_SECRET, secret: true },
    ]);
    new EnvironmentMetadata(vault).bind(HOST, threadId, "alpha");
  } finally {
    vault.close();
  }
}
async function mappedOwner(directoryPath: string, policy: string) {
  const prior = process.env.OPENCRAFT_TEST_ENVIRONMENT_ACCOUNT;
  process.env.OPENCRAFT_TEST_ENVIRONMENT_ACCOUNT = policy;
  try {
    return await openAssetConfigurations(directoryPath, { entry: mappedEntry, environmentLaunch: true });
  } finally {
    if (prior === undefined) delete process.env.OPENCRAFT_TEST_ENVIRONMENT_ACCOUNT;
    else process.env.OPENCRAFT_TEST_ENVIRONMENT_ACCOUNT = prior;
  }
}
type Owner = Awaited<ReturnType<typeof openAssetConfigurations>>;
function gateway(assets: Owner, reader: ReturnType<typeof openExecutionAdmission>) {
  const route = createHostEnvironmentLaunch({
    port: assets.environmentLaunch!,
    handoff: (locator) => assets.store.executionGitGrant(locator),
    routes: () => true,
  });
  return createRemoteEnvironmentLaunch({
    purpose: "dsh",
    instance: attachment,
    issuer: assets.environmentLaunch!.issuer,
    capabilities: {
      hostEnvironment: (threadId, source, recipient) =>
        route({ serverId: attachment, threadId, execution: source } as CapabilitySession, recipient),
    },
    admission: (input) => reader.resolve(input),
  });
}

test("a compiled mapping delivers existing login-partition data unchanged; nothing decrypted reaches Main", async (t) => {
  const f = await durable(t);
  const alpha = { hostId: HOST, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-1" } as const;
  f.bind("staff-7");
  f.admit(alpha.threadId, "alpha-input", alpha.turnId);
  seed(f.directory, f.canonical, alpha.threadId);
  const seen: string[] = [];
  const emit = Worker.prototype.emit;
  Worker.prototype.emit = function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event === "message") seen.push(JSON.stringify(args[0]) ?? "");
    return emit.call(this, event, ...args);
  } as typeof emit;
  t.after(() => {
    Worker.prototype.emit = emit;
  });
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(() => reader.close());
  const assets = await mappedOwner(f.directory, "directory");
  const launch = gateway(assets, reader);
  try {
    const values = (await launch.prepare(alpha)).apply({});
    assert.equal(values.SERVICE_KEY, LOGIN_SECRET, "values come from the mapped login partition");
    assert.equal(values.SHARED, LOGIN_PROJECT, "Project values come from the same partition");
    // Creator provenance names the same partition the values come from.
    const scope = await assets.environmentMetadata!.admit({
      account: f.login,
      hostId: HOST,
      threadId: null,
      projectId: null,
    });
    assert.equal(scope.account, "directory:staff-7");
    assert.ok(seen.length > 0);
    for (const message of seen)
      for (const value of [LOGIN_SECRET, LOGIN_PROJECT, CANONICAL_SECRET])
        assert.ok(!message.includes(value), "no decrypted value crossed into Main");
    // Revoking the login retires the mapping: the next launch is refused.
    f.unbind("staff-7");
    await assert.rejects(launch.prepare(alpha));
  } finally {
    launch.close();
    await assets.close();
  }
});

test("a partition outside the verified bindings or an ambiguous one is refused by the vault owner", async (t) => {
  const f = await durable(t);
  const alpha = { hostId: HOST, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-1" } as const;
  f.bind("staff-7");
  f.admit(alpha.threadId, "alpha-input", alpha.turnId);
  seed(f.directory, f.canonical, alpha.threadId);
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(() => reader.close());
  const foreign = await mappedOwner(f.directory, "foreign");
  const refusedLaunch = gateway(foreign, reader);
  try {
    await assert.rejects(refusedLaunch.prepare(alpha));
    await assert.rejects(
      foreign.environmentMetadata!.admit({ account: f.login, hostId: HOST, threadId: null, projectId: null }),
    );
  } finally {
    refusedLaunch.close();
    await foreign.close();
  }
  // A second directory login makes a "first match" mapping ambiguous.
  f.bind("staff-8");
  const second = { hostId: HOST, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-2" } as const;
  f.admit(second.threadId, "second-input", second.turnId);
  // The admission itself is valid: the canonical owner delivers it.
  const canonical = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  const plain = gateway(canonical, reader);
  try {
    assert.equal((await plain.prepare(second)).apply({}).SERVICE_KEY, CANONICAL_SECRET);
  } finally {
    plain.close();
    await canonical.close();
  }
  const first = await mappedOwner(f.directory, "first");
  const ambiguous = gateway(first, reader);
  try {
    await assert.rejects(ambiguous.prepare(second));
  } finally {
    ambiguous.close();
    await first.close();
  }
});

test("without a mapping the core vault owner still reads only the canonical partition", async (t) => {
  const f = await durable(t);
  const alpha = { hostId: HOST, threadId: "dsh-alpha", turnId: "dsh-turn-dsh-alpha-1" } as const;
  f.bind("staff-7");
  f.admit(alpha.threadId, "alpha-input", alpha.turnId);
  seed(f.directory, f.canonical, alpha.threadId);
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory: f.directory });
  t.after(() => reader.close());
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  const launch = gateway(assets, reader);
  try {
    const values = (await launch.prepare(alpha)).apply({});
    assert.equal(values.SERVICE_KEY, CANONICAL_SECRET);
    assert.equal(values.SHARED, undefined, "no login-partition Project value");
    assert.equal(
      (await assets.environmentMetadata!.admit({ account: f.login, hostId: HOST, threadId: null, projectId: null }))
        .account,
      f.login,
    );
  } finally {
    launch.close();
    await assets.close();
  }
});
