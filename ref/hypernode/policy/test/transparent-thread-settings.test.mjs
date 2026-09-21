import assert from "node:assert/strict";
import test from "node:test";
import { TransparentBackendRpcService } from "../src/services/transparent-backend-rpc.ts";
import { TransparentOuterQueueService } from "../src/services/transparent-outer-queue.ts";
import { TransparentOuterDispatchService } from "../src/services/transparent-outer-dispatch.ts";
import { TransparentThreadSettingsService } from "../src/services/transparent-thread-settings.ts";

import {
  TransparentCodexThreadService,
} from "../src/services/transparent-codex-thread.ts";
import {
  attachTransparentProtocolMapper,
  attachTransparentRuntimeAccess,
} from "./support/transparent-protocol-mapper.mjs";
import {
  normalizeTurnModel,
  projectedThreadSettings,
  threadResumeSettingsFromTurn,
  transparentThreadOpenParams,
} from "../src/services/transparent-thread-routing.ts";

test("turn routing writes the composer collaboration model into the official top-level field", () => {
  const original = {
    id: 7,
    method: "turn/start",
    params: {
      threadId: "outer",
      model: null,
      collaborationMode: { mode: "default", settings: { model: "ep-xodwa4gc" } },
      input: [],
    },
  };
  const normalized = normalizeTurnModel(original, {
    model: "gpt-5.6-sol",
    providerId: "openai",
  });
  assert.equal(normalized.params.model, "ep-xodwa4gc");
  assert.equal(normalized.params.collaborationMode.settings.model, "ep-xodwa4gc");
  assert.equal("modelProvider" in normalized.params, false);
  assert.equal(original.params.model, null, "normalization must not mutate the client message");
});

test("turn routing falls back to the durable model when Desktop omits both model fields", () => {
  const message = { id: 8, method: "turn/start", params: { threadId: "outer", input: [] } };
  assert.equal(normalizeTurnModel(message, { model: "ep-public" }).params.model, "ep-public");
  assert.equal(normalizeTurnModel({ method: "turn/steer", params: {} }, null).method, "turn/steer");
});

const settings = {
  approvalPolicy: "never",
  approvalsReviewer: "user",
  model: "gpt-5.6-sol",
  effort: "xhigh",
  serviceTier: "priority",
  permissions: ":danger-full-access",
  sandbox: "danger-full-access",
  sandboxPolicy: null,
  runtimeWorkspaceRoots: ["/workspace/project", "/workspace/shared"],
  config: { featureFlags: { futureProtocolField: true } },
  futureProtocolField: { nested: "preserved" },
};

test("thread open params preserve present and future client settings", () => {
  const requested = {
    ...settings,
    ephemeral: null,
    cwd: "/workspace/project",
    projectId: "project-hypernode-outer-only",
  };
  const params = transparentThreadOpenParams("thread/start", requested, {
    cwd: "/workspace/@main/projects/project",
    ephemeral: false,
    threadSource: "appServer",
  });

  const { projectId: _outerProjectId, ...backendRequested } = requested;
  assert.deepEqual(params, {
    ...backendRequested,
    cwd: "/workspace/@main/projects/project",
    threadSource: "appServer",
  });
  assert.equal("projectId" in params, false);
  assert.equal(requested.projectId, "project-hypernode-outer-only", "the outer binding is not mutated");
  assert.equal(requested.threadSource, undefined, "the client request must not be mutated");
});

test("thread resume by committed artifact pairs its required native id with the path", () => {
  const params = transparentThreadOpenParams("thread/resume", {
    ...settings,
    threadId: "outer-thread",
    projectId: "project-hypernode-outer-only",
    cwd: "/workspace/project",
    path: "/workspace/.codex/sessions/rollout.jsonl",
  }, {
    threadId: "inner-thread",
    cwd: "/workspace/@fork/projects/project",
    path: "/workspace/.hypernode/threads/outer-thread/generation-2.jsonl",
  });

  assert.equal(params.threadId, "inner-thread");
  assert.equal(params.cwd, "/workspace/@fork/projects/project");
  assert.equal(params.path, "/workspace/.hypernode/threads/outer-thread/generation-2.jsonl");
  assert.equal("projectId" in params, false);
  assert.deepEqual(params.permissions, settings.permissions);
  assert.equal(params.futureProtocolField.nested, "preserved");
});

