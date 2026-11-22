import { openWorkspaceExecutionService } from "../../apps/headless-server/src/workspaces/execution-service.js";
import { createWorkspaceNativeRouting } from "../../apps/headless-server/src/workspaces/native-routing.js";
import { WorkspacePlacementProjection } from "../../apps/headless-server/src/workspaces/placement-projection.js";
import { createWorkspaceExecutionAuthority } from "@opencraft/sandbox-node/workspace-execution-channel";
import { privateWorkspaceExecutionPolicy } from "../../apps/codex-core/src/workspace-execution-policy.js";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
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

test("physical Native routing composes Worker allocation, one-shot Core policy, exact receipts and resumed generation", async (t) => {
  const f = await fixture(t),
    directory = await mkdtemp(join(tmpdir(), "workspace-physical-routing-"));
  const socketPath = join(directory, "authority.sock"),
    token = "synthetic-physical-workspace-authority";
  const authority = await createWorkspaceExecutionAuthority({ socketPath, token });
  t.after(async () => {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  });
  const placement = new WorkspacePlacementProjection(f.port);
  assert.throws(() => placement.has("native-physical"), "Uninitialized placement cannot imply local");
  await placement.refresh();
  const context: TransportSubmissionContext = { sender: null };
  const hooks = createWorkspaceNativeRouting({
    port: f.port,
    placement,
    authority,
    admit: () => f.access(),
    onCleanupUnconfirmed() {},
  });
  const calls: { method: unknown; params: Record<string, unknown> }[] = [],
    registrations: unknown[] = [];
  const policy = privateWorkspaceExecutionPolicy({
    socketPath,
    token,
    readThread: async () => {
      throw Error("Must not infer local");
    },
    nativeRequest: async (_method, params) => {
      registrations.push(params);
      return {};
    },
  });
  const nativeObservers = new Set<(frame: string) => void>();
  const native: DuplexTransport = {
    status: { state: "open" },
    async connect() {},
    async close() {},
    subscribeStatus: () => () => {},
    subscribeMessage: (listener) => {
      nativeObservers.add(listener);
      return () => {
        nativeObservers.delete(listener);
      };
    },
    async send(frame) {
      const message = JSON.parse(frame);
      calls.push({ method: message.method, params: await policy(message.method, message.params) });
    },
  };
  const methods = new Map<string | number, string>();
  const transport = hooks.decorateNativeTransport!(native, (requestId) =>
    methods.has(requestId) ? { method: methods.get(requestId)!, context: () => context } : null,
  );
  t.after(async () => {
    await transport.close();
    placement.close();
  });
  const environment = await f.target(),
    send = async (id: number, method: string, params: unknown) => {
      methods.set(id, method);
      await transport.send(JSON.stringify({ id, method, params }));
    };
  await send(1, "thread/start", { workspacePlacement: { version: 1, intentId: "physical-create", environment } });
  assert.equal(
    hooks.requiresWorkspaceResume!("native-physical"),
    false,
    "Provider preparation is not a durable Native identity",
  );
  assert.equal(calls[0]!.params.cwd, "/workspace");
  assert.deepEqual(calls[0]!.params.runtimeWorkspaceRoots, ["/workspace"]);
  assert.equal(
    (calls[0]!.params.environments as { environmentId: string }[])[0]!.environmentId.startsWith("workspace-"),
    true,
  );
  assert.equal(registrations.length, 1);
  await hooks.finalizeNativeCreation!({
    requestId: 1,
    context,
    params: {},
    result: { thread: { id: "native-physical" } },
  });
  assert.equal(hooks.requiresWorkspaceResume!("native-physical"), true);
  await send(2, "turn/start", { threadId: "native-physical", input: [{ text: "synthetic-no-model-call" }] });
  await send(3, "thread/resume", { threadId: "native-physical", path: "/old/cached/rollout" });
  await hooks.finalizeNativeResume!({
    requestId: 3,
    context,
    params: {},
    result: { thread: { id: "native-physical" } },
  });
  assert.equal((await f.port.fixtureCounters()).allocated, 1);
  assert.equal(registrations.length, 1, "No redundant Native environment upsert");
  for (let id = 10; id < 75; id++)
    await assert.rejects(
      send(id, "thread/start", {
        workspacePlacement: { version: 1, intentId: "physical-create", environment },
      }),
      /already created/,
      "Confirmed duplicate preparation must not consume unresolved receipt capacity",
    );

  let confirmed = 0;
  await hooks.restoreProvisionalWorkspace!({
    threadId: "native-physical",
    context,
    confirm: async () => {
      confirmed++;
      return { thread: { id: "native-physical" } };
    },
  });
  assert.equal(confirmed, 1, "Empty Thread restore requires actual retained Native evidence");
  assert.equal(calls.length, 3, "Provisional restore never replays Native creation");
  await assert.rejects(send(4, "thread/fork", { threadId: "native-physical" }));
  await assert.rejects(
    send(5, "thread/start", {
      ephemeral: true,
      workspacePlacement: { version: 1, intentId: "ephemeral-denied", environment },
    }),
  );
  for (const observe of nativeObservers)
    observe(
      JSON.stringify({
        id: 100,
        result: { thread: { id: "native-orphan", environments: [{ environmentId: "workspace-ws-orphan" }] } },
      }),
    );
  assert.equal(hooks.requiresWorkspaceResume!("native-orphan"), true);
  const beforeOrphan = calls.length;
  await assert.rejects(send(6, "turn/start", { threadId: "native-orphan", cwd: "/local" }));
  assert.equal(
    calls.length,
    beforeOrphan,
    "Actual Native remote evidence without Worker placement cannot become local input",
  );
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-worker-execution-key|__opencraft_workspace_grant/);
});

