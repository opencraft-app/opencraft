import assert from "node:assert/strict";

import test from "node:test";


import { createCordisAppServerRegistry } from "@opencraft/appserver-client";

import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  parseJsonRpcMessage,
  OPENCRAFT_RESUME_HISTORY_EXTENSION,
  type JsonRpcRequest,
} from "@opencraft/appserver-protocol";

import {
  MemoryTransport,
  type InMemoryAppServer,
  type InMemoryAppServerPeer,
} from "@opencraft/appserver-transport-memory";

import type { SubmitIntent } from "@opencraft/composer-core";

import { createConversationKey, asTurnId } from "@opencraft/chat-core";

import {
  createAppServerWorkbenchRuntime,
  createConversationScopeRegistry,
} from "@opencraft/workbench-runtime";
import { DraftHarness, protocolThread, createHarness, oneDynamicTool, intent, waitForRequest, waitForAuthoritative } from "../fixtures/workbench-draft-harness";


test("Workbench exposes Fork and Side Chat only for explicitly declared lifecycle operations", async () => {
  const cases = [
    { declared: undefined, fork: false, sideChat: false },
    { declared: { version: 2, fork: true, ephemeral: true, injectItems: true, unsubscribe: true }, fork: false, sideChat: false },
    { declared: { version: 1, fork: true }, fork: true, sideChat: false },
    { declared: { version: 1, fork: false, ephemeralFork: true, ephemeral: true, injectItems: true, unsubscribe: true }, fork: false, sideChat: true },
    { declared: { version: 1, fork: true, ephemeral: true, injectItems: true, unsubscribe: true }, fork: true, sideChat: true },
  ];
  for (const item of cases) {
    const harness = createHarness(false, false, [], false, undefined, false, false, false, false, item.declared);
    const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false });
    try {
      await runtime.connect();
      assert.equal(runtime.resources.threads.capabilities().fork, item.fork);
      assert.equal(runtime.resources.threads.supportsSideChat?.(), item.sideChat);
    } finally { await runtime.dispose(); }
  }
});


test("opening a durable fork preserves its acknowledged effort and Fast tier without another resume", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false });
  try {
    await runtime.connect();
    const child = await runtime.resources.threads.fork!({ threadId: "thread-created", excludeTurns: true });
    const lease = await runtime.acquireThread(child.id);
    await waitForAuthoritative(lease);
    assert.equal(lease.getSnapshot().execution.effort, "high");
    assert.equal(lease.getSnapshot().execution.serviceTier, "priority");
    assert.equal(harness.requests.filter(request => request.method === "thread/resume").length, 0);
    lease.release();
  } finally { await runtime.dispose(); }
});

test("an acknowledged durable Fork stays in the default catalog until the Host lists it", async () => {
  const harness = createHarness(false, false, [], false, undefined, false, false, false, false, { version: 1, fork: true });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false });
  try {
    await runtime.connect();
    assert.deepEqual((await runtime.resources.threads.list()).data.map(thread => thread.id), ["thread-created"]);
    const child = await runtime.resources.threads.fork!({ threadId: "thread-created" });
    assert.equal(child.id, "thread-fork");
    assert.deepEqual((await runtime.resources.threads.list({ cursor: null, limit: 50 })).data.map(thread => thread.id), ["thread-fork", "thread-created"]);
    assert.deepEqual((await runtime.resources.threads.list({ archived: true })).data.map(thread => thread.id), ["thread-created"]);
    harness.publishFork();
    assert.equal((await runtime.resources.threads.list()).data.filter(thread => thread.id === child.id).length, 1);
    await runtime.resources.threads.fork!({ threadId: "thread-created", ephemeral: true, excludeTurns: true });
    assert.equal((await runtime.resources.threads.list()).data.some(thread => thread.id === "thread-fork-ephemeral"), false);
  } finally { await runtime.dispose(); }
});


test("a durable Fork can outlive the generic request deadline without a second native request", async () => {
  const harness = createHarness(false, false, [], false, undefined, false, false, false, false, { version: 1, fork: true });
  harness.holdFork();
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, requestTimeoutMs: 20, autoReconnect: false });
  try {
    await runtime.connect();
    const fork = runtime.resources.threads.fork!({ threadId: "thread-created" });
    const joined = runtime.resources.threads.fork!({ threadId: "thread-created" });
    await waitForRequest(harness, "thread/fork");
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(harness.requests.filter(request => request.method === "thread/fork").length, 1);
    harness.releaseFork();
    assert.equal((await fork).id, "thread-fork");
    assert.equal((await joined).id, "thread-fork");
    const request = harness.requests.find(request => request.method === "thread/fork");
    assert.deepEqual(request?.params, { threadId: "thread-created" });
  } finally { await runtime.dispose(); }
});


