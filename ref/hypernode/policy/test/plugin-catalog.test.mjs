import assert from "node:assert/strict";
import test from "node:test";

import {
  BUNDLED_PLUGIN_VERSIONS,
  HYPERNODE_MARKETPLACE,
  OPENAI_BUNDLED_MARKETPLACE,
  bundledPluginVersionForConnection,
  desktopMarketplace,
  installBundledPlugin,
  installBundledPluginForConnection,
  installedPluginSkillSummaries,
  marketplaceAddResponse,
  openAiBundledMarketplace,
  pluginDetail,
  pluginListResponse,
  visualizePluginDetail,
} from "../src/services/plugin.js";

test("SSH host catalog exposes HyperNode and the bundled Visualize plugin", () => {
  const response = pluginListResponse();
  assert.deepEqual(response.marketplaceLoadErrors, []);
  assert.deepEqual(response.featuredPluginIds, ["hypernode-control"]);
  assert.equal(response.marketplaces.length, 2);
  const marketplace = desktopMarketplace();
  assert.equal(marketplace.path, HYPERNODE_MARKETPLACE.path);
  assert.equal(marketplace.plugins.length, 1);
  const plugin = marketplace.plugins[0];
  assert.equal(plugin.source.type, "local");
  assert.equal(plugin.installed, true);
  assert.equal(plugin.installPolicy, "INSTALLED_BY_DEFAULT");
  assert.equal(plugin.availability, "AVAILABLE");

  const bundled = openAiBundledMarketplace();
  assert.equal(bundled.path, OPENAI_BUNDLED_MARKETPLACE.path);
  assert.equal(bundled.plugins.length, 1);
  assert.equal(bundled.plugins[0].id, "visualize@openai-bundled");
  assert.equal(bundled.plugins[0].localVersion, BUNDLED_PLUGIN_VERSIONS.visualize);
  assert.equal(bundled.plugins[0].interface.displayName, "可视化");
  assert.deepEqual(bundled.plugins[0].interface.capabilities, ["Interactive", "Read", "Write"]);
});

test("bundled marketplace add preserves its native identity", () => {
  assert.deepEqual(marketplaceAddResponse({
    source: "/workspace/.codex/.tmp/bundled-marketplaces/openai-bundled",
  }), {
    marketplaceName: "openai-bundled",
    installedRoot: "/workspace/.codex/.tmp/bundled-marketplaces/openai-bundled",
    alreadyAdded: true,
  });
});

test("bundled plugin version follows each Desktop materialized manifest", () => {
  const user = { username: "alice" };
  const ctx = {
    userDirectory: { find: (id) => id === "user:alice" ? user : null },
    workspaceFilesystem: {
      controlPathForUser: (path) => `/localhost/.codex${path.slice("/workspace/.codex".length)}`,
    },
    virtualFilesystem: {
      readFile(path, actualUser) {
        assert.equal(
          path,
          "/localhost/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/visualize/.codex-plugin/plugin.json",
        );
        assert.equal(actualUser, user);
        return Buffer.from(JSON.stringify({ name: "visualize", version: "1.0.22" }));
      },
    },
  };

  const version = bundledPluginVersionForConnection(
    ctx,
    { identity: { id: "user:alice" } },
    "visualize",
  );
  assert.equal(version, "1.0.22");
  assert.equal(openAiBundledMarketplace(version).plugins[0].localVersion, "1.0.22");
  assert.equal(
    visualizePluginDetail(version).skills[0].path,
    "/workspace/.codex/plugins/cache/openai-bundled/visualize/1.0.22/skills/visualize/SKILL.md",
  );
});

test("bundled plugin version rejects a manifest path escape", () => {
  const ctx = {
    userDirectory: { find: () => ({ username: "alice" }) },
    workspaceFilesystem: { controlPathForUser: (path) => path },
    virtualFilesystem: {
      readFile: () => Buffer.from(JSON.stringify({ name: "visualize", version: "../../escape" })),
    },
  };

  assert.equal(
    bundledPluginVersionForConnection(ctx, { identity: { id: "user:alice" } }, "visualize"),
    BUNDLED_PLUGIN_VERSIONS.visualize,
  );
});

