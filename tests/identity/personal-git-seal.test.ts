import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { ExecutionEnvironmentRuntime, type EnvironmentExecutionScope } from "@opencraft/execution-environment";
import { openGitGrant, type GitGrantScope } from "@opencraft/execution-environment/personal-git-protocol";
import {
  PersonalGitSealOwner,
  personalGitGrantFields,
  type PersonalGitSealPort,
} from "@opencraft/execution-environment/personal-git-seal";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { openHeadlessAssetsStorage } from "../../apps/headless-server/src/headless-assets-storage.js";

const admissionWorker = fileURLToPath(
  new URL("../../apps/headless-server/src/execution-admission.worker.ts", import.meta.url),
);

/** Real Actor store and real execution lease store, as the Gateway writes them. */
async function durable(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "git-seal-")),
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
  const identities = new ThreadIdentityDatabase(join(directory, "thread-identities/opencraft-server")),
    leases = new ExecutionLeaseStore(identities.database);
  const native = await observeNativeExecutionProcess(process.pid);
  const context = {
    sender: null,
    executionPrincipal: principal,
    actorContext: login.login.context,
    validUntil: principal.expiresAt,
  };
  const admit = (threadId: string, inputId: string, turnId: string) => {
    leases.capture(threadId, inputId, snapshotExecutionSubmission(context), "accepted");
    const executionId = leases.begin(threadId, inputId, native.incarnation);
    leases.started(threadId, turnId, inputId, native.incarnation);
    return executionId;
  };
  // The vault and its key exist before the owner Worker opens them.
  new EmployeeGitVaultStore(directory).close();
  const reader = openExecutionAdmission({ workerFile: admissionWorker, directory });
  t.after(async () => {
    await reader.close();
    identities.close();
    management.close();
    accounts.close();
    members.close();
    actors.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  /** Main's admission: the durable record read off this event loop. */
  const admitted = async (threadId: string, turnId: string) =>
    (await reader.resolve({ hostId: "opencraft-server", threadId, turnId }))!.scope;
  return { root, directory, leases, admit, admitted, actors, actorId: login.login.context.actorId };
}

/** Every message any Worker sends to this (Main) thread, and the Workers themselves. */
function spyWorkers(t: test.TestContext) {
  const messages: string[] = [],
    workers = new Set<Worker>();
  const emit = Worker.prototype.emit;
  Worker.prototype.emit = function (this: Worker, event: string | symbol, ...args: unknown[]) {
    workers.add(this);
    if (event === "message") messages.push(JSON.stringify(args[0]) ?? "");
    return emit.call(this, event, ...args);
  } as typeof emit;
  t.after(() => {
    Worker.prototype.emit = emit;
  });
  return { messages, workers };
}

/** An in-process issuer-mode runtime, as an identity composition constructs it. */
function runtime(t: test.TestContext, directory: string, root: string, gitSeal?: PersonalGitSealPort) {
  const previous = {
    runtime: process.env.OPENCRAFT_GIT_RUNTIME_DIRECTORY,
    worker: process.env.OPENCRAFT_GIT_WORKER_FILE,
  };
  process.env.OPENCRAFT_GIT_RUNTIME_DIRECTORY = join(root, "git-runtime");
  process.env.OPENCRAFT_GIT_WORKER_FILE = join(root, "unused-worker.mjs");
  const vault = new EmployeeGitVaultStore(directory);
  const value = new ExecutionEnvironmentRuntime(directory, vault, false, "issuer", gitSeal ? { gitSeal } : {});
  for (const [name, item] of [
    ["OPENCRAFT_GIT_RUNTIME_DIRECTORY", previous.runtime],
    ["OPENCRAFT_GIT_WORKER_FILE", previous.worker],
  ] as const)
    if (item === undefined) delete process.env[name];
    else process.env[name] = item;
  t.after(() => {
    value.close();
    vault.close();
  });
  return value;
}
const executionScope = (scope: GitGrantScope): EnvironmentExecutionScope =>
  ({ ...personalGitGrantFields(scope), projectId: null }) as EnvironmentExecutionScope;

test("a grant the vault-owner Worker seals verifies exactly like one sealed in-process; no key or value reaches Main", async (t) => {
  const f = await durable(t);
  const threadId = "seal-alpha",
    turnId = "dsh-turn-seal-alpha-1";
  f.admit(threadId, "alpha-input", turnId);
  const scope = await f.admitted(threadId, turnId);
  // The synchronous in-process issuer, as before this port.
  const local = new EmployeeGitVaultStore(f.directory);
  const inProcess = local.sealPersonalGitGrant(personalGitGrantFields(scope)),
    authority = local.personalGitAuthority("actor");
  local.close();
  const key = await readFile(join(f.directory, "employee-git-vault.key"));

  const spy = spyWorkers(t);
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  t.after(() => assets.close());
  const port = assets.personalGitSeal!;
  assert.equal(port.authority, authority, "the same grant authority as the in-process issuer");
  const sealed = await port.seal(personalGitGrantFields(scope));
  assert.match(sealed, /^v3\./u);
  assert.equal(sealed.length, inProcess.length);
  // The Git runtime's own verifier opens both to the same scope.
  assert.deepEqual(openGitGrant(key, sealed), openGitGrant(key, inProcess));
  assert.deepEqual(openGitGrant(key, sealed), personalGitGrantFields(scope));

  // An issuer-mode bridge accepts the Worker's grant and advertises the same authority.
  const owner = runtime(t, f.directory, f.root, port);
  const snapshot = await owner.prepare(executionScope(scope));
  const environment = snapshot.overlay();
  assert.equal(environment.OPENCRAFT_GIT_BROKER_AUTHORITY, authority);
  assert.deepEqual(openGitGrant(key, environment.OPENCRAFT_GIT_CAPABILITY), personalGitGrantFields(scope));

  assert.ok(spy.messages.length > 0, "the spy observed Worker replies");
  const secrets = [key.toString("hex"), key.toString("base64"), key.toString("base64url")];
  for (const message of spy.messages) {
    for (const secret of secrets) assert.ok(!message.includes(secret), "no vault key crossed into Main");
  }
  // The Worker serves no key or credential getter: unknown methods never run.
  const store = assets.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of ["sealPersonalGitGrant", "personalGitAuthority", "readCredential"])
    await assert.rejects(store[method]!(scope));
});