test("a consumer acquired during unsubscribe keeps its view and reestablishes server attachment", async () => {
  const harness = createHarness(false, false, [], true);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false });
  try {
    await runtime.connect();
    const old = await runtime.acquireThread("thread-created"); await waitForAuthoritative(old); old.release();
    const unsubscribing = runtime.resources.threads.unsubscribe!("thread-created");
    await waitForRequest(harness, "thread/unsubscribe");
    const current = await runtime.acquireThread("thread-created");
    harness.releaseUnsubscribe(); await unsubscribing;
    assert.equal(harness.requests.filter(request => request.method === "thread/read").length, 2);
    assert.equal(current.getSnapshot().authoritative, true);
    current.release();
  } finally { await runtime.dispose(); }
});


test("Draft creation resolves only a declared default and checks its input before RPC", async () => {
  for (const models of [[], [{ id: "text", model: "text", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null }]]) {
    const harness = createHarness(false, false, [], false, models);
    const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false });
    try {
      await runtime.connect();
      const request = intent({ type: "new-thread", draftId: "input-check", execution: { hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } });
      const submission = models.length ? { ...request, attachments: [{ id: "image", name: "Image", mimeType: "image/png", size: 1, lifecycle: "ready", uri: "file:///tmp/never-read.png" } as any] } : request;
      await assert.rejects(runtime.createThread(submission), models.length ? /不支持 image 输入/ : /请先选择模型/);
      assert.equal(harness.requests.some(message => message.method === "thread/start"), false);
    } finally { await runtime.dispose(); }
  }
});


test("failed baseline remains an error and retries on the same lease without reconnect", async () => {
  const harness = createHarness(false, true);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, requestTimeoutMs: 100, autoReconnect: false });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-created");
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "timed out waiting for recovery state");
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    };
    await until(() => lease.getSnapshot().phase === "error");
    assert.equal(runtime.getSnapshot().phase, "ready");
    assert.equal(runtime.getThreadResidency(lease.threadId)?.phase, "error");
    const generation = runtime.getSnapshot().connectionGeneration;
    const resumes = harness.requests.filter(r => r.method === "thread/read").length;
    const retry = lease.retryRestore();
    assert.equal(lease.getSnapshot().phase, "syncing");
    assert.equal(lease.getSnapshot().error, null);
    await until(() => harness.requests.filter(r => r.method === "thread/read").length > resumes);
    harness.releaseResume();
    await retry;
    assert.equal(lease.getSnapshot().authoritative, true);
    assert.equal(runtime.getSnapshot().connectionGeneration, generation);
    lease.release();
  } finally { await runtime.dispose(); }
});


test("Workbench starts on a client Draft without listing or creating a server Thread", async () => {
  const harness = createHarness();
  let nextDraft = 0;
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  const drafts = createConversationScopeRegistry({
    initialDraft: {
      draftId: `client-new-thread:${++nextDraft}`,
      entrypoint: "home",
      execution: {
        hostId: "local",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
    now: () => 100,
  });
  try {
    await runtime.connect();
    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.phase, "ready");
    assert.deepEqual(snapshot.residentThreads, []);
    assert.equal(drafts.getActiveDraft()?.id, "client-new-thread:1");
    assert.equal(drafts.getActiveDraft()?.target.execution.workspace.cwd, "/workspace");
    assert.throws(() => drafts.retargetDraft("client-new-thread:1", {
      hostId: "ssh:other",
      workspace: { cwd: "/workspace/other", runtimeWorkspaceRoots: ["/workspace/other"] },
    }), /cannot move to another Host/u);
    const updated = drafts.retargetDraft("client-new-thread:1", {
      hostId: "local",
      workspace: {
        cwd: "/workspace/other",
        runtimeWorkspaceRoots: ["/workspace/other"],
        projectId: "project-other",
      },
    });
    assert.equal(updated.id, "client-new-thread:1");
    assert.equal(updated.target.execution.hostId, "local");
    assert.equal(updated.target.execution.workspace.cwd, "/workspace/other");
    assert.equal(updated.target.execution.workspace.projectId, "project-other");
    assert.deepEqual(
      harness.requests.map((request) => request.method),
      ["initialize"],
    );
  } finally {
    await runtime.dispose();
  }
});


test("Workbench Host runtimes lease clients from one application Cordis registry", async () => {
  const harness = createHarness();
  const applicationRegistry = await createCordisAppServerRegistry();
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "ssh:alpha",
    transport: harness.transport,
    autoReconnect: false,
    clientRegistry: applicationRegistry.clients,
  });
  try {
    await runtime.connect();
    assert.equal(applicationRegistry.clients.getAll().length, 1);
    assert.equal(applicationRegistry.clients.getOrThrow("ssh:alpha").hostId, "ssh:alpha");
  } finally {
    await runtime.dispose();
    assert.equal(applicationRegistry.clients.getAll().length, 0);
    await applicationRegistry.dispose();
  }
});


