import { WorkspaceNativeAdmission } from "../../apps/headless-server/src/workspaces/native-admission.js";
import { WorkspaceNativeHandoff } from "../../apps/headless-server/src/workspaces/native-handoff.js";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerOwner } from "@opencraft/worker-owner";
import type { AssetStoragePort } from "@opencraft/plugin-assets/server";
import { SandboxConfigurationError } from "@opencraft/plugin-assets/server/configurations";
import type {
  WorkspaceExecutionPort,
  WorkspacePreparationStatus,
} from "../../apps/headless-server/src/workspaces/execution-owner.js";
import type { WorkspaceActorAdmission } from "../../apps/headless-server/src/workspaces/actor-authority.js";
type Port = AssetStoragePort &
  WorkspaceExecutionPort & {
    fixtureCounters(): Promise<{ allocated: number; deleted: number; retained: number }>;
    fixtureFailCleanup(): Promise<void>;
    fixtureDisableActor(): Promise<void>;
  };
const flag = () => {
  const value = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(value, 0, 1);
  return value;
};
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-native-owner-"));
  const open = () =>
    WorkerOwner.open<Port, { actorId: string; generation: number }>(
      new URL("../fixtures/assets-workspace-execution.worker.ts", import.meta.url),
      { name: "Synthetic workspace owner", workerData: { directory }, errors: [SandboxConfigurationError] },
    );
  let { owner, ready } = await open();
  t.after(async () => {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  });
  const access = (): WorkspaceActorAdmission => ({
    actorId: ready.actorId,
    generation: ready.generation,
    membershipRevision: 0,
    expiresAt: Date.now() + 60000,
    requestPermit: flag(),
    resourcePermit: flag(),
  });
  const target = async () =>
    (
      await owner.call.workspaceCatalog({
        scope: "actor:" + ready.actorId,
        permit: flag(),
        expiresAt: Date.now() + 60000,
        allowCustomEndpoints: false,
        canManagePlatform: false,
      })
    ).environments[0]!.target;
  return {
    get port() {
      return owner.call;
    },
    access,
    target,
    async reopen() {
      await owner.close();
      ({ owner, ready } = await open());
    },
    async replaceAfterUnconfirmed() {
      await assert.rejects(owner.close());
      ({ owner, ready } = await open());
    },
  };
}
async function settled(port: Port, token: string, desired: WorkspacePreparationStatus["state"]) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const value = await port.workspaceStatus(token);
    if (value.state === desired) return value;
    if (value.state === "failed" && desired !== "failed")
      throw Error("Preparation failed before expected Native phase");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Workspace phase did not settle");
}

test("Worker creates once, binds actual Native receipt, and retains resource authority beyond View/request lifetime", async (t) => {
  const f = await fixture(t),
    admitted = f.access(),
    environment = await f.target();
  const token = await f.port.workspaceBegin(admitted, { kind: "start", intentId: "original-intent", environment });
  const ready = await settled(f.port, token, "native-ready");
  assert.equal(ready.state, "native-ready");
  if (ready.state !== "native-ready") throw Error("unreachable");
  assert.equal(ready.selection.kind, "bound");
  assert.deepEqual(await f.port.fixtureCounters(), { allocated: 1, deleted: 0, retained: 1 });
  const receipt = await f.port.workspaceNativeReceipt(token, { result: { thread: { id: "native-original" } } });
  assert.equal(receipt.threadId, "native-original");
  Atomics.store(admitted.requestPermit, 0, 0);
  await f.port.workspaceCancel(token);
  await f.port.workspaceForget(token);
  assert.equal((await f.port.workspaceSelection(f.access(), receipt.threadId)).kind, "bound");
  assert.deepEqual(await f.port.workspaceFileScope(f.access(), receipt.threadId), {
    kind: "workspace",
    threadId: receipt.threadId,
    root: "/workspace",
  });
  assert.deepEqual(
    await f.port.workspaceFileRequest(f.access(), receipt.threadId, "fs/readDirectory", { path: "/workspace" }),
    { entries: [] },
  );
  const duplicate = await f.port.workspaceBegin(f.access(), {
    kind: "start",
    intentId: "original-intent",
    environment,
  });
  assert.equal((await settled(f.port, duplicate, "complete")).state, "complete");
  assert.equal((await f.port.fixtureCounters()).allocated, 1);
  Atomics.store(admitted.resourcePermit, 0, 0);
  await assert.rejects(f.port.workspaceSelection(f.access(), receipt.threadId));
});

