import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_VIRTUAL_SKILL_ALIASES } from "../src/services/builtin-virtual-skill.ts";
import {
  CODEX_ACCOUNTS_HTML,
  CODEX_ACCOUNTS_RESOURCE_URI,
  CODEX_ACCOUNTS_SERVER_NAME,
  ManagementCatalogAppsService,
  USERS_HTML,
  USERS_RESOURCE_URI,
  USERS_SERVER_NAME,
  resetCreditsFromUsageResponse,
  weeklyUsageFromUsageResponse,
} from "../src/services/management-catalog-apps.ts";
import {
  codexAccountsLaunchRequest,
  sharedCodexLaunchRequest,
  usersLaunchRequest,
} from "../src/services/mcp-app-launcher.ts";
import { McpRegistry } from "../src/services/mcp-registry.ts";

const connection = { identity: { id: "user:alice", username: "alice" } };

function fixture() {
  const service = Object.create(ManagementCatalogAppsService.prototype);
  let activeProfileId = "subscription-b";
  service.ctx = {
    userDirectory: {
      list: () => [{
        id: "user:alice",
        username: "alice",
        role: "administrator",
        linuxUid: 20001,
        codexBindingState: "bound",
        codexPlanType: "pro",
        loginCount: 7,
        lastLoginAtMs: 1000,
        loginOrigins: [{ remoteHost: "10.0.0.8", loginCount: 3, lastLoginAtMs: 900 }],
        sshPublicKey: "must-not-leak",
        homePath: "/private/alice",
        codexCredentialRef: "/private/auth.json",
      }],
    },
    accountCatalog: {
      list: () => [{
        userId: "user:alice",
        username: "alice",
        bindingState: "bound",
        authMode: "chatgpt",
        email: "alice@example.com",
        planType: "pro",
        lastVerifiedAtMs: 2000,
        remoteControlStatus: "enabled",
        activeProfileId,
        profiles: [
          { id: "subscription-a", name: "Personal", email: "a@example.com", planType: "plus", accountIdentity: "chatgpt:a" },
          { id: "subscription-b", name: "Work", email: "b@example.com", planType: "pro", accountIdentity: "chatgpt:b" },
        ],
      }],
      selectProfile(_connection, params) {
        activeProfileId = params.profileId;
        return {
          profile: { profileId: params.profileId },
          runtimeRefresh: { retired: 1, deferred: 0 },
        };
      },
    },
    sharedCodex: {
      list: () => [],
      activeForUser: () => null,
      shareForOwnerProfile: () => null,
      publish: () => { throw new Error("not configured"); },
      unpublish: () => false,
      activate: () => { throw new Error("not configured"); },
    },
  };
  return service;
}

test("the obsolete Hypernode menu skill alias is removed", () => {
  assert.equal(BUILTIN_VIRTUAL_SKILL_ALIASES.has("hypernode"), false);
  assert.equal(BUILTIN_VIRTUAL_SKILL_ALIASES.has("hypernode-help"), false);
});

test("users MCP output is explicit and does not leak host credentials or paths", () => {
  const result = fixture().users();
  assert.equal(result.users[0].username, "alice");
  assert.equal(result.users[0].loginOrigins[0].remoteHost, "10.0.0.8");
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes("must-not-leak"), false);
  assert.equal(encoded.includes("/private/alice"), false);
  assert.equal(encoded.includes("auth.json"), false);
});

test("Codex Accounts MCP output makes every saved profile an independent account", () => {
  const result = fixture().accounts(connection);
  assert.equal(result.accounts.length, 2);
  assert.deepEqual(result.accounts.map((account) => account.email), ["a@example.com", "b@example.com"]);
  assert.deepEqual(result.accounts.map((account) => account.active), [false, true]);
  assert.deepEqual(result.accounts.map((account) => account.selectable), [true, true]);
  assert.equal(JSON.stringify(result).includes("chatgpt:b"), false);
});