test("DraftSession rejects execution changes in flight and ignores stale completion", () => {
  let nextId = 0;
  const drafts = createConversationScopeRegistry({
    createDraftId: () => `draft:${++nextId}`,
  });
  const first = drafts.openDraft({
    execution: {
      hostId: "local",
      workspace: { cwd: "/one", runtimeWorkspaceRoots: ["/one"] },
    },
  });
  const secondConcurrent = drafts.openDraft({
    execution: {
      hostId: "ssh:ignored",
      workspace: { cwd: "/ignored", runtimeWorkspaceRoots: ["/ignored"] },
    },
  });
  assert.notEqual(secondConcurrent.id, first.id);
  drafts.activateDraft(first.id);
  drafts.beginSubmit(first.id, intent(first.target));
  assert.throws(() => drafts.retargetDraft(first.id, {
    hostId: "ssh:blocked",
    workspace: { cwd: "/blocked", runtimeWorkspaceRoots: ["/blocked"] },
  }), /cannot change/u);

  drafts.dismissDraft(first.id);
  const second = drafts.openDraft({
    execution: {
      hostId: "ssh:new",
      workspace: { cwd: "/new", runtimeWorkspaceRoots: ["/new"] },
    },
  });
  assert.notEqual(second.id, first.id);
  assert.equal(drafts.failDraft(first.id, new Error("stale")), null);
  assert.equal(drafts.promoteDraft(first.id), false);
  assert.equal(drafts.getActiveDraft()?.id, second.id);
});


test("Draft workspace discovery stays behind typed Project and filesystem resources", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  try {
    await runtime.connect();
    const projects = await runtime.resources.projects.list();
    assert.equal(projects.data[0]?.roots[0]?.path, "/workspace/projects/one");
    const directory = await runtime.resources.fileSystem.readDirectory("/workspace/projects");
    assert.deepEqual(directory.entries, [
      { fileName: "one", isDirectory: true, isFile: false },
      { fileName: "README.md", isDirectory: false, isFile: true },
    ]);
    const created = await runtime.resources.projects.create({
      name: "two",
      roots: [{ path: "/workspace/projects/two" }],
      idempotencyKey: "test:create:two",
      metadata: { origin: "test" },
    });
    assert.equal(created.project.id, "project-created");
    assert.equal(created.project.roots[0]?.path, "/workspace/projects/two");
    assert.deepEqual(
      harness.requests.slice(-3).map((request) => request.method),
      ["project/list", "fs/readDirectory", "project/create"],
    );
  } finally {
    await runtime.dispose();
  }
});


test("Host filesystem resources expose read, metadata, write and watch semantics", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "dsh",
    transport: harness.transport,
    autoReconnect: false,
  });
  try {
    await runtime.connect();
    const metadata = await runtime.resources.fileSystem.getMetadata("/workspace/README.md");
    assert.equal(metadata.isFile, true);
    const file = await runtime.resources.fileSystem.readFile("/workspace/README.md");
    assert.equal(atob(file.dataBase64), "hello from sandbox\n");
    await runtime.resources.fileSystem.writeFile(
      "/workspace/README.md",
      btoa("updated\n"),
    );
    const changed: string[][] = [];
    const watch = await runtime.resources.fileSystem.watch(
      "/workspace",
      (paths) => changed.push([...paths]),
    );
    harness.notifyFsChanged(watch.watchId, ["/workspace/README.md"]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(changed, [["/workspace/README.md"]]);
    await watch.dispose();
    assert.deepEqual(
      harness.requests.slice(-5).map((request) => request.method),
      ["fs/getMetadata", "fs/readFile", "fs/writeFile", "fs/watch", "fs/unwatch"],
    );
  } finally {
    await runtime.dispose();
  }
});


test("skills are a typed host resource and skills/changed is an invalidation signal", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  try {
    let changes = 0;
    let cancelledChanges = 0;
    const unsubscribe = runtime.resources.composerCatalog.subscribeSkillsChanged(() => {
      changes += 1;
    });
    const cancelEarly = runtime.resources.composerCatalog.subscribeSkillsChanged(() => {
      cancelledChanges += 1;
    });
    cancelEarly();
    await runtime.connect();
    const response = await runtime.resources.composerCatalog.listSkills({
      cwds: ["/workspace", "/shared"],
      forceReload: true,
      threadId: "thread-created",
      model: "native-model",
    });
    assert.equal(response.data[0]?.skills[0]?.name, "repo-review");
    const request = harness.requests.find((candidate) => candidate.method === "skills/list");
    assert.deepEqual(request?.params, {
      cwds: ["/workspace", "/shared"],
      forceReload: true,
    });
    harness.notifySkillsChanged();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(changes, 1);
    assert.equal(cancelledChanges, 0, "cancelled pre-start subscriptions remain cancelled");
    unsubscribe();
  } finally {
    await runtime.dispose();
  }
});


