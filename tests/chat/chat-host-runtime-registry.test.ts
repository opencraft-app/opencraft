import assert from "node:assert/strict";
import test from "node:test";

import {
  HostConnectionProviderRegistry,
  HostRuntimeRegistry,
  asConversationScopeId,
  createConversationBindingStore,
  createConversationActivationCoordinator,
  createConversationScopeLeaseRegistry,
  createConversationScopeRegistry,
  createConversationViewRegistry,
  createWorkbenchCoordinator,
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  normalizeHostConnectionProfile,
} from "@opencraft/workbench-runtime";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import type { SubmitIntent } from "@opencraft/composer-core";

function draftIntent(draftId: string): SubmitIntent {
  return {
    commandId: `command:${draftId}`,
    clientMessageId: `message:${draftId}`,
    target: {
      type: "new-thread",
      draftId,
      execution: { hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } },
    },
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Hello" }] }] },
    attachments: [], context: [], selections: {}, options: { autoContext: true }, createdAt: 1,
  };
}

test("canceling route readiness releases a late Thread lease without replacing the active location", async () => {
  let finish!: (lease: any) => void, releases = 0;
  const runtime = { acquireThread: () => new Promise(resolve => { finish = resolve; }) };
  const initial = createWorkbenchDraftLocation("local", "a");
  const coordinator = createWorkbenchCoordinator({ ensureConnected: async () => runtime } as any, initial);
  try {
    const pending = coordinator.prepare(createWorkbenchThreadLocation("local", "late"));
    await new Promise(resolve => setImmediate(resolve));
    coordinator.cancelPending();
    assert.equal(coordinator.getSnapshot().pendingLocation, null);
    finish({ threadId: "late", release: () => { releases++; } });
    assert.equal(await pending, null);
    assert.equal(releases, 1);
    assert.deepEqual(coordinator.getSnapshot().location, initial);
    assert.equal(coordinator.getSnapshot().phase, "idle");
  } finally { coordinator.dispose(); }
});

class FakeHostRuntime {
  starts = 0;
  disposals = 0;
  private releaseStart: (() => void) | null = null;
  private connectOperation: Promise<void> | null = null;
  private connected = false;

  constructor(readonly hostId: string, private readonly delayed = false) {}

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectOperation !== null) return this.connectOperation;
    this.starts += 1;
    const operation = (this.delayed
      ? new Promise<void>((resolve) => { this.releaseStart = resolve; })
      : Promise.resolve()).then(() => { this.connected = true; }).finally(() => {
        if (this.connectOperation === operation) this.connectOperation = null;
      });
    this.connectOperation = operation;
    return operation;
  }

  release(): void {
    this.releaseStart?.();
    this.releaseStart = null;
  }

  async acquireThread(threadId: string) {
    return { threadId, release: () => undefined };
  }

  async dispose(): Promise<void> {
    this.disposals += 1;
  }
}

class FailingHostRuntime extends FakeHostRuntime {
  override connect(): Promise<void> {
    this.starts += 1;
    return Promise.reject(new Error(`Host ${this.hostId} is unavailable`));
  }
}

class FailingDisposeHostRuntime extends FakeHostRuntime {
  override async dispose(): Promise<void> {
    this.disposals += 1;
    throw new Error(`Host ${this.hostId} failed to close`);
  }
}

function registration(hostId: string, runtime: FakeHostRuntime) {
  return {
    descriptor: {
      hostId,
      label: hostId.toUpperCase(),
      kind: hostId === "local" ? "local" as const : "remote-ssh" as const,
      transportEndpoint: `${hostId}.example`,
      executionLocation: hostId,
      workspaceBrowseRoots: [`/workspace/${hostId}`],
    },
    createRuntime: () => runtime,
  };
}

