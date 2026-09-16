import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { SharedCodexService } from "../src/services/shared-codex.ts";

function fixture() {
  const users = new Map([
    ["user:owner", { id: "user:owner", username: "owner", installationId: "owner-installation" }],
    ["user:consumer", { id: "user:consumer", username: "consumer", installationId: "consumer-installation" }],
    ["user:consumer-2", { id: "user:consumer-2", username: "consumer-2", installationId: "consumer-2-installation" }],
  ]);
  const markers = new Map();
  const activatedOwned = [];
  const runtimeRefreshes = [];
  const service = Object.create(SharedCodexService.prototype);
  service.fallback = new Map();
  service.fallbackActivations = new Map();
  service.ctx = {
    storage: { available: false, sql: null },
    userDirectory: {
      find: (id) => users.get(id) ?? null,
      setInstallationId(id, installationId) { users.get(id).installationId = installationId; },
      setCodexAccount(id, account) { users.get(id).account = account; },
    },
    accountCatalog: {
      profilesForUser(user) {
        return [{
          id: `profile-${user.username}`,
          name: `${user.username} Codex`,
          email: `${user.username}@example.com`,
          planType: "pro",
          accountIdentity: `chatgpt:${user.username}`,
        }];
      },
      activateProfile(user, profileId) {
        activatedOwned.push({ userId: user.id, profileId });
        markers.delete(user.username);
      },
    },
    modelGateway: {
      useSubscriptionForUser(user, profileId) {
        runtimeRefreshes.push({ userId: user.id, profileId });
        return { runtimeRefresh: { retired: 1, deferred: 0 } };
      },
    },
  };
  return { service, users, markers, activatedOwned, runtimeRefreshes };
}

test("a published Codex profile can be materialized into another SSH user", () => {
  const previousHostIdentity = globalThis.hostIdentity;
  const previousSha256 = globalThis.crypto.sha256;
  globalThis.crypto.sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
  const state = fixture();
  globalThis.hostIdentity = {
    readActiveCodexShare(username) { return state.markers.get(username) ?? ""; },
    activateSharedCodexAuthProfile(owner, profileId, consumer, shareId) {
      assert.equal(owner, "owner");
      assert.equal(profileId, "profile-owner");
      state.markers.set(consumer, shareId);
      return "shared-installation";
    },
    syncSharedCodexAuthProfile() {},
    clearActiveCodexAuth(username) { state.markers.delete(username); },
  };
  try {
    const published = state.service.publish(
      { identity: { id: "user:owner", username: "owner" } },
      "profile-owner",
    );
    assert.match(published.shareId, /^shared-/);
    const activated = state.service.activate(
      { identity: { id: "user:consumer", username: "consumer" } },
      published.shareId,
    );
    assert.equal(activated.share.shareId, published.shareId);
    assert.equal(state.users.get("user:consumer").installationId, "shared-installation");
    assert.equal(state.service.activeForUser("user:consumer").shareId, published.shareId);
    const second = state.service.activate(
      { identity: { id: "user:consumer-2", username: "consumer-2" } },
      published.shareId,
    );
    assert.equal(second.share.shareId, published.shareId);
    assert.equal(state.service.activeForUser("user:consumer").shareId, published.shareId,
      "another consumer must not revoke the first node member");
    assert.equal(state.service.activeForUser("user:consumer-2").shareId, published.shareId);
    assert.deepEqual(state.runtimeRefreshes.at(-1), {
      userId: "user:consumer-2",
      profileId: "default",
    });
    assert.equal(state.runtimeRefreshes.some((entry) => entry.userId === "user:consumer"), true);
    assert.throws(
      () => state.service.unpublish(
        { identity: { id: "user:consumer", username: "consumer" } },
        published.shareId,
      ),
      /only the publisher/,
    );
    assert.equal(state.service.unpublish(
      { identity: { id: "user:owner", username: "owner" } },
      published.shareId,
    ), true);
    assert.deepEqual(state.activatedOwned.at(-1), {
      userId: "user:consumer-2",
      profileId: "profile-consumer-2",
    });
    assert.equal(state.activatedOwned.some((entry) => entry.userId === "user:consumer"), true);
    assert.equal(state.service.list().length, 0);
  } finally {
    globalThis.hostIdentity = previousHostIdentity;
    if (previousSha256 === undefined) delete globalThis.crypto.sha256;
    else globalThis.crypto.sha256 = previousSha256;
  }
});

test("an unbound user automatically materializes the oldest node-shared profile", () => {
  const previousHostIdentity = globalThis.hostIdentity;
  const previousSha256 = globalThis.crypto.sha256;
  globalThis.crypto.sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
  const state = fixture();
  globalThis.hostIdentity = {
    readActiveCodexShare(username) { return state.markers.get(username) ?? ""; },
    activateSharedCodexAuthProfile(_owner, _profileId, consumer, shareId) {
      state.markers.set(consumer, shareId);
      return "shared-installation";
    },
    syncSharedCodexAuthProfile() {},
    clearActiveCodexAuth(username) { state.markers.delete(username); },
  };
  try {
    const published = state.service.publish(
      { identity: { id: "user:owner", username: "owner" } },
      "profile-owner",
    );
    assert.equal(state.service.ensureActiveForUser("user:consumer")?.shareId, published.shareId);
    assert.equal(state.service.activeForUser("user:consumer")?.shareId, published.shareId);
    assert.equal(state.users.get("user:consumer").installationId, "shared-installation");
    assert.deepEqual(state.runtimeRefreshes, [], "discovery must not replace the selected model");
  } finally {
    globalThis.hostIdentity = previousHostIdentity;
    if (previousSha256 === undefined) delete globalThis.crypto.sha256;
    else globalThis.crypto.sha256 = previousSha256;
  }
});