test("Composer catalog reads and writes AppServer-owned new-thread model defaults", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "fixture-host",
    transport: harness.transport,
    autoReconnect: false,
  });
  try {
    await runtime.connect();
    assert.deepEqual(
      await runtime.resources.composerCatalog.readNewThreadDefaults("/workspace"),
      { model: "gpt-5.6", effort: "high", serviceTier: null },
    );
    await runtime.resources.composerCatalog.writeNewThreadDefaults({
      model: "configured-model",
      effort: "xhigh",
    });
    const read = harness.requests.find((request) => request.method === "config/read");
    assert.deepEqual(read?.params, { includeLayers: false, cwd: "/workspace" });
    const write = harness.requests.find((request) => request.method === "config/batchWrite");
    assert.deepEqual(write?.params, {
      edits: [
        { keyPath: "model", value: "configured-model", mergeStrategy: "replace" },
        { keyPath: "model_reasoning_effort", value: "xhigh", mergeStrategy: "replace" },
      ],
    });
  } finally {
    await runtime.dispose();
  }
});


test("Draft Thread creation returns identity without starting or stealing a View-owned Turn", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  const drafts = createConversationScopeRegistry({
    initialDraft: {
      draftId: "client-new-thread:submit",
      execution: {
        hostId: "local",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
  });
  try {
    await runtime.connect();
    const target = drafts.getActiveDraft()?.target;
    assert.ok(target);
    drafts.beginSubmit(target.draftId, intent(target));
    const receipt = await runtime.createThread(intent(target));
    assert.equal(receipt.threadId, "thread-created");
    assert.equal(receipt.turnId, null);
    assert.equal(drafts.getActiveDraft()?.phase, "submitting");
    assert.deepEqual(runtime.getSnapshot().residentThreads, []);
    assert.deepEqual(
      harness.requests
        .filter((request) => request.method === "thread/start" || request.method === "turn/start")
        .map((request) => request.method),
      ["thread/start"],
    );
  } finally {
    await runtime.dispose();
  }
});


test("a first-Turn durable Host does not return a promotable Thread before turn/start is accepted", async () => {
  const harness = createHarness(true, false, [], false, undefined, false, false, true);
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "fixture-host",
    transport: harness.transport,
    autoReconnect: false,
  });
  const drafts = createConversationScopeRegistry({
    initialDraft: {
      draftId: "client-new-thread:durable-first-turn",
      execution: {
        hostId: "fixture-host",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
  });
  try {
    await runtime.connect();
    const target = drafts.getActiveDraft()?.target;
    assert.ok(target);
    const submitted = runtime.createThread(intent(target));
    await waitForRequest(harness, "turn/start");
    let settled = false;
    void submitted.finally(() => { settled = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false);
    assert.deepEqual(
      harness.requests
        .filter(request => request.method === "thread/start" || request.method === "turn/start")
        .map(request => request.method),
      ["thread/start", "turn/start"],
    );
    harness.releaseTurn();
    const receipt = await submitted;
    assert.equal(receipt.threadId, "thread-created");
    assert.equal(receipt.turnId, "turn-created");
  } finally {
    await runtime.dispose();
  }
});


test("a rejected first Turn never publishes a promotable Thread receipt", async () => {
  const harness = createHarness(false, false, [], false, undefined, false, false, true, true);
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "fixture-host",
    transport: harness.transport,
    autoReconnect: false,
  });
  const drafts = createConversationScopeRegistry({
    initialDraft: {
      draftId: "client-new-thread:durable-rejected",
      execution: {
        hostId: "fixture-host",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
  });
  try {
    await runtime.connect();
    const target = drafts.getActiveDraft()?.target;
    assert.ok(target);
    await assert.rejects(runtime.createThread(intent(target)), /first turn rejected/u);
    assert.deepEqual(
      harness.requests
        .filter(request => request.method === "thread/start" || request.method === "turn/start")
        .map(request => request.method),
      ["thread/start", "turn/start"],
    );
  } finally {
    await runtime.dispose();
  }
});


test("a created Thread cannot steal focus after its Draft is dismissed", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  const drafts = createConversationScopeRegistry({
    initialDraft: {
      draftId: "client-new-thread:stale",
      execution: {
        hostId: "local",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
  });
  try {
    await runtime.connect();
    const target = drafts.getActiveDraft()?.target;
    assert.ok(target);
    drafts.beginSubmit(target.draftId, intent(target));
    const submitted = runtime.createThread(intent(target));
    await waitForRequest(harness, "thread/start");
    drafts.dismissDraft(target.draftId);
    const existing = await runtime.acquireThread("thread-existing");
    const receipt = await submitted;
    assert.equal(receipt.threadId, "thread-created");
    assert.equal(existing.threadId, "thread-existing");
    assert.equal(runtime.getThreadResidency("thread-existing")?.viewLeaseCount, 1);
    assert.equal(drafts.getActiveDraft(), null);
    existing.release();
  } finally {
    await runtime.dispose();
  }
});


test("concurrent Thread acquisition shares one hydration and evicts only after the last lease", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
    maxInactiveThreads: 0,
  });
  try {
    await runtime.connect();
    const [first, second] = await Promise.all([
      runtime.acquireThread("thread-shared"),
      runtime.acquireThread("thread-shared"),
    ]);
    await waitForRequest(harness, "thread/read");
    await waitForAuthoritative(first);
    assert.equal(
      harness.requests.filter((request) => request.method === "thread/read").length,
      1,
    );
    first.release();
    assert.equal(runtime.getThreadResidency("thread-shared")?.viewLeaseCount, 1);
    second.release();
    assert.equal(runtime.getThreadResidency("thread-shared"), null);
  } finally {
    await runtime.dispose();
  }
});


