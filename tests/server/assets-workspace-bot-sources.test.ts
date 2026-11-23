import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { MembershipStore } from "@opencraft/access-control";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { SandboxConfigurations, SandboxConfigurationError } from "@opencraft/plugin-assets/server/configurations";
import { PLATFORM_ASSET_SCOPE } from "@opencraft/plugin-assets/contract";
import type { AssetStoragePort } from "@opencraft/plugin-assets/server";
import { WorkerOwner } from "@opencraft/worker-owner";
import type { spawnAssistant } from "@opencraft/personal-assistant/host";
import type { WorkspaceActorAdmission } from "../../apps/headless-server/src/workspaces/actor-authority.js";
import type { WorkspaceBotPort, WorkspaceBotSourcePort } from "../../apps/headless-server/src/workspaces/bot-owner.js";
import { createWorkspaceBotProvider } from "../../apps/headless-server/src/workspaces/bot-client.js";

type Port = WorkspaceBotPort &
  WorkspaceBotSourcePort &
  AssetStoragePort & {
    fixtureStats(): Promise<{ allocated: number; deleted: number; commands: number; keys: string[]; threadId: number }>;
    fixtureUnknownCreate(): Promise<void>;
  };
type Brain = Parameters<typeof spawnAssistant>[0];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const flag = () => {
  const value = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(value, 0, 1);
  return value;
};
const standard = { apiUrl: "https://api.e2b.dev", sandboxUrl: "https://e2b.dev" };
const custom = { apiUrl: "https://api.sandbox.example", sandboxUrl: "https://sandbox.example" };
const ordinary = (id: string) => ({ id, owner: "ordinary-owner", backend: "e2b" });
const large = { cpuMillis: 3000, memoryBytes: 1024 ** 3 };

async function fixture(t: test.TestContext, worker: { legacy?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bot-sources-"));
  const db = await openServerDatabase(directory),
    actors = new ActorStore(db),
    members = new MembershipStore(db);
  const principal = (subject: string) => ({
    provider: "local",
    subject,
    displayName: subject,
    expiresAt: Date.now() + 120000,
  });
  const admin = actors.resolveHuman(principal("admin"))!,
    member = actors.resolveHuman(principal("member"))!;
  members.setActor(admin.actorId, "admin", true, "fixture");
  members.setActor(member.actorId, "member", true, "fixture");
  const vault = await EmployeeGitVaultStore.open(directory),
    config = new SandboxConfigurations(vault);
  const seed = (scope: string, name: string, apiKey: string, endpoints = standard) => {
    const platform = scope === PLATFORM_ASSET_SCOPE,
      owner = platform ? "actor:" + admin.actorId : scope,
      source = platform ? { source: "platform" } : {};
    const before = config.snapshot(owner, true, true);
    const credential = config
      .update(
        owner,
        {
          action: "save-credential",
          revision: platform ? before.platformRevision : before.revision,
          ...source,
          name,
          apiKey,
          ...endpoints,
        },
        true,
        true,
      )
      .credentials.find((c) => c.name === name)!;
    const after = config.snapshot(owner, true, true);
    config.update(
      owner,
      {
        action: "save-environment",
        revision: platform ? after.platformRevision : after.revision,
        ...source,
        name,
        credentialId: credential.id,
        templateId: name,
      },
      true,
      true,
    );
  };
  config.adoptInstallation(
    {
      backend: "e2b",
      ...standard,
      capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
      lease: { timeoutMs: 60000, renewEveryMs: 10000, maxLifetimeMs: 3600000 },
      templates: [
        {
          id: "installed",
          name: "Installed",
          workspaceRoot: "/workspace",
          resources: { cpuMillis: 2000, memoryBytes: 2 * 1024 ** 3 },
        },
      ],
    },
    "key-installed",
  );
  seed("actor:" + admin.actorId, "personal", "key-personal");
  seed("actor:" + admin.actorId, "custom", "key-custom", custom);
  seed("actor:" + member.actorId, "member-custom", "key-member-custom", custom);
  seed(PLATFORM_ASSET_SCOPE, "shared", "key-shared");
  const fingerprint = (r: ReturnType<SandboxConfigurations["runtime"]>[number], platform = false) =>
    hash([
      ...(platform ? ["platform"] : []),
      r.environment.id,
      r.environment.templateId,
      r.credential.id,
      r.credential.generation,
      r.credential.apiUrl,
      r.credential.sandboxUrl,
    ]);
  const own = config.runtime("actor:" + admin.actorId, true);
  const personal = own.find((r) => r.environment.name === "personal")!,
    customRecord = own.find((r) => r.environment.name === "custom")!,
    shared = config.runtime(PLATFORM_ASSET_SCOPE, true, "platform").find((r) => r.environment.name === "shared")!;
  const partition = worker.legacy ? "legacy:admin" : "actor:" + admin.actorId;
  const ids = {
    personal: "e2b-" + hash([partition, admin.generation, fingerprint(personal)]).slice(0, 40),
    custom: "e2b-" + hash([partition, admin.generation, fingerprint(customRecord)]).slice(0, 40),
    shared: "e2b-shared-" + hash([fingerprint(shared, true)]).slice(0, 40),
    installed: "e2b",
  };
  vault.close();
  const workerData = {
    directory,
    ...(worker.legacy ? { legacyPartition: { [admin.actorId]: "legacy:admin" } } : {}),
  };
  const open = async () =>
    (
      await WorkerOwner.open<Port>(new URL("../fixtures/assets-bot-sources.worker.ts", import.meta.url), {
        name: "Synthetic Bot sources owner",
        workerData,
        errors: [SandboxConfigurationError],
      })
    ).owner;
  let owner = await open();
  const access = (actorId = admin.actorId): WorkspaceActorAdmission => ({
    actorId,
    generation: actors.get(actorId)!.generation,
    membershipRevision: members.revocationRevision(actorId, actors.bindings(actorId)),
    expiresAt: Date.now() + 120000,
    requestPermit: flag(),
    resourcePermit: flag(),
  });
  const brains: Brain[] = [],
    clients: ReturnType<typeof createWorkspaceBotProvider>[] = [];
  const client = (admission: (actorId: string) => WorkspaceActorAdmission = access) => {
    const value = createWorkspaceBotProvider({
      port: owner.call,
      onCleanupUnconfirmed() {},
      admission: (context) => admission(context.actorId),
      spawnLocal: (input) => {
        brains.push(input);
        return { ready: Promise.resolve(null), failed: () => false, close: async () => {} };
      },
    });
    clients.push(value);
    return value;
  };
  const source = (botId = "bot", ownerId = admin.actorId) => ({
    directory: "/private/main/brain",
    profileOptions: { apiKey: "brain-only-key" },
    request: async (method: string) => {
      assert.equal(method, "opencraft/personal-assistant/authorize");
      return {
        binding: {
          serverId: "server:fixture",
          botId,
          assignmentId: "assignment-" + botId,
          owner: { kind: "human", id: ownerId },
        },
        epoch: "epoch-1",
        expiresAt: Date.now() + 60000,
      };
    },
  });
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await owner.close().catch(() => {});
    members.close();
    actors.close();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    admin,
    member,
    actors,
    members,
    ids,
    access,
    client,
    brains,
    source,
    get port() {
      return owner.call;
    },
    async restart() {
      for (const c of clients) await c.close().catch(() => {});
      await owner.close().catch(() => {});
      owner = await open();
    },
  };
}
const run = async (brain: Brain, callId = "call") =>
  (await brain.request("environment/run", {
    argv: ["echo", "fixture"],
    workId: "work",
    callId,
    timeoutMs: 1000,
  })) as { state: string };
