import assert from "node:assert/strict";
import test from "node:test";

import {
  threadPrivacyLaunchRequest,
} from "../src/services/mcp-app-launcher.ts";
import { McpRegistry } from "../src/services/mcp-registry.ts";
import {
  THREAD_PRIVACY_HTML,
  THREAD_PRIVACY_RESOURCE_URI,
  THREAD_PRIVACY_SERVER_NAME,
  ThreadPrivacyService,
  threadPrivacyDisplayName,
} from "../src/services/thread-privacy.ts";

function connection(id, initialized = true) {
  return {
    identity: id ? { id, username: id.replace(/^user:/, "") } : null,
    initialized,
    activeThreadId: null,
    threadCatalogStatuses: new Map(),
    threadPresentationNames: new Map(),
  };
}

function fixture() {
  const threads = new Map([
    ["owned", {
      id: "owned", name: "My shared thread", preview: "secret", updatedAt: 10,
      recencyAt: 10, ephemeral: false, status: { type: "idle" },
    }],
    ["already-private", {
      id: "already-private", name: "My private thread", preview: "private", updatedAt: 9,
      recencyAt: 9, ephemeral: false, status: { type: "idle" },
    }],
    ["other", {
      id: "other", name: "Other user's thread", preview: "hidden", updatedAt: 8,
      recencyAt: 8, ephemeral: false, status: { type: "idle" },
    }],
    ["system", {
      id: "system", name: "System", preview: "", updatedAt: 7,
      recencyAt: 7, ephemeral: false, status: { type: "idle" },
    }],
  ]);
  const metadata = new Map([
    ["owned", { ownerPrincipalId: "user:alice", visibility: "nodeShared", kind: "transparentCodex" }],
    ["already-private", { ownerPrincipalId: "user:alice", visibility: "private", kind: "transparentCodex" }],
    ["other", { ownerPrincipalId: "user:bob", visibility: "nodeShared", kind: "transparentCodex" }],
    ["system", { ownerPrincipalId: "node:root", visibility: "nodeShared", kind: "management" }],
  ]);
  const visibilityChanges = [];
  const manager = {
    find: (id) => threads.get(id) ?? null,
    metadataFor: (id) => metadata.has(id) ? { ...metadata.get(id) } : null,
    ownerOf: (id) => metadata.get(id)?.ownerPrincipalId ?? null,
    isSystem: (id) => ["management", "all"].includes(metadata.get(id)?.kind),
    visibleTo(id, actor) {
      const value = metadata.get(id);
      return Boolean(value) && (value.visibility !== "private" || value.ownerPrincipalId === actor);
    },
    list(_params, actor) {
      return [...threads.values()]
        .filter((thread) => this.visibleTo(thread.id, actor))
        .sort((left, right) => right.recencyAt - left.recencyAt);
    },
    setVisibility(id, visibility) {
      metadata.get(id).visibility = visibility;
      visibilityChanges.push({ id, visibility });
      return threads.get(id);
    },
  };
  const alice = connection("user:alice");
  const bob = connection("user:bob");
  const charlie = connection("user:charlie");
  bob.activeThreadId = "owned";
  bob.threadCatalogStatuses.set("owned", "idle");
  bob.threadPresentationNames.set("owned", "My shared thread");
  const sent = [];
  const service = Object.create(ThreadPrivacyService.prototype);
  service.ctx = {
    threadManager: manager,
    transparentSubscription: {
      revokeWhere(id, predicate) {
        return id === "owned" && predicate(bob) ? [bob] : [];
      },
    },
    appServer: {
      connections: [alice, bob, charlie],
      send(target, message) { sent.push({ target, message }); },
    },
  };
  return { service, alice, bob, charlie, metadata, visibilityChanges, sent };
}

test("privacy service declares every Cordis dependency used by its mutation path", () => {
  assert.deepEqual(ThreadPrivacyService.inject, [
    "appServer",
    "mcpRegistry",
    "threadManager",
    "transparentSubscription",
  ]);
});