test("node-shared Codex profiles are global, first, and deduplicated for root", () => {
  const service = fixture();
  const rootConnection = { identity: { id: "node:root", username: "root" } };
  const shared = {
    shareId: "shared-owner-pro",
    ownerUserId: "user:owner",
    ownerUsername: "owner",
    ownerProfileId: "subscription-owner",
    displayName: "Owner Pro",
    email: "owner@example.com",
    planType: "pro",
    publishedAtMs: 100,
    updatedAtMs: 200,
  };
  service.ctx.accountCatalog.list = () => [{
    userId: "node:root",
    username: "root",
    bindingState: "unbound",
    authMode: null,
    email: null,
    planType: null,
    remoteControlStatus: "disconnected",
    profiles: [],
  }, {
    userId: "user:owner",
    username: "owner",
    bindingState: "bound",
    authMode: "chatgpt",
    email: "owner@example.com",
    planType: "pro",
    remoteControlStatus: "connected",
    activeProfileId: "subscription-owner",
    profiles: [{
      id: "subscription-owner",
      name: "Owner Pro",
      email: "owner@example.com",
      planType: "pro",
      accountIdentity: "chatgpt:owner",
    }],
  }];
  service.ctx.sharedCodex.list = () => [shared];
  service.ctx.sharedCodex.shareForOwnerProfile = (userId, profileId) =>
    userId === shared.ownerUserId && profileId === shared.ownerProfileId ? shared : null;

  const result = service.accounts(rootConnection);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].source, "shared");
  assert.equal(result.accounts[0].shareId, "shared-owner-pro");
  assert.equal(result.accounts[0].selectable, true);
  assert.equal(result.accounts.filter((account) => account.shareId === "shared-owner-pro").length, 1);
  assert.equal(result.accounts[1].username, "root");
});

test("a materialized shared credential is not projected as a second owned account", () => {
  const service = fixture();
  const rootConnection = { identity: { id: "node:root", username: "root" } };
  const shared = {
    shareId: "shared-owner-pro",
    ownerUserId: "user:owner",
    ownerUsername: "owner",
    ownerProfileId: "subscription-owner",
    displayName: "Owner Pro",
    email: "owner@example.com",
    planType: "pro",
    publishedAtMs: 100,
    updatedAtMs: 200,
  };
  service.ctx.accountCatalog.list = () => [{
    userId: "node:root",
    username: "root",
    bindingState: "bound",
    authMode: "chatgpt",
    email: "owner@example.com",
    planType: "pro",
    remoteControlStatus: "connected",
    profiles: [],
  }];
  service.ctx.sharedCodex.list = () => [shared];
  service.ctx.sharedCodex.activeForUser = () => shared;

  const result = service.accounts(rootConnection);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].source, "shared");
  assert.equal(result.accounts[0].active, true);
});

test("Codex weekly usage converts the direct wham response into remaining quota", () => {
  const result = weeklyUsageFromUsageResponse({
    rate_limit: {
      allowed: true,
      primary_window: {
        used_percent: 39,
        limit_window_seconds: 604800,
        reset_after_seconds: 571895,
        reset_at: 1788748115,
      },
      secondary_window: null,
    },
    rate_limit_reset_credits: {
      available_count: 3,
      applicable_available_count: 2,
    },
  }, 1000);
  assert.deepEqual(result, {
    available: true,
    usedPercent: 39,
    remainingPercent: 61,
    resetsAtMs: 1788748115000,
    windowDurationMins: 10080,
    resetCredits: { availableCount: 3, applicableAvailableCount: 2 },
    observedAtMs: 1000,
  });
  assert.deepEqual(resetCreditsFromUsageResponse({
    rate_limit_reset_credits: { available_count: 4, applicable_available_count: 1 },
  }), { availableCount: 4, applicableAvailableCount: 1 });
  assert.equal(resetCreditsFromUsageResponse({}), null);
  assert.equal(weeklyUsageFromUsageResponse({
    rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
  }), null, "the five-hour window must never be mislabeled as weekly quota");
});

test("Codex Accounts fetches usage directly without starting an app-server", () => {
  const service = fixture();
  service.weeklyUsageCache = new Map();
  const previousFilesystem = globalThis.hostFilesystem;
  const previousNetwork = globalThis.hostNetwork;
  const previousConfig = globalThis.hypernodeConfig;
  const requests = [];
  const reads = [];
  globalThis.hostFilesystem = {
    readFileForUser(username, path) {
      reads.push({ username, path });
      if (path.endsWith("/installation_id")) {
        return new TextEncoder().encode(`installation-${path.split("/").at(-2)}`);
      }
      return new TextEncoder().encode(JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: `private-token-${path}`, account_id: path },
      }));
    },
  };
  globalThis.hostNetwork = {
    request(value) {
      requests.push(value);
      return {
        status: 200,
        body: JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 25,
              limit_window_seconds: 604800,
              reset_at: 1788748115,
            },
          },
          rate_limit_reset_credits: {
            available_count: 2,
            applicable_available_count: 1,
          },
        }),
      };
    },
  };
  globalThis.hypernodeConfig = { remoteControlBaseUrl: "https://chatgpt.com/backend-api" };
  try {
    const result = service.accountsWithUsage(connection, true);
    assert.equal(result.accounts[0].weeklyUsage.remainingPercent, 75);
    assert.equal(result.accounts[1].weeklyUsage.remainingPercent, 75);
    assert.deepEqual(result.accounts[0].weeklyUsage.resetCredits, {
      availableCount: 2,
      applicableAvailableCount: 1,
    });
    assert.equal(reads.length, 4);
    assert.equal(reads[0].username, "alice");
    assert.equal(reads[0].path, ".codex/hypernode/accounts/subscription-a/auth.json");
    assert.equal(reads[1].path, ".codex/hypernode/accounts/subscription-a/installation_id");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].headers["chatgpt-account-id"], reads[0].path);
    assert.equal(requests[0].headers.authorization, `Bearer private-token-${reads[0].path}`);
    assert.equal(requests[0].headers["x-codex-installation-id"], "installation-subscription-a");
  } finally {
    globalThis.hostFilesystem = previousFilesystem;
    globalThis.hostNetwork = previousNetwork;
    globalThis.hypernodeConfig = previousConfig;
  }
});