test("passive Host observation does not create a runtime and sees its later creation", async () => {
  const registry = new HostRuntimeRegistry<FakeHostRuntime>();
  const runtime = new FakeHostRuntime("remote");
  registry.register(registration("remote", runtime));
  let notifications = 0;
  const unsubscribe = registry.subscribe(() => { notifications++; });
  assert.equal(registry.peekRuntime("remote"), null);
  assert.equal(runtime.starts, 0);
  assert.equal(notifications, 0);
  assert.equal(registry.getRuntime("remote"), runtime);
  assert.equal(notifications, 1);
  registry.getRuntime("remote");
  assert.equal(notifications, 1);
  assert.equal(runtime.starts, 0);
  unsubscribe();
  await registry.dispose();
});

test("Host registry is a lazy runtime index with deduplicated startup", async () => {
  const local = new FakeHostRuntime("local", true);
  const remote = new FakeHostRuntime("remote");
  const registry = new HostRuntimeRegistry([
    registration("local", local),
    registration("remote", remote),
  ]);
  try {
    assert.equal(local.starts, 0);
    assert.equal(registry.getRuntime("local"), local);
    const first = registry.ensureConnected("local");
    const second = registry.ensureConnected("local");
    assert.equal(first, second);
    assert.equal(local.starts, 1);
    local.release();
    assert.equal(await first, local);
    assert.equal(await registry.ensureConnected("local"), local);
    assert.equal(local.starts, 1);
    assert.equal(await registry.ensureConnected("remote"), remote);
    assert.deepEqual(registry.getSnapshot().hosts.map((host) => host.hostId), ["local", "remote"]);
  } finally {
    await registry.dispose();
  }
  assert.equal(local.disposals, 1);
  assert.equal(remote.disposals, 1);
});

test("Host registry dynamically publishes registration and fences a removed in-flight connection", async () => {
  const local = new FakeHostRuntime("local");
  const remote = new FakeHostRuntime("remote", true);
  const registry = new HostRuntimeRegistry([registration("local", local)]);
  const revisions: number[] = [];
  const removeListener = registry.subscribe(() => revisions.push(registry.getSnapshot().revision));
  try {
    registry.register(registration("remote", remote));
    assert.deepEqual(registry.getSnapshot().hosts.map((host) => host.hostId), ["local", "remote"]);
    const connecting = registry.ensureConnected("remote");
    assert.equal(remote.starts, 1);
    assert.equal(await registry.remove("remote"), true);
    assert.equal(remote.disposals, 1);
    assert.throws(() => registry.getRuntime("remote"), /Unknown Host/u);
    remote.release();
    await assert.rejects(connecting, /removed during connection/u);
    assert.deepEqual(revisions, [1, 2, 3], "registration, runtime creation, removal");
  } finally {
    removeListener();
    await registry.dispose();
  }
});

test("Host registry inspection is side-effect free and removal stays detached after disposal failure", async () => {
  const local = new FakeHostRuntime("local");
  const remote = new FailingDisposeHostRuntime("remote");
  const registry = new HostRuntimeRegistry([
    registration("local", local),
    registration("remote", remote),
  ]);
  assert.equal(registry.peekRuntime("remote"), null);
  assert.equal(remote.starts, 0);
  assert.equal(registry.getRuntime("remote"), remote);
  assert.equal(registry.peekRuntime("remote"), remote);
  await assert.rejects(registry.remove("remote"), /failed to close/u);
  assert.equal(registry.has("remote"), false);
  assert.equal(registry.peekRuntime("remote"), null);
  assert.deepEqual(registry.getSnapshot().hosts.map((host) => host.hostId), ["local"]);
  await registry.dispose();
});

