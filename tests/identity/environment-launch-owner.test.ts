import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";

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