test("issuance follows admission and every await is rechecked: a revoked lease or Actor is refused", async (t) => {
  const f = await durable(t);
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  t.after(() => assets.close());
  const port = assets.personalGitSeal!;
  f.admit("seal-lease", "lease-input", "dsh-turn-seal-lease-1");
  f.admit("seal-actor", "actor-input", "dsh-turn-seal-actor-1");
  const lease = await f.admitted("seal-lease", "dsh-turn-seal-lease-1"),
    actor = await f.admitted("seal-actor", "dsh-turn-seal-actor-1");

  // Claims that are not the owner's durable admission are refused.
  for (const forged of [
    { ...lease, executionId: "forged-execution" },
    { ...lease, leaseGeneration: lease.leaseGeneration + 1 },
    { ...lease, actorGeneration: lease.actorGeneration! + 1 },
    { ...lease, inputId: "actor-input" },
    { ...lease, account: "actor:human://fixture/other" },
    { ...lease, account: "local:owner", actorGeneration: undefined, membershipRevision: undefined },
  ])
    await assert.rejects(port.seal(forged as GitGrantScope), JSON.stringify(forged));

  // Admitted in Main, then the lease ends before the Worker seals.
  assert.match(await port.seal(lease), /^v3\./u);
  f.leases.finished("seal-lease", "dsh-turn-seal-lease-1");
  await assert.rejects(port.seal(lease), "an ended lease is not sealed");
  // Admitted in Main, then the Actor is disabled before the Worker seals.
  f.actors.setEnabled(f.actorId, false, "fixture");
  await assert.rejects(port.seal(actor), "a disabled Actor is not sealed");

  // Main's own recheck: a runtime closed while its grant was in flight never
  // returns a snapshot.
  let release!: () => void;
  const held: PersonalGitSealPort = {
    authority: port.authority,
    seal: async (scope) => {
      await new Promise<void>((resolve) => (release = resolve));
      return `v3.${"A".repeat(43)}${scope.inputId.length}`;
    },
  };
  const owner = runtime(t, f.directory, f.root, held);
  const pending = owner.prepare(executionScope(lease));
  owner.close();
  release();
  await assert.rejects(pending);
});

