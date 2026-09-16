import assert from "node:assert/strict";
import test from "node:test";

import {
  UserDirectoryService,
  onboardingWelcomeText,
} from "../src/services/user-directory.js";

test("new-user onboarding makes Codex binding optional", () => {
  const message = onboardingWelcomeText(
    { username: "alice" },
    { codexBindingState: "unbound" },
    { debug: true },
  );
  assert.match(message, /alice/);
  assert.match(message, /调试模式/);
  assert.match(message, /公共模型已经可用/);
  assert.match(message, /无需先绑定/);
  assert.match(message, /管理员/);
  assert.match(message, /添加 Codex 账户/);
  assert.match(message, /私有 CODEX_HOME/);
});

test("already-bound newcomers are not instructed to bind again", () => {
  const message = onboardingWelcomeText(
    { username: "alice" },
    { codexBindingState: "bound" },
  );
  assert.match(message, /已检测到你的 Codex 凭据/);
  assert.doesNotMatch(message, /添加 Codex 账户/);
});

test("fallback onboarding claim succeeds only once", () => {
  const service = Object.create(UserDirectoryService.prototype);
  service.ctx = { storage: { available: false } };
  service.fallback = new Map([["user:alice", {
    id: "user:alice",
    onboardingWelcomedAtMs: null,
  }]]);

  assert.equal(service.claimOnboardingWelcome("user:alice", 100), true);
  assert.equal(service.claimOnboardingWelcome("user:alice", 200), false);
  assert.equal(service.fallback.get("user:alice").onboardingWelcomedAtMs, 100);
});
