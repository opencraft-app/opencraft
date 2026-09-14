import assert from "node:assert/strict";
import test from "node:test";

import { CollaborationModeService } from "../src/services/collaboration-mode.ts";
import { TransparentProcessBridgeService } from "../src/services/transparent-process-bridge.ts";
import { TransparentBackendIngressService } from "../src/services/transparent-backend-ingress.ts";
import { TransparentBackendBootstrapService } from "../src/services/transparent-backend-bootstrap.ts";
import { TransparentAccountEventService } from "../src/services/transparent-account-event.ts";
import { TransparentBackendRpcService } from "../src/services/transparent-backend-rpc.ts";
import { TransparentBackendMessageService } from "../src/services/transparent-backend-message.ts";
import { TransparentForwardedResponseService } from "../src/services/transparent-forwarded-response.ts";
import { TransparentRequestRouterService } from "../src/services/transparent-request-router.ts";
import { TransparentRequestDispatchService } from
  "../src/services/transparent-request-dispatch.ts";
import {
  TransparentCodexThreadService,
} from "../src/services/transparent-codex-thread.ts";
import {
  backendInitializeParams,
} from "../src/services/transparent-thread-routing.ts";
import { attachTransparentProtocolMapper } from "./support/transparent-protocol-mapper.mjs";

function collaborationModeService() {
  return Object.create(CollaborationModeService.prototype);
}

function transparentBackendIngress() {
  return Object.create(TransparentBackendIngressService.prototype);
}

function transparentBackendBootstrap() {
  return Object.create(TransparentBackendBootstrapService.prototype);
}

function transparentAccountEvent() {
  return Object.create(TransparentAccountEventService.prototype);
}

function attachTransparentRequestDispatch(ctx) {
  const dispatch = Object.create(TransparentRequestDispatchService.prototype);
  dispatch.ctx = ctx;
  ctx.transparentRequestDispatch = dispatch;
}

function responseHarness() {
  const sent = [];
  const connection = { socket: { send: (message) => sent.push(structuredClone(message)) } };
  const service = Object.create(TransparentCodexThreadService.prototype);
  service.sequence = 0;
  service.bindings = new Map();
  service.reverseBindings = new Map();
  const transparentProcessBridge = Object.create(TransparentProcessBridgeService.prototype);
  transparentProcessBridge.sequence = 0;
  service.ctx = {
    appServerProjection: {
      projectBackend: () => {},
      projectThread: () => {},
    },
    transparentBackendMessage: Object.create(TransparentBackendMessageService.prototype),
    transparentForwardedResponse: Object.create(TransparentForwardedResponseService.prototype),
    collaborationMode: collaborationModeService(),
    transparentAccountEvent: transparentAccountEvent(),
    transparentBackendBootstrap: transparentBackendBootstrap(),
    transparentBackendIngress: transparentBackendIngress(),
    transparentBackendRpc: Object.create(TransparentBackendRpcService.prototype),
    transparentProcessBridge,
  };
  attachTransparentProtocolMapper(service);
  const state = {
    connections: new Set([connection]),
    internalRequests: new Map(),
    internalControlRequests: new Map(),
    forwardedRequests: new Map(),
    serverRequestIds: new Map(),
    abandonedRequestIds: new Set(),
    pendingThreadMessages: new Map(),
    commandProcesses: new Map(),
    hostProcesses: new Map(),
    threadOwners: new Map(),
  };
  return { service, state, connection, sent };
}

test("legacy collaboration presets match Codex 0.148 wire shape", () => {
  assert.deepEqual(collaborationModeService().legacyResponse(), {
    data: [
      { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
      { name: "Default", mode: "default", model: null, reasoning_effort: null },
    ],
  });
});

test("backend initialize preserves Desktop extensions without suppressing projection events", () => {
  const params = backendInitializeParams({
    clientInfo: { name: "codex_desktop", version: "26.818.61809" },
    initializeParams: {
      clientInfo: { name: "codex_desktop", version: "26.818.61809" },
      capabilities: {
        experimentalApi: false,
        requestAttestation: true,
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
        optOutNotificationMethods: ["thread/started"],
      },
      unknownFutureField: { enabled: true },
    },
  });

  assert.equal(params.capabilities.experimentalApi, true);
  assert.equal(params.capabilities.requestAttestation, true);
  assert.deepEqual(params.capabilities.extensions, {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  });
  assert.equal("optOutNotificationMethods" in params.capabilities, false);
  assert.deepEqual(params.unknownFutureField, { enabled: true });
});

test("collaboration mode catalog is routed to the per-user backend", () => {
  const service = Object.create(TransparentCodexThreadService.prototype);
  const calls = [];
  service.connections = new Map();
  service.ctx = {
    threadManager: {},
    transparentControlRouting: {
      queueControl: (connection, message) => calls.push({ connection, message }),
    },
    transparentRequestRouter: Object.create(TransparentRequestRouterService.prototype),
  };
  attachTransparentRequestDispatch(service.ctx);
  const connection = { identity: { id: "alice" } };
  const message = { id: 7, method: "collaborationMode/list", params: {} };

  assert.equal(service.intercept(message, connection), true);
  assert.deepEqual(calls, [{ connection, message }]);
});

test("collaboration catalog preserves successful backend payloads verbatim", () => {
  const { service, state, connection, sent } = responseHarness();
  state.forwardedRequests.set("backend:1", {
    connection,
    clientId: 41,
    outerThreadId: null,
    method: "collaborationMode/list",
  });
  const result = {
    data: [{
      name: "Future",
      mode: "future_mode",
      model: null,
      reasoning_effort: null,
      futureField: "/must/not/be/path-rewritten",
    }],
    futureTopLevel: { version: 2 },
  };

  service.onBackendMessage(state, { id: "backend:1", result });

  assert.deepEqual(sent, [{ id: 41, result }]);
});

test("only method-not-found receives the legacy collaboration catalog fallback", () => {
  const first = responseHarness();
  first.state.forwardedRequests.set("missing", {
    connection: first.connection,
    clientId: 1,
    outerThreadId: null,
    method: "collaborationMode/list",
  });
  first.service.onBackendMessage(first.state, {
    id: "missing",
    error: { code: -32601, message: "Method not found" },
  });
  assert.deepEqual(first.sent[0], {
    id: 1,
    result: collaborationModeService().legacyResponse(),
  });

  const second = responseHarness();
  second.state.forwardedRequests.set("unauthorized", {
    connection: second.connection,
    clientId: 2,
    outerThreadId: null,
    method: "collaborationMode/list",
  });
  second.service.onBackendMessage(second.state, {
    id: "unauthorized",
    error: { code: -32000, message: "Unauthorized" },
  });
  assert.deepEqual(second.sent[0], {
    id: 2,
    error: { code: -32000, message: "Unauthorized" },
  });
});