const sandbox = (backendId: string, templateId: string) => ({ kind: "sandbox" as const, backendId, templateId });

test("an Actor's catalogue lists personal, then platform, then installed, with disjoint IDs and no secrets or allocation", async (t) => {
  const f = await fixture(t),
    catalog = await f.port.workspaceBotSources(f.access());
  assert.deepEqual(
    catalog.providers.map((p) => p.backendId),
    [f.ids.personal, f.ids.custom, f.ids.shared, f.ids.installed],
  );
  // The installed template is published once, as the installed source.
  assert.deepEqual(catalog.providers.at(-1)!.templates, [{ id: "installed", name: "Installed" }]);
  for (const secret of ["key-", "apiKey", "api.e2b.dev", "sandbox.example"])
    assert.ok(!JSON.stringify(catalog).includes(secret), secret);
  assert.equal((await f.port.fixtureStats()).allocated, 0);
  // Custom endpoints are an administrator's; a member sees only shared sources.
  const foreign = await f.port.workspaceBotSources(f.access(f.member.actorId));
  assert.deepEqual(
    foreign.providers.map((p) => p.backendId),
    [f.ids.shared, f.ids.installed],
  );
  await assert.rejects(
    f.port.workspaceBotSourceOpen(f.access(f.member.actorId), foreign.revision, sandbox(f.ids.personal, "personal")),
  );
  await assert.rejects(f.port.workspaceBotSourceValidate(f.access(), "stale", sandbox(f.ids.personal, "personal")));
  // The Main facade lists the same sources for the Bot owner.
  const providers = await f.client().forContext(f.admin);
  assert.deepEqual(Object.keys(providers), [f.ids.personal, f.ids.custom, f.ids.shared, f.ids.installed]);
  await providers[f.ids.shared]!.validate!(sandbox(f.ids.shared, "shared"));
  await assert.rejects(providers[f.ids.shared]!.validate!(sandbox(f.ids.installed, "installed")));
});

