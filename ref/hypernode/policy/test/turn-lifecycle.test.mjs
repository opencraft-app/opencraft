import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_MCP_APP_PHASE_DELAYS_MS,
  SYNTHETIC_TURN_PHASE_DELAYS_MS,
  deferSyntheticMcpAppPhases,
  deferSyntheticTurnPhases,
  syntheticTurnTarget,
  startedTurnProjection,
  streamedAgentStartItem,
} from "../src/services/turn-lifecycle.ts";
import {
  VirtualSkillService,
  hasExplicitBuiltinVirtualSkill,
} from "../src/services/virtual-skill.js";

test("synthetic turn starts with native notLoaded item projection", () => {
  const turn = {
    id: "turn-1",
    items: [{ id: "stale" }],
    itemsView: "full",
    status: "inProgress",
  };

  const started = startedTurnProjection(turn);

  assert.deepEqual(started, {
    id: "turn-1",
    items: [],
    itemsView: "notLoaded",
    status: "inProgress",
  });
  assert.equal(turn.itemsView, "full", "projection must not mutate the durable Turn");
});

test("synthetic agent streaming never duplicates completed text", () => {
  const completed = {
    id: "agent-1",
    type: "agentMessage",
    text: 'open\n\n\ue200visualize\ue202{"path":"/workspace/demo.html"}\ue201',
    phase: "final_answer",
    memoryCitation: null,
  };

  const started = streamedAgentStartItem(completed);
  const delta = completed.text;

  assert.equal(started.text, "");
  assert.equal(`${started.text}${delta}`, completed.text);
  assert.equal((`${started.text}${delta}`.match(/visualize/g) ?? []).length, 1);
  assert.deepEqual(
    { ...started, text: `${started.text}${delta}` },
    completed,
    "started state plus deltas must reconstruct the authoritative completed item exactly",
  );
});

test("synthetic rich-message lifecycle crosses separate renderer commits", () => {
  assert.ok(SYNTHETIC_TURN_PHASE_DELAYS_MS.delta > 0);
  assert.ok(SYNTHETIC_TURN_PHASE_DELAYS_MS.itemCompletedAfterDelta > 0);
  assert.ok(SYNTHETIC_TURN_PHASE_DELAYS_MS.turnCompletedAfterItem > 0);
});

test("synthetic rich-message phases are queued one renderer commit at a time", () => {
  const events = [];
  const deferred = [];
  const connection = {};
  const appServer = {
    defer(actualConnection, delayMs, action) {
      assert.equal(actualConnection, connection);
      deferred.push({ delayMs, action });
    },
  };

  deferSyntheticTurnPhases(appServer, connection, {
    delta: () => events.push("delta"),
    itemCompleted: () => events.push("item/completed"),
    turnCompleted: () => events.push("turn/completed"),
  });

  assert.deepEqual(deferred.map(({ delayMs }) => delayMs), [
    SYNTHETIC_TURN_PHASE_DELAYS_MS.delta,
  ]);
  deferred.shift().action();
  assert.deepEqual(events, ["delta"]);
  assert.deepEqual(deferred.map(({ delayMs }) => delayMs), [
    SYNTHETIC_TURN_PHASE_DELAYS_MS.itemCompletedAfterDelta,
  ]);
  deferred.shift().action();
  assert.deepEqual(events, ["delta", "item/completed"]);
  assert.deepEqual(deferred.map(({ delayMs }) => delayMs), [
    SYNTHETIC_TURN_PHASE_DELAYS_MS.turnCompletedAfterItem,
  ]);
  deferred.shift().action();
  assert.deepEqual(events, ["delta", "item/completed", "turn/completed"]);
  assert.deepEqual(deferred, []);
});