test("Connection provider retirement waits for Host-owned leases and rejects new acquisition", async () => {
  const registry = new HostConnectionProviderRegistry();
  const transport: DuplexTransport = {
    status: { state: "idle" },
    connect: async () => undefined,
    send: async () => undefined,
    subscribeMessage: () => () => undefined,
    subscribeStatus: () => () => undefined,
    close: async () => undefined,
  };
  const unregister = registry.register("opencraft.test", {
    id: "opencraft.test.websocket",
    label: "Test socket",
    settingsPageId: "opencraft.test.settings",
    targets: ["web"],
    configVersion: 1,
    validate: (config) => config,
    createTransport: () => transport,
  });
  assert.equal(
    registry.getSnapshot().providers[0]?.settingsPageId,
    "opencraft.test.settings",
  );
  const lease = registry.acquire("opencraft.test.websocket", "web");
  let retired = false;
  const retirement = unregister().then(() => { retired = true; });
  await Promise.resolve();
  assert.equal(retired, false);
  assert.deepEqual(registry.getSnapshot().providers, []);
  assert.throws(() => registry.acquire("opencraft.test.websocket", "web"), /unavailable/u);
  assert.equal(lease.provider.createTransport(null, {
    platform: "web", hostId: "local", profileRevision: 0,
  }), transport);
  lease.release();
  await retirement;
  assert.equal(retired, true);
  await registry.close();
});

test("Connection providers reject an empty target settings identity", () => {
  const registry = new HostConnectionProviderRegistry();
  assert.throws(() => registry.register("opencraft.test", {
    id: "opencraft.test.invalid-settings",
    label: "Invalid settings",
    settingsPageId: "   ",
    targets: ["web"],
    configVersion: 1,
    validate: (config) => config,
    createTransport: () => { throw new Error("unreachable"); },
  }), /empty settings page ID/u);
});

test("Host profile boundary separates transport provider from semantic Host kind", () => {
  const profile = normalizeHostConnectionProfile({
    hostId: "host:one",
    displayName: "One",
    providerId: "opencraft.websocket",
    providerConfig: { url: "wss://one.example/appserver" },
    providerConfigVersion: 1,
    hostKind: "durable",
    enabled: true,
    autoConnect: false,
    includeInSidebar: true,
    credentialRef: null,
    transportEndpoint: "one.example",
    executionLocation: "One region",
    workspaceBrowseRoots: ["/workspace", "/workspace"],
    revision: 0,
  });
  assert.equal(profile.providerId, "opencraft.websocket");
  assert.equal(profile.hostKind, "durable");
  assert.deepEqual(profile.workspaceBrowseRoots, ["/workspace"]);
  assert.throws(() => normalizeHostConnectionProfile({ ...profile, providerConfig: { bad: Infinity } }), /non-finite/u);
});

test("initial Conversation View is presentable before a slow Host connects", async () => {
  const local = new FakeHostRuntime("local", true);
  const registry = new HostRuntimeRegistry([registration("local", local)]);
  const drafts = createConversationScopeRegistry({
    initialDraft: {
      draftId: "draft-shell-first",
      execution: {
        hostId: "local",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
  });
  const location = createWorkbenchDraftLocation("local", "draft-shell-first");
  const coordinator = createWorkbenchCoordinator(registry, location, "local");
  const bindings = createConversationBindingStore();
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: () => 1, createId: () => "client-id" },
  });
  const activation = createConversationActivationCoordinator(
    coordinator, bindings, drafts, leases, views,
  );
  try {
    const hydration = activation.presentInitial(location, "route:shell-first");

    assert.equal(local.starts, 1);
    assert.deepEqual(coordinator.getSnapshot().location, location);
    assert.equal(coordinator.getSnapshot().phase, "resolving");
    assert.equal(coordinator.getActiveThreadLease(), null);
    assert.ok(views.get("route:shell-first"));
    assert.equal(
      views.get("route:shell-first")?.composer.getSnapshot().draft.target.type,
      "new-thread",
    );

    local.release();
    assert.equal(await hydration, true);
    assert.equal(coordinator.getSnapshot().phase, "ready");
  } finally {
    activation.dispose();
    views.dispose();
    leases.dispose();
    drafts.dispose();
    bindings.dispose();
    coordinator.dispose();
    await registry.dispose();
  }
});

