import assert from "node:assert/strict";
import test from "node:test";

import { TransparentCodexThreadService } from "../src/services/transparent-codex-thread.ts";
import { TransparentBackendRegistryService } from "../src/services/transparent-backend-registry.ts";
import { TransparentBackendIngressService } from "../src/services/transparent-backend-ingress.ts";
import { TransparentBackendBootstrapService } from "../src/services/transparent-backend-bootstrap.ts";
import { TransparentAccountEventService } from "../src/services/transparent-account-event.ts";
import { TransparentBackendRpcService } from "../src/services/transparent-backend-rpc.ts";
import { AppServerProjectionService } from "../src/services/appserver-projection.ts";
import { TransparentSubscriptionService } from "../src/services/transparent-subscription.ts";
import { TransparentProcessBridgeService } from "../src/services/transparent-process-bridge.ts";
import { TransparentBackendMessageService } from "../src/services/transparent-backend-message.ts";
import { TransparentForwardedResponseService } from "../src/services/transparent-forwarded-response.ts";
import { TransparentConnectionCleanupService } from "../src/services/transparent-connection-cleanup.ts";
import { TransparentControlRoutingService } from "../src/services/transparent-control-routing.ts";
import { attachTransparentProtocolMapper } from "./support/transparent-protocol-mapper.mjs";

function createHarness() {
  const backendMessages = [];
  const firstMessages = [];
  const secondMessages = [];
  const first = { socket: { send: (message) => firstMessages.push(structuredClone(message)) } };
  const second = { socket: { send: (message) => secondMessages.push(structuredClone(message)) } };
  const service = Object.create(TransparentCodexThreadService.prototype);
  const transparentBackendRegistry = Object.create(TransparentBackendRegistryService.prototype);
  transparentBackendRegistry.backends = new Map();
  transparentBackendRegistry.connections = new Map();
  const transparentProcessBridge = Object.create(TransparentProcessBridgeService.prototype);
  transparentProcessBridge.sequence = 0;
  service.sequence = 0;
  service.bindings = new Map();
  service.reverseBindings = new Map();
  service.backends = transparentBackendRegistry.backends;
  service.connections = transparentBackendRegistry.connections;
  service.accountListeners = new Set();
  service.ctx = {
    transparentBackendMessage: Object.create(TransparentBackendMessageService.prototype),
    transparentForwardedResponse: Object.create(TransparentForwardedResponseService.prototype),
    transparentAccountEvent: Object.create(TransparentAccountEventService.prototype),
    transparentBackendBootstrap: Object.create(TransparentBackendBootstrapService.prototype),
    transparentBackendIngress: Object.create(TransparentBackendIngressService.prototype),
    transparentBackendRegistry,
    transparentBackendRpc: Object.create(TransparentBackendRpcService.prototype),
    transparentSubscription: Object.assign(
      Object.create(TransparentSubscriptionService.prototype),
      { threadSubscribers: new Map(), catalogBroadcasts: new Map() },
    ),
    transparentProcessBridge,
    transparentRuntimeRetirement: { retireThreadRuntimeIfIdle: () => false },
    virtualFilesystem: {
      send: (_processId, message) => backendMessages.push(structuredClone(message)),
      toVirtual: (value) => value,
      owns: () => false,
      normalize: (value) => value,
    },
    threadManager: { find: () => null, forget: () => {}, isTransparentCodex: () => false },
    transparentThreadBinding: { clearBinding: () => {} },
  };
  service.ctx.transparentRuntimeAccess = {
    localFilesystem: service.ctx.virtualFilesystem,
    filesystem: (state) => state.filesystem,
    filesystemForCwd: (cwd) => service.ctx.runtimeWorkspace?.filesystemForCwd(
      cwd,
      service.ctx.virtualFilesystem,
    ) ?? null,
    defaultFilesystem: () => service.ctx.workspaceFilesystem ?? service.ctx.virtualFilesystem,
    backendKey: (ownerUserId, filesystem, viewId = "main") =>
      `${ownerUserId}\0${filesystem === service.ctx.workspaceFilesystem ? "workspace" : "localhost"}\0${viewId}`,
    isWorkspaceFilesystem: (filesystem) =>
      service.ctx.runtimeWorkspace?.isWorkspaceFilesystem(filesystem) ?? false,
    toInner: (message) => message,
  };
  service.ctx.credential = { resolveCodexUser: () => null };
  service.ctx.transparentBackendLifecycle = {
    ensure: () => { throw new Error("unexpected backend creation"); },
  };
  service.ctx.transparentConnectionCleanup = Object.assign(
    Object.create(TransparentConnectionCleanupService.prototype),
    { ctx: service.ctx },
  );
  service.ctx.transparentControlRouting = Object.assign(
    Object.create(TransparentControlRoutingService.prototype),
    { ctx: service.ctx, sequence: 0 },
  );
  service.ctx.appServerProjection = Object.assign(
    Object.create(AppServerProjectionService.prototype),
    { ctx: service.ctx },
  );
  attachTransparentProtocolMapper(service);
  const state = {
    backendKey: "runtime",
    processId: "backend",
    phase: "ready",
    user: null,
    viewId: "main",
    filesystem: service.ctx.virtualFilesystem,
    connections: new Set([first, second]),
    forwardedRequests: new Map(),
    internalRequests: new Map(),
    internalControlRequests: new Map(),
    serverRequestIds: new Map(),
    pendingThreadMessages: new Map(),
    commandProcesses: new Map(),
    commandProcessesByConnection: new Map(),
    hostProcesses: new Map(),
    hostProcessesByConnection: new Map(),
    abandonedRequestIds: new Set(),
    threadOwners: new Map(),
    ephemeralOuterIds: new Map(),
  };
  return { service, state, first, second, firstMessages, secondMessages, backendMessages };
}

