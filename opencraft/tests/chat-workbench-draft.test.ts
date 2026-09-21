import assert from "node:assert/strict";
import test from "node:test";

import { createCordisAppServerRegistry } from "@opencraft/appserver-client";
import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  parseJsonRpcMessage,
  type JsonRpcRequest,
} from "@opencraft/appserver-protocol";
import {
  MemoryTransport,
  type InMemoryAppServer,
  type InMemoryAppServerPeer,
} from "@opencraft/appserver-transport-memory";
import type { SubmitIntent } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import {
  createAppServerWorkbenchRuntime,
  createConversationScopeRegistry,
} from "@opencraft/workbench-runtime";

interface DraftHarness {
  readonly requests: JsonRpcRequest[];
  readonly transport: MemoryTransport;
  releaseTurn(): void;
  releaseResume(): void;
  releaseUnsubscribe(): void;
  notifySkillsChanged(): void;
  notifyFsChanged(watchId: string, changedPaths: readonly string[]): void;
}

function protocolThread(id: string) {
  return {
    id,
    sessionId: `session:${id}`,
    name: "Draft fixture",
    cwd: "/workspace",
    path: `/rollouts/${id}.jsonl`,
    historyMode: "paginated",
    status: { type: "idle" },
    turns: [],
  };
}

function createHarness(
  delayTurn = false,
  delayResume = false,
  historyTurns: readonly unknown[] = [],
  delayUnsubscribe = false,
  models: readonly Record<string, unknown>[] = [{ id: "codex", model: "codex", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [{reasoningEffort:"medium",description:"Medium"}], defaultReasoningEffort:"medium" }],
): DraftHarness {
  const requests: JsonRpcRequest[] = [];
  let releaseTurn = () => undefined;
  let releaseResume = () => undefined;
  let releaseUnsubscribe = () => undefined;
  let activePeer: InMemoryAppServerPeer | null = null;
  const server: InMemoryAppServer = {
    connected(peer) {
      activePeer = peer;
    },
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(message)) return;
      requests.push(message);
      const send = (result: unknown) => peer.send(encodeJsonRpcMessage({
        id: message.id,
        result,
      }));
      if (message.method === "initialize") {
        send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "draft-test" });
      } else if (message.method === "model/list") {
        send({ data: models, nextCursor:null });
      } else if (message.method === "thread/read" && historyTurns.length > 0) {
        const threadId = (message.params as { threadId?: string }).threadId ?? "thread-created";
        send({ thread: protocolThread(threadId) });
      } else if (message.method === "thread/start") {
        send({ thread: protocolThread("thread-created") });
      } else if (message.method === "turn/start") {
        const respond = () => send({ turn: { id: "turn-created" } });
        if (delayTurn) releaseTurn = respond;
        else respond();
      } else if (message.method === "thread/resume") {
        const threadId = (message.params as { threadId?: string }).threadId ?? "thread-created";
        const respond = () => send({
          thread: protocolThread(threadId),
          model: "codex",
          modelProvider: "openai",
          serviceTier: "default",
          reasoningEffort: "medium",
          cwd: "/workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
          activePermissionProfile: { id: "workspace" },
          runtimeWorkspaceRoots: ["/workspace"],
          instructionSources: [],
          turnsBackwardsCursor: historyTurns.length > 0 ? "history:0" : null,
          itemsBackwardsCursor: null,
          initialTurnsPage: { data: [], nextCursor: null },
        });
        if (delayResume) releaseResume = respond;
        else respond();
      } else if (message.method === "thread/unsubscribe") {
        const respond = () => send({ status: "unsubscribed" });
        if (delayUnsubscribe) releaseUnsubscribe = respond; else respond();
      } else if (message.method === "thread/turns/list") {
        send({ data: historyTurns, nextCursor: null });
      } else if (message.method === "thread/items/list") {
        const turnId = (message.params as { turnId?: string }).turnId;
        const turn = historyTurns.find((candidate) => (
          typeof candidate === "object"
          && candidate !== null
          && (candidate as { id?: unknown }).id === turnId
        )) as { items?: readonly unknown[] } | undefined;
        send({ data: turn?.items ?? [], nextCursor: null });
      } else if (message.method === "project/list") {
        send({
          data: [{
            id: "project-one",
            name: "one",
            roots: [{ path: "/workspace/projects/one" }],
            metadata: {},
            position: 0,
            createdAt: 1,
            updatedAt: 1,
          }],
          nextCursor: null,
        });
      } else if (message.method === "project/create") {
        const params = message.params as {
          name: string;
          roots: Array<{ path: string }>;
          metadata?: Record<string, string> | null;
        };
        send({
          project: {
            id: "project-created",
            name: params.name,
            roots: params.roots,
            metadata: params.metadata ?? {},
            position: 1,
            createdAt: 2,
            updatedAt: 2,
          },
        });
      } else if (message.method === "fs/readDirectory") {
        send({
          entries: [
            { fileName: "one", isDirectory: true, isFile: false },
            { fileName: "README.md", isDirectory: false, isFile: true },
          ],
        });
      } else if (message.method === "fs/getMetadata") {
        send({
          isDirectory: false,
          isFile: true,
          isSymlink: false,
          createdAtMs: 1,
          modifiedAtMs: 2,
        });
      } else if (message.method === "fs/readFile") {
        send({ dataBase64: btoa("hello from sandbox\n") });
      } else if (message.method === "fs/writeFile") {
        send({});
      } else if (message.method === "fs/watch") {
        send({ path: (message.params as { path: string }).path });
      } else if (message.method === "fs/unwatch") {
        send({});
      } else if (message.method === "skills/list") {
        send({
          data: [{
            cwd: "/workspace",
            skills: [{
              name: "repo-review",
              description: "Review this repository",
              interface: {
                displayName: "Repository review",
                shortDescription: "Inspect the current changes",
                iconSmallUrl: null,
                iconLargeUrl: null,
              },
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "repo",
              enabled: true,
            }],
            errors: [],
          }],
        });
      } else {
        send({});
      }
    },
  };
  return {
    requests,
    transport: new MemoryTransport(server),
    releaseTurn: () => releaseTurn(),
    releaseResume: () => releaseResume(),
    releaseUnsubscribe: () => releaseUnsubscribe(),
    notifySkillsChanged: () => activePeer?.send(encodeJsonRpcMessage({
      method: "skills/changed",
      params: {},
    })),
    notifyFsChanged: (watchId, changedPaths) => activePeer?.send(encodeJsonRpcMessage({
      method: "fs/changed",
      params: { watchId, changedPaths },
    })),
  };
}