test("initial Host failure stays inside the presented Conversation View", async () => {
  const local = new FailingHostRuntime("local");
  const registry = new HostRuntimeRegistry([registration("local", local)]);
  const drafts = createConversationScopeRegistry({
    initialDraft: {
      draftId: "draft-offline",
      execution: {
        hostId: "local",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
  });
  const location = createWorkbenchDraftLocation("local", "draft-offline");
  const coordinator = createWorkbenchCoordinator(registry, location, "local");
  const bindings = createConversationBindingStore();
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: () => 1, createId: () => "client-id" },
  });
  const activation = createConversationActivationCoordinator(
    coordinator, bindings, drafts, leases, views,
  );
  try {
    assert.equal(await activation.presentInitial(location, "route:offline"), false);
    assert.equal(coordinator.getSnapshot().phase, "error");
    assert.match(coordinator.getSnapshot().error?.message ?? "", /unavailable/u);
    assert.ok(views.get("route:offline"));
    assert.deepEqual(coordinator.getSnapshot().location, location);
  } finally {
    activation.dispose();
    views.dispose();
    leases.dispose();
    drafts.dispose();
    bindings.dispose();
    coordinator.dispose();
    await registry.dispose();
  }
});

test("Draft promotion atomically keeps one Conversation Scope and one Composer", async () => {
  const local = new FakeHostRuntime("local");
  const registry = new HostRuntimeRegistry([registration("local", local)]);
  const drafts = createConversationScopeRegistry({
    initialDraft: {
      draftId: "draft-atomic",
      execution: {
        hostId: "local",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
  });
  const initial = createWorkbenchDraftLocation("local", "draft-atomic");
  const coordinator = createWorkbenchCoordinator(registry, initial, "local", "route:atomic");
  const bindings = createConversationBindingStore();
  const leases = createConversationScopeLeaseRegistry({});
  const viewRegistry = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: {
      now: () => 1,
      createId: () => "client-id",
    },
  });
  const activation = createConversationActivationCoordinator(
    coordinator, bindings, drafts, leases, viewRegistry,
  );
  try {
    const scopeId = asConversationScopeId("draft-atomic");
    assert.ok(leases.get(scopeId), "Draft lifetime owns its Conversation Scope before route activation");
    assert.equal(await activation.activate(initial), true);
    const composer = viewRegistry.get("route:atomic")?.composer;
    assert.ok(composer);
    const receipt = {
      commandId: "command-1",
      clientMessageId: "message-1",
      hostId: "local",
      threadId: "thread-created",
      turnId: "turn-created",
      acceptedAt: 1,
      replayed: false,
    } as const;
    drafts.beginSubmit("draft-atomic", draftIntent("draft-atomic"));
    drafts.acceptSubmission("draft-atomic", receipt);
    drafts.beginPromotion("draft-atomic");
    const location = await activation.promoteDraft("draft-atomic", receipt);
    assert.equal(location.kind, "thread");
    assert.equal(coordinator.getActiveThreadLease()?.threadId, "thread-created");
    assert.equal(drafts.getDraft("draft-atomic"), null);
    assert.equal(viewRegistry.get("route:atomic")?.composer, composer);
    assert.equal(bindings.resolve(scopeId)?.conversationKey?.threadId, "thread-created");
    assert.equal(local.starts, 1);
  } finally {
    activation.dispose();
    viewRegistry.dispose();
    leases.dispose();
    coordinator.dispose();
    await registry.dispose();
  }
});

