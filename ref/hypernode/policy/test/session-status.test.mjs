import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionStatusLaunchRequest,
} from "../src/services/mcp-app-launcher.ts";
import { McpRegistry } from "../src/services/mcp-registry.ts";
import {
  SESSION_STATUS_HTML,
  SESSION_STATUS_RESOURCE_URI,
  SESSION_STATUS_SERVER_NAME,
  SessionStatusService,
} from "../src/services/session-status.ts";

const alice = { identity: { id: "user:alice", username: "alice" } };

function fixture({ engine = "codex", model = "gpt-5.6", active = true } = {}) {
  const identity = "chatgpt:cf9fc489-7e2f-4d2d-b8e2-9664a992cb0e";
  const profile = {
    engineKind: engine,
    providerId: engine === "codex" ? "openai" : "public-deepseek",
    model,
    credentialIdentity: engine === "codex" ? identity : "model-provider:public:public-deepseek",
    actorUserId: "user:alice",
    turnConfig: {},
    fingerprint: "test",
  };
  const service = Object.create(SessionStatusService.prototype);
  service.ctx = {
    threadManager: {
      find: (id) => id === "thread-1" ? { id, model, status: { type: "idle" } } : null,
      visibleTo: (id, actor) => id === "thread-1" && actor === "user:alice",
      ownerOf: () => "user:alice",
    },
    threadExecution: { table: { get: () => active ? { executionProfile: profile, state: "running" } : null } },
    transparentRuntimeAccess: {
      stateForOuter: () => ({
        executionProfile: profile,
        ownerUserId: "user:alice",
        accountIdentity: profile.credentialIdentity,
        phase: "ready",
        realm: "workspace",
      }),
    },
    transparentThreadBinding: {
      runtimeHintFor: () => ({
        engineKind: engine,
        providerId: profile.providerId,
        model,
        ownerUserId: "user:alice",
        accountIdentity: profile.credentialIdentity,
        nextModel: "next-model",
      }),
      bindings: new Map([["thread-1", { realm: "workspace" }]]),
    },
    threadEngineBinding: {
      get: () => ({ engineKind: engine, generation: 2, provenance: "explicit-migration:test" }),
    },
    userDirectory: {
      find: () => ({ id: "user:alice", username: "alice", codexPlanType: "plus" }),
    },
    accountCatalog: {
      codexProfileForIdentity: (_user, value) => value === identity ? {
        id: "subscription-test",
        name: "alice@example.com",
        email: "alice@example.com",
        planType: "plus",
        accountIdentity: identity,
      } : null,
    },
    modelGateway: {
      visibleRecordsForUser: () => engine === "dsh" ? [{
        providerId: "public-deepseek",
        displayName: "DeepSeek 云端模型",
      }] : [],
    },
  };
  return service;
}

test("session status reports the active execution profile and a safe Codex account label", () => {
  const status = fixture().status("thread-1", alice);
  assert.equal(status.engine.id, "codex");
  assert.equal(status.engine.generation, 2);
  assert.equal(status.model.id, "gpt-5.6");
  assert.equal(status.account.username, "alice");
  assert.equal(status.account.displayName, "ChatGPT plus");
  assert.equal(status.account.email, "alice@example.com");
  assert.equal(status.account.planType, "plus");
  assert.equal(status.account.accountIdSuffix, "a992cb0e");
  assert.equal(JSON.stringify(status).includes("alice@example.com"), true);
  assert.equal(status.runtime.activeTurn, true);
  assert.equal(status.runtime.pendingModel, "next-model");
});

test("session status reports DSH provider and omits Codex account details", () => {
  const status = fixture({ engine: "dsh", model: "deepseek-v4-flash", active: false })
    .status("thread-1", alice);
  assert.equal(status.engine.label, "DSH 云端 Agent");
  assert.equal(status.model.providerLabel, "DeepSeek 云端模型");
  assert.equal(status.account, null);
  assert.equal(status.runtime.activeTurn, false);
});

test("session status denies an invisible conversation", () => {
  assert.throws(
    () => fixture().status("thread-1", { identity: { id: "user:bob", username: "bob" } }),
    (error) => error.code === -32004,
  );
});

test("a shared-thread viewer cannot read the Codex subscription email", () => {
  const service = fixture();
  service.ctx.threadManager.visibleTo = () => true;
  const status = service.status("thread-1", {
    identity: { id: "user:bob", username: "bob" },
  });
  assert.equal(status.account.username, "alice");
  assert.equal(status.account.email, null);
  assert.equal(JSON.stringify(status).includes("alice@example.com"), false);
});

test("session status MCP registration and UI are read-only and self-contained", () => {
  const service = fixture();
  const registry = new McpRegistry();
  registry.registerServer(service.registration());
  const inventory = registry.list({ detail: "full" }).data[0];
  assert.equal(inventory.name, SESSION_STATUS_SERVER_NAME);
  assert.equal(inventory.resources[0].uri, SESSION_STATUS_RESOURCE_URI);
  assert.equal(inventory.tools["sessionStatus.get"].annotations.readOnlyHint, true);
  assert.match(SESSION_STATUS_HTML, /window\.openai\.callTool/);
  assert.match(SESSION_STATUS_HTML, /sessionStatus\.get/);
  assert.match(SESSION_STATUS_HTML, /刷新状态/);
  assert.doesNotMatch(SESSION_STATUS_HTML, /ResizeObserver/);
  assert.doesNotMatch(SESSION_STATUS_HTML, /<script\b[^>]*\bsrc=/i);
  const inlineScript = SESSION_STATUS_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript));
});

test("session-status virtual skill launches the MCP App for its current thread", () => {
  assert.deepEqual(sessionStatusLaunchRequest(), {
    kind: "mcpAppLaunch",
    server: SESSION_STATUS_SERVER_NAME,
    tool: "sessionStatus.get",
    arguments: {},
    resourceUri: SESSION_STATUS_RESOURCE_URI,
    pluginId: "hypernode-control",
    appName: "当前会话状态",
    actionName: "查看会话状态",
    readOnlyHint: true,
  });
});