function intent(target: Extract<SubmitIntent["target"], { type: "new-thread" }>): SubmitIntent {
  return {
    commandId: "command-draft",
    clientMessageId: "message-draft",
    target,
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "Build it" }] }],
    },
    attachments: [],
    context: [],
    selections: {},
    options: { autoContext: true },
    createdAt: 1,
  };
}

async function waitForRequest(harness: DraftHarness, method: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (harness.requests.some((request) => request.method === method)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${method}`);
}

async function waitForAuthoritative(
  lease: Awaited<ReturnType<ReturnType<typeof createAppServerWorkbenchRuntime>["acquireThread"]>>,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (lease.getSnapshot().authoritative) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for authoritative Thread ${lease.threadId}`);
}

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
    assert.equal(harness.requests.filter(request => request.method === "thread/resume").length, 2);
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
      const deadline = Date.now() + 2000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "timed out waiting for recovery state");
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    };
    await until(() => lease.getSnapshot().phase === "error");
    assert.equal(runtime.getSnapshot().phase, "ready");
    assert.equal(runtime.getThreadResidency(lease.threadId)?.phase, "error");
    const generation = runtime.getSnapshot().connectionGeneration;
    const resumes = harness.requests.filter(r => r.method === "thread/resume").length;
    const retry = lease.retryRestore();
    assert.equal(lease.getSnapshot().phase, "syncing");
    assert.equal(lease.getSnapshot().error, null);
    await until(() => harness.requests.filter(r => r.method === "thread/resume").length > resumes);
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

test("Host filesystem resources expose Codex read, metadata, write and watch semantics", async () => {
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
    await runtime.connect();
    let changes = 0;
    const unsubscribe = runtime.resources.composerCatalog.subscribeSkillsChanged(() => {
      changes += 1;
    });
    const response = await runtime.resources.composerCatalog.listSkills({
      cwds: ["/workspace", "/shared"],
      forceReload: true,
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
    unsubscribe();
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
    await waitForRequest(harness, "thread/resume");
    assert.equal(
      harness.requests.filter((request) => request.method === "thread/resume").length,
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

test("Thread acquisition stays empty until its single authoritative Resume promotion", async () => {
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
    assert.equal(lease.getSnapshot().phase, "syncing");
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
    await waitForRequest(harness, "thread/resume");
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

test("a first Turn paints optimistically but cannot overtake its authoritative Resume baseline", async () => {
  const harness = createHarness(false, true);
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "local",
    transport: harness.transport,
    autoReconnect: false,
  });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-created");
    await waitForRequest(harness, "thread/resume");
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