for (const kind of ["personal", "shared", "installed"] as const)
  test(`the ${kind} source runs in the vault Worker with its own credential and reserves the installation budget`, async (t) => {
    const f = await fixture(t),
      providers = await f.client().forContext(f.admin),
      provider = providers[f.ids[kind]]!;
    const [template] = await provider.templates();
    const handle = await provider.spawn(sandbox(f.ids[kind], template!.id), f.source());
    assert.equal((await f.port.fixtureStats()).allocated, 0, "opening never allocates");
    assert.equal(f.brains[0]!.directory, "/private/main/brain");
    assert.equal(f.brains[0]!.executionEnvironment?.backendId, f.ids[kind]);
    assert.equal((await run(f.brains[0]!)).state, "completed");
    const stats = await f.port.fixtureStats();
    assert.equal(stats.allocated, 1);
    assert.ok(stats.threadId > 0);
    assert.deepEqual(stats.keys, ["key-" + kind]);
    await assert.rejects(f.port.workspaceBudgetReserve("ordinary", ordinary("while-bot"), large));
    await handle.close();
    assert.equal((await f.port.fixtureStats()).deleted, 1);
    const key = await f.port.workspaceBudgetReserve("ordinary", ordinary("after-bot"), large);
    await f.port.workspaceBudgetSettle(key, "not-created");
  });

test("a published entry outlives its request but not a disabled Actor or revoked membership", async (t) => {
  const f = await fixture(t),
    proof = f.access(),
    providers = await f.client(() => proof).forContext(f.admin);
  const handle = await providers[f.ids.personal]!.spawn(sandbox(f.ids.personal, "personal"), f.source());
  Atomics.store(proof.requestPermit, 0, 0);
  assert.equal((await run(f.brains[0]!)).state, "completed");
  const commands = (await f.port.fixtureStats()).commands;
  // The Worker reads committed membership itself; Main's permit is still set.
  f.members.setActor(f.admin.actorId, "admin", false, "fixture");
  await assert.rejects(run(f.brains[0]!, "after-membership-revocation"));
  assert.equal((await f.port.fixtureStats()).commands, commands);
  assert.deepEqual(await f.client().forContext(f.admin), {});
  await assert.rejects(f.port.workspaceBotSources(f.access()));
  await handle.close();
  assert.equal((await f.port.fixtureStats()).deleted, 1);
  // A disabled Actor has no environment either, from any source.
  const other = await f.client().forContext(f.member);
  assert.ok(Object.keys(other).length > 0);
  f.actors.setEnabled(f.member.actorId, false, "fixture");
  assert.deepEqual(await f.client().forContext(f.member), {});
});

test("request cancellation while the original assignment is pending denies publication in the Worker", async (t) => {
  const f = await fixture(t),
    proof = f.access(),
    providers = await f.client(() => proof).forContext(f.admin),
    original = f.source();
  let entered!: () => void, release!: () => void;
  const seen = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const spawning = providers[f.ids.shared]!.spawn(sandbox(f.ids.shared, "shared"), {
    ...original,
    request: async (method: string) => {
      entered();
      await gate;
      return original.request(method);
    },
  });
  const rejected = assert.rejects(spawning);
  await seen;
  Atomics.store(proof.requestPermit, 0, 0);
  release();
  await rejected;
  assert.equal(f.brains.length, 0);
  assert.equal((await f.port.fixtureStats()).allocated, 0);
});

test("an uncertain personal creation stays charged across Worker replacement", async (t) => {
  const f = await fixture(t),
    providers = await f.client().forContext(f.admin);
  const handle = await providers[f.ids.personal]!.spawn(sandbox(f.ids.personal, "personal"), f.source());
  await f.port.fixtureUnknownCreate();
  assert.equal((await run(f.brains[0]!)).state, "rejected");
  await handle.close().catch(() => {});
  await f.restart();
  assert.equal((await f.port.workspaceBotSources(f.access())).providers.length, 4);
  await assert.rejects(f.port.workspaceBudgetReserve("ordinary", ordinary("after-unknown"), large));
});

