import { RemoteBrowserService } from "../../apps/headless-server/src/remote-browser-service.mjs";
import { WorkspaceBrowserClient } from "../../apps/headless-server/src/workspaces/browser-client.js";
import { WorkspaceTerminalClient } from "../../apps/headless-server/src/workspaces/terminal-client.js";
import { WorkspaceArtifactClient } from "../../apps/headless-server/src/workspaces/artifact-client.js";
import { createHash } from "node:crypto";
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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    fixtureArtifactStats(): Promise<{ processes: number }>;
    fixtureTerminalStats(): Promise<{ active: number }>;
    fixtureBrowserStats(): Promise<{ owners: number; attached: number; commands: number }>;
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
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of [...cleanup].reverse()) await close();
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
    defer(close: () => Promise<void>) {
      cleanup.push(close);
    },
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
  const nativeHooks = service.createCodexWorkspaceHooks({ hostId: "local-codex" });
  assert.equal(typeof nativeHooks.prepareWorkspaceArtifact, "function");
  const output = await nativeHooks.readWorkspaceArtifact!("native-gateway-service", "/workspace/output.bin", context);
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of output.body) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(131089, 65));
  } finally {
    await output.dispose();
  }
  const terminalScope = {
    account: "actor:" + actor.actorId,
    hostId: "local-codex",
    threadId: "native-gateway-service",
    projectId: null,
  };
  const noLocalTerminal = async (): Promise<never> => {
    throw Error("Must not select a controller PTY");
  };
  const terminal = await service.selectHostTerminalService("local-codex", terminalScope, context, noLocalTerminal);
  assert.strictEqual(
    await service.selectHostTerminalService("local-codex", terminalScope, { ...context }, noLocalTerminal),
    terminal,
    "Each request resolves a stable Actor/incarnation service without changing its authority",
  );
  await terminal.probe();
  await terminal.dispatch(
    "process/spawn",
    { processHandle: "gateway-terminal", command: ["/bin/sh"], tty: true, size: { cols: 80, rows: 24 } },
    terminalScope,
    () => {},
    undefined,
    context,
  );
  assert.equal((await f.port.fixtureTerminalStats()).active, 1);
  live = false;
  await assert.rejects(files.assertCurrent());
  await assert.rejects(service.readCatalog("local-codex", context));
  assert.equal((await f.port.fixtureCounters()).allocated, 1);
  await service.close();
  await assert.rejects(service.readFileScope("local-codex", context, "native-gateway-service"));
  assert.equal((await f.port.fixtureCounters()).retained, 1, "The composition does not own/close the caller Worker");
});