test("placement projection keeps classification fenced on refresh failure and advances only complete committed pages", async () => {
  let fail = false,
    calls = 0;
  const projection = new WorkspacePlacementProjection({
    workspacePlacementPage: async (cursor) => {
      calls++;
      if (fail) throw Error("Synthetic owner unavailable");
      return cursor === undefined
        ? { items: [{ workspaceId: "ws-a", hostId: "local-codex", threadId: "remote-a" }], next: "ws-a" }
        : { items: [{ workspaceId: "ws-b", hostId: "local-codex", threadId: "remote-b" }], next: null };
    },
  });
  await projection.refresh();
  assert.equal(calls, 2);
  assert.equal(projection.has("remote-a"), true);
  assert.equal(projection.has("remote-b"), true);
  fail = true;
  await assert.rejects(projection.refresh());
  assert.throws(() => projection.has("remote-a"));
  assert.throws(() => projection.has("other-local"));
  fail = false;
  await projection.refresh();
  assert.equal(projection.has("remote-a"), true);
  projection.observeNativeThread({ id: "orphan-remote", environments: [{ environmentId: "workspace-ws-orphan" }] });
  projection.observeNativeThread({ id: "known-local", environments: [{ environmentId: "opencraft" }] });
  assert.equal(projection.has("orphan-remote"), true);
  assert.equal(projection.isKnownLocal("known-local"), true);
  await projection.refresh();
  assert.equal(projection.has("orphan-remote"), true, "Journal absence cannot erase actual Native remote evidence");
  projection.observeNativeThread({ id: "orphan-remote", environments: [{ environmentId: "opencraft" }] });
  assert.equal(projection.isKnownLocal("orphan-remote"), false, "A new selection cannot silently reconcile an orphan");
  projection.forgetNativeLocal();
  assert.equal(projection.isKnownLocal("known-local"), false);
  projection.close();
  assert.throws(() => projection.has("remote-a"));
});

test("Gateway workspace service composes the existing Worker catalog and scoped files without opening another resource writer", async (t) => {
  const f = await fixture(t),
    actor = f.access(),
    environment = await f.target();
  const token = await f.port.workspaceBegin(actor, { kind: "start", intentId: "gateway-service", environment });
  await settled(f.port, token, "native-ready");
  await f.port.workspaceNativeReceipt(token, { result: { thread: { id: "native-gateway-service" } } });
  const directory = await mkdtemp(join(tmpdir(), "workspace-gateway-service-"));
  let live = true,
    localCalls = 0;
  const service = await openWorkspaceExecutionService({
    port: f.port,
    socketPath: join(directory, "authority.sock"),
    token: "synthetic-gateway-service-authority",
    actors: {
      get: (id) =>
        id === actor.actorId
          ? {
              id,
              kind: "human",
              enabled: true,
              generation: actor.generation,
              displayName: "Fixture",
              createdAt: 0,
              createdBy: null,
            }
          : null,
      isCurrent: (context) =>
        live &&
        context.actorId === actor.actorId &&
        context.generation === actor.generation &&
        context.expiresAt > Date.now(),
      bindings: () => [{ provider: "local", subject: "fixture" }],
      onAuthorityChanged: () => () => {},
    },
    access: { admitsActor: () => true, store: { revocationRevision: () => 0, onAuthorityChanged: () => () => {} } },
    onCleanupUnconfirmed() {},
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const context: TransportSubmissionContext = {
    sender: null,
    actorContext: {
      actorId: actor.actorId,
      generation: actor.generation,
      credentialId: null,
      expiresAt: Date.now() + 60000,
    },
  };
  assert.equal((await service.readCatalog("local-codex", context)).environments.length, 1);
  assert.deepEqual(await service.readFileScope("local-codex", context, "native-gateway-service"), {
    kind: "workspace",
    threadId: "native-gateway-service",
    root: "/workspace",
  });
  assert.equal(
    service.createCodexWorkspaceHooks({ hostId: "local-codex" }).requiresWorkspaceResume!("native-gateway-service"),
    true,
  );
  const local = async () => {
    localCalls++;
    return { files: { request: async () => ({ local: true }) }, assertCurrent() {} };
  };
  const files = await service.selectHostFiles(
    "local-codex",
    context,
    { workspaceThreadId: "native-gateway-service" },
    local,
  );
  assert.deepEqual(await files.files.request("fs/readDirectory", { path: "/workspace" }), { entries: [] });
  await assert.rejects(service.selectHostFiles("local-codex", context, { workspaceThreadId: "unknown-thread" }, local));
  assert.equal(localCalls, 0, "An unresolved remote scope never becomes controller files");
  await assert.rejects(
    service.readFileScope("local-codex", context, "unknown-thread"),
    "A journal absence alone cannot authorize local file scope",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(files.files.request("fs/readDirectory", { path: "/workspace" }, controller.signal));
  live = false;
  await assert.rejects(files.assertCurrent());
  await assert.rejects(service.readCatalog("local-codex", context));
  assert.equal((await f.port.fixtureCounters()).allocated, 1);
  await service.close();
  await assert.rejects(service.readFileScope("local-codex", context, "native-gateway-service"));
  assert.equal((await f.port.fixtureCounters()).retained, 1, "The composition does not own/close the caller Worker");
});