test("Thread acquisition stays empty until its single authoritative Read promotion", async () => {
  const harness = createHarness(false, true, [{
    id: "turn-history-one",
    status: "completed",
    itemsView: "full",
    items: [{
      id: "message-history-one",
      type: "agentMessage",
      text: "authoritative history",
    }],
  }]);
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-painted-first");
    assert.equal(lease.getSnapshot().authoritative, false);
    assert.equal(lease.getSnapshot().phase, "empty");
    assert.equal(lease.getSnapshot().timeline.frames.length, 0);
    assert.equal(runtime.getThreadResidency("thread-painted-first")?.hydrating, true);
    let visibleTimelinePromotions = 0;
    let visibleFrameCount = 0;
    const unsubscribe = lease.subscribe(() => {
      const nextFrameCount = lease.getSnapshot().timeline.frames.length;
      if (nextFrameCount !== visibleFrameCount) {
        visibleTimelinePromotions += 1;
        visibleFrameCount = nextFrameCount;
      }
    });
    await waitForRequest(harness, "thread/read");
    harness.releaseResume();
    await waitForAuthoritative(lease);
    assert.equal(lease.getSnapshot().phase, "live");
    assert.equal(lease.getSnapshot().timeline.frames.length, 1);
    assert.equal(visibleTimelinePromotions, 1);
    unsubscribe();
    lease.release();
  } finally {
    await runtime.dispose();
  }
});


test("slow dynamic-tool registration does not hold restored history behind hydration", async () => {
  const harness = createHarness(false, false, [{
    id: "turn-history-one",
    status: "completed",
    itemsView: "full",
    items: [{ id: "message-history-one", type: "agentMessage", text: "history is ready" }],
  }], false, undefined, true, true);
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
    dynamicTools: oneDynamicTool,
  });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-created");
    await waitForAuthoritative(lease);
    assert.equal(harness.requests.some(request => request.method === "runtime/capabilities/register"), false);
    assert.equal(lease.getSnapshot().timeline.frames.length, 1);
    const stopping = lease.interrupt(asTurnId("turn-history-one"));
    await waitForRequest(harness, "turn/interrupt");
    await stopping;

    const submitting = lease.submit({
      ...intent({
        type: "new-thread",
        draftId: "unused",
        execution: {
          hostId: "local",
          workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
        },
      }),
      target: {
        type: "existing-thread",
        key: createConversationKey("local", "thread-created"),
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(
      harness.requests.some((request) => request.method === "turn/start"),
      false,
      "execution must still wait for the capability lease",
    );
    await waitForRequest(harness, "runtime/capabilities/register");
    harness.releaseCapabilityRegistration();
    await submitting;
    assert.equal(
      harness.requests.filter((request) => request.method === "runtime/capabilities/register").length,
      1,
    );
    assert.equal(harness.requests.filter((request) => request.method === "turn/start").length, 1);
    lease.release();
  } finally {
    await runtime.dispose();
  }
});


