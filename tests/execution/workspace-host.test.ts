import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireCodexWriter } from "@opencraft/account-pool-host";
import { WorkspaceOwner, WorkspaceOwnerConflict, defaultWorkspace, workspaceIdentity } from "@opencraft/workspace-host";
import { codexWorkspaceStorageOutcomes, openCodexWorkspaceHost, type CodexWorkspaceHostOptions } from "../../apps/opencraft-daemon/src/workspace-host.ts";

function options(overrides: Partial<CodexWorkspaceHostOptions> = {}): CodexWorkspaceHostOptions {
  return {
    overlaysLock: true,
    recovery: { serialize: async (_id, work) => work(), inspect: async () => "lost", continue: async () => null, changed() {} },
    providerRetry: { serialize: async (_id, work) => work(), inspect: async () => "unknown", continue: async () => null, changed() {} },
    providerRetryAdmission: () => true,
    schedules: { validate: async () => {}, submit: async () => ({ state: "unknown" }), inspect: async () => ({ state: "unknown" }) },
    diagnostic: () => {},
    schedulesChanged: () => {},
    ...overrides,
  } as CodexWorkspaceHostOptions;
}

async function root(t: test.TestContext, name = "workspace-host-") {
  const directory = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("workspace identity is explicit: an empty root or a non-slug id is refused", () => {
  assert.deepEqual(defaultWorkspace("/data/codex"), { id: "default", root: "/data/codex" });
  assert.throws(() => defaultWorkspace(""), /explicit data root/);
  assert.throws(() => workspaceIdentity("../other", "/data"), /lowercase slug/);
});

test("lifecycle core opens in order, drains dispatch owners, then closes state and releases the lock last", async () => {
  const events: string[] = [];
  const owner = await WorkspaceOwner.open(defaultWorkspace("/virtual"), {
    lock: async () => { events.push("lock"); return () => { events.push("unlock"); }; },
  }, ({ own }) => {
    for (const [name, stage] of [["state-a", "state"], ["state-b", "state"], ["dispatch-a", "dispatch"], ["dispatch-b", "dispatch"]] as const) {
      events.push(`open ${name}`);
      own(name, stage, name, async value => { events.push(`close ${value}`); });
    }
    return "stores";
  });
  assert.equal(owner.stores, "stores");
  await owner.drain();
  assert.equal(owner.phase, "drained");
  assert.deepEqual(events.splice(0), ["lock", "open state-a", "open state-b", "open dispatch-a", "open dispatch-b", "close dispatch-b", "close dispatch-a"]);
  await Promise.all([owner.close(), owner.close()]);
  assert.equal(owner.phase, "closed");
  assert.deepEqual(events, ["close state-b", "close state-a", "unlock"], "drain is not repeated; the lock goes last");
});

test("lifecycle core keeps closing and releases the lock when one store fails to close", async () => {
  const events: string[] = [];
  const owner = await WorkspaceOwner.open(defaultWorkspace("/virtual"), { lock: async () => () => { events.push("unlock"); } }, ({ own }) => {
    own("a", "state", null, () => { events.push("close a"); });
    own("b", "state", null, () => { throw new Error("b failed"); });
    own("c", "dispatch", null, () => { throw new Error("c failed"); });
  });
  await assert.rejects(owner.close(), /c failed/);
  assert.deepEqual(events, ["close a", "unlock"]);
});

test("default workspace opens every WH store at today's Codex data root", async t => {
  const directory = await root(t);
  const host = await openCodexWorkspaceHost(defaultWorkspace(directory), options());
  try {
    assert.deepEqual(host.identity, { id: "default", root: directory });
    assert.deepEqual(codexWorkspaceStorageOutcomes(host).map(row => row.name),
      ["opencraft-host-state", "thread-creation-lifecycle", "conversation-schedules", "interrupted-turn-recovery", "provider-turn-retry"]);
    assert.equal(host.stores.hostState.path, join(directory, "opencraft-host-state.sqlite"));
  } finally { await host.close(); }
});

for (const overlaysLock of [true, false]) test(`a second owner of the same root is refused while the first is open (overlays lock ${overlaysLock})`, async t => {
  const directory = await root(t);
  const first = await openCodexWorkspaceHost(defaultWorkspace(directory), options({ overlaysLock }));
  await assert.rejects(openCodexWorkspaceHost(defaultWorkspace(directory), options({ overlaysLock })), WorkspaceOwnerConflict);
  // The refused owner unwound without closing anything of the first owner.
  first.stores.provisionalThreads.created("thread", { thread: { id: "thread" } });
  assert.equal(first.stores.provisionalThreads.get("thread")?.phase, "created");
  await first.close();
  const second = await openCodexWorkspaceHost(defaultWorkspace(directory), options({ overlaysLock }));
  try { assert.equal(second.stores.provisionalThreads.get("thread")?.phase, "created"); }
  finally { await second.close(); }
});

test("an overlays lock held by another owner refuses opening; close releases the lock", async t => {
  const directory = await root(t);
  const elsewhere = await acquireCodexWriter(join(directory, "host-overlays-owner"));
  await assert.rejects(openCodexWorkspaceHost(defaultWorkspace(directory), options()));
  elsewhere();
  const host = await openCodexWorkspaceHost(defaultWorkspace(directory), options());
  await assert.rejects(acquireCodexWriter(join(directory, "host-overlays-owner")), "the open owner holds the lock");
  await host.close();
  (await acquireCodexWriter(join(directory, "host-overlays-owner")))();
});

test("drain waits for an in-flight recovery and leaves passive state open; close releases the overlays lock", async t => {
  const directory = await root(t);
  let release!: () => void;
  let inspected!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { inspected = resolve; });
  const host = await openCodexWorkspaceHost(defaultWorkspace(directory), options({
    recovery: { serialize: async (_id, work) => work(), changed() {}, continue: async () => null,
      inspect: async () => { inspected(); await held; return "live"; } },
  }));
  host.stores.recovery.started("thread", "turn");
  host.stores.recovery.lost();
  const flight = host.stores.recovery.recover();
  await reached;
  let drained = false;
  const draining = host.drain().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(drained, false, "drain must wait for the recovery flight");
  release();
  await flight;
  await draining;
  assert.equal(host.phase, "drained");
  assert.equal(host.stores.queue.list("thread").length, 0, "drain leaves the queue and host state open");
  await host.close();
  assert.throws(() => host.stores.hostState.database.prepare("SELECT 1").get());
  await host.close();
  const next = await openCodexWorkspaceHost(defaultWorkspace(directory), options());
  await next.close();
});

test("a failed open unwinds in reverse and releases the overlays lock", async t => {
  const directory = await root(t);
  // A directory where a store file belongs makes that store fail to open after earlier stores opened.
  await mkdir(join(directory, "interrupted-turn-recovery.sqlite"));
  await assert.rejects(openCodexWorkspaceHost(defaultWorkspace(directory), options()));
  await rm(join(directory, "interrupted-turn-recovery.sqlite"), { recursive: true });
  const host = await openCodexWorkspaceHost(defaultWorkspace(directory), options());
  await host.close();
});

test("two workspaces with different roots are independent owners", async t => {
  const a = await openCodexWorkspaceHost(workspaceIdentity("a", await root(t, "workspace-a-")), options());
  const b = await openCodexWorkspaceHost(workspaceIdentity("b", await root(t, "workspace-b-")), options());
  try {
    a.stores.provisionalThreads.created("only-a", { thread: { id: "only-a" } });
    assert.equal(b.stores.provisionalThreads.get("only-a"), null);
    await a.close();
    b.stores.provisionalThreads.created("only-b", { thread: { id: "only-b" } });
    assert.equal(b.stores.provisionalThreads.get("only-b")?.phase, "created");
  } finally { await a.close(); await b.close(); }
});