test("a superseded Draft promotion cannot partially retarget its Scope", async () => {
  const local = new FakeHostRuntime("local");
  const registry = new HostRuntimeRegistry([registration("local", local)]);
  const drafts = createConversationScopeRegistry({
    initialDraft: {
      draftId: "draft-superseded",
      execution: {
        hostId: "local",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
  });
  const initial = createWorkbenchDraftLocation("local", "draft-superseded");
  const coordinator = createWorkbenchCoordinator(registry, initial, "local", "route:superseded");
  const bindings = createConversationBindingStore();
  const leases = createConversationScopeLeaseRegistry({});
  const viewRegistry = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: () => 1, createId: () => "client-id" },
  });
  const activation = createConversationActivationCoordinator(
    coordinator, bindings, drafts, leases, viewRegistry,
  );
  const receipt = {
    commandId: "command-superseded",
    clientMessageId: "message-superseded",
    hostId: "local",
    threadId: "thread-superseded",
    turnId: "turn-superseded",
    acceptedAt: 1,
    replayed: false,
  } as const;
  try {
    const scopeId = asConversationScopeId("draft-superseded");
    await activation.activate(initial);
    drafts.beginSubmit("draft-superseded", draftIntent("draft-superseded"));
    drafts.acceptSubmission("draft-superseded", receipt);
    drafts.beginPromotion("draft-superseded");
    const prepared = await activation.preparePromotion("draft-superseded", receipt);
    assert.ok(prepared);
    drafts.dismissDraft("draft-superseded");
    assert.throws(() => prepared.commit(), /promotion was superseded/u);
    assert.equal(bindings.resolve(scopeId)?.conversationKey, null);
    assert.equal(
      viewRegistry.get("route:superseded")?.composer.getSnapshot().draft.target.type,
      "new-thread",
    );
  } finally {
    activation.dispose();
    viewRegistry.dispose();
    leases.dispose();
    coordinator.dispose();
    await registry.dispose();
  }
});

test("prepared activation does not change presentation before commit", async () => {
  const local = new FakeHostRuntime("local");
  const registry = new HostRuntimeRegistry([registration("local", local)]);
  const initial = createWorkbenchDraftLocation("local", "draft-prepared");
  const coordinator = createWorkbenchCoordinator(registry, initial);
  try {
    const prepared = await coordinator.prepare(
      createWorkbenchThreadLocation("local", "thread-prepared"),
    );
    assert.ok(prepared);
    assert.deepEqual(coordinator.getSnapshot().location, initial);
    assert.equal(prepared.commit(), true);
    assert.equal(coordinator.getActiveThreadLease()?.threadId, "thread-prepared");
  } finally {
    coordinator.dispose();
    await registry.dispose();
  }
});

test("a local New-chat Draft replaces the visible Thread before Host readiness", async () => {
  const local = new FakeHostRuntime("local");
  const registry = new HostRuntimeRegistry([registration("local", local)]);
  const initial = createWorkbenchThreadLocation("local", "thread-current");
  const coordinator = createWorkbenchCoordinator(registry, initial, "local", "route:thread");
  try {
    assert.equal(await coordinator.activate(initial), true);
    assert.equal(coordinator.getActiveThreadLease()?.threadId, "thread-current");

    const home = createWorkbenchDraftLocation("local", "draft-home");
    coordinator.presentLocalDraft(home, "route:home");

    assert.deepEqual(coordinator.getSnapshot().location, home);
    assert.deepEqual(coordinator.getSnapshot().pendingLocation, home);
    assert.equal(coordinator.getSnapshot().phase, "resolving");
    assert.equal(coordinator.getActiveThreadLease(), null);

    const prepared = await coordinator.prepare(home);
    assert.ok(prepared);
    assert.equal(prepared.commit(), true);
    assert.deepEqual(coordinator.getSnapshot().location, home);
    assert.equal(coordinator.getSnapshot().pendingLocation, null);
  } finally {
    coordinator.dispose();
    await registry.dispose();
  }
});

test("Workbench coordinator publishes navigation intent before remote hydration", async () => {
  const local = new FakeHostRuntime("local");
  const remote = new FakeHostRuntime("remote", true);
  const registry = new HostRuntimeRegistry([
    registration("local", local),
    registration("remote", remote),
  ]);
  const initial = createWorkbenchDraftLocation("local", "draft-pending");
  const target = createWorkbenchThreadLocation("remote", "thread-pending");
  const coordinator = createWorkbenchCoordinator(registry, initial);
  try {
    const preparing = coordinator.prepare(target);
    assert.deepEqual(coordinator.getSnapshot().location, initial);
    assert.deepEqual(coordinator.getSnapshot().pendingLocation, target);
    assert.equal(coordinator.getSnapshot().phase, "resolving");

    remote.release();
    const prepared = await preparing;
    assert.ok(prepared);
    assert.deepEqual(coordinator.getSnapshot().pendingLocation, target);
    assert.equal(prepared.commit(), true);
    assert.deepEqual(coordinator.getSnapshot().location, target);
    assert.equal(coordinator.getSnapshot().pendingLocation, null);
  } finally {
    coordinator.dispose();
    await registry.dispose();
  }
});

