import assert from "node:assert/strict";
import test from "node:test";

import { TransparentModelListService } from "../src/services/transparent-model-list.ts";

function harness({ customPage = null, credential = false } = {}) {
  const responses = [];
  const subscriptions = [];
  const service = Object.create(TransparentModelListService.prototype);
  service.ctx = {
    appServer: {
      send: (_connection, response) => responses.push(response),
      audit: () => {},
      summarizeResult: () => ({}),
    },
    credential: {
      resolveCodexUser: () => credential ? { accountIdentity: "chatgpt:test" } : null,
    },
    modelCatalog: {
      customPage: () => customPage,
      mergeSubscriptionPage: (result) => ({ ...result, merged: true }),
      list: () => ({ data: [{ id: "public" }], nextCursor: null }),
    },
    transparentControlRouting: {
      requestUserBackend: (connection, method, params, callback) => {
        subscriptions.push({ connection, method, params, callback });
      },
    },
  };
  return { service, responses, subscriptions };
}

test("custom model cursors remain local and never start a subscription backend", () => {
  const page = { data: [{ id: "private" }], nextCursor: null };
  const { service, responses, subscriptions } = harness({ customPage: page });
  service.handle({
    connection: { identity: { id: "user:alice" } },
    message: { id: "models", method: "model/list", params: { cursor: "custom:1" } },
  });

  assert.deepEqual(responses, [{ id: "models", result: page }]);
  assert.equal(subscriptions.length, 0);
});

test("a Codex credential merges the native subscription page with visible models", () => {
  const { service, responses, subscriptions } = harness({ credential: true });
  const connection = { identity: { id: "user:alice" } };
  service.handle({
    connection,
    message: { id: 7, method: "model/list", params: { limit: 10 } },
  });

  assert.equal(responses.length, 0);
  assert.equal(subscriptions.length, 1);
  subscriptions[0].callback(null, { data: [{ id: "gpt" }], nextCursor: null });
  assert.deepEqual(responses, [{
    id: 7,
    result: { data: [{ id: "gpt" }], nextCursor: null, merged: true },
  }]);
});

test("subscription errors are returned without fabricating a local page", () => {
  const { service, responses, subscriptions } = harness({ credential: true });
  service.handle({
    connection: { identity: { id: "user:alice" } },
    message: { id: "models", method: "model/list", params: {} },
  });
  subscriptions[0].callback({ code: -32001, message: "subscription unavailable" });
  assert.deepEqual(responses, [{
    id: "models",
    error: { code: -32001, message: "subscription unavailable" },
  }]);
});

test("users without a Codex credential receive the local provider catalog", () => {
  const { service, responses, subscriptions } = harness();
  service.handle({
    connection: { identity: { id: "user:bob" } },
    message: { id: "models", method: "model/list", params: {} },
  });
  assert.deepEqual(responses, [{
    id: "models",
    result: { data: [{ id: "public" }], nextCursor: null },
  }]);
  assert.equal(subscriptions.length, 0);
});