test("privacy MCP server exposes an explicit owner-authorized UI mutation", () => {
  const { service } = fixture();
  const registry = new McpRegistry();
  registry.registerServer(service.registration());

  const inventory = registry.list({ detail: "full" }).data[0];
  assert.equal(inventory.name, THREAD_PRIVACY_SERVER_NAME);
  assert.equal(inventory.resources[0].uri, THREAD_PRIVACY_RESOURCE_URI);
  assert.equal(inventory.tools["threadPrivacy.list"].annotations.readOnlyHint, true);
  assert.equal(inventory.tools["threadPrivacy.setPrivate"].annotations.readOnlyHint, false);
  assert.equal(inventory.tools["threadPrivacy.setPrivate"].annotations.idempotentHint, true);
  assert.equal(inventory.tools["threadPrivacy.setShared"].annotations.readOnlyHint, false);
  assert.equal(inventory.tools["threadPrivacy.setShared"].annotations.idempotentHint, true);
  assert.match(THREAD_PRIVACY_HTML, /window\.openai\.callTool/);
  assert.match(THREAD_PRIVACY_HTML, /threadPrivacy\.setPrivate/);
  assert.match(THREAD_PRIVACY_HTML, /threadPrivacy\.setShared/);
  assert.match(THREAD_PRIVACY_HTML, /备注：/);
  assert.match(THREAD_PRIVACY_HTML, /节点公开.*不代表互联网公开/);
  assert.match(THREAD_PRIVACY_HTML, /aria-live="polite"/);
  assert.match(THREAD_PRIVACY_HTML, /name="visibility"/);
  assert.match(THREAD_PRIVACY_HTML, /class="form-select"/);
  assert.match(THREAD_PRIVACY_HTML, /class="btn btn-primary"/);
  assert.doesNotMatch(THREAD_PRIVACY_HTML, /linear-gradient/);
  assert.doesNotMatch(THREAD_PRIVACY_HTML, /(?:^|[{;])\s*max-width\s*:/m);
  assert.doesNotMatch(THREAD_PRIVACY_HTML, /<main class="card"/);
  assert.doesNotMatch(THREAD_PRIVACY_HTML, /#[0-9a-f]{3,8}/i);
  assert.doesNotMatch(THREAD_PRIVACY_HTML, /ResizeObserver/);
  const inlineScript = THREAD_PRIVACY_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript));
});

test("privacy chooser turns skill invocation titles into readable labels", () => {
  assert.equal(
    threadPrivacyDisplayName("☁️ [$hypernode](/workspace/.codex/skills/hypernode/SKILL.md)"),
    "HyperNode",
  );
  assert.equal(
    threadPrivacyDisplayName("[$set-visibility](/workspace/.codex/skills/set-visibility/SKILL.md)"),
    "设置可见性",
  );
  assert.equal(threadPrivacyDisplayName("[Project notes](https://example.com)"), "Project notes");
});

test("privacy chooser lists only non-system conversations owned by the SSH identity", () => {
  const { service, alice } = fixture();
  const result = service.listFor(alice, "already-private");

  assert.deepEqual(result.threads.map(({ id }) => id), ["owned", "already-private"]);
  assert.equal(result.preferredThreadId, "already-private");
  assert.equal(result.threads[0].visibility, "nodeShared");
  assert.equal(result.threads[1].visibility, "private");
});

test("only the owner can make a conversation private", () => {
  const { service, bob, visibilityChanges } = fixture();

  assert.throws(
    () => service.makePrivate("owned", bob),
    (error) => error.code === -32004 && /not accessible/.test(error.message),
  );
  assert.deepEqual(visibilityChanges, []);
});

test("only the owner can make a conversation node-shared", () => {
  const { service, bob, visibilityChanges } = fixture();

  assert.throws(
    () => service.makeShared("already-private", bob),
    (error) => error.code === -32004 && /not accessible/.test(error.message),
  );
  assert.deepEqual(visibilityChanges, []);
});