test("streaming command process ids are isolated per frontend connection", () => {
  const harness = createHarness();
  const { service, state, first, second, firstMessages, secondMessages, backendMessages } = harness;

  service.forwardControlNow(state, first, {
    id: "first-start",
    method: "command/exec",
    params: { command: ["bash"], processId: "terminal", tty: true, streamStdin: true, streamStdoutStderr: true },
  });
  service.forwardControlNow(state, second, {
    id: "second-start",
    method: "command/exec",
    params: { command: ["bash"], processId: "terminal", tty: true, streamStdin: true, streamStdoutStderr: true },
  });

  const firstBackendProcessId = backendMessages[0].params.processId;
  const secondBackendProcessId = backendMessages[1].params.processId;
  assert.notEqual(firstBackendProcessId, secondBackendProcessId);
  assert.notEqual(firstBackendProcessId, "terminal");
  assert.notEqual(secondBackendProcessId, "terminal");

  service.onBackendMessage(state, {
    method: "command/exec/outputDelta",
    params: { processId: firstBackendProcessId, stream: "stdout", deltaBase64: "aGk=", capReached: false },
  });
  assert.equal(firstMessages.length, 1);
  assert.equal(firstMessages[0].params.processId, "terminal");
  assert.equal(secondMessages.length, 0, "terminal output is connection-scoped, not fanout traffic");

  service.forwardControlNow(state, first, {
    id: "first-resize",
    method: "command/exec/resize",
    params: { processId: "terminal", size: { cols: 120, rows: 40 } },
  });
  assert.equal(backendMessages[2].params.processId, firstBackendProcessId);

  const firstRequestId = backendMessages[0].id;
  service.onBackendMessage(state, {
    id: firstRequestId,
    result: { exitCode: 0, stdout: "", stderr: "" },
  });
  assert.equal(firstMessages.at(-1).id, "first-start");
  assert.equal(state.commandProcesses.has(firstBackendProcessId), false);
  assert.equal(state.commandProcesses.has(secondBackendProcessId), true);
});

