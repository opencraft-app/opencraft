import assert from "node:assert/strict";
import test from "node:test";
import { AccountCatalogService } from "../src/services/account-catalog.ts";

test("startup restores the persisted selected Codex profile into active auth", () => {
  const previousHostIdentity = globalThis.hostIdentity;
  const activated = [];
  globalThis.hostIdentity = {
    readActiveCodexShare: () => "",
    readCodexAuth: () => { throw new Error("active auth is absent"); },
  };
  try {
    const user = { id: "user-1", username: "alice" };
    const service = Object.create(AccountCatalogService.prototype);
    service.ctx = {
      userDirectory: { list: () => [user] },
      modelGateway: {
        selectionForUser: () => ({ kind: "codex", profileId: "subscription-a" }),
      },
    };
    service.rawProfilesForUser = () => [{
      userId: "user-1",
      profileId: "subscription-a",
      accountIdentity: "chatgpt:account-a",
      displayName: "Account A",
      email: "a@example.com",
      planType: "pro",
      credentialRef: "profile-a/auth.json",
      createdAtMs: 1,
      updatedAtMs: 1,
    }];
    service.activateProfile = (candidate, profileId) => {
      activated.push([candidate.id, profileId]);
      return service.rawProfilesForUser()[0];
    };

    assert.equal(service.reconcileSelectedProfiles(), 1);
    assert.deepEqual(activated, [["user-1", "subscription-a"]]);
  } finally {
    globalThis.hostIdentity = previousHostIdentity;
  }
});

test("startup does not replace an active node-shared Codex profile", () => {
  const previousHostIdentity = globalThis.hostIdentity;
  globalThis.hostIdentity = {
    readActiveCodexShare: () => "shared-a",
  };
  try {
    const service = Object.create(AccountCatalogService.prototype);
    service.ctx = {
      userDirectory: { list: () => [{ id: "user-1", username: "alice" }] },
      modelGateway: {
        selectionForUser: () => ({ kind: "codex", profileId: "subscription-a" }),
      },
    };
    service.rawProfilesForUser = () => { throw new Error("must not inspect personal profiles"); };
    service.activateProfile = () => { throw new Error("must not restore a personal profile"); };
    assert.equal(service.reconcileSelectedProfiles(), 0);
  } finally {
    globalThis.hostIdentity = previousHostIdentity;
  }
});