test("private threads are denied inbound and suppressed outbound for non-owners", () => {
  const { service, alice, bob } = fixture();
  const request = { id: "read", method: "thread/read", params: { threadId: "already-private" } };
  assert.equal(service.guardInbound(request, alice), false);
  assert.throws(
    () => service.guardInbound(request, bob),
    (error) => error.code === -32004,
  );
  assert.equal(service.guardOutbound({
    method: "item/completed",
    params: { threadId: "already-private", item: { type: "agentMessage" } },
  }, bob), null);
  assert.deepEqual(service.guardOutbound({
    method: "thread/archived",
    params: { threadId: "already-private", hypernodePrivacyRevocation: true },
  }, bob), {
    method: "thread/archived",
    params: { threadId: "already-private" },
  });
});

test("making a conversation private revokes other viewers immediately", () => {
  const { service, alice, bob, charlie, metadata, visibilityChanges, sent } = fixture();
  const result = service.makePrivate("owned", alice);

  assert.equal(metadata.get("owned").visibility, "private");
  assert.deepEqual(visibilityChanges, [{ id: "owned", visibility: "private" }]);
  assert.equal(result.ownerPrincipalId, "user:alice");
  assert.equal(result.revokedConnections, 2);
  assert.equal(bob.activeThreadId, null);
  assert.equal(bob.threadCatalogStatuses.has("owned"), false);
  assert.equal(bob.threadPresentationNames.has("owned"), false);
  assert.deepEqual(sent.map(({ target, message }) => ({
    target: target.identity.id,
    method: message.method,
    threadId: message.params.threadId,
  })), [
    { target: "user:bob", method: "thread/archived", threadId: "owned" },
    { target: "user:charlie", method: "thread/archived", threadId: "owned" },
  ]);
});

test("making an already-private conversation private is notification-idempotent", () => {
  const { service, alice, visibilityChanges, sent } = fixture();
  const result = service.makePrivate("already-private", alice);

  assert.equal(result.visibility, "private");
  assert.equal(result.revokedConnections, 0);
  assert.deepEqual(visibilityChanges, [{ id: "already-private", visibility: "private" }]);
  assert.deepEqual(sent, []);
});

test("making a private conversation node-shared announces it to other SSH users", () => {
  const { service, alice, bob, metadata, visibilityChanges, sent } = fixture();
  const result = service.makeShared("already-private", alice);

  assert.equal(metadata.get("already-private").visibility, "nodeShared");
  assert.equal(result.visibility, "nodeShared");
  assert.equal(result.notifiedConnections, 2);
  assert.equal(service.ctx.threadManager.visibleTo("already-private", bob.identity.id), true);
  assert.deepEqual(visibilityChanges, [{ id: "already-private", visibility: "nodeShared" }]);
  assert.deepEqual(sent.map(({ target, message }) => ({
    target: target.identity.id,
    method: message.method,
    threadId: message.params.threadId,
  })), [
    { target: "user:bob", method: "thread/unarchived", threadId: "already-private" },
    { target: "user:charlie", method: "thread/unarchived", threadId: "already-private" },
  ]);
});

test("making an already-shared conversation shared is notification-idempotent", () => {
  const { service, alice, visibilityChanges, sent } = fixture();
  const result = service.makeShared("owned", alice);

  assert.equal(result.visibility, "nodeShared");
  assert.equal(result.notifiedConnections, 0);
  assert.deepEqual(visibilityChanges, [{ id: "owned", visibility: "nodeShared" }]);
  assert.deepEqual(sent, []);
});

test("set-visibility virtual skill launches the visibility MCP App for the current thread", () => {
  assert.deepEqual(threadPrivacyLaunchRequest("thread-123"), {
    kind: "mcpAppLaunch",
    server: THREAD_PRIVACY_SERVER_NAME,
    tool: "threadPrivacy.list",
    arguments: { preferredThreadId: "thread-123" },
    resourceUri: THREAD_PRIVACY_RESOURCE_URI,
    pluginId: "hypernode-control",
    appName: "设置可见性",
    actionName: "设置会话可见性",
    readOnlyHint: true,
  });
});