test("Workbench coordinator keeps Host preference separate from committed route", async () => {
  const local = new FakeHostRuntime("local");
  const remote = new FakeHostRuntime("remote");
  const registry = new HostRuntimeRegistry([
    registration("local", local),
    registration("remote", remote),
  ]);
  const initial = createWorkbenchDraftLocation("local", "view-1");
  const coordinator = createWorkbenchCoordinator(registry, initial);
  try {
    coordinator.setSelectedHostId("remote");
    assert.equal(coordinator.getSnapshot().selectedHostId, "remote");
    assert.deepEqual(coordinator.getSnapshot().location, initial);
    assert.equal(coordinator.getRuntime(), local);

    const remoteThread = createWorkbenchThreadLocation("remote", "thread-9");
    assert.equal(await coordinator.activate(remoteThread), true);
    assert.deepEqual(coordinator.getSnapshot().location, remoteThread);
    assert.equal(coordinator.getRuntime(), remote);
    assert.equal(coordinator.getActiveThreadLease()?.threadId, "thread-9");
  } finally {
    coordinator.dispose();
    await registry.dispose();
  }
});

test("an obsolete Host activation cannot commit after a newer intent", async () => {
  const local = new FakeHostRuntime("local");
  const slow = new FakeHostRuntime("slow", true);
  const fast = new FakeHostRuntime("fast");
  const registry = new HostRuntimeRegistry([
    registration("local", local),
    registration("slow", slow),
    registration("fast", fast),
  ]);
  const coordinator = createWorkbenchCoordinator(
    registry,
    createWorkbenchDraftLocation("local", "view-1"),
  );
  try {
    const obsolete = coordinator.activate(createWorkbenchThreadLocation("slow", "old"));
    await Promise.resolve();
    const latest = createWorkbenchThreadLocation("fast", "new");
    assert.equal(await coordinator.activate(latest), true);
    slow.release();
    assert.equal(await obsolete, false);
    assert.deepEqual(coordinator.getSnapshot().location, latest);
  } finally {
    coordinator.dispose();
    await registry.dispose();
  }
});

test("Host registry rejects ambiguous and unknown Host identities", async () => {
  const local = new FakeHostRuntime("local");
  assert.throws(
    () => new HostRuntimeRegistry([
      registration("local", local),
      registration("local", new FakeHostRuntime("duplicate")),
    ]),
    /Duplicate Host runtime/u,
  );

  const registry = new HostRuntimeRegistry([registration("local", local)]);
  try {
    await assert.rejects(registry.ensureConnected("missing"), /Unknown Host runtime/u);
  } finally {
    await registry.dispose();
  }
});

test("disposing the Host registry fences a connection that completes late", async () => {
  const local = new FakeHostRuntime("local", true);
  const registry = new HostRuntimeRegistry([registration("local", local)]);
  const connecting = registry.ensureConnected("local");
  const disposing = registry.dispose();
  local.release();
  await assert.rejects(connecting, /disposed during connection/u);
  await disposing;
  assert.equal(local.disposals, 1);
  assert.throws(() => registry.getRuntime("local"), /disposed/u);
});