test("synthetic MCP App lifecycle commits the tool before completing its Turn", () => {
  const events = [];
  const deferred = [];
  const connection = {};
  const appServer = {
    defer(actualConnection, delayMs, action) {
      assert.equal(actualConnection, connection);
      deferred.push({ delayMs, action });
    },
  };

  deferSyntheticMcpAppPhases(appServer, connection, {
    itemCompleted: () => events.push("item/completed:mcpToolCall"),
    turnCompleted: () => events.push("turn/completed"),
  });
  assert.equal(deferred[0].delayMs, SYNTHETIC_MCP_APP_PHASE_DELAYS_MS.itemCompleted);
  deferred.shift().action();
  assert.deepEqual(events, ["item/completed:mcpToolCall"]);
  assert.equal(
    deferred[0].delayMs,
    SYNTHETIC_MCP_APP_PHASE_DELAYS_MS.turnCompletedAfterItem,
  );
  deferred.shift().action();
  assert.deepEqual(events, ["item/completed:mcpToolCall", "turn/completed"]);
});

test("Desktop markdown skill mentions resolve outside the fixed management thread", () => {
  const service = Object.create(VirtualSkillService.prototype);
  service.aliases = new Map([
    ["hypernode", "hypernode"],
    ["users", "users"],
    ["search", "search-conversations"],
  ]);

  assert.equal(service.resolveInput([{
    type: "text",
    text: "[$hypernode](/workspace/.codex/skills/hypernode/SKILL.md) \n",
  }]), "hypernode");
  assert.equal(service.resolveInput([{
    type: "text",
    text: "[$users](/workspace/.codex/skills/users/SKILL.md) \n",
  }]), "users");
  assert.equal(service.resolveInput([{ type: "text", text: "普通消息" }]), null);
  assert.equal(service.resolveInput([{ type: "text", text: "$search 登录失败" }]), "search");
});

test("Codex account skill declares its Cordis account catalog dependency", () => {
  assert.equal(VirtualSkillService.inject.includes("accountCatalog"), true);
});

test("MCP App launcher skills register dynamically and seed the virtual filesystem", () => {
  const directories = [];
  const files = new Map();
  const notifications = [];
  const service = Object.create(VirtualSkillService.prototype);
  service.skills = new Map();
  service.aliases = new Map();
  service.ctx = {
    appServer: {
      broadcastNotification(method, params) { notifications.push({ method, params }); },
    },
    vfs: {
      createDirectory(path) { directories.push(path); },
      remove(path) {
        for (const file of [...files.keys()]) {
          if (file === path || file.startsWith(`${path}/`)) files.delete(file);
        }
      },
      writeFile(path, bytes) { files.set(path, String.fromCharCode(...bytes)); },
    },
  };
  const result = { kind: "mcpAppLaunch", server: "example" };

  const unregister = service.register({
    name: "calculator",
    aliases: ["calc"],
    description: "Open the calculator.",
    displayName: "Calculator",
    defaultPrompt: "Open calculator",
    run: () => result,
  });

  assert.equal(service.resolveInput([{ type: "text", text: "$calc" }]), "calc");
  assert.equal(service.execute("calc"), result);
  assert.deepEqual(directories, ["/workspace/.codex/skills/calculator"]);
  assert.match(files.get("/workspace/.codex/skills/calculator/SKILL.md"), /name: calculator/);
  assert.deepEqual(notifications, [{ method: "skills/changed", params: {} }]);
  assert.equal(unregister(), true);
  assert.deepEqual(notifications, [
    { method: "skills/changed", params: {} },
    { method: "skills/changed", params: {} },
  ]);
  assert.equal(service.resolveInput([{ type: "text", text: "$calculator" }]), null);
  assert.equal(unregister(), false);
});

test("agent-executed builder skills stay in the Codex turn instead of synthetic dispatch", () => {
  const service = Object.create(VirtualSkillService.prototype);
  service.skills = new Map();
  service.aliases = new Map();
  service.ctx = {
    vfs: {
      createDirectory() {}, remove() {}, writeFile() {},
    },
  };
  service.register({
    name: "build-mcp-app",
    execution: "agent",
    description: "Build an app from one sentence.",
    instructions: "---\nname: build-mcp-app\ndescription: Build an app.\n---\n",
    run() { throw new Error("must not execute synthetically"); },
  });
  assert.equal(service.resolveInput([{ type: "text", text: "$build-mcp-app 做一个番茄钟" }]), null);
  assert.equal(service.list()[0].name, "build-mcp-app");
});