test("a failed vault owner fails closed: no synchronous fallback, no grant", async (t) => {
  const f = await durable(t);
  f.admit("seal-fail", "fail-input", "dsh-turn-seal-fail-1");
  const scope = await f.admitted("seal-fail", "dsh-turn-seal-fail-1");
  const spy = spyWorkers(t);
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  t.after(() => assets.close().catch(() => {}));
  const port = assets.personalGitSeal!;
  const owner = runtime(t, f.directory, f.root, port);
  // The synchronous snapshot never signs with the local vault key instead.
  assert.throws(() => owner.snapshot(executionScope(scope)), { message: "personal_git_async_issuer_required" });
  assert.ok((await owner.prepare(executionScope(scope))).overlay().OPENCRAFT_GIT_CAPABILITY);
  for (const worker of spy.workers) await worker.terminate();
  await assert.rejects(port.seal(scope));
  // A fresh scope (not cached) must reach the dead owner and is refused.
  f.admit("seal-fail-2", "fail-input-2", "dsh-turn-seal-fail-2-1");
  const next = await f.admitted("seal-fail-2", "dsh-turn-seal-fail-2-1");
  await assert.rejects(owner.prepare(executionScope(next)));
  assert.throws(() => owner.snapshot(executionScope(scope)), { message: "personal_git_async_issuer_required" });
});

test("close drains an in-flight seal; later seals are refused", async (t) => {
  const f = await durable(t);
  f.admit("seal-close", "close-input", "dsh-turn-seal-close-1");
  const scope = await f.admitted("seal-close", "dsh-turn-seal-close-1");
  const assets = await openHeadlessAssetsStorage(f.directory, { environmentLaunch: true });
  const port = assets.personalGitSeal!;
  const inFlight = port.seal(scope);
  const closed = assets.close();
  assert.match(await inFlight, /^v3\./u, "a seal accepted before close completes");
  await closed;
  await assert.rejects(port.seal(scope), "no seal after close");
  // The Worker-side owner refuses once retired, before reading admission.
  let reads = 0;
  const sealOwner = new PersonalGitSealOwner(
    { personalGitAuthority: () => "a".repeat(64), sealPersonalGitGrant: () => "v3.sealed" },
    (claim) => (reads++, claim),
  );
  assert.equal(sealOwner.seal(scope), "v3.sealed");
  assert.equal(reads, 2, "admission is read before and after signing");
  sealOwner.close();
  assert.throws(() => sealOwner.seal(scope), { message: "personal_git_execution_unavailable" });
  assert.equal(reads, 2);
});

test("without a separate vault owner every path is unchanged", async (t) => {
  const f = await durable(t);
  f.admit("seal-default", "default-input", "dsh-turn-seal-default-1");
  const scope = await f.admitted("seal-default", "dsh-turn-seal-default-1");
  const key = await readFile(join(f.directory, "employee-git-vault.key"));
  // The synchronous issuer: snapshot and prepare both sign in-process.
  await mkdir(join(f.root, "git-runtime"), { recursive: true, mode: 0o700 });
  const owner = runtime(t, f.directory, f.root);
  for (const snapshot of [owner.snapshot(executionScope(scope)), await owner.prepare(executionScope(scope))])
    assert.deepEqual(openGitGrant(key, snapshot.overlay().OPENCRAFT_GIT_CAPABILITY), personalGitGrantFields(scope));
  // An owner without ENV delivery serves no seal port.
  const assets = await openHeadlessAssetsStorage(f.directory);
  try {
    assert.equal(assets.personalGitSeal, undefined);
    const store = assets.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    await assert.rejects(store.personalGitSeal!(scope));
  } finally {
    await assets.close();
  }
  assert.throws(
    () =>
      new ExecutionEnvironmentRuntime(f.directory, {} as EmployeeGitVaultStore, false, "disabled", {
        gitSeal: { authority: "forged", seal: async () => "" },
      }),
  );
});