test("Codex Accounts switches only a profile owned by the current SSH user", () => {
  const service = fixture();
  service.weeklyUsageCache = new Map();
  const result = service.selectAccount(connection, "subscription-a");
  assert.equal(result.selectedProfileId, "subscription-a");
  assert.deepEqual(result.runtimeRefresh, { retired: 1, deferred: 0 });
  assert.deepEqual(result.accounts.map((account) => account.active), [true, false]);
  assert.throws(
    () => service.selectAccount(connection, "subscription-missing"),
    /not available to the current SSH user/,
  );
});

test("management catalog MCP servers expose self-contained read-only Apps", () => {
  const service = fixture();
  const registry = new McpRegistry();
  registry.registerServer(service.usersRegistration());
  registry.registerServer(service.accountsRegistration());
  const inventory = registry.list({ detail: "full" }, connection).data;
  const users = inventory.find((server) => server.name === USERS_SERVER_NAME);
  const accounts = inventory.find((server) => server.name === CODEX_ACCOUNTS_SERVER_NAME);
  assert.equal(users.resources[0].uri, USERS_RESOURCE_URI);
  assert.equal(accounts.resources[0].uri, CODEX_ACCOUNTS_RESOURCE_URI);
  assert.match(CODEX_ACCOUNTS_RESOURCE_URI, /\/v6\.html$/);
  assert.equal(users.tools["users.list"].annotations.readOnlyHint, true);
  assert.equal(accounts.tools["codexAccounts.list"].annotations.readOnlyHint, true);
  assert.equal(accounts.tools["codexAccounts.select"].annotations.readOnlyHint, false);
  assert.equal(accounts.tools["codexAccounts.publish"].annotations.readOnlyHint, false);
  assert.equal(accounts.tools["codexAccounts.unpublish"].annotations.destructiveHint, true);
  assert.equal(accounts.tools["codexAccounts.useShared"].annotations.readOnlyHint, false);
  for (const [html, tool] of [[USERS_HTML, "users.list"], [CODEX_ACCOUNTS_HTML, "codexAccounts.list"]]) {
    assert.match(html, /window\.openai\.callTool/);
    assert.match(html, new RegExp(tool.replace(".", "\\.")));
    assert.doesNotMatch(html, /ResizeObserver/);
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i);
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
  }
  assert.match(CODEX_ACCOUNTS_HTML, /周额度剩余/);
  assert.match(CODEX_ACCOUNTS_HTML, /weeklyUsage/);
  assert.match(CODEX_ACCOUNTS_HTML, /当前可用重置券/);
  assert.match(CODEX_ACCOUNTS_HTML, /account-action/);
  assert.match(CODEX_ACCOUNTS_HTML, /codexAccounts\.select/);
  assert.match(CODEX_ACCOUNTS_HTML, /codexAccounts\.publish/);
  assert.match(CODEX_ACCOUNTS_HTML, /codexAccounts\.useShared/);
});

test("users and accounts skills launch their MCP Apps", () => {
  assert.equal(usersLaunchRequest().server, USERS_SERVER_NAME);
  assert.equal(usersLaunchRequest().tool, "users.list");
  assert.equal(usersLaunchRequest().resourceUri, USERS_RESOURCE_URI);
  assert.equal(codexAccountsLaunchRequest().server, CODEX_ACCOUNTS_SERVER_NAME);
  assert.equal(codexAccountsLaunchRequest().tool, "codexAccounts.list");
  assert.equal(codexAccountsLaunchRequest().resourceUri, CODEX_ACCOUNTS_RESOURCE_URI);
  assert.equal(sharedCodexLaunchRequest().server, CODEX_ACCOUNTS_SERVER_NAME);
  assert.equal(sharedCodexLaunchRequest().arguments.mode, "shared");
  assert.equal(sharedCodexLaunchRequest().resourceUri, CODEX_ACCOUNTS_RESOURCE_URI);
});