test("capability failure preserves read history and retries only on a subsequent send", async () => {
  const harness = createHarness(false, false, [{ id: "history", status: "completed", items: [
    { id: "message", type: "agentMessage", text: "history survives" },
  ] }], false, undefined, true, true);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
    autoReconnect: false, dynamicTools: oneDynamicTool });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-created"); await waitForAuthoritative(lease);
    assert.equal(harness.requests.some(r => r.method === "runtime/capabilities/register" || r.method === "thread/resume"), false);
    const submission = () => lease.submit(intent({ type: "existing-thread", key: createConversationKey("local", "thread-created") }));
    const failed = submission();
    await waitForRequest(harness, "runtime/capabilities/register");
    harness.failCapabilityRegistration(); await assert.rejects(failed);
    assert.equal(JSON.stringify(lease.getSnapshot().timeline).includes("history survives"), true);
    const retry = submission();
    for (let i = 0; i < 50 && harness.requests.filter(r => r.method === "runtime/capabilities/register").length < 2; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(harness.requests.filter(r => r.method === "runtime/capabilities/register").length, 2);
    harness.releaseCapabilityRegistration(); await retry;
    assert.equal(harness.requests.filter(r => r.method === "turn/start").length, 1);
    lease.release();
  } finally { await runtime.dispose(); }
});


test("Thread catalog metadata removes the first-restore metadata waterfall", async () => {
  const harness = createHarness(false, false, [{
    id: "turn-history-one",
    status: "completed",
    itemsView: "full",
    items: [{ id: "message-history-one", type: "agentMessage", text: "ready" }],
  }]);
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  try {
    await runtime.connect();
    const listed = await runtime.resources.threads.list();
    assert.equal(listed.data[0]?.id, "thread-created");
    const lease = await runtime.acquireThread("thread-created");
    await waitForAuthoritative(lease);
    assert.equal(harness.requests.some((request) => request.method === "thread/resume"), false);
    assert.equal(harness.requests.filter((request) => request.method === "thread/read").length, 1);
    assert.equal(lease.getSnapshot().timeline.frames.length, 1);
    lease.release();
  } finally {
    await runtime.dispose();
  }
});


test("Host history capability removes the deep-link metadata waterfall", async () => {
  const harness = createHarness(false, false, [{
    id: "turn-history-one",
    status: "completed",
    itemsView: "full",
    items: [{ id: "message-history-one", type: "agentMessage", text: "ready" }],
  }], false, undefined, true);
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  try {
    const lease = await runtime.acquireThread("thread-created");
    await waitForAuthoritative(lease);
    assert.equal(harness.requests.some((request) => request.method === "thread/resume"), false);
    assert.equal(harness.requests.filter((request) => request.method === "thread/read").length, 1);
    lease.release();
  } finally {
    await runtime.dispose();
  }
});


test("a first Turn paints optimistically but cannot overtake its authoritative Read baseline", async () => {
  const harness = createHarness(false, true);
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-created");
    await waitForRequest(harness, "thread/read");
    const submission: SubmitIntent = {
      ...intent({
        type: "new-thread",
        draftId: "draft-promoted",
        execution: {
          hostId: "local",
          workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
        },
      }),
      target: {
        type: "existing-thread",
        key: createConversationKey("local", "thread-created"),
      },
    };

    const submitting = lease.submit(submission);
    assert.equal(
      lease.getSnapshot().timeline.frames
        .flatMap((frame) => frame.blocks)
        .filter((block) => block.type === "user-message").length,
      1,
      "the local first message paints before remote hydration",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(
      harness.requests.filter((request) => request.method === "turn/start").length,
      0,
      "the transport write cannot race the unfinished Resume snapshot",
    );

    harness.releaseResume();
    await waitForRequest(harness, "turn/start");
    await submitting;
    assert.equal(lease.getSnapshot().authoritative, true);
    assert.equal(
      lease.getSnapshot().timeline.frames
        .flatMap((frame) => frame.blocks)
        .filter((block) => block.type === "user-message").length,
      1,
    );
    lease.release();
  } finally {
    await runtime.dispose();
  }
});


test("a mounted observer is a residency owner after its View lease is released", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
    maxInactiveThreads: 0,
  });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-observed");
    await waitForAuthoritative(lease);
    const unsubscribe = lease.subscribe(() => undefined);
    assert.deepEqual(runtime.getThreadResidency("thread-observed"), {
      threadId: "thread-observed",
      phase: "resident",
      viewLeaseCount: 1,
      subscriberCount: 1,
      pendingCommandCount: 0,
      activeStreamCount: 0,
      pendingInteractionCount: 0,
      hydrating: false,
      authoritative: true,
      touchedAt: runtime.getThreadResidency("thread-observed")?.touchedAt,
    });

    lease.release();
    assert.equal(runtime.getThreadResidency("thread-observed")?.viewLeaseCount, 0);
    assert.equal(runtime.getThreadResidency("thread-observed")?.subscriberCount, 1);
    unsubscribe();
    assert.equal(runtime.getThreadResidency("thread-observed"), null);
  } finally {
    await runtime.dispose();
  }
});