test("cancellation preserves a late positive Native identity and restores the exact workspace after confirmed cleanup", async (t) => {
  const f = await fixture(t),
    environment = await f.target(),
    token = await f.port.workspaceBegin(f.access(), { kind: "start", intentId: "late-intent", environment });
  await settled(f.port, token, "native-ready");
  await f.port.workspaceCancel(token);
  await settled(f.port, token, "failed");
  await assert.rejects(f.port.workspaceForget(token), "Unresolved physical creation cannot be forgotten");
  await assert.rejects(f.port.workspaceNativeReceipt(token, { result: { thread: { id: "late-native" } } }));
  const before = (await f.port.workspacePlacementPage()).items;
  assert.equal(before[0]?.threadId, "late-native");
  await f.reopen();
  assert.deepEqual(
    (await f.port.workspacePlacementPage()).items,
    before,
    "Idle retained workspaces remain remote after restart",
  );
  const restoring = await f.port.workspaceBegin(f.access(), { kind: "restore", threadId: "late-native" });
  const ready = await settled(f.port, restoring, "native-ready");
  assert.equal(ready.state, "native-ready");
  if (ready.state !== "native-ready" || ready.selection.kind !== "bound") throw Error("unreachable");
  assert.equal(ready.selection.workspaceId, before[0]!.workspaceId);
  assert.equal(ready.selection.generation, 2);
  assert.equal(
    (await f.port.workspaceNativeReceipt(restoring, { result: { thread: { id: "late-native" } } })).threadId,
    "late-native",
  );
});

test("readonly Actor epoch recheck records positive Native evidence but refuses revoked publication", async (t) => {
  const f = await fixture(t),
    token = await f.port.workspaceBegin(f.access(), {
      kind: "start",
      intentId: "revoked",
      environment: await f.target(),
    });
  await settled(f.port, token, "native-ready");
  await f.port.fixtureDisableActor();
  await assert.rejects(f.port.workspaceNativeReceipt(token, { result: { thread: { id: "created-before-revoke" } } }));
  assert.equal((await f.port.workspacePlacementPage()).items[0]?.threadId, "created-before-revoke");
  await assert.rejects(f.port.workspaceSelection(f.access(), "created-before-revoke"));
  assert.equal((await f.port.fixtureCounters()).retained, 0);
});