test("thread resume without an artifact uses only the native inner id", () => {
  const params = transparentThreadOpenParams("thread/resume", {
    threadId: "outer-thread",
    path: "/stale/client-rollout.jsonl",
  }, {
    threadId: "inner-thread",
    cwd: "/workspace/projects/project",
  });

  assert.equal(params.threadId, "inner-thread");
  assert.equal(params.path, undefined);
});

test("turn permissions survive the internal resume boundary", () => {
  const resumed = threadResumeSettingsFromTurn({
    approvalPolicy: "never",
    approvalsReviewer: "user",
    permissions: ":danger-full-access",
    runtimeWorkspaceRoots: ["/workspace/projects", "/workspace/shared"],
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/stale"] },
    model: "gpt-5.6-sol",
    input: [{ type: "text", text: "must not enter thread/resume" }],
  });

  assert.equal(resumed.permissions, ":danger-full-access");
  assert.equal(resumed.approvalPolicy, "never");
  assert.deepEqual(resumed.runtimeWorkspaceRoots, ["/workspace/projects", "/workspace/shared"]);
  assert.equal(resumed.sandbox, undefined, "permissions and sandbox are mutually exclusive");
  assert.equal(resumed.input, undefined);
});

test("an explicit turn sandbox maps to the legacy resume sandbox mode", () => {
  assert.equal(threadResumeSettingsFromTurn({
    sandboxPolicy: { type: "dangerFullAccess" },
  }).sandbox, "danger-full-access");
  assert.equal(threadResumeSettingsFromTurn({
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  }).sandbox, "read-only");
  assert.equal(threadResumeSettingsFromTurn({
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/workspace"] },
  }).sandbox, "workspace-write");
});

test("public model settings project a complete thread-scoped notification", () => {
  const projected = projectedThreadSettings({
    model: "ep-xodwa4gc",
    effort: "low",
  }, {}, {
    cwd: "/workspace/project",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: { id: ":danger-full-access" },
  }, {}, "hypernode-public-kimi-k3");

  assert.equal(projected.model, "ep-xodwa4gc");
  assert.equal(projected.modelProvider, "hypernode-public-kimi-k3");
  assert.equal(projected.cwd, "/workspace/project");
  assert.equal(projected.approvalPolicy, "never");
  assert.equal(projected.effort, "low");
  assert.equal(projected.collaborationMode.settings.model, "ep-xodwa4gc");
  assert.equal(projected.collaborationMode.settings.reasoningEffort, "low");
  assert.deepEqual(projected.sandboxPolicy, { type: "dangerFullAccess" });
});

test("routed thread settings acknowledge locally and stage the next-Turn provider route", () => {
  const service = Object.create(TransparentThreadSettingsService.prototype);
  const outerThreadId = "outer-thread";
  const connection = { socket: { send: (message) => sent.push(message) } };
  const sent = [];
  const broadcasts = [];
  let stored;
  const runtimeHints = new Map([[outerThreadId, {
    ownerUserId: "user:new",
    accountIdentity: null,
  }]]);
  service.ctx = {
    appServer: {
      send: (_connection, response) => sent.push(response),
      audit: () => {},
      summarizeResult: () => ({}),
      broadcastNotification: (method, params) => broadcasts.push({ method, params }),
    },
    threadManager: {
      get: () => ({ id: outerThreadId, cwd: "/workspace/project" }),
      changed: () => {},
    },
    transparentRuntimeAccess: { stateForOuter: () => null },
    transparentThreadBinding: {
      runtimeHintFor: (threadId) => runtimeHints.get(threadId) ?? null,
      setRuntimeHint: (_threadId, value) => { stored = value; },
    },
  };

  service.update({
    connection,
    threadId: outerThreadId,
    message: {
      id: "settings-request",
      method: "thread/settings/update",
      params: { threadId: outerThreadId, model: "ep-xodwa4gc", effort: "low" },
    },
    provider: { id: "hypernode-public-kimi-k3" },
  });

  assert.deepEqual(sent, [{ id: "settings-request", result: {} }]);
  assert.equal(stored.nextProviderId, "hypernode-public-kimi-k3");
  assert.equal(stored.nextModel, "ep-xodwa4gc");
  assert.equal(stored.providerId, undefined, "the active Runtime identity is not mutated");
  assert.equal(broadcasts[0].method, "thread/settings/updated");
  assert.equal(broadcasts[0].params.threadSettings.model, "ep-xodwa4gc");
});