test("host process handles are isolated and notifications retain the client handle", () => {
  const harness = createHarness();
  const { service, state, first, second, firstMessages, secondMessages, backendMessages } = harness;

  for (const [connection, id] of [[first, "first"], [second, "second"]]) {
    service.forwardControlNow(state, connection, {
      id: `${id}-spawn`,
      method: "process/spawn",
      params: { command: ["/bin/sh", "-lc", "echo ok"], processHandle: "probe", streamStdoutStderr: true },
    });
  }
  const firstHandle = backendMessages[0].params.processHandle;
  const secondHandle = backendMessages[1].params.processHandle;
  assert.notEqual(firstHandle, secondHandle);
  assert.notEqual(firstHandle, "probe");

  service.onBackendMessage(state, { id: backendMessages[0].id, result: {} });
  assert.equal(firstMessages.at(-1).id, "first-spawn");
  assert.equal(state.hostProcesses.has(firstHandle), true, "spawn acknowledgement must not release a live process");

  service.onBackendMessage(state, {
    method: "process/outputDelta",
    params: { processHandle: firstHandle, stream: "stdout", deltaBase64: "b2s=", capReached: false },
  });
  assert.equal(firstMessages.at(-1).params.processHandle, "probe");
  assert.equal(secondMessages.length, 0);

  service.forwardControlNow(state, first, {
    id: "resize",
    method: "process/resizePty",
    params: { processHandle: "probe", size: { cols: 120, rows: 40 } },
  });
  assert.equal(backendMessages.at(-1).params.processHandle, firstHandle);
  service.forwardControlNow(state, first, {
    id: "stdin",
    method: "process/writeStdin",
    params: { processHandle: "probe", deltaBase64: "ZXhpdAo=", closeStdin: false },
  });
  assert.equal(backendMessages.at(-1).params.processHandle, firstHandle);
  service.forwardControlNow(state, first, {
    id: "kill",
    method: "process/kill",
    params: { processHandle: "probe" },
  });
  assert.equal(backendMessages.at(-1).params.processHandle, firstHandle);

  service.onBackendMessage(state, {
    method: "process/exited",
    params: { processHandle: firstHandle, exitCode: 0, stdout: "", stderr: "" },
  });
  assert.equal(firstMessages.at(-1).params.processHandle, "probe");
  assert.equal(state.hostProcesses.has(firstHandle), false);
  assert.equal(state.hostProcesses.has(secondHandle), true);
});

test("terminal actions map a lexical localhost alias and generated cd input into the user home", () => {
  const harness = createHarness();
  const { service, state, first, backendMessages } = harness;
  const virtualCwd = "/localhost/polaris";
  const clientCwd = "/data/hypernode/../../localhost/polaris";
  const physicalCwd = "/data/hypernode/.runtime/users/alice/home/polaris";
  service.ctx.virtualFilesystem.normalize = (value) => {
    if (value === clientCwd) return virtualCwd;
    return value;
  };
  service.ctx.virtualFilesystem.owns = (value) => value === virtualCwd;
  service.ctx.virtualFilesystem.ensureWorkingDirectory = (value) => {
    assert.equal(value, virtualCwd);
    return physicalCwd;
  };
  service.ctx.virtualFilesystem.toPhysical = (value) => value === virtualCwd ? physicalCwd : value;

  service.forwardControlNow(state, first, {
    id: "spawn",
    method: "process/spawn",
    params: {
      command: ["/bin/bash", "-il"],
      cwd: clientCwd,
      processHandle: "terminal",
      tty: true,
    },
  });
  assert.equal(backendMessages[0].params.cwd, physicalCwd);

  const generatedInput = `cd "${clientCwd}" && echo aaa\n`;
  service.forwardControlNow(state, first, {
    id: "stdin",
    method: "process/writeStdin",
    params: {
      processHandle: "terminal",
      deltaBase64: Buffer.from(generatedInput).toString("base64"),
    },
  });
  assert.equal(
    Buffer.from(backendMessages[1].params.deltaBase64, "base64").toString("utf8"),
    `cd "${physicalCwd}" && echo aaa\n`,
  );
});