for (const scenario of ["recover", "cancel", "missing-thread", "dispose"] as const) {
  test(`initial-route connection recovery: ${scenario}`, async () => {
    class ObservableRuntime extends FakeHostRuntime {
      phase = scenario === "missing-thread" ? "ready" : "error";
      listeners = new Set<() => void>();
      reads = 0;
      getSnapshot() { return { phase: this.phase }; }
      subscribe(listener: () => void) { this.listeners.add(listener); listener(); return () => { this.listeners.delete(listener); }; }
      override async connect() { this.starts++; if (this.phase !== "ready") throw new Error("connection unavailable"); }
      override async acquireThread(threadId: string) { this.reads++; if (scenario === "missing-thread") throw new Error("thread not found"); return { threadId, release() {} }; }
      ready() { this.phase = "ready"; for (const listener of this.listeners) listener(); }
    }
    const runtime = new ObservableRuntime("local");
    const registry = new HostRuntimeRegistry([registration("local", runtime)]);
    const drafts = createConversationScopeRegistry({});
    const location = createWorkbenchThreadLocation("local", "existing-thread");
    const coordinator = createWorkbenchCoordinator(registry, location, "local");
    const bindings = createConversationBindingStore();
    const leases = createConversationScopeLeaseRegistry({});
    const views = createConversationViewRegistry({ scopeLeases: leases, composerServices: { now: () => 1, createId: () => "id" } });
    const activation = createConversationActivationCoordinator(coordinator, bindings, drafts, leases, views);
    try {
      assert.equal(await activation.presentInitial(location, "initial-view"), false);
      if (scenario === "cancel") coordinator.cancelPending();
      if (scenario === "dispose") activation.dispose();
      runtime.ready();
      await new Promise(resolve => setImmediate(resolve));
      if (scenario === "recover") {
        assert.equal(coordinator.getSnapshot().phase, "ready");
        assert.equal(coordinator.getActiveThreadLease()?.threadId, "existing-thread");
        assert.equal(runtime.reads, 1);
      } else if (scenario === "missing-thread") {
        assert.equal(coordinator.getSnapshot().failureStage, "thread");
        assert.equal(runtime.reads, 1, "domain rejection is not retried on readiness");
      } else assert.equal(runtime.reads, 0, "canceled or disposed intent must not return");
      assert.equal(runtime.listeners.size, 0);
    } finally { activation.dispose(); views.dispose(); leases.dispose(); drafts.dispose(); bindings.dispose(); coordinator.dispose(); await registry.dispose(); }
  });
}

test("explicit conversation selection rechecks an expired connection before suspended timers run", async () => {
  const { ConnectionLifecycleOwner } = await import("../../packages/workbench-runtime/src/connection-lifecycle");
  let now = 0, sequence = 0;
  const timers = new Map<number, () => void>();
  const runs: Array<{ resolve(value: object): void; signal: AbortSignal }> = [];
  const owner = new ConnectionLifecycleOwner<object>({
    clock: { now: () => now, setTimeout(run) { const id = ++sequence; timers.set(id, run); return id; },
      clearTimeout(id) { timers.delete(id as number); } },
    run: attempt => new Promise(resolve => runs.push({ resolve, signal: attempt.signal })),
    valid: () => true, invalidate() {}, changed() {}, usable() {}, backoff() {}, manual: () => false,
  });
  const runtime = new FakeHostRuntime("local");
  runtime.connect = () => owner.connect();
  const registry = new HostRuntimeRegistry([registration("local", runtime)]);
  const initial = createWorkbenchDraftLocation("local", "initial");
  const coordinator = createWorkbenchCoordinator(registry, initial);
  try {
    const first = coordinator.prepare(createWorkbenchThreadLocation("local", "first"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs.length, 1);
    // A hidden/frozen page advances elapsed time without dispatching its timers.
    now = 31_000;
    const next = coordinator.prepare(createWorkbenchThreadLocation("local", "next"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs.length, 2, "new navigation must reach the connection deadline owner");
    assert.equal(runs[0]!.signal.aborted, true);
    assert.equal(await first, null, "superseded selection cannot replace the new destination");
    const joined = registry.ensureConnected("local");
    assert.equal(registry.ensureConnected("local"), joined, "current startup remains single-flight");
    runs[1]!.resolve({});
    assert.equal(await joined, runtime);
    assert.equal((await next)?.commit(), true);
    assert.deepEqual(coordinator.getSnapshot().location, createWorkbenchThreadLocation("local", "next"));
    runs[0]!.resolve({});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(coordinator.getSnapshot().location, createWorkbenchThreadLocation("local", "next"));
  } finally { owner.dispose(); coordinator.dispose(); await registry.dispose(); }
});