test("steer stays on the active Turn Runtime after next-Turn settings change", () => {
  const service = Object.create(TransparentCodexThreadService.prototype);
  const outerThreadId = "outer-thread";
  const connection = {};
  const forwarded = [];
  const runtime = {
    backendKey: "runtime-openai",
    phase: "ready",
    opened: new Set([outerThreadId]),
    openResults: new Map(),
  };
  service.bindings = new Map([[outerThreadId, { realm: "workspace", viewId: "main" }]]);
  service.principal = { id: "principal:root" };
  service.backends = new Map([[runtime.backendKey, runtime]]);
  service.runtimeHintFor = () => ({
    ownerUserId: "user:alice",
    providerId: "openai",
    model: "gpt-5.6-sol",
    backendKey: runtime.backendKey,
    nextProviderId: "public-k3",
    nextModel: "kimi-k3",
  });
  service.filesystemForRealm = () => ({});
  service.attachConnection = () => {};
  service.forwardNow = (state, actor, threadId, message) => {
    forwarded.push({ state, actor, threadId, message });
  };
  service.ctx = {
    principal: { current: () => ({ id: "principal:root" }) },
    threadExecution: {
      table: { get: () => ({ runtimeId: runtime.backendKey, executionProfile: { fingerprint: "openai" } }) },
    },
    threadManager: {
      metadataFor: () => ({ ownerPrincipalId: "user:alice" }),
      find: () => ({ cwd: "/workspace/project" }),
    },
    runtimeWorkspace: { viewIdForThread: () => "main" },
    transparentThreadBinding: {
      bindings: service.bindings,
      runtimeHintFor: service.runtimeHintFor,
    },
    transparentBackendLifecycle: { ensure: () => assert.fail("active Runtime must be reused") },
    transparentBackendChannel: { send: () => assert.fail("steer must be forwarded") },
    transparentOuterDispatch: {
      forward: (state, actor, threadId, message) =>
        service.forwardNow(state, actor, threadId, message),
      open: () => assert.fail("active Runtime is already open"),
    },
  };
  attachTransparentRuntimeAccess(service);
  service.ctx.transparentBackendRegistry.attach = () => {};
  service.ctx.transparentOuterQueue = Object.assign(
    Object.create(TransparentOuterQueueService.prototype),
    { ctx: service.ctx },
  );

  service.ctx.transparentOuterQueue.enqueue({
    connection,
    outerThreadId,
    action: {
      connection,
      message: { id: "steer-1", method: "turn/steer", params: { threadId: outerThreadId, input: [] } },
      respondFromOpen: false,
    },
  });

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].state, runtime);
});