async function artifactClose(port: Port, token: string) {
  for (let i = 0; i < 600; i++) {
    const value = await port.workspaceArtifactClose(token);
    if (value === "closed") return;
    if (value === "failed") throw Error("Artifact cleanup unconfirmed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Artifact cleanup did not settle");
}
async function artifactFixture(t: test.TestContext) {
  const f = await fixture(t),
    token = await f.port.workspaceBegin(f.access(), {
      kind: "start",
      intentId: "artifacts",
      environment: await f.target(),
    });
  await settled(f.port, token, "native-ready");
  await f.port.workspaceNativeReceipt(token, { result: { thread: { id: "native-artifacts" } } });
  return f;
}
test("real Worker artifact credits preserve bounded chunks, do not block the FIFO, and read actual scoped helper output", async (t) => {
  const f = await artifactFixture(t),
    token = await f.port.workspaceArtifactDownload(f.access(), "native-artifacts", "/workspace/output.bin");
  const next = async (sequence: number) => {
    for (let i = 0; i < 600; i++) {
      const value = await f.port.workspaceArtifactRead(token, sequence);
      if (value.state !== "pending") return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Artifact credit did not settle");
  };
  assert.equal((await f.port.workspacePlacementPage()).items[0]?.threadId, "native-artifacts");
  const first = await next(0);
  assert.equal(first.state, "chunk");
  if (first.state !== "chunk") throw Error("unreachable");
  assert.equal(first.data.byteLength, 65536);
  assert.deepEqual(await next(0), first, "Repeated credit never advances the source");
  await assert.rejects(f.port.workspaceArtifactRead(token, 2), "A skipped credit is not an acknowledgement");
  const chunks = [Buffer.from(first.data)];
  for (let sequence = 1; ; sequence++) {
    const value = await next(sequence);
    if (value.state === "done") break;
    assert.equal(value.state, "chunk");
    if (value.state !== "chunk") throw Error("unreachable");
    assert.ok(value.data.byteLength <= 65536);
    chunks.push(Buffer.from(value.data));
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(131089, 65));
  await artifactClose(f.port, token);
  assert.equal((await f.port.fixtureArtifactStats()).processes, 0);
  const stream = await new WorkspaceArtifactClient(f.port).read(
    f.access(),
    "native-artifacts",
    "/workspace/output.bin",
    () => {},
  );
  try {
    const result: Buffer[] = [];
    for await (const chunk of stream.body) result.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(result), Buffer.alloc(131089, 65));
  } finally {
    await stream.dispose();
  }
  assert.equal(
    (await f.port.workspaceSelection(f.access(), "native-artifacts")).kind,
    "bound",
    "Finishing output is not resource destruction",
  );
});

test("Worker artifact uploads cross only byte credits, verify the remote hash receipt, and preserve the Native resource after cancellation", async (t) => {
  const f = await artifactFixture(t),
    client = new WorkspaceArtifactClient(f.port),
    directory = await mkdtemp(join(tmpdir(), "workspace-upload-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "synthetic.bin"),
    bytes = Buffer.alloc(200017, 66);
  await writeFile(source, bytes, { mode: 0o600 });
  const metadata = {
    id: "synthetic-artifact",
    name: "sample.bin",
    mimeType: "application/octet-stream",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    origin: "upload" as const,
  };
  const delivered = await client.upload(f.access(), "native-artifacts", { ...metadata, path: source }, () => {});
  assert.equal(delivered.path, "/workspace/.opencraft/attachments/" + metadata.sha256 + ".bin");
  assert.equal(delivered.origin, "execution-copy");
  const stream = await client.read(f.access(), "native-artifacts", delivered.path, () => {});
  try {
    const result: Buffer[] = [];
    for await (const chunk of stream.body) result.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(result), bytes);
  } finally {
    await stream.dispose();
  }
  await assert.rejects(
    client.upload(f.access(), "native-artifacts", { ...metadata, sha256: "0".repeat(64), path: source }, () => {}),
  );
  const access = f.access(),
    waiting = await f.port.workspaceArtifactUpload(access, "native-artifacts", { ...metadata, size: 1 });
  assert.equal(
    (await f.port.workspacePlacementPage()).items.length,
    1,
    "A provider waiting for bytes cannot occupy the FIFO",
  );
  Atomics.store(access.requestPermit, 0, 0);
  await artifactClose(f.port, waiting);
  const controller = new AbortController(),
    reading = await client.read(f.access(), "native-artifacts", "/workspace/output.bin", () => {}, controller.signal);
  controller.abort();
  await reading.dispose();
  assert.equal((await f.port.fixtureArtifactStats()).processes, 0);
  assert.equal((await f.port.workspaceSelection(f.access(), "native-artifacts")).kind, "bound");
});

async function terminalOperation(port: Port, token: string) {
  for (let i = 0; i < 600; i++) {
    const value = await port.workspaceTerminalStatus(token);
    if (value.state !== "pending") {
      await port.workspaceTerminalForget(token);
      if (value.state === "failed") throw Error("Terminal operation failed");
      return value.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Terminal operation did not settle");
}
test("Worker terminal uses the existing process owner/replay and keeps published processes independent of a View watch", async (t) => {
  const f = await artifactFixture(t),
    seed = f.access(),
    selection = await f.port.workspaceSelection(seed, "native-artifacts");
  if (selection.kind !== "bound") throw Error("unreachable");
  const lease = { workspaceId: selection.workspaceId, generation: selection.generation };
  const watch = await f.port.workspaceTerminalOpen(seed, "native-artifacts", lease);
  await terminalOperation(
    f.port,
    await f.port.workspaceTerminalRequest(watch, f.access(), "process/spawn", {
      processHandle: "remote-terminal",
      command: ["/bin/sh"],
      tty: true,
      size: { cols: 80, rows: 24 },
    }),
  );
  Atomics.store(seed.requestPermit, 0, 0);
  let snapshot = await f.port.workspaceTerminalSnapshot(watch, "remote-terminal", 0);
  assert.equal(Buffer.from(snapshot.output[0]!.deltaBase64, "base64").toString(), "synthetic-ready\n");
  await f.port.workspaceTerminalUnwatch(watch);
  assert.equal((await f.port.fixtureTerminalStats()).active, 1, "Detaching output is not terminal destruction");
  const next = await f.port.workspaceTerminalOpen(f.access(), "native-artifacts", lease);
  await terminalOperation(
    f.port,
    await f.port.workspaceTerminalRequest(next, f.access(), "process/writeStdin", {
      processHandle: "remote-terminal",
      deltaBase64: Buffer.from("echo-bytes").toString("base64"),
    }),
  );
  snapshot = await f.port.workspaceTerminalSnapshot(next, "remote-terminal", 1);
  assert.equal(Buffer.from(snapshot.output[0]!.deltaBase64, "base64").toString(), "echo-bytes");
  await assert.rejects(
    f.port.workspaceTerminalOpen(f.access(), "native-artifacts", { ...lease, generation: lease.generation + 1 }),
  );
  await terminalOperation(
    f.port,
    await f.port.workspaceTerminalRequest(next, f.access(), "process/kill", { processHandle: "remote-terminal" }),
  );
  assert.equal((await f.port.fixtureTerminalStats()).active, 0);
  assert.equal(
    (await f.port.fixtureCounters()).retained,
    1,
    "Killing a terminal is not destroying the Native workspace",
  );
});

test("Main stable terminal proxy authorizes each original operation context, not the first or last subscriber", async (t) => {
  const f = await artifactFixture(t),
    seed = f.access(),
    selection = await f.port.workspaceSelection(seed, "native-artifacts");
  if (selection.kind !== "bound") throw Error("unreachable");
  const token = await f.port.workspaceTerminalOpen(seed, "native-artifacts", {
    workspaceId: selection.workspaceId,
    generation: selection.generation,
  });
  const first: TransportSubmissionContext = {
      sender: null,
      actorContext: {
        actorId: seed.actorId,
        generation: seed.generation,
        credentialId: null,
        expiresAt: Date.now() + 60000,
      },
    },
    second = { ...first };
  let expired = false;
  const proxy = new WorkspaceTerminalClient({
    port: f.port,
    token,
    threadId: "native-artifacts",
    actorId: seed.actorId,
    generation: seed.generation,
    admit: (context) => {
      if (context === first && expired) throw Error("Original first View expired");
      return f.access();
    },
    onCleanupUnconfirmed() {},
  });
  const events: { method: string; params: unknown }[] = [],
    remove = proxy.subscribe((method, params) => events.push({ method, params }));
  t.after(async () => {
    remove();
    await proxy.close();
  });
  const scope = {
    hostId: "local-codex",
    account: "actor:" + seed.actorId,
    threadId: "native-artifacts",
    projectId: null,
  };
  let accepted = 0;
  await proxy.dispatch(
    "process/spawn",
    { processHandle: "shared-view-terminal", command: ["/bin/sh"], tty: true, size: { cols: 80, rows: 24 } },
    scope,
    () => {},
    () => {
      accepted++;
    },
    first,
  );
  expired = true;
  await proxy.dispatch(
    "process/writeStdin",
    { processHandle: "shared-view-terminal", deltaBase64: Buffer.from("second-view").toString("base64") },
    scope,
    () => {},
    undefined,
    second,
  );
  await assert.rejects(
    proxy.dispatch(
      "process/writeStdin",
      { processHandle: "shared-view-terminal", deltaBase64: "YQ==" },
      scope,
      () => {},
      undefined,
      first,
    ),
  );
  await assert.rejects(
    proxy.dispatch(
      "process/writeStdin",
      { processHandle: "shared-view-terminal", deltaBase64: "YQ==" },
      scope,
      () => {},
      undefined,
      { ...second, actorContext: { ...second.actorContext!, actorId: "human://fixture/foreign" } },
    ),
  );
  assert.equal(accepted, 1);
  for (
    let i = 0;
    i < 100 &&
    !events.some((value) => JSON.stringify(value.params).includes(Buffer.from("second-view").toString("base64")));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(events.some((value) => value.method === "process/outputDelta"));
  await proxy.close();
  assert.equal(
    (await f.port.fixtureTerminalStats()).active,
    1,
    "Closing a proxy detaches only; Worker retains the process owner",
  );
});

async function browserReady(port: Port, token: string) {
  for (let i = 0; i < 600; i++) {
    const value = await port.workspaceBrowserStatus(token);
    if (value.state === "ready") return value;
    if (value.state === "failed") throw Error("Browser opening failed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Browser opening did not settle");
}
async function browserClose(port: Port, token: string) {
  for (let i = 0; i < 600; i++) {
    const value = await port.workspaceBrowserClose(token);
    if (value === "closed") return;
    if (value === "failed") throw Error("Browser detach unconfirmed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Browser detach did not settle");
}
test("Worker browser channels bind the original resource, preserve frame credits, and never replay a physical command", async (t) => {
  const f = await artifactFixture(t),
    access = f.access(),
    selection = await f.port.workspaceSelection(access, "native-artifacts");
  if (selection.kind !== "bound") throw Error("unreachable");
  const lease = { workspaceId: selection.workspaceId, generation: selection.generation };
  const token = await f.port.workspaceBrowserOpen(access, "native-artifacts", lease);
  await browserReady(f.port, token);
  await f.port.workspaceBrowserSend(token, 0, { id: "browser-command", page: "private-page", method: "snapshot" });
  for (let i = 0; i < 200 && (await f.port.workspaceBrowserSent(token, 0)) === "pending"; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await f.port.workspaceBrowserForget(token, 0);
  await assert.rejects(
    f.port.workspaceBrowserSend(token, 0, { id: "browser-command", page: "private-page", method: "snapshot" }),
    "Losing an acknowledgement is not permission to replay",
  );
  let frames = await f.port.workspaceBrowserRead(token, 0);
  for (let i = 0; i < 200 && !frames.frames.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    frames = await f.port.workspaceBrowserRead(token, 0);
  }
  assert.equal(frames.frames.length, 1);
  assert.equal((frames.frames[0]!.message as { id: string }).id, "browser-command");
  assert.deepEqual(
    await f.port.workspaceBrowserRead(token, 0),
    frames,
    "A repeated read credit does not lose the unacknowledged frame",
  );
  Atomics.store(access.requestPermit, 0, 0);
  assert.deepEqual(
    await f.port.workspaceBrowserRead(token, 1),
    { frames: [] },
    "Resource custody does not expire with a View request",
  );
  await browserClose(f.port, token);
  assert.deepEqual(await f.port.fixtureBrowserStats(), { owners: 1, attached: 0, commands: 1 });
  const bad = await f.port.workspaceBrowserOpen(f.access(), "native-artifacts", {
    ...lease,
    generation: lease.generation + 1,
  });
  await assert.rejects(browserReady(f.port, bad));
  await browserClose(f.port, bad);
  const next = await f.port.workspaceBrowserOpen(f.access(), "native-artifacts", lease);
  await browserReady(f.port, next);
  await f.port.fixtureDisableActor();
  await assert.rejects(f.port.workspaceBrowserRead(next, 0));
  await browserClose(f.port, next);
  assert.equal((await f.port.fixtureBrowserStats()).commands, 1);
});

test("Main browser proxy preserves result/media routing and detaches on overflow without recreating or replaying owner work", async (t) => {
  const f = await artifactFixture(t),
    access = f.access(),
    selection = await f.port.workspaceSelection(access, "native-artifacts");
  if (selection.kind !== "bound") throw Error("unreachable");
  const lease = { workspaceId: selection.workspaceId, generation: selection.generation };
  const peer = await WorkspaceBrowserClient.open({
    port: f.port,
    access,
    threadId: "native-artifacts",
    lease,
    authorize() {},
  });
  f.defer(() => peer.close());
  const received: unknown[] = [];
  peer.on("message", (message) => received.push(message));
  await new Promise<void>((resolve, reject) =>
    peer.send({ id: "media-once", page: "page-a", method: "syntheticMedia" }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  for (let i = 0; i < 200 && received.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(received.length, 2);
  assert.deepEqual(
    received.map((message) => (message as { type: string }).type),
    ["frame", "result"],
  );
  await peer.close();
  assert.equal(
    (await f.port.fixtureBrowserStats()).owners,
    1,
    "Transport detach does not kill the independent Browser Owner",
  );
  const flooding = await WorkspaceBrowserClient.open({
    port: f.port,
    access: f.access(),
    threadId: "native-artifacts",
    lease,
    authorize() {},
  });
  f.defer(() => flooding.close());
  // No read listener: the bounded queue must retire, never silently discard
  // a result or replay the originating command to catch up after overflow.
  await new Promise<void>((resolve) =>
    flooding.send({ id: "overflow-once", page: "page-a", method: "syntheticFlood" }, () => resolve()),
  );
  await flooding.close();
  assert.equal((await f.port.fixtureBrowserStats()).commands, 2);
  assert.equal((await f.port.fixtureBrowserStats()).owners, 1);
});

test("central durable browser service selects one actual Worker channel for two tabs and never reaches the local browser fallback", async (t) => {
  const f = await artifactFixture(t),
    access = f.access(),
    directory = await mkdtemp(join(tmpdir(), "workspace-browser-composition-"));
  let allowed = true,
    local = 0;
  const workspace = await openWorkspaceExecutionService({
    port: f.port,
    socketPath: join(directory, "authority.sock"),
    token: "synthetic-browser-service-authority",
    actors: {
      get: (id) =>
        id === access.actorId
          ? {
              id,
              kind: "human",
              enabled: true,
              generation: access.generation,
              displayName: "Fixture",
              createdAt: 0,
              createdBy: null,
            }
          : null,
      isCurrent: (ctx) =>
        ctx.actorId === access.actorId && ctx.generation === access.generation && ctx.expiresAt > Date.now(),
      bindings: () => [{ provider: "local", subject: "fixture" }],
      onAuthorityChanged: () => () => {},
    },
    access: { admitsActor: () => true, store: { revocationRevision: () => 0, onAuthorityChanged: () => () => {} } },
    onCleanupUnconfirmed() {},
  });
  const browser = new RemoteBrowserService({
    root: directory,
    dataDirectory: directory,
    ownerAvailable: async () => true,
    ownerConnector: async () => {
      local++;
      throw Error("Controller browser fallback is forbidden");
    },
    spawnImpl() {
      throw Error("No Chromium process in this synthetic test");
    },
  });
  f.defer(async () => {
    await browser.close();
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  workspace.connectBrowserRouting({
    service: browser,
    assertThreadAccess: (descriptor) => {
      if (!allowed || descriptor.ownerId !== access.actorId || descriptor.threadId !== "native-artifacts")
        throw Error("Synthetic Thread grant revoked");
    },
  });
  const binding = (callId: string) => ({
    ownerId: access.actorId,
    hostId: "local-codex",
    threadId: "native-artifacts",
    turnId: "synthetic-turn",
    callId,
    authorize() {
      if (!allowed) throw Error("Synthetic browser authority revoked");
    },
  });
  const first = await browser.createTab(binding("first"), { url: "https://example.test/" });
  const second = await browser.createTab(binding("second"), { url: "https://example.test/" });
  assert.notEqual(first.tabId, second.tabId);
  assert.equal(local, 0);
  assert.equal((await f.port.fixtureBrowserStats()).attached, 1);
  assert.equal((await browser.conversationTabs(access.actorId, "local-codex", "native-artifacts", () => {})).length, 2);
  await browser.closeTab(binding("close-first"), { tabId: first.tabId });
  assert.equal((await browser.conversationTabs(access.actorId, "local-codex", "native-artifacts", () => {})).length, 1);
  allowed = false;
  await assert.rejects(browser.createTab(binding("denied"), { url: "https://example.test/" }));
  assert.equal(local, 0);
  await browser.close();
  await workspace.close();
  assert.equal((await f.port.fixtureBrowserStats()).attached, 0);
  assert.equal(
    (await f.port.fixtureBrowserStats()).owners,
    1,
    "Central/transport shutdown does not kill the resource-owned Browser Owner",
  );
});
