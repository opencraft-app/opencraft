import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  MCP_APP_BUILDER_HTML,
  McpAppBuilderService,
  validateDynamicMcpAppSpec,
} from "../src/services/mcp-app-builder.ts";
import { McpRegistry } from "../src/services/mcp-registry.ts";

const OWNER = { identity: { id: "user-1", username: "alice" } };
const OTHER = { identity: { id: "user-2", username: "bob" } };

function html(label = "one") {
  return `<!doctype html><html><body><button id="run">${label}</button><script>window.openai.callTool("demo.run", {})<\/script></body></html>`;
}

function spec(overrides = {}) {
  return {
    appId: "demo-app",
    title: "Demo App",
    description: "A dynamically published test app.",
    uiHtml: html(),
    entryTool: "demo.run",
    tools: [{
      name: "demo.run",
      title: "Run demo",
      description: "Echo the supplied arguments.",
      inputSchema: { type: "object", additionalProperties: true },
      readOnlyHint: true,
      handler: { kind: "echo", text: "r1" },
    }],
    ...overrides,
  };
}

function sqliteStorage() {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec(source, ...bindings) {
      const statement = database.prepare(source);
      const rows = statement.columns().length > 0
        ? statement.all(...bindings)
        : (statement.run(...bindings), []);
      return { toArray: () => rows };
    },
  };
  return {
    available: true,
    sql,
    transactionSync(callback) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function harness(storage = null) {
  const registry = new McpRegistry();
  const skills = new Map();
  const service = Object.create(McpAppBuilderService.prototype);
  service.apps = new Map();
  service.releases = new Map();
  service.runtimeRestores = [];
  service.ctx = {
    storage: storage ?? {
      available: false,
      sql: null,
      transactionSync(callback) { return callback(); },
    },
    mcpRegistry: {
      replaceServer(server) { return registry.replaceServer(server); },
      removeServer(name) { return registry.removeServer(name); },
    },
    virtualSkills: {
      replace(skill) {
        const previous = skills.get(skill.name);
        skills.set(skill.name, skill);
        return () => {
          if (skills.get(skill.name) !== skill) return false;
          if (previous) skills.set(skill.name, previous);
          else skills.delete(skill.name);
          return true;
        };
      },
      remove(name) { return skills.delete(name); },
    },
  };
  return { registry, service, skills };
}

test("dynamic MCP App validation rejects unsafe or incomplete UI bundles", () => {
  assert.equal(validateDynamicMcpAppSpec(spec()).appId, "demo-app");
  assert.throws(() => validateDynamicMcpAppSpec(spec({ uiHtml: "<p>fragment</p>" })), /complete HTML/);
  assert.throws(() => validateDynamicMcpAppSpec(spec({ uiHtml: "<!doctype html><script src='x.js'></script><script>window.openai</script>" })), /external scripts/);
  assert.throws(() => validateDynamicMcpAppSpec(spec({ entryTool: "missing" })), /entryTool/);
  assert.throws(() => validateDynamicMcpAppSpec(spec({
    tools: [{ ...spec().tools[0], handler: { kind: "javascript", source: "return (;" } }],
  })), /Unexpected token|expression/);
});

test("builder UI is self-contained and uses the MCP Apps bridge without ResizeObserver", () => {
  assert.match(MCP_APP_BUILDER_HTML, /window\.openai/);
  assert.match(MCP_APP_BUILDER_HTML, /appBuilder\.publish/);
  assert.doesNotMatch(MCP_APP_BUILDER_HTML, /ResizeObserver/);
  assert.doesNotMatch(MCP_APP_BUILDER_HTML, /<script\b[^>]*\bsrc=/i);
});

test("publishing hot-replaces a real server and skill with content-addressed UI versions", () => {
  const { registry, service, skills } = harness();
  service.saveDraft(spec(), OWNER);
  const r1 = service.publish("demo-app", OWNER);
  assert.equal(r1.revision, 1);
  assert.match(r1.uiResourceUri, /^ui:\/\/hypernode\/apps\/demo-app\/sha256-[a-f0-9]{64}\.html$/);
  assert.equal(registry.servers.get("hypernode-app-demo-app").version, "1.0.0");
  assert.ok(skills.has("app-demo-app"));

  const oldServer = registry.servers.get("hypernode-app-demo-app");
  service.saveDraft(spec({
    tools: [{ ...spec().tools[0], handler: { kind: "echo", text: "r2" } }],
  }), OWNER);
  const r2 = service.publish("demo-app", OWNER);
  assert.equal(r2.revision, 2);
  assert.equal(r2.uiResourceUri, r1.uiResourceUri, "backend-only release reuses the UI cache key");
  assert.equal(registry.servers.get("hypernode-app-demo-app").version, "2.0.0");

  const pinned = oldServer.tools[0].call({ value: 1 }, {
    connection: OWNER, server: oldServer.name, threadId: "thread-1", tool: "demo.run", meta: null,
  });
  assert.equal(pinned.structuredContent.revision, 1, "a call pinned before replacement keeps its release closure");

  service.saveDraft(spec({ uiHtml: html("three") }), OWNER);
  const r3 = service.publish("demo-app", OWNER);
  assert.equal(r3.revision, 3);
  assert.notEqual(r3.uiResourceUri, r2.uiResourceUri, "a UI byte change gets a new resource URI");

  const listing = registry.list({}, OWNER);
  assert.ok(listing.data.some((server) => server.name === "hypernode-app-demo-app"));
  assert.ok(!registry.list({}, OTHER).data.some((server) => server.name === "hypernode-app-demo-app"));
  assert.throws(() => registry.read({
    server: "hypernode-app-demo-app", uri: r3.uiResourceUri,
  }, OTHER), /unknown MCP server/);
});

test("rollback atomically reactivates an immutable release and its original UI URI", () => {
  const { registry, service } = harness();
  service.saveDraft(spec(), OWNER);
  const r1 = service.publish("demo-app", OWNER);
  service.saveDraft(spec({ uiHtml: html("two") }), OWNER);
  service.publish("demo-app", OWNER);
  const active = service.rollback("demo-app", 1, OWNER);
  assert.equal(active.uiResourceUri, r1.uiResourceUri);
  assert.equal(registry.servers.get("hypernode-app-demo-app").version, "1.0.0");
  assert.equal(service.launchRequest("demo-app", OWNER).resourceUri, r1.uiResourceUri);
  assert.throws(() => service.rollback("demo-app", 1, OTHER), /not found/);
});

test("ordinary DSH capability calls can unpublish and republish an owned App", () => {
  const { registry, service, skills } = harness();
  service.saveDraft(spec(), OWNER);
  service.publish("demo-app", OWNER);

  const result = service.executeAgent({ action: "unpublish", app_id: "demo-app" }, "user-1");
  assert.match(result.text, /"unpublished":true/);
  assert.equal(registry.servers.has("hypernode-app-demo-app"), false);
  assert.equal(skills.has("app-demo-app"), false);
  assert.equal(service.apps.get("demo-app").activeRevision, null);
  assert.equal(service.releases.get("demo-app").size, 1);

  const republished = service.publish("demo-app", OWNER);
  assert.equal(republished.revision, 2);
  assert.equal(registry.servers.has("hypernode-app-demo-app"), true);
  assert.equal(skills.has("app-demo-app"), true);
});

test("ordinary DSH capability calls permanently delete only an owned App", () => {
  const storage = sqliteStorage();
  const { registry, service, skills } = harness(storage);
  service.initializeStorage();
  service.saveDraft(spec(), OWNER);
  service.publish("demo-app", OWNER);

  assert.throws(
    () => service.executeAgent({ action: "delete", app_id: "demo-app" }, "user-2"),
    /not found/,
  );
  const result = service.executeAgent({ action: "delete", app_id: "demo-app" }, "user-1");
  assert.match(result.text, /"deleted":true/);
  assert.equal(registry.servers.has("hypernode-app-demo-app"), false);
  assert.equal(skills.has("app-demo-app"), false);
  assert.equal(service.apps.has("demo-app"), false);
  assert.equal(service.releases.has("demo-app"), false);

  const reconstructed = harness(storage);
  reconstructed.service.initializeStorage();
  reconstructed.service.loadStorage();
  assert.equal(reconstructed.service.apps.has("demo-app"), false);
  assert.equal(reconstructed.service.releases.has("demo-app"), false);
});

test("a published JavaScript handler executes in the version-pinned server closure", () => {
  const { registry, service } = harness();
  service.saveDraft(spec({
    tools: [{
      ...spec().tools[0],
      handler: {
        kind: "javascript",
        source: "return { structuredContent: { doubled: Number(args.value) * 2, revision: context.revision }, text: 'computed' };",
      },
    }],
  }), OWNER);
  service.publish("demo-app", OWNER);
  const result = registry.call({
    server: "hypernode-app-demo-app",
    tool: "demo.run",
    threadId: "thread-1",
    arguments: { value: 21 },
  }, OWNER);
  assert.deepEqual(result.structuredContent, { doubled: 42, revision: 1 });
  assert.equal(result.content[0].text, "computed");
});

test("DSH can publish a complete App through one high-level capability call", () => {
  const { registry, service } = harness();
  const result = service.executeAgent({
    action: "publish",
    spec_json: JSON.stringify(spec({
      tools: [{
        ...spec().tools[0],
        handler: { kind: "javascript", source: "return { answer: Number(args.value || 0) + 1 };" },
      }],
    })),
  }, "user-1");
  assert.match(result.text, /"published":true/);
  assert.match(result.text, /\$app-demo-app/);
  assert.equal(registry.servers.get("hypernode-app-demo-app").version, "1.0.0");
});

test("drafts, immutable releases, and the active pointer survive catalog reconstruction", () => {
  const storage = sqliteStorage();
  const first = harness(storage);
  first.service.initializeStorage();
  first.service.saveDraft(spec(), OWNER);
  const r1 = first.service.publish("demo-app", OWNER);
  first.service.saveDraft(spec({ uiHtml: html("two") }), OWNER);
  const r2 = first.service.publish("demo-app", OWNER);
  first.service.rollback("demo-app", 1, OWNER);

  const second = harness(storage);
  second.service.initializeStorage();
  second.service.loadStorage();
  assert.equal(second.service.apps.get("demo-app").activeRevision, 1);
  assert.equal(second.service.apps.get("demo-app").nextRevision, 3);
  assert.equal(second.service.releases.get("demo-app").get(1).uiResourceUri, r1.uiResourceUri);
  assert.equal(second.service.releases.get("demo-app").get(2).uiResourceUri, r2.uiResourceUri);
});
