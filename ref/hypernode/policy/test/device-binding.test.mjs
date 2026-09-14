import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_ACCOUNT_NOT_BOUND,
  accountUpdatedBindingState,
  codexAccountHandoffRequiredError,
  codexAccountNotBoundError,
  providerIdFromAccountIdentity,
  runtimeNeedsAccountHandoff,
} from "../src/services/transparent-thread-routing.ts";
import { deviceLoginPrompt } from "../src/services/codex-account-binding.ts";
import { CodexAccountBindingService } from "../src/services/codex-account-binding.ts";
import { renderAccountCatalog } from "../src/services/account-catalog.ts";
import { remoteControlAuthRequiredMessage } from "../src/services/remote-control.js";

test("unbound per-user Codex devices return an actionable deterministic error", () => {
  const error = codexAccountNotBoundError({
    userId: "user:alice",
    username: "alice",
    installationId: "11111111-2222-4333-8444-555555555555",
    bindingState: "unbound",
  });

  assert.equal(error.code, CODEX_ACCOUNT_NOT_BOUND);
  assert.match(error.message, /alice/);
  assert.deepEqual(error.data, {
    kind: "codexAccountNotBound",
    userId: "user:alice",
    username: "alice",
    installationId: "11111111-2222-4333-8444-555555555555",
    bindingState: "unbound",
    loginMethod: "chatgptDeviceCode",
  });
});

test("a transparent backend never silently executes with another Codex account", () => {
  const error = codexAccountHandoffRequiredError(
    { username: "bob" },
    { username: "alice" },
  );
  assert.equal(error.code, -32069);
  assert.equal(error.data.kind, "codexAccountHandoffRequired");
  assert.match(error.message, /alice/);
  assert.match(error.message, /bob/);
});

test("resident runtime identity wins over a changed credential file", () => {
  const actor = { accountIdentity: "chatgpt:new" };
  const reloadedCredential = { accountIdentity: "chatgpt:new" };
  assert.equal(runtimeNeedsAccountHandoff(
    { accountIdentity: "chatgpt:old" }, reloadedCredential, actor,
  ), true);
  assert.equal(runtimeNeedsAccountHandoff(
    { accountIdentity: "chatgpt:new" }, { accountIdentity: "chatgpt:other" }, actor,
  ), false);
  assert.equal(runtimeNeedsAccountHandoff(
    { accountIdentity: "chatgpt:old" }, null,
    { accountIdentity: "model-provider:public:public-a" },
  ), true);
});

test("thread runtime provider routes are recovered from durable account identities", () => {
  assert.equal(
    providerIdFromAccountIdentity("model-provider:public:public-a", "user:alice"),
    "public-a",
  );
  assert.equal(
    providerIdFromAccountIdentity("model-provider:user:alice:private-a", "user:alice"),
    "private-a",
  );
  assert.equal(providerIdFromAccountIdentity("chatgpt:account-a", "user:alice"), null);
});

test("real Codex account/updated notifications preserve binding state", () => {
  assert.equal(accountUpdatedBindingState({ authMode: "chatgpt", planType: "pro" }), "bound");
  assert.equal(accountUpdatedBindingState({ authMode: "apiKey", planType: null }), "bound");
  assert.equal(accountUpdatedBindingState({ authMode: null, planType: null }), "unbound");
  assert.equal(accountUpdatedBindingState({ account: { type: "chatgpt" } }), "bound");
});

test("management-thread device login prompt carries the official response fields", () => {
  const prompt = deviceLoginPrompt("alice", {
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  });
  assert.match(prompt, /alice/);
  assert.match(prompt, /https:\/\/auth\.openai\.com\/codex\/device/);
  assert.match(prompt, /ABCD-EFGH/);
  assert.match(prompt, /不会写入/);
});

test("adding a subscription stages a fresh local device without logging out the old account", () => {
  const calls = [];
  const installations = [];
  const previousHostIdentity = globalThis.hostIdentity;
  const previousRandomBytes = globalThis.crypto.randomBytes;
  let randomSequence = 0;
  globalThis.crypto.randomBytes = () => (++randomSequence).toString(16).padStart(32, "0");
  globalThis.hostIdentity = {
    beginCodexAuthLogin(username, stagingId, installationId) {
      calls.push({ kind: "stage", username, stagingId, installationId });
      return "installation-old";
    },
    rollbackCodexAuthLogin() { return "installation-old"; },
    commitCodexAuthLogin() {},
  };
  const service = Object.create(CodexAccountBindingService.prototype);
  service.flows = new Map();
  service.boundListeners = new Set();
  service.ctx = {
    userDirectory: {
      find: () => ({ id: "user:alice", username: "alice", installationId: "installation-old" }),
      setInstallationId(_userId, value) { installations.push(value); },
      setCodexBindingState() {},
      setCodexAccount() {},
      deliverAgentMessage() {},
    },
    transparentControlRouting: {
      resetCodexControlBackend(userId) {
        calls.push({ kind: "reset", userId });
        return true;
      },
      requestUserBackend(_connection, method, params, callback) {
        calls.push({ kind: "rpc", method, params });
        if (method === "account/read") {
          callback(null, {
            account: { type: "chatgpt", email: "old@example.com", planType: "pro" },
            requiresOpenaiAuth: true,
          });
        }
      },
    },
  };
  try {
    service.begin(
      { identity: { id: "user:alice", username: "alice" } },
      "thread-management",
      { forceNew: true },
    );
    assert.equal(calls.some((call) => call.method === "account/logout"), false);
    assert.equal(calls.some((call) => call.kind === "stage"), true);
    assert.equal(calls.filter((call) => call.kind === "reset").length, 1);
    assert.equal(calls.at(-1).method, "account/login/start");
    assert.notEqual(installations[0], "installation-old");
  } finally {
    globalThis.hostIdentity = previousHostIdentity;
    if (previousRandomBytes === undefined) delete globalThis.crypto.randomBytes;
    else globalThis.crypto.randomBytes = previousRandomBytes;
  }
});

test("management account catalog exposes ownership and remote state without credentials", () => {
  const output = renderAccountCatalog([{
    username: "alice",
    email: "alice@example.com",
    authMode: "chatgpt",
    planType: "pro",
    remoteControlStatus: "connected",
  }]);
  assert.match(output, /alice/);
  assert.match(output, /alice@example\.com/);
  assert.match(output, /connected/);
  assert.doesNotMatch(output, /access.token|refresh.token|bearer/i);
});

test("remote control auth guidance names the owning SSH user and management action", () => {
  const message = remoteControlAuthRequiredMessage({ username: "alice" });
  assert.match(message, /alice/);
  assert.match(message, /管理员/);
  assert.match(message, /添加 Codex 账户/);
});