test("virtual Skills materialize into the authenticated user's durable CODEX_HOME", () => {
  const files = new Map();
  const service = Object.create(VirtualSkillService.prototype);
  service.skills = new Map([[
    "build-mcp-app",
    {
      name: "build-mcp-app",
      description: "一句话创建 App",
      instructions: "---\nname: build-mcp-app\ndescription: 一句话创建 App\n---\n\n# Builder\n",
      resources: { "references/ui-quality.md": "审美规范" },
      run() {},
    },
  ]]);
  service.ctx = {
    userDirectory: {
      find(id) { return id === "user-1" ? { id, username: "alice", homePath: "/users/alice" } : null; },
    },
    virtualFilesystem: {
      createDirectory() {},
      remove({ path }) {
        for (const file of [...files.keys()]) if (file === path || file.startsWith(`${path}/`)) files.delete(file);
      },
      writeFile({ path }, bytes) { files.set(path, new TextDecoder().decode(Uint8Array.from(bytes))); },
    },
  };
  service.materializeForConnection({ identity: { id: "user-1" } });
  assert.match(files.get("/localhost/.codex/skills/build-mcp-app/SKILL.md"), /一句话创建 App/);
  assert.equal(
    files.get("/localhost/.codex/skills/build-mcp-app/references/ui-quality.md"),
    "审美规范",
  );
});

test("transparent routing recognizes built-in skills without a service dependency", () => {
  assert.equal(hasExplicitBuiltinVirtualSkill([{
    type: "text",
    text: "[$users](/workspace/.codex/skills/users/SKILL.md) \n",
  }]), true);
  assert.equal(hasExplicitBuiltinVirtualSkill([{ type: "text", text: "$accounts" }]), true);
  assert.equal(hasExplicitBuiltinVirtualSkill([{ type: "text", text: "$search 登录失败" }]), true);
  assert.equal(hasExplicitBuiltinVirtualSkill([{ type: "text", text: "$calculator" }]), true);
  assert.equal(hasExplicitBuiltinVirtualSkill([{ type: "text", text: "$private-thread" }]), true);
  assert.equal(hasExplicitBuiltinVirtualSkill([{ type: "text", text: "$thread-visibility" }]), true);
  assert.equal(hasExplicitBuiltinVirtualSkill([{ type: "text", text: "$share-thread" }]), true);
  assert.equal(hasExplicitBuiltinVirtualSkill([{ type: "text", text: "$set-visibility" }]), true);
  assert.equal(hasExplicitBuiltinVirtualSkill([{ type: "text", text: "普通消息" }]), false);
});

test("synthetic lifecycle is limited to system threads and explicit virtual skills", () => {
  const ctx = {
    rootThread: { is: (threadId) => threadId === "root" },
    allThread: { is: (threadId) => threadId === "all" },
    virtualSkills: {
      resolveInput: (input) => input[0]?.text === "$users" ? "users" : null,
    },
  };

  assert.equal(syntheticTurnTarget(ctx, "root", [{ type: "text", text: "hello" }]).allowed, true);
  assert.equal(syntheticTurnTarget(ctx, "all", [{ type: "text", text: "hello" }]).allowed, true);
  assert.deepEqual(syntheticTurnTarget(ctx, "ephemeral", [{ type: "text", text: "$users" }]), {
    allowed: true,
    virtualSkill: "users",
  });
  assert.deepEqual(syntheticTurnTarget(ctx, "ordinary", [{ type: "text", text: "hello" }]), {
    allowed: false,
    virtualSkill: null,
  });
});