test("control processes select the backend that owns their sandbox cwd", () => {
  const harness = createHarness();
  const { service, first } = harness;
  const workspaceFilesystem = { enabled: true, owns: (cwd) => cwd.startsWith("/workspace") };
  const localhostFilesystem = { owns: (cwd) => cwd.startsWith("/localhost") };
  service.connections = new Map();
  service.ctx.transparentBackendRegistry.connections = service.connections;
  service.ctx.workspaceFilesystem = workspaceFilesystem;
  service.ctx.virtualFilesystem = localhostFilesystem;
  service.ctx.workspaceView = { viewIdForThread: () => "main" };
  service.ctx.runtimeWorkspace = {
    filesystemForCwd: (cwd) => {
      if (workspaceFilesystem.owns(cwd)) return workspaceFilesystem;
      if (localhostFilesystem.owns(cwd)) return localhostFilesystem;
      return null;
    },
    viewIdForThread: () => "main",
    isWorkspaceFilesystem: (filesystem) => filesystem === workspaceFilesystem,
  };
  const selected = [];
  service.ctx.transparentBackendLifecycle.ensure = (input) => {
    selected.push({
      filesystem: input.filesystem,
      viewId: input.viewId,
      cwd: input.initialCwd,
    });
    return { phase: "initializing", pendingControl: [] };
  };
  first.identity = { id: "alice" };

  service.ctx.transparentControlRouting.queueControl(first, {
    id: "local",
    method: "process/spawn",
    params: { cwd: "/localhost/repo", processHandle: "p", command: ["git", "status"] },
  });
  service.ctx.transparentControlRouting.queueControl(first, {
    id: "fork",
    method: "process/spawn",
    params: { cwd: "/workspace/@fork-thread-1/projects/repo", processHandle: "q", command: ["git", "status"] },
  });

  assert.equal(selected[0].filesystem, localhostFilesystem);
  assert.equal(selected[0].viewId, "main");
  assert.equal(selected[1].filesystem, workspaceFilesystem);
  assert.equal(selected[1].viewId, "thread-1");
});

test("temporary artifact reads select the active Thread's dedicated backend", () => {
  const { service, state, first } = createHarness();
  first.identity = { id: "viewer" };
  first.activeThreadId = "outer-thread";
  service.connections = new Map();
  service.ctx.transparentBackendRegistry.connections = service.connections;
  service.ctx.transparentRuntimeLocator = {
    stateForOuter: (threadId) => threadId === "outer-thread" ? state : null,
  };
  service.ctx.transparentBackendRegistry.attach = (candidate, connection) => {
    assert.equal(candidate, state);
    assert.equal(connection, first);
  };

  assert.equal(service.ctx.transparentControlRouting.stateForControl(first, {
    id: "preview",
    method: "process/spawn",
    params: { cwd: "/", command: ["cat", "/tmp/cumora.png"], processHandle: "image" },
  }), state);
});

test("closing a frontend kills its host processes", () => {
  const harness = createHarness();
  const { service, state, first, second, backendMessages } = harness;
  service.ctx.transparentBackendRegistry.connections = new Map([
    [first, new Set([state])],
    [second, new Set([state])],
  ]);
  service.connections = service.ctx.transparentBackendRegistry.connections;
  service.forwardControlNow(state, first, {
    id: "spawn",
    method: "process/spawn",
    params: { command: ["/bin/sh"], processHandle: "terminal", tty: true },
  });
  const backendHandle = backendMessages[0].params.processHandle;

  service.close(first);
  assert.equal(state.hostProcesses.size, 0);
  assert.equal(backendMessages[1].method, "process/kill");
  assert.equal(backendMessages[1].params.processHandle, backendHandle);
});

test("closing a frontend terminates its PTYs and abandons their deferred responses", () => {
  const harness = createHarness();
  const { service, state, first, second, firstMessages, secondMessages, backendMessages } = harness;
  service.ctx.transparentBackendRegistry.connections = new Map([
    [first, new Set([state])],
    [second, new Set([state])],
  ]);
  service.connections = service.ctx.transparentBackendRegistry.connections;

  service.forwardControlNow(state, first, {
    id: "start",
    method: "command/exec",
    params: { command: ["bash"], processId: "terminal", tty: true },
  });
  const startRequestId = backendMessages[0].id;
  const backendProcessId = backendMessages[0].params.processId;

  service.close(first);
  assert.equal(state.commandProcesses.size, 0);
  assert.equal(backendMessages[1].method, "command/exec/terminate");
  assert.equal(backendMessages[1].params.processId, backendProcessId);

  service.onBackendMessage(state, {
    id: startRequestId,
    result: { exitCode: 0, stdout: "", stderr: "" },
  });
  assert.equal(firstMessages.length, 0);
  assert.equal(secondMessages.length, 0, "an abandoned response must not be broadcast with its internal id");
});