test("rotating a personal key retires only entries on that source and needs a new selection", async (t) => {
  const f = await fixture(t),
    providers = await f.client().forContext(f.admin);
  const installed = await providers.e2b!.spawn(sandbox("e2b", "installed"), f.source("installed-bot"));
  const personal = await providers[f.ids.personal]!.spawn(
    sandbox(f.ids.personal, "personal"),
    f.source("personal-bot"),
  );
  assert.equal((await run(f.brains[0]!)).state, "completed");
  assert.equal((await run(f.brains[1]!)).state, "completed");
  const admission = {
    scope: "actor:" + f.admin.actorId,
    permit: flag(),
    expiresAt: Date.now() + 60000,
    allowCustomEndpoints: true,
    canManagePlatform: true,
  };
  const snapshot = await f.port.snapshot(admission),
    credential = snapshot.credentials.find((c) => c.name === "personal")!;
  await f.port.update(admission, {
    action: "save-credential",
    revision: snapshot.revision,
    id: credential.id,
    name: "personal",
    ...standard,
    apiKey: "key-rotated",
  });
  assert.equal((await run(f.brains[0]!, "installed-after-rotation")).state, "completed");
  const commands = (await f.port.fixtureStats()).commands;
  await assert.rejects(run(f.brains[1]!, "personal-after-rotation"));
  assert.equal((await f.port.fixtureStats()).commands, commands);
  const next = await f.port.workspaceBotSources(f.access());
  assert.ok(!next.providers.some((p) => p.backendId === f.ids.personal));
  assert.equal(next.providers.length, 4);
  await personal.close();
  await installed.close();
});

test("a composition's backend identity keeps personal IDs of its older partition", async (t) => {
  const f = await fixture(t, { legacy: true });
  const catalog = await f.port.workspaceBotSources(f.access());
  // Only personal IDs follow the hook; platform and installed IDs are unchanged.
  assert.deepEqual(
    catalog.providers.map((p) => p.backendId),
    [f.ids.personal, f.ids.custom, f.ids.shared, f.ids.installed],
  );
  const providers = await f.client().forContext(f.admin);
  const handle = await providers[f.ids.personal]!.spawn(sandbox(f.ids.personal, "personal"), f.source());
  assert.equal((await run(f.brains[0]!)).state, "completed");
  await handle.close();
  // The hook is consulted only for personal records; once the member has one
  // the hook cannot place, its whole catalogue is denied.
  assert.equal((await f.port.workspaceBotSources(f.access(f.member.actorId))).providers.length, 2);
  const admission = {
    scope: "actor:" + f.member.actorId,
    permit: flag(),
    expiresAt: Date.now() + 60000,
    allowCustomEndpoints: false,
    canManagePlatform: false,
  };
  const before = await f.port.snapshot(admission);
  const saved = await f.port.update(admission, {
    action: "save-credential",
    revision: before.revision,
    name: "member",
    ...standard,
    apiKey: "key-member",
  });
  await f.port.update(admission, {
    action: "save-environment",
    revision: saved.revision,
    name: "member",
    credentialId: saved.credentials.find((c) => c.name === "member")!.id,
    templateId: "member",
  });
  await assert.rejects(f.port.workspaceBotSources(f.access(f.member.actorId)));
});

test("the installation-wide port keeps serving the installed source beside per-Actor sources", async (t) => {
  const f = await fixture(t),
    client = f.client();
  assert.deepEqual(await client.templates(), [{ id: "installed", name: "Installed" }]);
  const legacy = await client.spawn(sandbox("e2b", "installed"), f.source("legacy-bot"));
  const providers = await client.forContext(f.admin);
  const scoped = await providers[f.ids.shared]!.spawn(sandbox(f.ids.shared, "shared"), f.source("scoped-bot"));
  assert.equal((await run(f.brains[0]!)).state, "completed");
  assert.equal((await run(f.brains[1]!)).state, "completed");
  assert.deepEqual((await f.port.fixtureStats()).keys.sort(), ["key-installed", "key-shared"]);
  await scoped.close();
  await legacy.close();
  assert.equal((await f.port.fixtureStats()).deleted, 2);
});

test("a platform pool is shared by members but keeps each Bot's own assignment and lease", async (t) => {
  const f = await fixture(t),
    first = await f.client().forContext(f.admin),
    second = await f.client().forContext(f.member);
  let epoch = "epoch-1";
  const original = f.source("bot-one"),
    changing = { ...original, request: async (method: string) => ({ ...(await original.request(method)), epoch }) };
  const environment = sandbox(f.ids.shared, "shared");
  const one = await first[f.ids.shared]!.spawn(environment, changing);
  const two = await second[f.ids.shared]!.spawn(environment, f.source("bot-two", f.member.actorId));
  assert.equal((await run(f.brains[0]!)).state, "completed");
  assert.equal((await run(f.brains[1]!)).state, "completed");
  epoch = "epoch-2";
  await assert.rejects(run(f.brains[0]!, "changed-epoch"));
  await one.close();
  assert.equal((await f.port.fixtureStats()).deleted, 1);
  assert.equal((await run(f.brains[1]!, "still-valid")).state, "completed");
  await two.close();
  assert.equal((await f.port.fixtureStats()).deleted, 2);
});