test("an in-flight Thread command remains resident without a foreground View", async () => {
  const harness = createHarness(true);
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
    maxInactiveThreads: 0,
  });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-background");
    const submitting = lease.submit({
      ...intent({
        type: "new-thread",
        draftId: "unused",
        execution: {
          hostId: "local",
          workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
        },
      }),
      target: {
        type: "existing-thread",
        key: createConversationKey("local", "thread-background"),
      },
    });
    await waitForRequest(harness, "turn/start");
    lease.release();
    assert.equal(runtime.getThreadResidency("thread-background")?.viewLeaseCount, 0);
    assert.equal(runtime.getThreadResidency("thread-background")?.pendingCommandCount, 1);
    harness.releaseTurn();
    await submitting;
    assert.notEqual(
      runtime.getThreadResidency("thread-background"),
      null,
      "the accepted Turn bridges the receipt-to-stream-notification gap",
    );
  } finally {
    await runtime.dispose();
  }
});



test("host-default policy ignores stale Composer models and follows current Host configuration", async () => {
  for (const existing of [false, true]) {
    const models: Record<string, unknown>[] = [{ id: "configured-old", model: "configured-old", isDefault: true,
      inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }], defaultReasoningEffort: "medium" }];
    const harness = createHarness(false, false, [], false, models);
    const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
      autoReconnect: false, modelSelectionPolicy: "host-default" });
    try {
      await runtime.connect();
      await runtime.resources.composerCatalog.writeNewThreadDefaults({ model: "must-not-write", effort: null });
      assert.ok(!harness.requests.some(request => request.method === "config/batchWrite"));
      // Config changed after the page connected. Submission must read it again.
      models[0] = { ...models[0], id: "hermes-model:custom:configured-new", model: "hermes-model:custom:configured-new" };
      const target: SubmitIntent["target"] = existing
        ? { type: "existing-thread", key: createConversationKey("local", "thread-created") }
        : { type: "new-thread", draftId: "host-default", execution: { hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } };
      const submission = { ...intent(target), selections: { model: "auto", effort: "high" } };
      if (existing) {
        const lease = await runtime.acquireThread("thread-created");
        await waitForAuthoritative(lease);
        await lease.submit(submission);
        lease.release();
      } else await runtime.createThread(submission);
      const request = harness.requests.find(request => request.method === (existing ? "turn/start" : "thread/start"))!;
      const params = request.params as { model?: string; effort?: string };
      assert.equal(params.model, "hermes-model:custom:configured-new");
      assert.equal(params.effort, undefined, "Hermes retains configured reasoning");
      assert.equal(submission.selections.model, "auto", "original draft is not mutated");
    } finally { await runtime.dispose(); }
  }
});


test("host-default does not send when the configured default is missing", async () => {
  const harness = createHarness(false, false, [], false, [{ id: "other", model: "other", isDefault: false }]);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
    autoReconnect: false, modelSelectionPolicy: "host-default" });
  try {
    await runtime.connect();
    await assert.rejects(runtime.createThread({ ...intent({ type: "new-thread", draftId: "no-default", execution: {
      hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    } }), selections: { model: "other" } }), /当前 Bot 未配置可用的默认模型/);
    assert.equal(harness.requests.some(request => request.method === "thread/start" || request.method === "turn/start"), false);
  } finally { await runtime.dispose(); }
});


test("Host schedule invalidation subscriptions detach without affecting shared listeners", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false });
  try {
    let changes = 0;
    const remove = runtime.resources.host.subscribeSchedulesChanged!(() => { changes++; });
    const cancelled = runtime.resources.host.subscribeSchedulesChanged!(() => { throw new Error("cancelled observer called"); }); cancelled();
    await runtime.connect(); harness.notifySchedulesChanged();
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(changes, 1);
    remove(); harness.notifySchedulesChanged();
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(changes, 1);
  } finally { await runtime.dispose(); }
});



test("idle LRU detaches server readership and reacquisition waits before restoring", async () => {
  const harness = createHarness(false, false, [], true, undefined, false, false, false, false, { version: 1, unsubscribe: true });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false, maxInactiveThreads: 0 });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("evicted"); await waitForAuthoritative(lease); lease.release();
    await waitForRequest(harness, "thread/unsubscribe");
    let acquired = false;
    const reopening = runtime.acquireThread("evicted").then(value => { acquired = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(acquired, false);
    assert.equal(harness.requests.filter(request => request.method === "thread/read").length, 1);
    harness.releaseUnsubscribe();
    const restored = await reopening; await waitForAuthoritative(restored);
    assert.equal(harness.requests.filter(request => request.method === "thread/read").length, 2);
    restored.release(); harness.releaseUnsubscribe();
  } finally { await runtime.dispose(); }
});