function serviceHarness({ resume }) {
  const outerThreadId = "outer-thread";
  const innerThreadId = "inner-thread";
  const sent = [];
  const filesystem = {
    ensureWorkingDirectory: (cwd) => assert.equal(cwd, "/workspace/project"),
    owns: (value) => value === "/workspace" || value.startsWith("/workspace/"),
    toPhysical: (value) => value.replace(/^\/workspace/, "/runtime/workspace"),
    toVirtual: (value) => value.replace(/^\/runtime\/workspace/, "/workspace"),
    send: (_processId, message) => sent.push(structuredClone(message)),
  };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.sequence = 0;
  service.bindings = resume
    ? new Map([[outerThreadId, { innerThreadId, backendKey: "backend", durable: true }]])
    : new Map();
  service.reverseBindings = resume ? new Map([[innerThreadId, outerThreadId]]) : new Map();
  service.runtimeHints = resume
    ? new Map([[outerThreadId, {
      providerId: "hypernode-public-kimi-k3",
      model: "ep-xodwa4gc",
    }]])
    : new Map();
  service.runtimeHintFor = (threadId) => service.runtimeHints.get(threadId) ?? null;
  service.ctx = {
    transparentOuterDispatch: Object.create(TransparentOuterDispatchService.prototype),
    transparentBackendRpc: Object.create(TransparentBackendRpcService.prototype),
    threadArtifactStore: {
      current: () => resume
        ? {
          innerThreadId,
          path: "/workspace/.hypernode/threads/outer-thread/generation-2.jsonl",
        }
        : null,
      runtimePath: (path) => path,
      ensureModelProvider: (path, provider) => {
        assert.equal(path, "/workspace/.hypernode/threads/outer-thread/generation-2.jsonl");
        assert.equal(provider, "hypernode-public-kimi-k3");
        return {
          providerChanged: false,
          sessionMetaCount: 1,
          responseItemIdsStripped: 0,
        };
      },
    },
    threadManager: {
      get: () => ({
        id: outerThreadId,
        cwd: "/workspace/project",
        ephemeral: false,
        threadSource: "appServer",
      }),
      find: () => null,
      isTransparentCodex: () => true,
    },
  };
  attachTransparentProtocolMapper(service);
  service.ctx.transparentOuterDispatch.ctx = service.ctx;
  service.ctx.transparentOuterDispatch.sequence = 0;
  const state = {
    backendKey: "backend",
    processId: "codex",
    filesystem,
    user: null,
    realm: "workspace",
    viewId: resume ? "fork" : "main",
    opening: new Set(),
    opened: new Set(),
    internalRequests: new Map(),
    pendingByOuter: new Map([[outerThreadId, [{
      message: {
        id: "desktop-open",
        method: resume ? "thread/resume" : "thread/start",
        params: {
          ...settings,
          threadId: resume ? outerThreadId : undefined,
          cwd: "/workspace/project",
          path: resume ? "/workspace/.codex/sessions/rollout.jsonl" : undefined,
        },
      },
    }]]]),
  };
  return { service, state, sent, outerThreadId, innerThreadId };
}

for (const resume of [false, true]) {
  test(`transparent ${resume ? "resume" : "start"} maps routing fields without dropping settings`, () => {
    const { service, state, sent, outerThreadId, innerThreadId } = serviceHarness({ resume });
    service.openOuter(state, outerThreadId);

    assert.equal(sent.length, 1);
    const request = sent[0];
    assert.equal(request.method, resume ? "thread/resume" : "thread/start");
    assert.equal(request.params.cwd, "/runtime/workspace/project");
    assert.deepEqual(request.params.runtimeWorkspaceRoots, [
      "/runtime/workspace/project",
      "/runtime/workspace/shared",
    ]);
    assert.equal(request.params.permissions, ":danger-full-access");
    assert.equal(request.params.sandboxPolicy, null);
    assert.equal(request.params.model, "gpt-5.6-sol");
    assert.equal(request.params.effort, "xhigh");
    assert.equal(request.params.serviceTier, "priority");
    assert.deepEqual(request.params.futureProtocolField, { nested: "preserved" });
    if (resume) {
      assert.equal(request.params.threadId, innerThreadId);
      // The explicit Desktop model wins, while the durable provider route is
      // restored even if the rollout itself still records an older provider.
      assert.equal(request.params.modelProvider, "hypernode-public-kimi-k3");
      assert.equal(
        request.params.path,
        "/runtime/workspace/.hypernode/threads/outer-thread/generation-2.jsonl",
      );
    }

    const response = service.ctx.transparentRuntimeAccess.toOuter({
      id: request.id,
      result: {
        thread: { id: resume ? innerThreadId : "new-inner", cwd: request.params.cwd },
        model: request.params.model,
        effort: request.params.effort,
        serviceTier: request.params.serviceTier,
        permissions: request.params.permissions,
      },
    }, state);
    assert.equal(response.result.thread.cwd, "/workspace/project");
    if (resume) assert.equal(response.result.thread.id, outerThreadId);
    assert.equal(response.result.model, "gpt-5.6-sol");
    assert.equal(response.result.effort, "xhigh");
    assert.equal(response.result.serviceTier, "priority");
    assert.equal(response.result.permissions, ":danger-full-access");
  });
}

test("a provisional binding is restarted instead of resumed before its first durable Turn", () => {
  const { service, state, sent, outerThreadId } = serviceHarness({ resume: true });
  service.bindings.get(outerThreadId).durable = false;

  service.openOuter(state, outerThreadId);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "thread/start");
  assert.equal(sent[0].params.threadId, undefined);
  assert.equal(sent[0].params.path, undefined);
});
