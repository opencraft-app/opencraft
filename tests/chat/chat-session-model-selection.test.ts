import assert from "node:assert/strict";
import test from "node:test";
import type { SubmitIntent } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { createHarness, intent, waitForAuthoritative } from "../fixtures/workbench-draft-harness";

test("session-selected configured model reaches new and existing conversation requests", async () => {
  for (const existing of [false, true]) {
    const models = [
      { id: "configured-default", model: "configured-default", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null },
      { id: "configured-custom", model: "configured-custom", isDefault: false, inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null },
    ];
    const harness = createHarness(false, false, [], false, models);
    const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
      autoReconnect: false, modelSelectionPolicy: "session" });
    try {
      await runtime.connect();
      const target: SubmitIntent["target"] = existing
        ? { type: "existing-thread", key: createConversationKey("local", "thread-created") }
        : { type: "new-thread", draftId: "chosen-model", execution: { hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } };
      const submission = { ...intent(target), selections: { model: "configured-custom" } };
      if (existing) {
        const lease = await runtime.acquireThread("thread-created");
        await waitForAuthoritative(lease);
        await lease.submit(submission);
        lease.release();
      } else await runtime.createThread(submission);
      const request = harness.requests.find(request => request.method === (existing ? "turn/start" : "thread/start"))!;
      assert.equal((request.params as { model?: string }).model, "configured-custom");
      assert.equal(harness.requests.some(request => request.method === "config/batchWrite"), false);
    } finally { await runtime.dispose(); }
  }
});

test("embedded catalog and submission use the Model Settings allowlist", async () => {
  const models = [
    { id: "configured-default", model: "configured-default", isDefault: true,
      inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null },
    { id: "provider-catalog-only", model: "provider-catalog-only", isDefault: false,
      inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null },
  ];
  const harness = createHarness(false, false, [], false, models);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
    autoReconnect: false, modelSelectionPolicy: "session",
    readSelectableModels: async () => [{ id: "configured-default", displayName: "Configured Default",
      groupKey: "plan", groupLabel: "Plan", configuredRole: "fallback" }],
  });
  try {
    await runtime.connect();
    assert.deepEqual((await runtime.resources.composerCatalog.listModels()).data.map((model) =>
      [model.id, model.displayName, model.groupLabel, model.configuredRole]),
    [["configured-default", "Configured Default", "Plan", "fallback"]]);
    await assert.rejects(runtime.createThread({ ...intent({ type: "new-thread", draftId: "catalog-only", execution: {
      hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    } }), selections: { model: "provider-catalog-only" } }), /所选模型已不可用/);
    assert.equal(harness.requests.some((request) => request.method === "thread/start"), false);
  } finally { await runtime.dispose(); }
});

test("ordinary embedded sends do not depend on Model Settings reads", async () => {
  let reads = 0;
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
    autoReconnect: false, modelSelectionPolicy: "session",
    readSelectableModels: async () => { reads += 1; throw new Error("catalog unavailable"); },
  });
  try {
    await runtime.connect();
    await runtime.createThread(intent({ type: "new-thread", draftId: "default-without-config-read", execution: {
      hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    } }));
    const lease = await runtime.acquireThread("thread-created");
    await waitForAuthoritative(lease);
    await lease.submit(intent({ type: "existing-thread", key: createConversationKey("local", "thread-created") }));
    lease.release();
    assert.equal(reads, 0);
    assert.equal(harness.requests.filter((request) => request.method === "thread/start" || request.method === "turn/start").length, 2);
  } finally { await runtime.dispose(); }
});

test("explicit embedded selection can send when Model Settings is unavailable", async () => {
  const harness = createHarness();
  let cachedLookup = false;
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
    autoReconnect: false, modelSelectionPolicy: "session",
    readSelectableModels: async (_catalog, options) => {
      cachedLookup = options?.preferCached === true;
      throw new Error("catalog unavailable");
    },
  });
  try {
    await runtime.connect();
    await runtime.createThread({ ...intent({ type: "new-thread", draftId: "explicit-unverified", execution: {
      hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    } }), selections: { model: "fixture-model" } });
    assert.equal(cachedLookup, true);
    assert.equal(harness.requests.some((request) => request.method === "thread/start"), true);
  } finally { await runtime.dispose(); }
});