test("failed cleanup retains budget and provider identity across Worker replacement without replay", async (t) => {
  const f = await fixture(t),
    token = await f.port.workspaceBegin(f.access(), {
      kind: "start",
      intentId: "cleanup-unknown",
      environment: await f.target(),
    });
  await settled(f.port, token, "native-ready");
  await f.port.workspaceNativeReceipt(token, { result: { thread: { id: "retained-native" } } });
  await f.port.fixtureFailCleanup();
  await f.replaceAfterUnconfirmed();
  assert.equal((await f.port.fixtureCounters()).retained, 1);
  const restoring = await f.port.workspaceBegin(f.access(), { kind: "restore", threadId: "retained-native" });
  await settled(f.port, restoring, "failed");
  assert.equal(
    (await f.port.fixtureCounters()).allocated,
    0,
    "A retained provider member is not absence and is not replayed",
  );
  await assert.rejects(
    f.port.workspaceBudgetReserve(
      "bot",
      { id: "other", owner: "other", backend: "e2b" },
      { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
    ),
  );
});

test("live restore still waits for the exact Native resume, and invalid receipts cannot consume correlation", async (t) => {
  const f = await fixture(t),
    environment = await f.target();
  const create = await f.port.workspaceBegin(f.access(), { kind: "start", intentId: "live-resume", environment });
  await settled(f.port, create, "native-ready");
  await f.port.workspaceNativeReceipt(create, { result: { thread: { id: "live-native" } } });
  const restore = await f.port.workspaceBegin(f.access(), { kind: "restore", threadId: "live-native" });
  await settled(f.port, restore, "native-ready");
  assert.equal((await f.port.fixtureCounters()).allocated, 1, "Live resume must not allocate again");
  await assert.rejects(f.port.workspaceNativeReceipt(restore, { result: { thread: { id: "foreign-native" } } }));
  assert.equal((await f.port.workspaceStatus(restore)).state, "native-ready");
  assert.equal(
    (await f.port.workspaceNativeReceipt(restore, { result: { thread: { id: "live-native" } } })).threadId,
    "live-native",
  );
});

test("Main Native handoff retains a cancelled late receipt and refreshes committed remote placement", async (t) => {
  const f = await fixture(t),
    context: TransportSubmissionContext = { sender: null };
  let live = true,
    refreshes = 0;
  const operation = new WorkspaceNativeHandoff({
    port: f.port,
    admit: () => f.access(),
    placementChanged: async () => {
      refreshes++;
    },
  });
  const prepared = await operation.prepare(
    1,
    {
      method: "thread/start",
      context: () => {
        if (!live) throw Error("expired");
        return context;
      },
    },
    { kind: "start", intentId: "native-handoff-late", environment: await f.target() },
  );
  assert.equal(prepared.kind, "dispatch");
  if (prepared.kind !== "dispatch") throw Error("unreachable");
  assert.equal((await prepared.resolve()).kind, "bound");
  await operation.abort(1);
  live = false;
  await assert.rejects(
    operation.finalize({ requestId: 1, context, result: { thread: { id: "native-handoff-late" } } }),
  );
  assert.equal(refreshes, 1);
  assert.equal((await f.port.workspacePlacementPage()).items[0]?.threadId, "native-handoff-late");
  await operation.close();
});

test("Main Native handoff requires original context and exact Worker receipt, without replay on duplicate intent", async (t) => {
  const f = await fixture(t),
    context: TransportSubmissionContext = { sender: null };
  const operation = new WorkspaceNativeHandoff({
    port: f.port,
    admit: () => f.access(),
    placementChanged: async () => {},
  });
  const environment = await f.target(),
    request = { method: "thread/start", context: () => context };
  const prepared = await operation.prepare(1, request, { kind: "start", intentId: "native-handoff-once", environment });
  assert.equal(prepared.kind, "dispatch");
  await assert.rejects(
    operation.finalize({ requestId: 1, context: { sender: null }, result: { thread: { id: "wrong-context" } } }),
  );
  await assert.rejects(operation.finalize({ requestId: 1, context, result: { thread: { id: "" } } }));
  assert.equal(
    (await operation.finalize({ requestId: 1, context, result: { thread: { id: "native-handoff-once" } } }))?.threadId,
    "native-handoff-once",
  );
  const duplicate = await operation.prepare(2, request, {
    kind: "start",
    intentId: "native-handoff-once",
    environment,
  });
  assert.equal(duplicate.kind, "existing");
  assert.equal((await f.port.fixtureCounters()).allocated, 1);
  await operation.close();
});

test("trusted Native admission separates login/request expiry from monotonic Actor/member resource revocation", () => {
  const actorId = "human://fixture/native-admission";
  let generation = 1,
    revision = 0,
    enabled = true,
    admitted = true;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const owner = new WorkspaceNativeAdmission({
    actors: {
      get: (id) =>
        id === actorId
          ? { id, kind: "human", enabled, generation, displayName: "Fixture", createdAt: 0, createdBy: null }
          : null,
      isCurrent: (context) => enabled && context.generation === generation && context.expiresAt > Date.now(),
      bindings: () => [{ provider: "local", subject: "fixture" }],
      onAuthorityChanged: subscribe,
    },
    access: {
      admitsActor: () => admitted,
      store: { revocationRevision: () => revision, onAuthorityChanged: subscribe },
    },
  });
  try {
    const context: TransportSubmissionContext = {
      sender: null,
      actorContext: { actorId, generation, credentialId: null, expiresAt: Date.now() + 60000 },
    };
    const first = owner.admit(context),
      second = owner.admit(context);
    assert.equal(first.resourcePermit, second.resourcePermit);
    assert.notEqual(first.requestPermit, second.requestPermit);
    Atomics.store(first.requestPermit, 0, 0);
    assert.equal(Atomics.load(second.resourcePermit, 0), 1);
    assert.throws(() => owner.admit({ ...context, validUntil: Date.now() - 1 }));
    assert.equal(Atomics.load(first.resourcePermit, 0), 1, "Expired login/View does not own published compute");
    revision++;
    for (const notify of listeners) notify();
    assert.equal(Atomics.load(first.resourcePermit, 0), 0);
    const replacement = owner.admit(context);
    assert.equal(Atomics.load(replacement.resourcePermit, 0), 1);
    admitted = false;
    for (const notify of listeners) notify();
    assert.equal(Atomics.load(replacement.resourcePermit, 0), 0);
    admitted = true;
    generation++;
    assert.throws(() => owner.admit(context), "A new Actor generation does not revive the original request");
    enabled = false;
    assert.throws(() => owner.admit({ ...context, actorContext: { ...context.actorContext!, generation } }));
  } finally {
    owner.close();
  }
  assert.equal(listeners.size, 0);
});