test("text updates notify their Conversation without publishing Host residency", async () => {
  const history = [{ id: "turn-one", status: "inProgress", items: [{ id: "answer", type: "agentMessage", text: "first" }] }];
  const harness = createHarness(false, false, history);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("observed"); await waitForAuthoritative(lease);
    await new Promise(resolve => setTimeout(resolve, 0));
    let host = 0, conversation = 0;
    const stopConversation = lease.subscribe(() => conversation++);
    const stopHost = runtime.subscribe(() => host++);
    harness.notify("item/agentMessage/delta", { threadId: "observed", turnId: "turn-one", itemId: "answer", delta: " next" });
    for (let attempt = 0; attempt < 100 && conversation === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(conversation, 1); assert.equal(host, 0);
    harness.notify("turn/completed", { threadId: "observed", turn: { ...history[0], status: "completed" } });
    for (let attempt = 0; attempt < 100 && host === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(host, 1, "actual residency changes still publish once");
    stopHost(); stopConversation(); lease.release();
  } finally { await runtime.dispose(); }
});


test("idle content budget evicts oversized history even below the count limit", async () => {
  const harness = createHarness(false, false, [{ id: "one", status: "completed", items: [{ id: "text", type: "agentMessage", text: "large".repeat(1000) }] }]);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false, maxInactiveThreads: 4, maxInactiveThreadBytes: 1024 });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("large"); await waitForAuthoritative(lease);
    assert.equal(runtime.getSnapshot().residentThreads.length, 1);
    lease.release();
    assert.equal(runtime.getSnapshot().residentThreads.length, 0);
    const restored = await runtime.acquireThread("large"); await waitForAuthoritative(restored);
    assert.equal(harness.requests.filter(request => request.method === "thread/read").length, 2);
    restored.release();
  } finally { await runtime.dispose(); }
});


for (const reopen of [false, true]) {
  test(`failed idle unsubscribe ${reopen ? "cannot later detach a reopened consumer" : "retries without retaining history"}`, async () => {
    const timers = new Set<{ callback: () => void; delay: number }>();
    const harness = createHarness(false, false, [], false, undefined, false, false, false, false, { version: 1, unsubscribe: true });
    const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
      autoReconnect: false, maxInactiveThreads: 0,
      clock: { setTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer; },
        clearTimeout(timer) { timers.delete(timer as never); } },
    });
    try {
      await runtime.connect();
      const lease = await runtime.acquireThread("retry"); await waitForAuthoritative(lease);
      harness.failNextUnsubscribe(); lease.release();
      for (let attempt = 0; attempt < 100 && ![...timers].some(timer => timer.delay === 15000); attempt++) await new Promise(resolve => setTimeout(resolve, 1));
      const retry = [...timers].find(timer => timer.delay === 15000);
      assert.ok(retry);
      assert.equal(runtime.getSnapshot().residentThreads.length, 0);
      if (reopen) {
        const restored = await runtime.acquireThread("retry"); await waitForAuthoritative(restored);
        assert.equal(timers.has(retry), false);
        assert.equal(harness.requests.filter(request => request.method === "thread/unsubscribe").length, 1);
        restored.release();
      } else {
        timers.delete(retry); retry.callback();
        for (let attempt = 0; attempt < 100 && harness.requests.filter(request => request.method === "thread/unsubscribe").length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
        assert.equal(harness.requests.filter(request => request.method === "thread/unsubscribe").length, 2);
      }
    } finally { await runtime.dispose(); }
  });
}

test("opening a failed Turn is read-only and Continue resumes before admitting its new Turn", async () => {
  const harness = createHarness(false, false, [{ id: "failed", status: "failed", error: { message: "Capacity", codexErrorInfo: "serverOverloaded" }, items: [
    { id: "question", type: "userMessage", content: [{ type: "text", text: "Continue my task" }] },
  ] }]);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-created"); await waitForAuthoritative(lease);
    assert.equal(harness.requests.some(r => r.method === "thread/resume"), false);
    await lease.continueTurn(asTurnId("failed"));
    const methods = harness.requests.map(r => r.method);
    assert.equal(methods.filter(m => m === "thread/resume").length, 1);
    assert.ok(methods.indexOf("thread/resume") < methods.indexOf("turn/start"));
    lease.release();
  } finally { await runtime.dispose(); }
});