test("bundled plugin install publishes the materialized tree to canonical cache", () => {
  const calls = [];
  installBundledPlugin({
    createDirectory: (...args) => calls.push(["mkdir", ...args]),
    remove: (...args) => calls.push(["remove", ...args]),
    copy: (...args) => calls.push(["copy", ...args]),
  }, "visualize", BUNDLED_PLUGIN_VERSIONS.visualize);
  assert.deepEqual(calls, [
    ["mkdir", "/workspace/.codex/plugins/cache/openai-bundled/visualize", true],
    ["remove", "/workspace/.codex/plugins/cache/openai-bundled/visualize/1.0.23", true, true],
    [
      "copy",
      "/workspace/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/visualize",
      "/workspace/.codex/plugins/cache/openai-bundled/visualize/1.0.23",
      true,
    ],
  ]);
});

test("authenticated bundled plugin install copies within the user's durable control volume", () => {
  const calls = [];
  const user = { username: "alice" };
  const ctx = {
    userDirectory: { find: (id) => id === "user:alice" ? user : null },
    workspaceFilesystem: {
      controlPathForUser: (path) => `/localhost/.codex${path.slice("/workspace/.codex".length)}`,
    },
    virtualFilesystem: {
      createDirectory: (...args) => calls.push(["mkdir", ...args]),
      remove: (...args) => calls.push(["remove", ...args]),
      copy: (...args) => calls.push(["copy", ...args]),
    },
    vfs: { kind: "memory" },
  };

  installBundledPluginForConnection(
    ctx,
    { identity: { id: "user:alice" } },
    "visualize",
    BUNDLED_PLUGIN_VERSIONS.visualize,
  );

  assert.deepEqual(calls, [
    ["mkdir", {
      path: "/localhost/.codex/plugins/cache/openai-bundled/visualize",
      recursive: true,
    }, user],
    ["remove", {
      path: "/localhost/.codex/plugins/cache/openai-bundled/visualize/1.0.23",
      recursive: true,
      force: true,
    }, user],
    ["copy", {
      sourcePath: "/localhost/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/visualize",
      destinationPath: "/localhost/.codex/plugins/cache/openai-bundled/visualize/1.0.23",
      recursive: true,
    }, ctx.vfs, user],
  ]);
});

test("catalog detail resolves the existing virtual management skill", () => {
  const detail = pluginDetail();
  assert.equal(detail.marketplaceName, "hypernode");
  assert.equal(detail.summary.id, "hypernode-control");
  assert.equal(detail.skills.length, 1);
  assert.equal(detail.skills[0].path, "/workspace/.codex/skills/hypernode/SKILL.md");
  assert.deepEqual(detail.apps, []);
  assert.deepEqual(detail.mcpServers, ["hypernode-calculator"]);
});

test("Visualize detail mirrors the native bundled plugin contract", () => {
  const detail = visualizePluginDetail();
  assert.equal(detail.marketplaceName, "openai-bundled");
  assert.equal(detail.summary.id, "visualize@openai-bundled");
  assert.equal(detail.skills[0].name, "visualize:visualize");
  assert.equal(
    detail.skills[0].path,
    "/workspace/.codex/plugins/cache/openai-bundled/visualize/1.0.23/skills/visualize/SKILL.md",
  );
  assert.equal(detail.skills[0].scope, "user");
  assert.equal(detail.skills[0].dependencies, null);
});

test("installed bundled skills use the native cache-backed skills/list shape", () => {
  assert.deepEqual(installedPluginSkillSummaries(), [visualizePluginDetail().skills[0]]);
});

test("catalog records use official nullable and collection shapes", () => {
  const plugin = desktopMarketplace().plugins[0];
  assert.equal(plugin.remotePluginId, null);
  assert.equal(plugin.interface.composerIcon, null);
  assert.ok(Array.isArray(plugin.interface.defaultPrompt));
  assert.ok(Array.isArray(plugin.interface.screenshots));
  assert.ok(Array.isArray(plugin.keywords));
});