test("unselected session inherits the current configured model and reasoning", async () => {
  const models: Record<string, unknown>[] = [{ id: "old-default", model: "old-default", isDefault: true,
    inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }], defaultReasoningEffort: "medium" }];
  const harness = createHarness(false, false, [], false, models);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
    autoReconnect: false, modelSelectionPolicy: "session" });
  try {
    await runtime.connect();
    models[0] = { ...models[0], id: "current-default", model: "current-default" };
    await runtime.createThread(intent({ type: "new-thread", draftId: "inherit-default", execution: {
      hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    } }));
    const request = harness.requests.find(request => request.method === "thread/start")!;
    assert.equal((request.params as { model?: string }).model, "current-default");
    assert.equal((request.params as { effort?: string }).effort, undefined);
    assert.equal(harness.requests.some(request => request.method === "config/batchWrite"), false);
  } finally { await runtime.dispose(); }
});

test("an existing session keeps its current model when the Composer has no new choice", async () => {
  const models = [
    { id: "configured-default", model: "configured-default", isDefault: true,
      inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null },
    { id: "fixture-model", model: "fixture-model", isDefault: false,
      inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null },
  ];
  const harness = createHarness(false, false, [], false, models);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
    autoReconnect: false, modelSelectionPolicy: "session" });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("thread-created");
    await waitForAuthoritative(lease);
    await lease.submit(intent({ type: "existing-thread", key: createConversationKey("local", "thread-created") }));
    lease.release();
    const request = harness.requests.find(request => request.method === "turn/start")!;
    assert.equal((request.params as { model?: string }).model, undefined);
    assert.equal(harness.requests.some(request => request.method === "config/batchWrite"), false);
  } finally { await runtime.dispose(); }
});

test("session selection rejects a model removed from the current session catalog before starting a turn", async () => {
  const models = [{ id: "configured-default", model: "configured-default", isDefault: true,
    inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null }];
  const harness = createHarness(false, false, [], false, models);
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
    autoReconnect: false, modelSelectionPolicy: "session" });
  try {
    await runtime.connect();
    await assert.rejects(runtime.createThread({ ...intent({ type: "new-thread", draftId: "removed-model", execution: {
      hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    } }), selections: { model: "removed-model" } }), /所选模型已不可用/);
    assert.equal(harness.requests.some(request => request.method === "thread/start" || request.method === "turn/start"), false);
  } finally { await runtime.dispose(); }
});



test("session model choices never write Host defaults through the catalog port", async () => {
  const harness = createHarness();
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport,
    autoReconnect: false, modelSelectionPolicy: "session" });
  try {
    await runtime.connect();
    await runtime.resources.composerCatalog.writeNewThreadDefaults({ model: "session-only", effort: "high" });
    assert.equal(harness.requests.some(request => request.method === "config/batchWrite"), false);
  } finally { await runtime.dispose(); }
});


test("personal speed selection preserves Fast and explicit standard through new and existing requests", async () => {
  for (const serviceTier of ["priority", null, undefined]) for (const existing of [false, true]) {
    const harness = createHarness();
    const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: harness.transport, autoReconnect: false });
    try {
      await runtime.connect();
      const target: SubmitIntent["target"] = existing
        ? { type: "existing-thread", key: createConversationKey("local", "thread-created") }
        : { type: "new-thread", draftId: "personal-speed", execution: { hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } };
      const submission = { ...intent(target), selections: { serviceTier } };
      if (existing) {
        const lease = await runtime.acquireThread("thread-created");
        await waitForAuthoritative(lease);
        await lease.submit(submission);
        lease.release();
      } else await runtime.createThread(submission);
      for (const method of existing ? ["turn/start"] : ["thread/start"]) {
        const request = harness.requests.find(request => request.method === method)!;
        assert.equal((request.params as { serviceTier?: string | null }).serviceTier, serviceTier, method);
        assert.equal(Object.hasOwn(request.params!, "serviceTier"), serviceTier !== undefined, "unknown tier preserves Host inheritance");
      }
      assert.equal(harness.requests.some(request => request.method === "config/batchWrite"), false);
    } finally { await runtime.dispose(); }
  }
});
